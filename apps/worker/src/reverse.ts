import { ApplicationFailure, activityInfo, log } from '@temporalio/activity'
import { applyGuardedTransition, inTransaction, type PoolClient } from '@payments/db'
import { AUDIT_ACTORS, AUDIT_SUBJECTS, PAYABLE_EVENTS, PAYMENT_EVENTS, recordAudit, reversal } from '@payments/ledger'
import { workerPool } from './db'
import type { RevertEvidence } from './watch'

export type ReverseOutcome =
  | { readonly kind: 'reversed'; readonly ledgerTransactionId: string }
  /** Reversed before: a worker that died after COMMIT and before Temporal recorded the result. */
  | { readonly kind: 'already-reversed' }

/** The `reverse` activity: a final revert is the proof, so the money comes back in one transaction. No chain reads. */
export async function reverse(reference: string, evidence: RevertEvidence): Promise<string> {
  const client = await workerPool().connect()
  try {
    const outcome = await reversePayment(client, reference, evidence)
    const line =
      outcome.kind === 'reversed' ? `reversed (ledger transaction ${outcome.ledgerTransactionId}), the invoice is open again` : 'already reversed'
    log.info(`${reference} reverse: ${line}`)
    return line
  } catch (error) {
    log.error(`${reference} reverse: attempt ${activityInfo().attempt} FAILED — ${String(error)}`)
    throw error
  } finally {
    client.release()
  }
}

/**
 * SENT → FAILED, released once, the invoice payable again. No Temporal context in here, so
 * `tests/db/failure.db.test.ts` calls it directly; it joins a transaction the caller opened.
 */
export async function reversePayment(client: PoolClient, reference: string, evidence: RevertEvidence): Promise<ReverseOutcome> {
  return inTransaction(client, async () => {
    // 1. The invoice lock, before `reversal` locks the ledger's accounts: settle's order, for the
    //    same reason (a payment and a reversal on one invoice would deadlock), and NO KEY UPDATE too.
    const invoice = await client.query<{ id: string }>(
      `SELECT id FROM payables WHERE id = (SELECT payable_id FROM payments WHERE reference = $1) FOR NO KEY UPDATE`,
      [reference],
    )
    const invoiceId = invoice.rows[0]?.id
    if (invoiceId === undefined) {
      throw new Error(`${reference}: no invoice to reopen`)
    }

    // 2. The payment, read after the lock, so a reversal that committed while this one waited is seen.
    const payment = await client.query<{ status: string; failure_reason: string | null; amount_minor: string; currency: string }>(
      'SELECT status, failure_reason, amount_minor, currency FROM payments WHERE reference = $1',
      [reference],
    )
    const row = payment.rows[0]
    if (row === undefined) {
      throw new Error(`${reference}: no payment has this reference`)
    }
    if (row.status === 'FAILED' && row.failure_reason === 'reverted') {
      return { kind: 'already-reversed' }
    }
    if (row.status !== 'SENT') {
      const state = row.failure_reason === null ? row.status : `${row.status} ${row.failure_reason}`
      throw ApplicationFailure.nonRetryable(`${reference}: nothing to reverse, the payment is ${state}`)
    }

    // 3. The transfer failed.
    await applyGuardedTransition(client, {
      table: 'payments',
      idColumn: 'reference',
      id: reference,
      statusColumn: 'status',
      from: 'SENT',
      to: 'FAILED',
      extraSet: { failure_reason: 'reverted' },
    })
    await recordAudit(client, {
      actor: AUDIT_ACTORS.worker,
      subjectType: AUDIT_SUBJECTS.payment,
      subjectId: reference,
      event: PAYMENT_EVENTS.failed,
      context: { reason: 'reverted', ...evidence },
    })

    // 4. The money came back: Dr Available / Cr Reserved, with the proof. `reversal` writes the
    //    `released` row itself. Partner debt does not move: the invoice is still owed.
    const { txHash, blockNumber, finalBlock } = evidence
    const ledgerTransactionId = await reversal(client, {
      reference,
      amount: BigInt(row.amount_minor),
      currency: row.currency,
      proof: { txHash, blockNumber, reason: `reverted onchain: receipt status 0 in block ${String(blockNumber)}, final at ${String(finalBlock)}` },
    })

    // 5. The invoice reopened, with this payment off it: it is paid again with a new key. The
    //    failed attempt stays findable through `payments.payable_id`.
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
      actor: AUDIT_ACTORS.worker,
      subjectType: AUDIT_SUBJECTS.invoice,
      subjectId: invoiceId,
      event: PAYABLE_EVENTS.reopened,
      context: { reference, reason: 'reverted' },
    })
    return { kind: 'reversed', ledgerTransactionId }
  })
}
