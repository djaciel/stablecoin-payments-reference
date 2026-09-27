import { ApplicationFailure, activityInfo, log } from '@temporalio/activity'
import { chainErrorMessage } from '@payments/chain'
import { applyGuardedTransition, inTransaction, type PoolClient } from '@payments/db'
import { AUDIT_ACTORS, AUDIT_SUBJECTS, PAYMENT_EVENTS, recordAudit } from '@payments/ledger'
import { workerPool } from './db'

/** Why a run gave up, as the workflow saw it. */
export interface Escalation {
  /** The step that gave up: `sign`, `execute`, `watch`, `settle` or `reverse`. */
  readonly step: string
  /** How its retries ended (Temporal's `RetryState`); null when the wait for finality ran out of time. */
  readonly retryState: string | null
  /** The checks made, for the finality wait; null when the failure does not say (a non-retryable one can come on any attempt). */
  readonly attempts: number | null
  readonly lastError: string
}

export type EscalateOutcome =
  | { readonly kind: 'escalated'; readonly fromStatus: string }
  /** Already in REVIEW, or finished: nothing is written. */
  | { readonly kind: 'nothing-to-escalate'; readonly status: string }

/** The `escalate` activity: no proof either way, so REVIEW, with the reason written down. */
export async function escalate(reference: string, escalation: Escalation): Promise<string> {
  const client = await workerPool().connect()
  try {
    const outcome = await escalatePayment(client, reference, escalation)
    const line =
      outcome.kind === 'escalated'
        ? `${outcome.fromStatus} → REVIEW (${escalation.step} gave up: ${chainErrorMessage(escalation.lastError)})`
        : `nothing to escalate: ${outcome.status}`
    log.info(`${reference} escalate: ${line}`)
    return line
  } catch (error) {
    log.error(`${reference} escalate: attempt ${activityInfo().attempt} FAILED — ${String(error)}`)
    throw error
  } finally {
    client.release()
  }
}

/**
 * RESERVED or SENT → REVIEW, and the audit row that says why, in one transaction. No ledger call
 * and no invoice change, and that is the point: without proof either way the money stays in
 * Reserved and the invoice stays PAYING. No Temporal context in here, so
 * `tests/db/failure.db.test.ts` calls it directly; it joins a transaction the caller opened.
 */
export async function escalatePayment(client: PoolClient, reference: string, escalation: Escalation): Promise<EscalateOutcome> {
  return inTransaction(client, async () => {
    const result = await client.query<{ status: string; tx_hash: string | null; nonce: number | null }>(
      'SELECT status, tx_hash, nonce FROM payments WHERE reference = $1 FOR UPDATE',
      [reference],
    )
    const payment = result.rows[0]
    if (payment === undefined) {
      throw ApplicationFailure.nonRetryable(`${reference}: no payment has this reference`)
    }
    if (payment.status !== 'RESERVED' && payment.status !== 'SENT') {
      return { kind: 'nothing-to-escalate', status: payment.status }
    }

    await applyGuardedTransition(client, {
      table: 'payments',
      idColumn: 'reference',
      id: reference,
      statusColumn: 'status',
      from: payment.status,
      to: 'REVIEW',
      extraSet: { review_from_status: payment.status },
    })
    await recordAudit(client, {
      actor: AUDIT_ACTORS.worker,
      subjectType: AUDIT_SUBJECTS.payment,
      subjectId: reference,
      event: PAYMENT_EVENTS.escalated,
      context: {
        fromStatus: payment.status,
        step: escalation.step,
        retryState: escalation.retryState,
        attempts: escalation.attempts,
        // viem's messages quote the endpoint, and a provider's URL carries its key.
        lastError: chainErrorMessage(escalation.lastError),
        txHash: payment.tx_hash,
        nonce: payment.nonce,
      },
    })
    return { kind: 'escalated', fromStatus: payment.status }
  })
}
