import { type PoolClient, inTransaction } from '@payments/db'
import { toMinor } from './money'
import { postTransaction } from './post'
import { ACCOUNTS, type MinorUnits } from './types'

/**
 * The opening positions the article prints, posted as real ledger transactions.
 *
 * Nothing here writes a balance directly. A seed is a `kind = 'seed'` transaction like any
 * other — balanced, locked and checked by the same engine — because a ledger that can be
 * bootstrapped by an UPDATE is a ledger whose balances are a suggestion.
 *
 * These numbers are ARTICLE AND EXPERIMENT FIXTURES ONLY. In the demo the books are
 * chain-true: treasury funding is posted at the amounts actually observed onchain (Phase 6),
 * not at a round number chosen for a paragraph.
 *
 * Seeds carry no reference, so running one twice doubles the balances rather than being
 * refused. That is why `pnpm ledger:seed` empties the ledger before it seeds, and why the
 * database tests reset between tests.
 */

const USDC = 'USDC'

/** §5's Available 10,000. */
export const CANONICAL_TREASURY: MinorUnits = toMinor(10_000)
/** §7's Partner debt 1,000, which is also the payment the whole walkthrough follows. */
export const CANONICAL_PARTNER_DEBT: MinorUnits = toMinor(1_000)
/** §9's race starts here: enough for one payment of 1,000 and not for two. */
export const RACE_TREASURY: MinorUnits = toMinor(1_500)

/**
 * The article's opening position: Available 10,000 and Partner debt 1,000 (§5, §7).
 * Used by the walkthrough and by every experiment that is not the race.
 */
export async function seedCanonical(client: PoolClient): Promise<void> {
  // Both postings or neither: an opening position with the funding but not the debt would be
  // a position the article never describes. It opens its own transaction only when the caller
  // has not, so a seed can be the whole unit of work or part of a bigger one.
  await inTransaction(client, async () => {
    await fundTreasury(client, CANONICAL_TREASURY)
    await accruePartnerDebt(client, CANONICAL_PARTNER_DEBT)
  })
}

/**
 * The race's own opening position: `treasury:available` = 1,500, which is enough for one
 * payment of 1,000 and not for two. The canonical number for §9, and the reason that
 * experiment does not reuse the 10,000 seed.
 */
export async function seedRaceScenario(client: PoolClient): Promise<void> {
  await inTransaction(client, async () => {
    await fundTreasury(client, RACE_TREASURY)
    await accruePartnerDebt(client, CANONICAL_PARTNER_DEBT)
  })
}

/** Dr `treasury:available` / Cr `equity:opening`: money arrives from nowhere, once. */
async function fundTreasury(client: PoolClient, amount: MinorUnits): Promise<void> {
  await postTransaction(client, {
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
 * partner in the first place, compressed into one entry pair so §7 has a debt to clear.
 */
async function accruePartnerDebt(client: PoolClient, amount: MinorUnits): Promise<void> {
  await postTransaction(client, {
    kind: 'seed',
    currency: USDC,
    entries: [
      { account: ACCOUNTS.equityOpening, direction: 'debit', amount },
      { account: ACCOUNTS.partnerPayable, direction: 'credit', amount },
    ],
  })
}
