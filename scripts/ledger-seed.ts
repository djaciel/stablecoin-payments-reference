import { type Pool, createPool, readDatabaseUrl } from '@payments/db'
import {
  ACCOUNTS,
  type AccountBalance,
  CANONICAL_PARTNER_DEBT,
  formatMinor,
  getBalances,
  reserve,
  seedCanonical,
  seedRaceScenario,
  settle,
  withLedgerTransaction,
} from '@payments/ledger'

/**
 * Puts the article's numbers into the books and prints them.
 *
 *   pnpm ledger:seed                Available 10,000 / Reserved 0 / Partner debt 1,000 (§5, §7)
 *   pnpm ledger:seed --walkthrough  that position, then after the reserve (§5), then after the settle (§7)
 *   pnpm ledger:seed --race         Available 1,500, the opening position of §9's race
 *
 * THIS COMMAND DESTROYS WHAT IS IN THE LEDGER. It is a fixture for a demo database, so every
 * run empties `ledger_transactions` and `ledger_entries` first and puts the balances back to
 * zero — otherwise a second run would double the figures, since seeds carry no reference and
 * nothing stops them from being posted twice. It is also why it refuses to run against any
 * database but the demo ones.
 */

/** Databases this script is allowed to empty. Anything else is somebody's real data. */
const DEMO_DATABASES = ['payments', 'payments_test']

/** The article's display names, in the article's order. */
const DISPLAYED = [
  [ACCOUNTS.treasuryAvailable, 'Available'],
  [ACCOUNTS.treasuryReserved, 'Reserved'],
  [ACCOUNTS.partnerPayable, 'Partner debt'],
] as const
// `equity:opening` is deliberately absent: it is the internal counterpart that lets a seed
// balance, and it appears nowhere in the published text.

/** The payment the article follows, and the amount it follows it with. */
const REFERENCE = 'PAY-4821'
const PAYMENT = CANONICAL_PARTNER_DEBT
const USDC = 'USDC'

type Mode = 'opening' | 'walkthrough' | 'race'

const MODES: Record<string, Mode> = {
  '--walkthrough': 'walkthrough',
  '--race': 'race',
}

async function main(): Promise<void> {
  const mode = readMode(process.argv.slice(2))
  assertDemoDatabase()

  const pool = createPool()
  try {
    await resetLedger(pool)

    if (mode === 'race') {
      await withLedgerTransaction(pool, (client) => seedRaceScenario(client))
      header('race scenario (§9): 1,500 is enough for one payment of 1,000 and not for two')
      snapshot(await position(pool))
      return
    }

    await withLedgerTransaction(pool, (client) => seedCanonical(client))
    if (mode === 'opening') {
      header('canonical opening position (§5, §7)')
      snapshot(await position(pool))
      return
    }

    header(`the article's walkthrough: ${REFERENCE} for ${formatMinor(PAYMENT)} ${USDC}`)
    snapshot(await position(pool), 'Opening position (§5, §7)')

    await withLedgerTransaction(pool, (client) =>
      reserve(client, { reference: REFERENCE, amount: PAYMENT, currency: USDC }),
    )
    snapshot(await position(pool), 'After reserving (§5) — the money is set aside before anything is signed')

    await withLedgerTransaction(pool, (client) =>
      settle(client, { reference: REFERENCE, amount: PAYMENT, currency: USDC }),
    )
    snapshot(await position(pool), 'After settling (§7) — the transfer is confirmed, so the debt goes with it')
  } finally {
    await pool.end()
  }
}

function readMode(args: readonly string[]): Mode {
  const [flag, ...rest] = args
  if (flag === undefined) {
    return 'opening'
  }
  const mode = MODES[flag]
  if (mode === undefined || rest.length > 0) {
    throw new Error(`takes one flag at most (--walkthrough or --race) and does not understand: ${args.join(' ')}`)
  }
  return mode
}

/**
 * Refuses to run anywhere but the demo databases, before a single statement is sent.
 *
 * The reset below removes EVERY ledger transaction in the database it is pointed at, not only
 * the ones this script wrote, and CASCADE empties whatever references them. A DATABASE_URL
 * left over from something real must not be one habit away from that.
 */
function assertDemoDatabase(): void {
  const database = new URL(readDatabaseUrl()).pathname.replace(/^\//, '')
  if (DEMO_DATABASES.includes(database)) {
    return
  }
  throw new Error(
    `refusing to seed the database "${database}": ledger:seed empties the ledger before it seeds, ` +
      `and it only does that to the demo databases (${DEMO_DATABASES.join(', ')}). ` +
      'Point DATABASE_URL at one of them.',
  )
}

/**
 * Empties the ledger, so the figures below are this run's and nobody else's.
 *
 * TRUNCATE rather than reversal entries: this is a fixture command for a demo database, and
 * pretending a fixture reset is an accounting event would teach the wrong lesson. It also does
 * not fire the append-only triggers, which is the only reason the ledger can be emptied at
 * all. `ledger_accounts` keeps its rows — the chart of accounts comes from the migration —
 * and only its balances go back to zero.
 *
 * These two statements are the test harness's `resetDatabase` minus the part that truncates
 * every other table: sharing that one would mean a script importing from `tests/`, and would
 * mean this command wiping the payments and partners of the very demo it is seeding.
 */
async function resetLedger(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE ledger_entries, ledger_transactions RESTART IDENTITY CASCADE')
  await pool.query('UPDATE ledger_accounts SET balance_minor = 0')
}

/** The books as they stand, read on their own connection once the writes have committed. */
async function position(pool: Pool): Promise<Map<string, AccountBalance>> {
  const client = await pool.connect()
  try {
    const balances = await getBalances(client)
    return new Map(balances.map((balance) => [balance.code, balance]))
  } finally {
    client.release()
  }
}

function header(title: string): void {
  console.log(`\nledger:seed  ${title}\n`)
}

/** Available / Reserved / Partner debt, in whole USDC and in the minor units the ledger holds. */
function snapshot(balances: Map<string, AccountBalance>, title?: string): void {
  const indent = title === undefined ? '  ' : '    '
  if (title !== undefined) {
    console.log(`  ${title}`)
  }
  for (const [code, name] of DISPLAYED) {
    const balance = balances.get(code)
    if (balance === undefined) {
      continue
    }
    console.log(
      `${indent}${name.padEnd(13)} ${formatMinor(balance.balanceMinor).padStart(14)} ${balance.currency}` +
        `   (${balance.balanceMinor} minor units)`,
    )
  }
  console.log('')
}

main().catch((error: unknown) => {
  console.error(`\nledger:seed  ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
})
