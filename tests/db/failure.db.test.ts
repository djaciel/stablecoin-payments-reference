import { inTransaction } from '@payments/db'
import { ACCOUNTS, seedArticle, toMinor, withLedgerTransaction } from '@payments/ledger'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPayment } from '../../apps/api/src/payments/create-payment'
import { reversePayment } from '../../apps/worker/src/reverse'
import { balanceOf, resetDatabase, seedInvoices, testPool, withClient } from './helpers/database'

/**
 * §6 on the books, against real Postgres: what happens to the money when a payment fails after it
 * was reserved. A final revert is proof it did not land, so the money comes back and the invoice
 * reopens.
 */

/** What `watch` hands `reverse`: the demo's first real revert (out of gas, no Transfer event). */
const EVIDENCE = {
  txHash: '0x885e7ec8daa3e948f0e4eafcb56d8c82e46660ae3267b8ccfdeadeb63f1a83c5',
  blockNumber: 47151263,
  finalBlock: 47151877,
}

const pool = testPool()
let invoiceId: string
let reference: string

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await resetDatabase(pool)
  await withLedgerTransaction(pool, (client) => seedArticle(client))
  invoiceId = (await seedInvoices(pool)).first
  reference = await reserveAndSend(invoiceId)
})

describe('a payment that reverted onchain', () => {
  it('releases the money only with proof, reopens the invoice, and posts once', async () => {
    const first = await withClient(pool, (client) => reversePayment(client, reference, EVIDENCE))
    const again = await withClient(pool, (client) => reversePayment(client, reference, EVIDENCE))

    expect(first.kind).toBe('reversed')
    expect(again.kind).toBe('already-reversed')
    // §6's 10,000 / 0. Partner debt does not move: the invoice is still owed.
    expect(await balanceOf(pool, ACCOUNTS.treasuryAvailable)).toBe(toMinor(10_000))
    expect(await balanceOf(pool, ACCOUNTS.treasuryReserved)).toBe(0n)
    expect(await balanceOf(pool, ACCOUNTS.partnerPayable)).toBe(toMinor(1_000))

    const state = await pool.query(
      `SELECT pm.status, pm.failure_reason, p.status AS invoice, p.payment_reference,
              (SELECT count(*) FROM ledger_transactions WHERE kind = 'reversal') AS reversals,
              (SELECT proof FROM ledger_transactions WHERE kind = 'reversal' AND reference = pm.reference) AS proof,
              (SELECT count(*) FROM audit_log WHERE subject_id = pm.reference AND event = 'failed') AS failed,
              (SELECT count(*) FROM audit_log WHERE subject_id = pm.reference AND event = 'released') AS released,
              (SELECT count(*) FROM audit_log WHERE subject_id = p.id::text AND event = 'reopened') AS reopened
         FROM payments pm JOIN payables p ON p.id = pm.payable_id
        WHERE pm.reference = $1`,
      [reference],
    )
    expect(state.rows[0]).toMatchObject({
      status: 'FAILED',
      failure_reason: 'reverted',
      invoice: 'OPEN',
      payment_reference: null,
      reversals: '1',
      proof: { txHash: EVIDENCE.txHash, blockNumber: EVIDENCE.blockNumber },
      failed: '1',
      released: '1',
      reopened: '1',
    })

    // Payable again: a new key on the same invoice reserves its money once more.
    const retry = await withClient(pool, (client) => inTransaction(client, () => createPayment(client, { idempotencyKey: 'key-2', payableId: invoiceId })))
    expect(retry.kind === 'recorded' && retry.payment.status).toBe('RESERVED')
  })
})

/** RESERVED through the api's door, then what `sign` and `execute` leave on the row: SENT with its hash. */
async function reserveAndSend(payableId: string): Promise<string> {
  const outcome = await withClient(pool, (client) => inTransaction(client, () => createPayment(client, { idempotencyKey: 'key-1', payableId })))
  if (outcome.kind !== 'recorded' || outcome.payment.status !== 'RESERVED') {
    throw new Error(`expected a RESERVED payment, got ${outcome.kind}`)
  }
  await pool.query(`UPDATE payments SET status = 'SENT', tx_hash = $2, signed_tx = '0x02', nonce = 11 WHERE reference = $1`, [
    outcome.payment.reference,
    EVIDENCE.txHash,
  ])
  return outcome.payment.reference
}
