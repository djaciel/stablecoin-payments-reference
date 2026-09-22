import { inTransaction } from '@payments/db'
import { ACCOUNTS, seedArticle, toMinor, withLedgerTransaction } from '@payments/ledger'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPayment } from '../../apps/api/src/payments/create-payment'
import { resumePayment } from '../../apps/api/src/payments/resume-payment'
import { escalatePayment } from '../../apps/worker/src/escalate'
import { reversePayment } from '../../apps/worker/src/reverse'
import { balanceOf, resetDatabase, seedInvoices, testPool, withClient } from './helpers/database'

/**
 * §6 on the books, against real Postgres: what happens to the money when a payment fails after it
 * was reserved. A final revert is proof it did not land, so the money comes back and the invoice
 * reopens. Without proof either way the payment goes to REVIEW, and nothing moves, there or back.
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

describe('a payment with no proof either way', () => {
  it('goes to REVIEW and back on resume, and leaves Reserved untouched', async () => {
    const escalation = {
      step: 'watch',
      retryState: 'MAXIMUM_ATTEMPTS_REACHED',
      attempts: 5,
      lastError: 'the node did not answer (failure injection: node not responding is armed for watch)',
    }
    const first = await withClient(pool, (client) => escalatePayment(client, reference, escalation))
    const again = await withClient(pool, (client) => escalatePayment(client, reference, escalation))

    expect(first).toEqual({ kind: 'escalated', fromStatus: 'SENT' })
    expect(again).toEqual({ kind: 'nothing-to-escalate', status: 'REVIEW' })
    // §6's REVIEW row: 9,000 / 1,000, as after the reserve. The invoice is still owed.
    expect(await balanceOf(pool, ACCOUNTS.treasuryAvailable)).toBe(toMinor(9_000))
    expect(await balanceOf(pool, ACCOUNTS.treasuryReserved)).toBe(toMinor(1_000))
    expect(await balanceOf(pool, ACCOUNTS.partnerPayable)).toBe(toMinor(1_000))

    const state = await pool.query(
      `SELECT pm.status, pm.review_from_status, p.status AS invoice, p.payment_reference,
              (SELECT array_agg(kind ORDER BY kind) FROM ledger_transactions WHERE kind <> 'seed') AS postings,
              (SELECT count(*) FROM audit_log WHERE subject_id = pm.reference AND event = 'escalated') AS escalated,
              (SELECT context FROM audit_log WHERE subject_id = pm.reference AND event = 'escalated') AS context
         FROM payments pm JOIN payables p ON p.id = pm.payable_id
        WHERE pm.reference = $1`,
      [reference],
    )
    expect(state.rows[0]).toMatchObject({
      status: 'REVIEW',
      review_from_status: 'SENT',
      invoice: 'PAYING',
      payment_reference: reference,
      postings: ['reserve'],
      escalated: '1',
      // "Escalates to manual review with all the context" (§9).
      context: { fromStatus: 'SENT', step: 'watch', attempts: 5, lastError: escalation.lastError, txHash: EVIDENCE.txHash, nonce: 11 },
    })

    // Resumed (§9): back to where it was, for its workflow to look for the proof again. Once only.
    const resumed = await withClient(pool, (client) => inTransaction(client, () => resumePayment(client, reference)))
    const resumedAgain = await withClient(pool, (client) => inTransaction(client, () => resumePayment(client, reference)))

    expect(resumed.kind === 'resumed' && resumed.payment.status).toBe('SENT')
    expect(resumedAgain).toEqual({ kind: 'not-in-review', status: 'SENT' })
    expect(await balanceOf(pool, ACCOUNTS.treasuryAvailable)).toBe(toMinor(9_000))
    expect(await balanceOf(pool, ACCOUNTS.treasuryReserved)).toBe(toMinor(1_000))
    expect(await balanceOf(pool, ACCOUNTS.partnerPayable)).toBe(toMinor(1_000))

    const back = await pool.query(
      `SELECT pm.status, pm.review_from_status,
              (SELECT array_agg(kind ORDER BY kind) FROM ledger_transactions WHERE kind <> 'seed') AS postings,
              (SELECT count(*) FROM audit_log WHERE subject_id = pm.reference AND event = 'resumed') AS resumed,
              (SELECT context FROM audit_log WHERE subject_id = pm.reference AND event = 'resumed') AS context
         FROM payments pm
        WHERE pm.reference = $1`,
      [reference],
    )
    expect(back.rows[0]).toMatchObject({ status: 'SENT', review_from_status: null, postings: ['reserve'], resumed: '1', context: { to: 'SENT' } })
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
