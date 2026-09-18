import { type Pool, createPool, readDatabaseUrl } from '@payments/db'
import {
  ACCOUNTS,
  type AccountBalance,
  ARTICLE_PARTNER_DEBT,
  ARTICLE_TREASURY,
  cancel,
  formatMinor,
  getBalances,
  reserve,
  reversal,
  seedArticle,
  seedRace,
  settle,
  withLedgerTransaction,
} from '@payments/ledger'

/**
 * Puts the article's numbers into the books and prints them.
 *
 *   pnpm ledger:seed                     Available 10,000 / Reserved 0 / Partner debt 1,000 (§5, §7)
 *   pnpm ledger:seed --walkthrough       that position, then after the reserve (§5), then after the settle (§7)
 *   pnpm ledger:seed --race              Available 1,500, the opening position of §9's race
 *   pnpm ledger:seed --release=reversal  reserve, then the transfer reverts onchain (§6): Available back to 10,000
 *   pnpm ledger:seed --release=cancel    reserve, then cancel before signing: the same figures, no chain proof
 *
 * THIS COMMAND DESTROYS WHAT IS IN THE LEDGER. It is a fixture for a demo database, so every
 * run empties `ledger_transactions`, `ledger_entries` and `audit_log` first and puts the
 * balances back to zero — otherwise a second run would double the figures, since seeds carry
 * no reference and nothing stops them from being posted twice. It is also why it refuses to
 * run against any database but the demo ones.
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
const PAYMENT = ARTICLE_PARTNER_DEBT
const USDC = 'USDC'

/**
 * Proof that the transfer reverted, for the `--release=reversal` run. A FIXTURE: this hash
 * exists in no block anywhere. The real thing comes from the receipt the worker read, and
 * whether the hash really reverted where it says is checked by reconciliation (Phase 9).
 */
const REVERTED = {
  txHash: '0x4e8f1c07a4b2b6f9d3e5a1c8b0d7f26a93c45e18b7d2a0f6c1e93b5d8a47f0c62',
  blockNumber: 45_155_022,
  reason: 'execution reverted',
}

/** Why the admin cancelled, for the `--release=cancel` run. */
const CANCEL_REASON = 'the partner invoice was paid by another route'

type Mode = 'opening' | 'walkthrough' | 'race' | 'reversal' | 'cancel'

const MODES: Record<string, Mode> = {
  '--walkthrough': 'walkthrough',
  '--race': 'race',
  '--release=reversal': 'reversal',
  '--release=cancel': 'cancel',
}

async function main(): Promise<void> {
  const mode = readMode(process.argv.slice(2))
  assertDemoDatabase()

  const pool = createPool()
  try {
    await resetLedger(pool)

    if (mode === 'race') {
      await withLedgerTransaction(pool, (client) => seedRace(client))
      header('race scenario (§9): 1,500 is enough for one payment of 1,000 and not for two')
      snapshot(await position(pool))
      return
    }

    await withLedgerTransaction(pool, (client) => seedArticle(client))
    if (mode === 'opening') {
      header('canonical opening position (§5, §7)')
      snapshot(await position(pool))
      return
    }

    if (mode === 'reversal' || mode === 'cancel') {
      await release(pool, mode)
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
    const known = Object.keys(MODES).join(', ')
    throw new Error(`takes one flag at most (${known}) and does not understand: ${args.join(' ')}`)
  }
  return mode
}

/**
 * The two release doors, from the article's opening position: reserve 1,000, then send it
 * back to available — with proof that the transfer reverted, or because nothing was ever
 * signed. Both end where §6 ends: Available 10,000, Reserved 0.
 *
 * What the reader is meant to notice is that the entries are identical. Only the kind and the
 * justification differ, and the database refuses that same movement under any other kind.
 */
async function release(pool: Pool, door: 'reversal' | 'cancel'): Promise<void> {
  header(`the ${door} door: ${REFERENCE} for ${formatMinor(PAYMENT)} ${USDC}`)
  snapshot(await position(pool), 'Opening position (§5, §7)')

  await withLedgerTransaction(pool, (client) =>
    reserve(client, { reference: REFERENCE, amount: PAYMENT, currency: USDC }),
  )
  snapshot(await position(pool), 'After reserving (§5) — the money is set aside')

  await withLedgerTransaction(pool, (client) =>
    door === 'reversal'
      ? reversal(client, { reference: REFERENCE, amount: PAYMENT, currency: USDC, proof: REVERTED })
      : cancel(client, { reference: REFERENCE, amount: PAYMENT, currency: USDC, reason: CANCEL_REASON }),
  )
  snapshot(
    await position(pool),
    door === 'reversal'
      ? 'After the reversal (§6) — the transaction reverted onchain, so the hold is released'
      : 'After the cancel — nothing was ever signed, so the transfer can no longer land',
  )

  await printReleaseReason(pool)
  console.log(`  Available is back at ${formatMinor(ARTICLE_TREASURY)} and Reserved at 0.000000.\n`)
}

/** The audit row the release wrote in the same database transaction as its entries. */
async function printReleaseReason(pool: Pool): Promise<void> {
  const rows = await pool.query<{ actor: string; event: string; context: Record<string, unknown> }>(
    `SELECT actor, event, context FROM audit_log
      WHERE subject_type = 'payment' AND subject_id = $1 ORDER BY id DESC LIMIT 1`,
    [REFERENCE],
  )
  const row = rows.rows[0]
  if (row === undefined) {
    return
  }
  const reason = row.context['reason']
  console.log(`  audit_log  ${row.actor} ${row.event}: ${JSON.stringify(row.context['proof'])}`)
  if (typeof reason === 'string') {
    console.log(`             reason: ${reason}`)
  }
  console.log('')
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
 * `audit_log` is named explicitly because it has no foreign key to the ledger (and should not
 * have one: most of what it records is not a money movement). CASCADE therefore never reaches
 * it, and leaving it behind would give this demo a log narrating releases whose transactions
 * no longer exist — exactly the wart version 1 carried.
 *
 * These statements are the test harness's `resetDatabase` minus the part that truncates every
 * other table: sharing that one would mean a script importing from `tests/`, and would mean
 * this command wiping the payments and partners of the very demo it is seeding.
 */
async function resetLedger(pool: Pool): Promise<void> {
  await pool.query('TRUNCATE ledger_entries, ledger_transactions, audit_log RESTART IDENTITY CASCADE')
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
