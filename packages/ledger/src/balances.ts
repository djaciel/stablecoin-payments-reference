import type { PoolClient } from '@payments/db'
import type { AccountBalance, AccountCode } from './types'

/**
 * Every account and where it stands. It reads the maintained balance rather than summing the
 * entries at query time: that figure is the one the `CHECK` constraint guards, so it is the one
 * a caller must see. Whether it still agrees with the entries is the invariant suite's question.
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
