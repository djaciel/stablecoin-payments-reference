import {
  ACCOUNTS,
  EXAMPLE_PARTNER_DEBT,
  EXAMPLE_TREASURY,
  type MinorUnits,
  getBalances,
  reserve,
  seedExample,
  settle,
  toMinor,
  withLedgerTransaction,
} from '@payments/ledger'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { resetDatabase, testPool, withClient } from './helpers/database'

/**
 * The example figures, asserted step by step: the same walk `pnpm ledger:seed --walkthrough`
 * prints, checked by a machine. The seed, `vocabulary.test.ts` and this file quote the same
 * figures, so one of them cannot change alone.
 */

const USDC = 'USDC'
const PAYMENT = toMinor(1_000)
const REFERENCE = 'PAY-4821'

const pool = testPool()

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await resetDatabase(pool)
  await withLedgerTransaction(pool, (client) => seedExample(client))
})

describe('the example walkthrough', () => {
  it('opens at Available 10,000, Reserved 0, Partner debt 1,000, posted as two balanced seeds', async () => {
    expect(await position()).toEqual({
      available: EXAMPLE_TREASURY,
      reserved: 0n,
      partnerDebt: EXAMPLE_PARTNER_DEBT,
    })

    // Not written as balances: two `seed` transactions of two entries each, through the same
    // engine as everything else.
    expect(await count(`SELECT count(*) AS count FROM ledger_transactions WHERE kind = 'seed'`)).toBe(2)
    expect(await count('SELECT count(*) AS count FROM ledger_entries')).toBe(4)
  })

  it('reserves then settles: 9,000 / 1,000 / 1,000, then 9,000 / 0 / 0, with the balances still equal to their entries', async () => {
    await withLedgerTransaction(pool, (client) =>
      reserve(client, { reference: REFERENCE, amount: PAYMENT, currency: USDC }),
    )

    // Reserved: the money is no longer available before anything has been signed, and the total did
    // not move.
    expect(await position()).toEqual({
      available: toMinor(9_000),
      reserved: PAYMENT,
      partnerDebt: EXAMPLE_PARTNER_DEBT,
    })

    await withLedgerTransaction(pool, (client) =>
      settle(client, { reference: REFERENCE, amount: PAYMENT, currency: USDC }),
    )

    // Settled: the hold is gone and so is the debt. Available does not move: it was reduced at
    // reserve time.
    expect(await position()).toEqual({
      available: toMinor(9_000),
      reserved: 0n,
      partnerDebt: 0n,
    })

    // And the balances the CHECK constraint guards still say what the entries say: every
    // account, not only the three the screens show.
    expect(await accountsThatDriftedFromTheirEntries()).toEqual([])
  })
})

/** Available / Reserved / Partner debt, read through the ledger's own reader. */
async function position(): Promise<Record<string, MinorUnits>> {
  const balances = await withClient(pool, (client) => getBalances(client))
  const byCode = new Map(balances.map((balance) => [balance.code, balance.balanceMinor]))
  return {
    available: byCode.get(ACCOUNTS.treasuryAvailable) ?? 0n,
    reserved: byCode.get(ACCOUNTS.treasuryReserved) ?? 0n,
    partnerDebt: byCode.get(ACCOUNTS.partnerPayable) ?? 0n,
  }
}

/** Accounts whose maintained `balance_minor` disagrees with the signed sum of their entries. */
async function accountsThatDriftedFromTheirEntries(): Promise<string[]> {
  const result = await pool.query<{ code: string }>(
    `SELECT a.code
       FROM ledger_accounts a
       LEFT JOIN ledger_entries e ON e.account_code = a.code
      GROUP BY a.code, a.balance_minor, a.normal_side
     HAVING a.balance_minor <> coalesce(
              sum(CASE WHEN e.direction = a.normal_side THEN e.amount_minor ELSE -e.amount_minor END), 0)`,
  )
  return result.rows.map((row) => row.code)
}

async function count(sql: string): Promise<number> {
  const result = await pool.query<{ count: string }>(sql)
  return Number(result.rows[0]?.count)
}
