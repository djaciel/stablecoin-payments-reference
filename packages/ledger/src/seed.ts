import { type PoolClient, inTransaction } from '@payments/db'
import { toMinor } from './money'
import { writeTransaction } from './engine'
import { ACCOUNTS, type MinorUnits } from './types'

/**
 * The opening positions the article prints, posted as real `kind = 'seed'` transactions —
 * balanced, locked and checked by the same engine — because a ledger that can be bootstrapped
 * by an UPDATE is a ledger whose balances are a suggestion. FIXTURES ONLY: in the demo the
 * books are chain-true.
 *
 * Seeds carry no reference, so running one twice doubles the balances rather than being
 * refused. Hence `pnpm ledger:seed` empties the ledger first, and the tests reset between them.
 */

const USDC = 'USDC'

/** §5's Available 10,000. */
export const ARTICLE_TREASURY: MinorUnits = toMinor(10_000)
/** §7's Partner debt 1,000, which is also the payment the whole walkthrough follows. */
export const ARTICLE_PARTNER_DEBT: MinorUnits = toMinor(1_000)
/** §9's race starts here: enough for one payment of 1,000 and not for two. */
export const RACE_TREASURY: MinorUnits = toMinor(1_500)

/** The article's opening position: Available 10,000 and Partner debt 1,000 (§5, §7). */
export async function seedArticle(client: PoolClient): Promise<void> {
  // Both postings or neither: the funding without the debt is a position the article never
  // describes. `inTransaction` opens one only when the caller has not.
  await inTransaction(client, async () => {
    await fundTreasury(client, ARTICLE_TREASURY)
    await accruePartnerDebt(client, ARTICLE_PARTNER_DEBT)
  })
}

/** The race's own opening position (§9): 1,500 is enough for one payment of 1,000, not two. */
export async function seedRace(client: PoolClient): Promise<void> {
  await inTransaction(client, async () => {
    await fundTreasury(client, RACE_TREASURY)
    await accruePartnerDebt(client, ARTICLE_PARTNER_DEBT)
  })
}

/** Dr `treasury:available` / Cr `equity:opening`: money arrives from nowhere, once. */
async function fundTreasury(client: PoolClient, amount: MinorUnits): Promise<void> {
  await writeTransaction(client, {
    kind: 'seed',
    currency: USDC,
    entries: [
      { account: ACCOUNTS.treasuryAvailable, direction: 'debit', amount },
      { account: ACCOUNTS.equityOpening, direction: 'credit', amount },
    ],
  })
}

/**
 * Dr `equity:opening` / Cr `partner:payable`: the billing that made the company owe the
 * partner, compressed into one entry pair so §7 has a debt to clear.
 */
async function accruePartnerDebt(client: PoolClient, amount: MinorUnits): Promise<void> {
  await writeTransaction(client, {
    kind: 'seed',
    currency: USDC,
    entries: [
      { account: ACCOUNTS.equityOpening, direction: 'debit', amount },
      { account: ACCOUNTS.partnerPayable, direction: 'credit', amount },
    ],
  })
}
