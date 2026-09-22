import { activityInfo, log } from '@temporalio/activity'
import { applyGuardedTransition, inTransaction, type PoolClient } from '@payments/db'
import { AUDIT_ACTORS, AUDIT_SUBJECTS, PAYABLE_EVENTS, PAYMENT_EVENTS, recordAudit, settle as settleLedger } from '@payments/ledger'
import { workerPool } from './db'
import type { SettlementEvidence } from './watch'

export type SettleOutcome =
  | { readonly kind: 'settled'; readonly ledgerTransactionId: string }
  /** Settled before: a worker that died after COMMIT and before Temporal recorded the result. */
  | { readonly kind: 'already-settled' }

/** The `settle` activity: the books, the payment and the invoice move in one transaction. No chain reads. */
export async function settle(reference: string, evidence: SettlementEvidence): Promise<string> {
  const client = await workerPool().connect()
  try {
    const outcome = await settlePayment(client, reference, evidence)
    const line = outcome.kind === 'settled' ? `settled (ledger transaction ${outcome.ledgerTransactionId})` : 'already settled'
    log.info(`${reference} settle: ${line}`)
    return line
  } catch (error) {
    log.error(`${reference} settle: attempt ${activityInfo().attempt} FAILED — ${String(error)}`)
    throw error
  } finally {
    client.release()
  }
}

/**
 * SENT → SETTLED, posted once. No Temporal API in here, so `tests/db/settlement.db.test.ts` calls
 * it directly; like every unit of work in this repo it joins a transaction the caller opened.
 */
export async function settlePayment(client: PoolClient, reference: string, evidence: SettlementEvidence): Promise<SettleOutcome> {
  return inTransaction(client, async () => {
    // 1. The invoice lock, before `settle` locks the ledger's accounts: the order `create-payment.ts`
    //    uses, or a payment and a settle on the same invoice deadlock. NO KEY UPDATE for the same
    //    reason as there: a payment's foreign key check holds a share lock on this row.
    const invoice = await client.query<{ id: string }>(
      `SELECT id FROM payables WHERE id = (SELECT payable_id FROM payments WHERE reference = $1) FOR NO KEY UPDATE`,
      [reference],
    )
    const invoiceId = invoice.rows[0]?.id
    if (invoiceId === undefined) {
      throw new Error(`${reference}: no invoice to settle against`)
    }

    // 2. The payment, read after the lock, so a settle that committed while this one waited is seen.
    const payment = await client.query<{ status: string; amount_minor: string; currency: string }>(
      'SELECT status, amount_minor, currency FROM payments WHERE reference = $1',
      [reference],
    )
    const row = payment.rows[0]
    if (row === undefined) {
      throw new Error(`${reference}: no payment has this reference`)
    }
    if (row.status === 'SETTLED') {
      return { kind: 'already-settled' }
    }

    // 3. The books (§7): Dr Partner debt / Cr Reserved. Available does not move.
    const amountMinor = BigInt(row.amount_minor)
    const ledgerTransactionId = await settleLedger(client, { reference, amount: amountMinor, currency: row.currency })

    // 4. The payment and its invoice, in the same transaction as the entries.
    await applyGuardedTransition(client, {
      table: 'payments',
      idColumn: 'reference',
      id: reference,
      statusColumn: 'status',
      from: 'SENT',
      to: 'SETTLED',
    })
    await applyGuardedTransition(client, { table: 'payables', idColumn: 'id', id: invoiceId, statusColumn: 'status', from: 'PAYING', to: 'PAID' })

    // 5. The evidence, next to the entries it justifies.
    await recordAudit(client, {
      actor: AUDIT_ACTORS.worker,
      subjectType: AUDIT_SUBJECTS.payment,
      subjectId: reference,
      event: PAYMENT_EVENTS.settled,
      context: { ...evidence, amountMinor, ledgerTransactionId },
    })
    await recordAudit(client, {
      actor: AUDIT_ACTORS.worker,
      subjectType: AUDIT_SUBJECTS.invoice,
      subjectId: invoiceId,
      event: PAYABLE_EVENTS.paid,
      context: { reference },
    })
    return { kind: 'settled', ledgerTransactionId }
  })
}
