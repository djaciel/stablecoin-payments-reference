import { createHash, randomInt } from 'node:crypto'
import { applyGuardedTransition, type PoolClient } from '@payments/db'
import type { PaymentFailureReason, PaymentView } from '@payments/domain'
import { AUDIT_ACTORS, AUDIT_SUBJECTS, PAYABLE_EVENTS, InsufficientFunds, LedgerRejected, PAYMENT_EVENTS, recordAudit, reserve, toMinorFromDecimal, type AuditEventName } from '@payments/ledger'
import { MAX_PAYMENT_USDC, MIN_PAYMENT_USDC } from '../config'
import { screenPayment } from './compliance'
import { PAYMENT_COLUMNS, toView, type PaymentRow } from './read-payments'

/**
 * `POST /payments` (§4, §5): record the intent, validate it and set the money aside, in six steps
 * and inside the CALLER's transaction, which this file never opens, commits or rolls back. A plain
 * function, not a Nest service, so `tests/db/payments.db.test.ts` can run it on two connections.
 */

const MIN_PAYMENT = toMinorFromDecimal(MIN_PAYMENT_USDC)
const MAX_PAYMENT = toMinorFromDecimal(MAX_PAYMENT_USDC)
const REFERENCE_ATTEMPTS = 5
const COLUMNS = `${PAYMENT_COLUMNS}, request_fingerprint`
type IntentRow = PaymentRow & { readonly request_fingerprint: string }

export interface PaymentRequest {
  readonly idempotencyKey: string
  readonly payableId: string
  /** Absent runs it now; a time reserves the money now and leaves the transfer to the dispatcher. */
  readonly executeAt?: Date
}

export type PaymentOutcome =
  /** The first time this key was seen: a new payment, RESERVED or FAILED. */
  | { readonly kind: 'recorded'; readonly payment: PaymentView }
  /** The same request again: the payment the first one made. Nothing written. */
  | { readonly kind: 'replayed'; readonly payment: PaymentView }
  /** The key already belongs to a different request. Nothing written. */
  | { readonly kind: 'key-conflict' }
  /** No invoice with that id, so nothing to pay. Nothing written. */
  | { readonly kind: 'unknown-payable' }

export async function createPayment(client: PoolClient, request: PaymentRequest): Promise<PaymentOutcome> {
  const fingerprint = fingerprintOf(request)

  // 1. The intent, CREATED. The unique index on the key is the idempotency gate: see insertIntent.
  const intent = await insertIntent(client, request, fingerprint)
  if (intent === 'key-taken') {
    return replay(client, request.idempotencyKey, fingerprint)
  }
  if (intent === undefined) {
    return { kind: 'unknown-payable' }
  }
  const { reference, destination, currency } = intent
  const amountMinor = BigInt(intent.amount_minor)
  // The time joins the `created` row rather than getting an event of its own: the story then reads
  // Created and Reserved at once and Signed minutes later, which is the gap this feature is about.
  await audit(client, reference, PAYMENT_EVENTS.created, {
    idempotencyKey: request.idempotencyKey,
    destination,
    amountMinor,
    ...(request.executeAt ? { executeAt: request.executeAt.toISOString() } : {}),
  })

  // 2. Lock the invoice so its status holds still until COMMIT. Taken BEFORE step 4's account
  //    locks, on every path, so two payments queue instead of deadlocking. NO KEY UPDATE, not
  //    UPDATE: step 1's foreign key check already holds a share lock on this row, and so does any
  //    other payment for the same invoice; FOR UPDATE would wait on theirs while they wait on ours.
  const invoice = await client.query<{ id: string; status: string; partner_status: string | null }>(
    `SELECT p.id, p.status, partners.status AS partner_status
       FROM payables p LEFT JOIN partners ON partners.id = p.partner_id
      WHERE p.id = $1
        FOR NO KEY UPDATE OF p`,
    [request.payableId],
  )
  const locked = invoice.rows[0]
  if (locked === undefined) {
    throw new Error(`payable ${request.payableId} vanished between reading it and locking it`)
  }

  // 3. The validations: one condition and one reason each; the first that says no wins.
  if (locked.status !== 'OPEN') {
    return fail(client, intent, 'payable_not_open')
  }
  // Only when the invoice has a partner: one written to an address somebody typed has no account
  // that could be inactive, and whether that address may be paid is the next check's business.
  if (locked.partner_status !== null && locked.partner_status !== 'active') {
    return fail(client, intent, 'partner_inactive')
  }
  // The allowlist is its own table (`0013`), so this asks the one question it answers. Any admin
  // may add a row through `POST /allowlist`; in a real system that is a reviewed control (§11).
  const allowed = await client.query('SELECT 1 FROM allowlist WHERE address = $1', [destination])
  if (allowed.rowCount === 0) {
    return fail(client, intent, 'destination_not_allowlisted')
  }
  if (amountMinor < MIN_PAYMENT || amountMinor > MAX_PAYMENT) {
    return fail(client, intent, 'amount_out_of_range', { min: MIN_PAYMENT_USDC, max: MAX_PAYMENT_USDC })
  }
  const screening = screenPayment({ destination, amountMinor })
  if (screening.decision === 'reject') {
    return fail(client, intent, 'compliance_rejected', { screening: screening.reason })
  }

  // 4. Set the money aside before anything is signed: Dr treasury:reserved / Cr treasury:available.
  let ledgerTransactionId: string
  try {
    ledgerTransactionId = await reserve(client, { reference, amount: amountMinor, currency })
  } catch (error) {
    if (error instanceof InsufficientFunds) {
      // Thrown by the engine under the account lock and BEFORE anything was written, so this
      // transaction is still usable and step 5 records the refusal in it.
      return fail(client, intent, 'insufficient_funds', { requestedMinor: error.requested, availableMinor: error.available })
    }
    if (error instanceof LedgerRejected && error.constraint === 'ledger_transactions_one_kind_per_reference') {
      // Unreachable while step 1 hands out fresh references: it is the ledger's own guarantee that
      // one payment is reserved once, the double-click experiment's ledger-level assertion.
      throw new Error(`${reference} already has a reserve in the ledger; it was not reserved twice`, { cause: error })
    }
    throw error
  }

  // 6. RESERVED, and the invoice PAYING with this payment on it. The caller COMMITs and answers 201.
  await applyGuardedTransition(client, { ...paymentStatusField(reference), from: 'CREATED', to: 'RESERVED' })
  await applyGuardedTransition(client, {
    table: 'payables',
    idColumn: 'id',
    id: locked.id,
    statusColumn: 'status',
    from: 'OPEN',
    to: 'PAYING',
    extraSet: { payment_reference: reference },
  })
  await audit(client, reference, PAYMENT_EVENTS.reserved, { amountMinor, currency, ledgerTransactionId })
  await recordAudit(client, { actor: AUDIT_ACTORS.api, subjectType: AUDIT_SUBJECTS.invoice, subjectId: locked.id, event: PAYABLE_EVENTS.paymentLinked, context: { reference } })
  return { kind: 'recorded', payment: toView({ ...intent, status: 'RESERVED' }) }
}

/**
 * 5. A refusal is recorded, not rolled back: the payment and its key survive as FAILED, so the same
 * request again gets the same answer. The invoice was never touched and stays OPEN. The caller
 * COMMITs and answers 422.
 */
async function fail(client: PoolClient, intent: IntentRow, reason: PaymentFailureReason, context = {}): Promise<PaymentOutcome> {
  const { reference } = intent
  await applyGuardedTransition(client, { ...paymentStatusField(reference), from: 'CREATED', to: 'FAILED', extraSet: { failure_reason: reason } })
  await audit(client, reference, PAYMENT_EVENTS.failed, { reason, ...context })
  return { kind: 'recorded', payment: toView({ ...intent, status: 'FAILED', failure_reason: reason }) }
}

/**
 * Step 1's INSERT, reading the invoice's destination and amount in the same statement. A second
 * request with the same key waits on the unique index until the first one commits, then fails
 * with 23505. The savepoint keeps the caller's transaction usable after that failure (and exists
 * only inside a transaction, so outside one this refuses instead of committing on its own).
 */
async function insertIntent(client: PoolClient, request: PaymentRequest, fingerprint: string): Promise<IntentRow | 'key-taken' | undefined> {
  for (let attempt = 1; attempt <= REFERENCE_ATTEMPTS; attempt += 1) {
    await client.query('SAVEPOINT payment_intent')
    try {
      const inserted = await client.query<IntentRow>(
        `INSERT INTO payments (reference, status, payable_id, destination, amount_minor, currency, idempotency_key, request_fingerprint, execute_at)
         SELECT $1, 'CREATED', id, destination, amount_minor, currency, $2, $3, $5 FROM payables WHERE id = $4
         RETURNING ${COLUMNS}`,
        [newReference(), request.idempotencyKey, fingerprint, request.payableId, request.executeAt ?? null],
      )
      await client.query('RELEASE SAVEPOINT payment_intent')
      return inserted.rows[0]
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT payment_intent')
      // By constraint name, which Postgres guarantees, never by message.
      const constraint = uniqueViolationOn(error)
      if (constraint === 'payments_idempotency_key') {
        return 'key-taken'
      }
      if (constraint !== 'payments_reference_key') {
        throw error
      }
    }
  }
  throw new Error(`no free PAY-XXXX reference after ${String(REFERENCE_ATTEMPTS)} attempts`)
}

/** The key was taken, and under READ COMMITTED this statement sees the commit step 1 waited for. */
async function replay(client: PoolClient, key: string, fingerprint: string): Promise<PaymentOutcome> {
  const result = await client.query<IntentRow>(`SELECT ${COLUMNS} FROM payments WHERE idempotency_key = $1`, [key])
  const row = result.rows[0]
  if (row === undefined) {
    throw new Error(`idempotency key ${key} is taken, but no payment carries it`)
  }
  return row.request_fingerprint === fingerprint ? { kind: 'replayed', payment: toView(row) } : { kind: 'key-conflict' }
}

/**
 * What "the same body" means, all of it here: the validated request rather than the raw bytes, so
 * whitespace, key order or the case of the invoice id is not a different body. Two times are two
 * requests, so the time joins it; the spread puts it there ONLY when it was asked for, which keeps
 * a body with no time hashing to exactly the bytes it always did, and every key already recorded
 * still replaying instead of answering 409.
 */
function fingerprintOf(request: PaymentRequest): string {
  const body = { payableId: request.payableId.toLowerCase(), ...(request.executeAt ? { executeAt: request.executeAt.toISOString() } : {}) }
  return createHash('sha256').update(JSON.stringify(body)).digest('hex')
}

/** The article's PAY-XXXX: four random digits. A real system uses a longer id; ten thousand runs out. */
function newReference(): string {
  return `PAY-${String(randomInt(10_000)).padStart(4, '0')}`
}

function uniqueViolationOn(error: unknown): string | undefined {
  const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown }
  return code === '23505' && typeof constraint === 'string' ? constraint : undefined
}

/** Where a payment's status lives, for `applyGuardedTransition`: which table, which row, which column. */
function paymentStatusField(reference: string): { table: string; idColumn: string; id: string; statusColumn: string } {
  return { table: 'payments', idColumn: 'reference', id: reference, statusColumn: 'status' }
}

function audit(client: PoolClient, reference: string, event: AuditEventName, context: Record<string, unknown>): Promise<void> {
  return recordAudit(client, { actor: AUDIT_ACTORS.api, subjectType: AUDIT_SUBJECTS.payment, subjectId: reference, event, context })
}
