import {
  ACCOUNTS,
  InsufficientFunds,
  NotZeroSum,
  writeTransaction,
  withLedgerTransaction,
} from '@payments/ledger'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { balanceOf, resetDatabase, testPool, withClient } from './helpers/database'

/**
 * Three of the four guards in `migrations/0002_ledger.sql`, each violated on purpose (the fourth, the release rule, is tested in T-07).
 *
 * Every guard is tried through raw SQL as the application role, not only through the posting
 * engine: a guarantee that holds for well-behaved callers only is not a guarantee. The
 * article claims the books cannot be unbalanced, cannot be edited and cannot go negative —
 * these are those three claims, executable.
 */

const USDC = 'USDC'
/** A fixture amount in minor units (500 USDC). The article's own figures belong to the seed. */
const SEEDED = 500_000_000n

const pool = testPool()

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await resetDatabase(pool)
})

/** Puts money in the treasury the way every other posting does: through the engine. */
async function seedTreasury(amount: bigint): Promise<void> {
  await withLedgerTransaction(pool, (client) =>
    writeTransaction(client, {
      kind: 'seed',
      currency: USDC,
      entries: [
        { account: ACCOUNTS.treasuryAvailable, direction: 'debit', amount },
        { account: ACCOUNTS.equityOpening, direction: 'credit', amount },
      ],
    }),
  )
}

describe('the ledger guards', () => {
  it('refuses a transaction whose debits and credits do not cancel out, at COMMIT', async () => {
    await withClient(pool, async (client) => {
      await client.query('BEGIN')
      const transaction = await client.query<{ id: string }>(
        `INSERT INTO ledger_transactions (kind, currency) VALUES ('seed', $1) RETURNING id`,
        [USDC],
      )
      // The INSERT is accepted: a transaction's entries arrive one row at a time and are
      // legitimately unbalanced in between, which is why the guard is DEFERRED.
      await client.query(
        `INSERT INTO ledger_entries (transaction_id, account_code, direction, amount_minor, currency)
         VALUES ($1, $2, 'debit', $3, $4)`,
        [transaction.rows[0]?.id, ACCOUNTS.treasuryAvailable, SEEDED.toString(), USDC],
      )

      await expect(client.query('COMMIT')).rejects.toThrow(/must cancel out/)
      await client.query('ROLLBACK').catch(() => undefined)
    })

    expect(await countRows('ledger_entries')).toBe(0)
    expect(await balanceOf(pool, ACCOUNTS.treasuryAvailable)).toBe(0n)

    // The engine says the same thing earlier and better: before writing, naming the gap.
    const refusal = await withLedgerTransaction(pool, (client) =>
      writeTransaction(client, {
        kind: 'seed',
        currency: USDC,
        entries: [
          { account: ACCOUNTS.treasuryAvailable, direction: 'debit', amount: 700n },
          { account: ACCOUNTS.equityOpening, direction: 'credit', amount: 500n },
        ],
      }),
    ).catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(NotZeroSum)
    expect((refusal as NotZeroSum).imbalance).toBe(200n)
    expect(await countRows('ledger_transactions')).toBe(0)

    // And it refuses to post at all without a transaction to be deferred until: in autocommit
    // the transaction row would commit on its own, the first entry would trip the guard, and
    // the append-only trigger would make that orphan impossible to delete.
    const outside = await withClient(pool, (client) =>
      writeTransaction(client, {
        kind: 'seed',
        currency: USDC,
        entries: [
          { account: ACCOUNTS.treasuryAvailable, direction: 'debit', amount: SEEDED },
          { account: ACCOUNTS.equityOpening, direction: 'credit', amount: SEEDED },
        ],
      }),
    ).catch((error: unknown) => error)

    expect((outside as Error).message).toMatch(/must run inside a transaction/)
    expect(await countRows('ledger_transactions')).toBe(0)
  })

  it('refuses to edit or delete a posted entry, and says to post a correction instead', async () => {
    await seedTreasury(SEEDED)

    await expect(pool.query('UPDATE ledger_entries SET amount_minor = 1')).rejects.toThrow(
      /append-only: UPDATE on ledger_entries.*Post a correcting transaction instead/s,
    )
    await expect(pool.query('DELETE FROM ledger_entries')).rejects.toThrow(/append-only: DELETE/)
    await expect(pool.query('DELETE FROM ledger_transactions')).rejects.toThrow(/append-only: DELETE/)

    // History is intact and the balance still says what the entries say.
    expect(await countRows('ledger_entries')).toBe(2)
    expect(await balanceOf(pool, ACCOUNTS.treasuryAvailable)).toBe(SEEDED)
  })

  it('refuses to take an account that may not go negative below zero', async () => {
    await seedTreasury(SEEDED)

    // Through the engine, under the row lock, with the numbers the API shows in the race.
    const refusal = await withLedgerTransaction(pool, (client) =>
      writeTransaction(client, {
        kind: 'reserve',
        reference: 'PAY-0001',
        currency: USDC,
        entries: [
          { account: ACCOUNTS.treasuryReserved, direction: 'debit', amount: SEEDED + 1n },
          { account: ACCOUNTS.treasuryAvailable, direction: 'credit', amount: SEEDED + 1n },
        ],
      }),
    ).catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(InsufficientFunds)
    expect((refusal as InsufficientFunds).account).toBe(ACCOUNTS.treasuryAvailable)
    expect((refusal as InsufficientFunds).requested).toBe(SEEDED + 1n)
    expect((refusal as InsufficientFunds).available).toBe(SEEDED)

    // And through raw SQL, which never met the engine: this is the CHECK, not the lock.
    await expect(
      pool.query(`UPDATE ledger_accounts SET balance_minor = -1 WHERE code = $1`, [ACCOUNTS.treasuryAvailable]),
    ).rejects.toThrow(/ledger_accounts_balance_never_negative/)

    expect(await balanceOf(pool, ACCOUNTS.treasuryAvailable)).toBe(SEEDED)

    // An account that is meant to go negative still can: the rule is per account, not global.
    await pool.query(`UPDATE ledger_accounts SET balance_minor = -1 WHERE code = $1`, [ACCOUNTS.partnerPayable])
    expect(await balanceOf(pool, ACCOUNTS.partnerPayable)).toBe(-1n)
  })
})

async function countRows(table: 'ledger_entries' | 'ledger_transactions'): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`)
  return Number(result.rows[0]?.count)
}
