import type { SignedTransaction, TransactionToSign } from '@payments/chain'
import { inTransaction } from '@payments/db'
import { ACCOUNTS, seedExample, toMinor, withLedgerTransaction } from '@payments/ledger'
import { keccak256, type Hex } from 'viem'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { cancelPayment } from '../../apps/api/src/payments/cancel-payment'
import { createPayment } from '../../apps/api/src/payments/create-payment'
import { signPayment } from '../../apps/worker/src/sign'
import { balanceOf, barrier, resetDatabase, seedInvoices, testPool, withClient } from './helpers/database'

/**
 * Invariant 5's second door, against real Postgres: reserved money goes back to available with no
 * chain proof ONLY while no signed bytes exist, because that absence is the proof: no node can
 * include what was never signed.
 *
 * The condition is read under `SELECT … FROM payments WHERE reference = $1 FOR UPDATE`, the lock
 * `signPayment` holds across the signer call, so the two cannot interleave. The last two tests are
 * that claim from both ends: cancel first leaves `sign` with nothing to do, and run at the same
 * instant one of them wins, whichever it is, with the loser writing nothing.
 */

/** What step 2 would have read from the chain. Nothing is broadcast here. */
const CHAIN_READS = { gas: 72_000n, maxFeePerGas: 12_000_000n, maxPriorityFeePerGas: 1_000_000n }
const RACE_RUNS = 5

const pool = testPool()
let invoiceId: string
let reference: string

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  ;({ invoiceId, reference } = await reserveAPayment('key-1'))
})

describe('cancelling a payment', () => {
  it('gives the money back when nothing was signed, and the invoice is payable again', async () => {
    const cancelled = await withClient(pool, (client) => inTransaction(client, () => cancelPayment(client, reference)))

    expect(cancelled.kind === 'cancelled' && cancelled.payment.status).toBe('FAILED')
    expect(cancelled.kind === 'cancelled' && cancelled.payment.reason).toBe('cancelled')
    // The opening figures again, reached with nothing onchain to point at. Partner debt
    // does not move: the invoice is still owed, and an invoice is not a payment.
    expect(await balanceOf(pool, ACCOUNTS.treasuryAvailable)).toBe(toMinor(10_000))
    expect(await balanceOf(pool, ACCOUNTS.treasuryReserved)).toBe(0n)
    expect(await balanceOf(pool, ACCOUNTS.partnerPayable)).toBe(toMinor(1_000))

    const state = await pool.query(
      `SELECT pm.status, pm.failure_reason, pm.tx_hash, p.status AS invoice, p.payment_reference,
              (SELECT count(*) FROM ledger_transactions WHERE kind = 'cancel') AS cancels,
              (SELECT proof FROM ledger_transactions WHERE kind = 'cancel' AND reference = pm.reference) AS proof,
              (SELECT count(*) FROM audit_log WHERE subject_id = pm.reference AND event = 'failed') AS failed,
              (SELECT count(*) FROM audit_log WHERE subject_id = pm.reference AND event = 'released') AS released,
              (SELECT count(*) FROM audit_log WHERE subject_id = p.id::text AND event = 'reopened') AS reopened
         FROM payments pm JOIN payables p ON p.id = pm.payable_id
        WHERE pm.reference = $1`,
      [reference],
    )
    expect(state.rows[0]).toMatchObject({
      status: 'FAILED',
      failure_reason: 'cancelled',
      tx_hash: null,
      invoice: 'OPEN',
      payment_reference: null,
      cancels: '1',
      // The column a reversal fills. Empty here, which is the whole difference between the doors.
      proof: null,
      failed: '1',
      released: '1',
      reopened: '1',
    })

    const written = await rowCounts()
    const again = await withClient(pool, (client) => inTransaction(client, () => cancelPayment(client, reference)))
    expect(again).toEqual({ kind: 'not-cancellable', status: 'FAILED' })
    expect(await rowCounts()).toEqual(written)

    // Payable again, like a reversal leaves it: a NEW key on the same invoice reserves its money.
    const retry = await withClient(pool, (client) =>
      inTransaction(client, () => createPayment(client, { idempotencyKey: 'key-2', payableId: invoiceId })),
    )
    expect(retry.kind === 'recorded' && retry.payment.status).toBe('RESERVED')
  })

  it('refuses a payment whose transaction is already signed, and writes nothing at all', async () => {
    await withClient(pool, (client) => signPayment(client, { reference, pendingNonce: 4, ...CHAIN_READS }, signStub))
    const written = await rowCounts()

    const refused = await withClient(pool, (client) => inTransaction(client, () => cancelPayment(client, reference)))

    expect(refused).toEqual({ kind: 'signed-already' })
    expect(await rowCounts()).toEqual(written)
    // The hold is untouched, which is the point: those bytes can still land.
    expect(await balanceOf(pool, ACCOUNTS.treasuryReserved)).toBe(toMinor(1_000))
    expect(await balanceOf(pool, ACCOUNTS.treasuryAvailable)).toBe(toMinor(9_000))
    const state = await pool.query(
      'SELECT pm.status, p.status AS invoice FROM payments pm JOIN payables p ON p.id = pm.payable_id WHERE pm.reference = $1',
      [reference],
    )
    expect(state.rows[0]).toMatchObject({ status: 'RESERVED', invoice: 'PAYING' })
  })

  it('leaves nothing to sign once it has been cancelled: no hash, no nonce, no signer call', async () => {
    await withClient(pool, (client) => inTransaction(client, () => cancelPayment(client, reference)))

    let asked = 0
    const counted = (transaction: TransactionToSign): Promise<SignedTransaction> => {
      asked += 1
      return signStub(transaction)
    }
    const outcome = await withClient(pool, (client) =>
      signPayment(client, { reference, pendingNonce: 4, ...CHAIN_READS }, counted),
    )

    // The direction that costs money: signing after the hold was released would burn a treasury
    // nonce on a FAILED payment, and every payout signed after it would wait behind that nonce.
    expect(outcome).toEqual({ kind: 'not-reserved', status: 'FAILED' })
    expect(asked).toBe(0)
    const stored = await pool.query('SELECT tx_hash, signed_tx, nonce FROM payments WHERE reference = $1', [reference])
    expect(stored.rows[0]).toEqual({ tx_hash: null, signed_tx: null, nonce: null })
  })

  it('lets sign or cancel win when they run at the same instant, never both and never neither', async () => {
    for (let run = 1; run <= RACE_RUNS; run += 1) {
      const race = await reserveAPayment(`key-race-${String(run)}`)
      // Both transactions are open before either takes the payment's row lock, so one waits.
      const startTogether = barrier(2)
      const signing = withClient(pool, (client) =>
        inTransaction(client, async () => {
          await startTogether()
          return signPayment(client, { reference: race.reference, pendingNonce: 4, ...CHAIN_READS }, signStub)
        }),
      )
      const cancelling = withClient(pool, (client) =>
        inTransaction(client, async () => {
          await startTogether()
          return cancelPayment(client, race.reference)
        }),
      )
      // A deadlock (40P01) would reject one of these instead of returning an outcome.
      const [signOutcome, cancelOutcome] = await Promise.all([signing, cancelling])

      const signWon = signOutcome.kind === 'signed'
      const cancels = await countTransactions('cancel')
      const stored = await pool.query<{ tx_hash: string | null }>('SELECT tx_hash FROM payments WHERE reference = $1', [
        race.reference,
      ])
      // Exactly one of the two happened: a signed transaction, or a release of its money.
      expect([stored.rows[0]?.tx_hash !== null, cancels === 1]).toEqual([signWon, !signWon])

      if (signWon) {
        expect(cancelOutcome).toEqual({ kind: 'signed-already' })
        expect(await balanceOf(pool, ACCOUNTS.treasuryReserved)).toBe(toMinor(1_000))
      } else {
        expect(cancelOutcome.kind).toBe('cancelled')
        expect(signOutcome).toMatchObject({ kind: 'not-reserved', status: 'FAILED' })
        expect(await balanceOf(pool, ACCOUNTS.treasuryReserved)).toBe(0n)
      }
    }
  })
})

/** A fresh ledger, one invoice and its payment RESERVED through the api's own door. */
async function reserveAPayment(idempotencyKey: string): Promise<{ invoiceId: string; reference: string }> {
  await resetDatabase(pool)
  await withLedgerTransaction(pool, (client) => seedExample(client))
  const { first } = await seedInvoices(pool)
  const outcome = await withClient(pool, (client) =>
    inTransaction(client, () => createPayment(client, { idempotencyKey, payableId: first })),
  )
  if (outcome.kind !== 'recorded' || outcome.payment.status !== 'RESERVED') {
    throw new Error(`expected a RESERVED payment, got ${outcome.kind}`)
  }
  return { invoiceId: first, reference: outcome.payment.reference }
}

/**
 * Bytes whose hash names them, which is all `signPayment` checks. Real signatures are
 * `signing.db.test.ts`'s business; these tests are about the lock.
 */
function signStub(transaction: TransactionToSign): Promise<SignedTransaction> {
  const signedTransaction = `0x02${transaction.nonce.toString(16).padStart(64, '0')}` as Hex
  return Promise.resolve({ hash: keccak256(signedTransaction), signedTransaction })
}

/** Everything a refused cancel must leave exactly as it found it. */
async function rowCounts(): Promise<Record<string, string>> {
  const result = await pool.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM audit_log) AS audit,
            (SELECT count(*) FROM ledger_transactions) AS transactions,
            (SELECT count(*) FROM ledger_entries) AS entries`,
  )
  return result.rows[0] ?? {}
}

async function countTransactions(kind: string): Promise<number> {
  const result = await pool.query<{ count: string }>('SELECT count(*) AS count FROM ledger_transactions WHERE kind = $1', [
    kind,
  ])
  return Number(result.rows[0]?.count)
}
