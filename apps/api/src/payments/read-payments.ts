import { explorerTransactionUrl } from '@payments/chain'
import { inTransaction, type Pool, type PoolClient } from '@payments/db'
import { workflowUrl, type AuditStep, type PaymentFailureReason, type PaymentSummary, type PaymentTimeline, type PaymentView } from '@payments/domain'
import { AUDIT_SUBJECTS, PAYMENT_EVENTS, formatMinor } from '@payments/ledger'

/**
 * The payment reads: one payment, the Transfers list, and one payment's story. The story is the
 * audit log and nothing else, no chain reads: what the screen shows is what the steps wrote.
 */

/** The columns every payment read selects and `toView` maps. `create-payment.ts` adds its fingerprint. */
export const PAYMENT_COLUMNS = 'reference, status, payable_id, destination, amount_minor, currency, failure_reason, tx_hash, created_at'

/** The list shows the latest ones; the rest are still in the database. */
const LIST_LIMIT = 100

export interface PaymentRow {
  readonly reference: string
  readonly status: PaymentView['status']
  readonly payable_id: string | null
  readonly destination: string
  readonly amount_minor: string
  readonly currency: string
  readonly failure_reason: PaymentFailureReason | null
  readonly tx_hash: string | null
  readonly created_at: Date
}

/** `GET /payments/:reference`. */
export async function findPayment(db: Pool | PoolClient, reference: string): Promise<PaymentView | undefined> {
  const result = await db.query<PaymentRow>(`SELECT ${PAYMENT_COLUMNS} FROM payments WHERE reference = $1`, [reference])
  return result.rows[0] === undefined ? undefined : toView(result.rows[0])
}

/** `GET /payments`: newest first. */
export async function listPayments(db: Pool | PoolClient): Promise<PaymentSummary[]> {
  return selectSummaries(db, `ORDER BY created_at DESC LIMIT ${String(LIST_LIMIT)}`, [])
}

/**
 * `GET /payments/:reference/timeline`: the payment's audit rows in the order they were written,
 * plus its invoice's rows that name it (`payment-linked`, `paid`). One snapshot for both reads,
 * so a step never shows before the state that goes with it, or the other way round.
 */
export async function paymentTimeline(pool: Pool, reference: string): Promise<PaymentTimeline | undefined> {
  const client = await pool.connect()
  try {
    return await inTransaction(client, async () => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')
      const [payment] = await selectSummaries(client, 'WHERE reference = $2', [reference])
      if (payment === undefined) {
        return undefined
      }
      const steps = await client.query<AuditRow>(
        `SELECT at, actor, subject_type, event, context FROM audit_log
          WHERE (subject_type = $1 AND subject_id = $2)
             OR (subject_type = $3 AND subject_id = $4 AND context->>'reference' = $2)
          ORDER BY id`,
        [AUDIT_SUBJECTS.payment, reference, AUDIT_SUBJECTS.invoice, payment.payableId],
      )
      // Only a payment whose money was reserved is ever dispatched: a refused one has no workflow to link.
      const reserved = steps.rows.some((row) => row.subject_type === AUDIT_SUBJECTS.payment && row.event === PAYMENT_EVENTS.reserved)
      return { payment, steps: steps.rows.map(toStep), ...(reserved ? { workflowUrl: workflowUrl(reference) } : {}) }
    })
  } finally {
    client.release()
  }
}

export function toView(row: PaymentRow): PaymentView {
  return {
    reference: row.reference,
    status: row.status,
    amount: formatMinor(BigInt(row.amount_minor)),
    destination: row.destination,
    payableId: row.payable_id,
    reason: row.failure_reason ?? undefined,
    transaction: transactionView(row.tx_hash),
    createdAt: row.created_at.toISOString(),
  }
}

/** The hash and its explorer link, once `sign` has stored one. Shared with the Payables screen's read. */
export function transactionView(txHash: string | null): PaymentView['transaction'] {
  return txHash === null ? undefined : { hash: txHash, explorerUrl: explorerTransactionUrl(txHash) }
}

interface SummaryRow extends PaymentRow {
  readonly partner_name: string | null
  readonly last_change_at: Date
}

/** `$1` is taken by the audit subject; `filter` numbers its own parameters from `$2`. */
async function selectSummaries(db: Pool | PoolClient, filter: string, params: readonly unknown[]): Promise<PaymentSummary[]> {
  const result = await db.query<SummaryRow>(
    `SELECT ${PAYMENT_COLUMNS},
            (SELECT partners.name FROM payables JOIN partners ON partners.id = payables.partner_id
              WHERE payables.id = payments.payable_id) AS partner_name,
            (SELECT coalesce(max(at), payments.created_at) FROM audit_log
              WHERE subject_type = $1 AND subject_id = payments.reference) AS last_change_at
       FROM payments ${filter}`,
    [AUDIT_SUBJECTS.payment, ...params],
  )
  return result.rows.map((row) => ({ ...toView(row), partnerName: row.partner_name, lastChangeAt: row.last_change_at.toISOString() }))
}

interface AuditRow {
  readonly at: Date
  readonly actor: string
  readonly subject_type: string
  readonly event: string
  readonly context: Readonly<Record<string, unknown>>
}

/** Numbers and flags become strings too, so the screen prints them without asking what they are. */
function toStep(row: AuditRow): AuditStep {
  return {
    at: row.at.toISOString(),
    actor: row.actor,
    subjectType: row.subject_type,
    event: row.event,
    context: Object.fromEntries(
      Object.entries(row.context).map(([key, value]) => [key, typeof value === 'string' ? value : JSON.stringify(value)]),
    ),
  }
}
