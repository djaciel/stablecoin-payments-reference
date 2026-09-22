import { inTransaction } from '@payments/db'
import { ACCOUNTS, seedArticle, toMinor, withLedgerTransaction } from '@payments/ledger'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPayment } from '../../apps/api/src/payments/create-payment'
import { settlePayment } from '../../apps/worker/src/settle'
import { balanceOf, resetDatabase, seedInvoices, testPool, withClient } from './helpers/database'

/**
 * §7's Paid moment on the books, against real Postgres: settling is one transaction that posts
 * once, which is what makes a worker that runs it again after a crash harmless.
 */

/** What `watch` hands `settle`: the first real payout's own numbers. */
const EVIDENCE = {
  txHash: '0x97a4d339d0f1f82f7bde40e64c71fc2ccd8305a7fdde8add2ef2dec407d55751',
  blockNumber: 47131497,
  finalBlock: 47131540,
  logIndex: 56,
}

const pool = testPool()
let reference: string

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await resetDatabase(pool)
  await withLedgerTransaction(pool, (client) => seedArticle(client))
  const { first } = await seedInvoices(pool)
  reference = await reserveAndSend(first)
})

describe('settling a payment', () => {
  it("posts once however often it runs: §7's 9,000 / 0 / 0, the payment SETTLED, the invoice PAID", async () => {
    const first = await withClient(pool, (client) => settlePayment(client, reference, EVIDENCE))
    const again = await withClient(pool, (client) => settlePayment(client, reference, EVIDENCE))

    expect(first.kind).toBe('settled')
    expect(again.kind).toBe('already-settled')
    // Reserved out, Partner debt cleared; Available was reduced at the reserve and does not move.
    expect(await balanceOf(pool, ACCOUNTS.treasuryAvailable)).toBe(toMinor(9_000))
    expect(await balanceOf(pool, ACCOUNTS.treasuryReserved)).toBe(0n)
    expect(await balanceOf(pool, ACCOUNTS.partnerPayable)).toBe(0n)

    const state = await pool.query<{ payment: string; invoice: string; settles: string; audits: string }>(
      `SELECT pm.status AS payment, p.status AS invoice,
              (SELECT count(*) FROM ledger_transactions WHERE kind = 'settle') AS settles,
              (SELECT count(*) FROM audit_log WHERE subject_id = pm.reference AND event = 'settled') AS audits
         FROM payments pm JOIN payables p ON p.id = pm.payable_id
        WHERE pm.reference = $1`,
      [reference],
    )
    expect(state.rows[0]).toEqual({ payment: 'SETTLED', invoice: 'PAID', settles: '1', audits: '1' })
  })
})

/** RESERVED through the api's door, then what `sign` and `execute` leave on the row: SENT with its hash. */
async function reserveAndSend(payableId: string): Promise<string> {
  const outcome = await withClient(pool, (client) => inTransaction(client, () => createPayment(client, { idempotencyKey: 'key-1', payableId })))
  if (outcome.kind !== 'recorded' || outcome.payment.status !== 'RESERVED') {
    throw new Error(`expected a RESERVED payment, got ${outcome.kind}`)
  }
  // The bytes are never read by settle; the table only asks that hash, bytes and nonce come together.
  await pool.query(`UPDATE payments SET status = 'SENT', tx_hash = $2, signed_tx = '0x02', nonce = 4 WHERE reference = $1`, [
    outcome.payment.reference,
    EVIDENCE.txHash,
  ])
  return outcome.payment.reference
}
