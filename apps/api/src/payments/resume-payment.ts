import { applyGuardedTransition, type PoolClient } from '@payments/db'
import type { PaymentView } from '@payments/domain'
import { AUDIT_ACTORS, AUDIT_SUBJECTS, PAYMENT_EVENTS, recordAudit } from '@payments/ledger'
import { PAYMENT_COLUMNS, toView, type PaymentRow } from './read-payments'

export type ResumeOutcome =
  /** Back where it was before REVIEW, committed with its `resumed` row by the caller. */
  | { readonly kind: 'resumed'; readonly payment: PaymentView }
  /** Not in REVIEW: nothing written. */
  | { readonly kind: 'not-in-review'; readonly status: string }
  | { readonly kind: 'unknown' }

/**
 * `POST /payments/:reference/resume`: REVIEW → the state it came from, inside the CALLER's
 * transaction, like `createPayment`. No ledger call: the money stayed reserved through REVIEW and
 * stays reserved now. The workflow that looks for the proof again is dispatched after COMMIT.
 */
export async function resumePayment(client: PoolClient, reference: string): Promise<ResumeOutcome> {
  const result = await client.query<PaymentRow & { readonly review_from_status: 'RESERVED' | 'SENT' | null }>(
    `SELECT ${PAYMENT_COLUMNS}, review_from_status FROM payments WHERE reference = $1 FOR UPDATE`,
    [reference],
  )
  const payment = result.rows[0]
  if (payment === undefined) {
    return { kind: 'unknown' }
  }
  if (payment.status !== 'REVIEW' || payment.review_from_status === null) {
    return { kind: 'not-in-review', status: payment.status }
  }

  const to = payment.review_from_status
  await applyGuardedTransition(client, {
    table: 'payments',
    idColumn: 'reference',
    id: reference,
    statusColumn: 'status',
    from: 'REVIEW',
    to,
    extraSet: { review_from_status: null },
  })
  await recordAudit(client, {
    actor: AUDIT_ACTORS.admin,
    subjectType: AUDIT_SUBJECTS.payment,
    subjectId: reference,
    event: PAYMENT_EVENTS.resumed,
    context: { to },
  })
  return { kind: 'resumed', payment: toView({ ...payment, status: to }) }
}
