import { inTransaction } from '@payments/db'
import {
  ACCOUNTS,
  InsufficientFunds,
  RACE_TREASURY,
  reserve,
  seedRace,
  toMinor,
  withLedgerTransaction,
} from '@payments/ledger'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { balanceOf, barrier, resetDatabase, testPool, withClient } from './helpers/database'

/**
 * The article's §9 race, executable.
 *
 * The treasury holds 1,500. Two payments of 1,000 arrive at the same instant, with different
 * keys. One must be reserved and the other rejected for insufficient funds — never both.
 *
 * What is asserted is the outcome, not the instant in between: an outside observer cannot see
 * a mid-transaction balance, so "Available never goes negative" is carried by the final figure
 * here plus the CHECK constraint that `guards.db.test.ts` violates on purpose.
 */

const USDC = 'USDC'
const PAYMENT = toMinor(1_000)

const pool = testPool()

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await resetDatabase(pool)
})

describe('two payments racing for the same money', () => {
  it('reserves exactly one of them, rejects the other for insufficient funds, and leaves no trace of it', async () => {
    await withLedgerTransaction(pool, (client) => seedRace(client))

    // The latch is what makes this a race. Each attempt opens its own transaction on its own
    // connection and waits here, so both are open and contending for the same account row
    // when the reserve runs — which is the window the lock in the engine closes.
    const startTogether = barrier(2)
    const attempt = (reference: string): Promise<string> =>
      withLedgerTransaction(pool, async (client) => {
        await startTogether()
        return reserve(client, { reference, amount: PAYMENT, currency: USDC })
      })

    const references = ['PAY-0001', 'PAY-0002'] as const
    const outcomes = await Promise.allSettled(references.map(attempt))

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.findIndex((outcome) => outcome.status === 'rejected')
    expect(rejected).toBeGreaterThanOrEqual(0)

    // The engine rejected it, under the lock, with the numbers: `available` is what it read
    // while holding the row, `requested` what the payment asked for. A rejection that came
    // from the database CHECK instead would carry no amounts, and the API could not show the
    // article's message.
    const refusal: unknown = outcomes[rejected]?.status === 'rejected' ? outcomes[rejected].reason : undefined
    expect(refusal).toBeInstanceOf(InsufficientFunds)
    expect((refusal as InsufficientFunds).account).toBe(ACCOUNTS.treasuryAvailable)
    expect((refusal as InsufficientFunds).requested).toBe(PAYMENT)
    expect((refusal as InsufficientFunds).available).toBe(RACE_TREASURY - PAYMENT)

    // §9's figures: 1,500 minus the one payment that fit.
    expect(await balanceOf(pool, ACCOUNTS.treasuryAvailable)).toBe(RACE_TREASURY - PAYMENT)
    expect(await balanceOf(pool, ACCOUNTS.treasuryReserved)).toBe(PAYMENT)
    expect(await countReserves()).toBe(1)

    // And a rejection has to be complete. Entries written before the guard noticed, or a
    // ledger transaction row with nothing under it, would mean the books remember a payment
    // the article says never happened.
    const loser = references[rejected] ?? ''
    expect(await countRowsFor(loser)).toEqual({ transactions: 0, entries: 0 })
  })
})

/**
 * The canary. It does NOT test the ledger — it tests this file's ability to run two things at
 * once at all, using the broken pattern the ledger exists to avoid: read the balance, subtract
 * in application code, write it back, no lock.
 *
 * What proves the concurrency is the pair of `pg_backend_pid()` values: two distinct
 * server-side sessions, both inside open transactions at the same moment, since the barrier
 * cannot release until its second caller has arrived. If those two numbers are ever equal,
 * these tests are running down a single connection, no row can be contended, and every
 * concurrency assertion in this repository is theatre.
 *
 * The lost update that follows (1,500 minus two withdrawals of 1,000 leaving 500, not -500) is
 * the CONSEQUENCE, not the proof: the barrier makes both reads happen before either write, so
 * that arithmetic is arranged rather than observed. It is here because it is precisely the
 * outcome `SELECT … FOR UPDATE` exists to prevent.
 */
describe('canary: the harness itself', () => {
  // If this test times out, the pool could not hand out two connections at once and the
  // barrier never opened. That is the failure this canary exists to make loud, so it gets a
  // short timeout instead of the suite's 30 seconds.
  it('runs two transactions on separate backends, open at the same moment', { timeout: 10_000 }, async () => {
    await pool.query('CREATE TABLE IF NOT EXISTS canary_balance (id int PRIMARY KEY, amount bigint NOT NULL)')
    await pool.query('TRUNCATE canary_balance')
    await pool.query('INSERT INTO canary_balance (id, amount) VALUES (1, $1)', [RACE_TREASURY.toString()])

    const bothHaveRead = barrier(2)
    // `inTransaction` from @payments/db rather than the ledger's own door: this table is not
    // money, and the point is to write it the way the ledger never does.
    const unguardedWithdrawal = (): Promise<number> =>
      withClient(pool, (client) =>
        inTransaction(client, async () => {
          const backend = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
          const read = await client.query<{ amount: string }>('SELECT amount FROM canary_balance WHERE id = 1')
          const seen = BigInt(read.rows[0]?.amount ?? '0')

          // Reaching here means BOTH transactions are open and neither has written: the
          // barrier cannot release until its second caller arrives. This is the window the
          // real ledger closes with SELECT ... FOR UPDATE.
          await bothHaveRead()

          await client.query('UPDATE canary_balance SET amount = $1 WHERE id = 1', [(seen - PAYMENT).toString()])
          return backend.rows[0]?.pid ?? 0
        }),
      )

    const [firstBackend, secondBackend] = await Promise.all([unguardedWithdrawal(), unguardedWithdrawal()])

    // The actual proof of concurrency. Getting past the barrier proves the two transactions
    // were open simultaneously; distinct backend pids prove they are separate server-side
    // sessions rather than one connection used twice.
    expect(
      firstBackend,
      'Both transactions ran on the same Postgres backend, so they cannot contend for a row lock and every concurrency assertion in this repository is theatre. Fix the harness, not the ledger.',
    ).not.toBe(secondBackend)

    // And the consequence, which is why the ledger cannot be written this way: two withdrawals
    // of 1,000 from 1,500 leave 500, not -500. One update was lost.
    const final = await pool.query<{ amount: string }>('SELECT amount FROM canary_balance WHERE id = 1')
    expect(BigInt(final.rows[0]?.amount ?? '0')).toBe(RACE_TREASURY - PAYMENT)

    await pool.query('DROP TABLE canary_balance')
  })
})

async function countReserves(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*) AS count FROM ledger_transactions WHERE kind = 'reserve'`,
  )
  return Number(result.rows[0]?.count)
}

async function countRowsFor(reference: string): Promise<{ transactions: number; entries: number }> {
  const result = await pool.query<{ transactions: string; entries: string }>(
    `SELECT count(DISTINCT t.id) AS transactions, count(e.id) AS entries
       FROM ledger_transactions t
       LEFT JOIN ledger_entries e ON e.transaction_id = t.id
      WHERE t.reference = $1`,
    [reference],
  )
  return { transactions: Number(result.rows[0]?.transactions), entries: Number(result.rows[0]?.entries) }
}
