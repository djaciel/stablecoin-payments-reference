import type { PoolClient } from '@payments/db'
import type { AccountBalance, AccountCode } from './types'

/**
 * Every account and where it stands, for `pnpm ledger:seed` today and the admin view later.
 *
 * It reads the balance the ledger maintains rather than summing the entries at query time,
 * and that is deliberate: the maintained figure is the one the `CHECK` constraint guards, so
 * it is the one a caller must see. Whether it still agrees with the entries is a question for
 * the invariant suite — a good one, but a test, not a read path.
 *
 * The chart of accounts is fixed by `migrations/0002_ledger.sql`, which is why `code` is
 * typed as one of them: `ACCOUNTS` and that INSERT are the same list.
 */
export async function getBalances(client: PoolClient): Promise<AccountBalance[]> {
  const result = await client.query<{ code: AccountCode; currency: string; balance_minor: string }>(
    'SELECT code, currency, balance_minor FROM ledger_accounts ORDER BY code',
  )
  return result.rows.map((row) => ({
    code: row.code,
    currency: row.currency,
    balanceMinor: BigInt(row.balance_minor),
  }))
}
