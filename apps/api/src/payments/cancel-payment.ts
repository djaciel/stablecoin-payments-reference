import { applyGuardedTransition, type PoolClient } from '@payments/db'
import type { PaymentView } from '@payments/domain'
import { AUDIT_ACTORS, AUDIT_SUBJECTS, PAYABLE_EVENTS, PAYMENT_EVENTS, cancel, recordAudit } from '@payments/ledger'
import { PAYMENT_COLUMNS, toView, type PaymentRow } from './read-payments'

export type CancelOutcome =
  /** RESERVED → FAILED `cancelled`, the money back and the invoice open again, committed by the caller. */
  | { readonly kind: 'cancelled'; readonly payment: PaymentView }
  /** Signed bytes exist, so only the chain can end this payment. Nothing written. */
  | { readonly kind: 'signed-already' }
  /** Nothing to cancel: it is not waiting any more. Nothing written. */
  | { readonly kind: 'not-cancellable'; readonly status: string }
  | { readonly kind: 'unknown' }

/** What goes in the books when nobody typed a reason: the one place the button cancels from. */
const FROM_THE_QUEUE = 'cancelled from the scheduled queue'

/**
 * `POST /payments/:reference/cancel`: the second release door, and the only one allowed
 * without a chain proof. No signed bytes exist, so no node can ever include any,
 * and that absence IS the proof. Inside the CALLER's transaction, like `createPayment`.
 */
export async function cancelPayment(client: PoolClient, reference: string, reason?: string): Promise<CancelOutcome> {
  // 1. The invoice first, `reverse`'s query and `createPayment`'s order: cancel reopens it, and
  //    taking it before the ledger's account locks is why two payments on one invoice queue
  //    instead of deadlocking. NO KEY UPDATE because a payment's foreign key check holds a
  //    share lock on this row, and FOR UPDATE would wait on it.
  const invoice = await client.query<{ id: string }>(
    `SELECT id FROM payables WHERE id = (SELECT payable_id FROM payments WHERE reference = $1) FOR NO KEY UPDATE`,
    [reference],
  )

  // 2. The payment read UNDER its own row lock, never before it. `signPayment` holds this same
  //    lock from before its checks until after it has stored hash, bytes and nonce, with the
  //    signer call inside that window: so sign and cancel serialize, and the loser sees the change.
  const result = await client.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE reference = $1 FOR UPDATE`, [
    reference,
  ])
  const payment = result.rows[0]
  if (payment === undefined) {
    return { kind: 'unknown' }
  }
  // 3. A hash means signed bytes exist, whatever the status says. They can still land, so this
  //    money is not ours to release.
  if (payment.tx_hash !== null) {
    return { kind: 'signed-already' }
  }
  if (payment.status !== 'RESERVED') {
    return { kind: 'not-cancellable', status: payment.status }
  }
  const invoiceId = invoice.rows[0]?.id
  if (invoiceId === undefined) {
    // Unreachable: every payment is written against an invoice, an ad-hoc one included.
    throw new Error(`${reference}: no invoice to reopen`)
  }

  // 4. The payment failed, and why is a code a screen can print.
  await applyGuardedTransition(client, {
    table: 'payments',
    idColumn: 'reference',
    id: reference,
    statusColumn: 'status',
    from: 'RESERVED',
    to: 'FAILED',
    extraSet: { failure_reason: 'cancelled' },
  })
  await recordAudit(client, {
    actor: AUDIT_ACTORS.admin,
    subjectType: AUDIT_SUBJECTS.payment,
    subjectId: reference,
    event: PAYMENT_EVENTS.failed,
    context: { reason: 'cancelled', ...(reason === undefined ? {} : { note: reason }) },
  })

  // 5. The money came back: Dr Available / Cr Reserved, the same entries a reversal writes and a
  //    different justification. `cancel` writes its own `released` row, with the sentence that
  //    stands in for a chain proof.
  await cancel(client, { reference, amount: BigInt(payment.amount_minor), currency: payment.currency, reason: reason ?? FROM_THE_QUEUE })

  // 6. The invoice reopened, exactly as a reversal reopens it: it is paid again with a NEW key.
  //    Partner debt does not move — the invoice is still owed, and an invoice is not a payment.
  await applyGuardedTransition(client, {
    table: 'payables',
    idColumn: 'id',
    id: invoiceId,
    statusColumn: 'status',
    from: 'PAYING',
    to: 'OPEN',
    extraSet: { payment_reference: null },
  })
  await recordAudit(client, {
    actor: AUDIT_ACTORS.admin,
    subjectType: AUDIT_SUBJECTS.invoice,
    subjectId: invoiceId,
    event: PAYABLE_EVENTS.reopened,
    context: { reference, reason: 'cancelled' },
  })
  return { kind: 'cancelled', payment: toView({ ...payment, status: 'FAILED', failure_reason: 'cancelled' }) }
}
