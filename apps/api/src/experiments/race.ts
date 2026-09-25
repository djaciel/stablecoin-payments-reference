import { randomUUID } from 'node:crypto'
import { createPool, inTransaction, migrate, readDatabaseUrl, type Pool, type PoolClient } from '@payments/db'
import type { RaceAttempt, RaceResult } from '@payments/domain'
import { ACCOUNTS, ARTICLE_PARTNER_DEBT, formatMinor, getBalances, seedRace } from '@payments/ledger'
import { createPayment, type PaymentOutcome } from '../payments/create-payment'
import { statusCodeOf } from '../payments/payments.controller'

/**
 * §9's race, with the article's own figures: Available 1,500, two payments of 1,000 fired at the
 * same instant with different keys. One is reserved, the other is refused for insufficient funds,
 * and Available never crosses into negative.
 *
 * It runs against a sandbox database of its own, because Available in the demo is real testnet
 * money and this race needs two payments whose sum exceeds it. The sandbox is
 * created and migrated on demand by the real runner over the real files, and emptied and reseeded
 * on every run, so the figures are the article's every time.
 */

/** Where the race runs, and the only database this endpoint may empty. */
const SANDBOX_DATABASE = 'payments_experiment'

/** §9's two payments. Their sum, 2,000, is what 1,500 cannot cover. */
const PAYMENT = ARTICLE_PARTNER_DEBT

/** The sandbox's one partner, invented here: no seed is derived and no address is ever paid. */
const PARTNER = {
  name: 'Race Logistics',
  depositAddress: '0x5Ace000000000000000000000000000000000001',
  payoutAddress: '0x5Ace000000000000000000000000000000000002',
}

export async function runRace(demo: Pool): Promise<RaceResult> {
  // 1. Where it will run, refused before a statement is sent anywhere.
  const sandboxUrl = sandboxDatabaseUrl()

  // 2 and 3. The sandbox exists and carries the schema that ships.
  await createSandboxDatabase(demo)
  await migrate(sandboxUrl)

  // 4. Its own pool, and nothing else in the api ever gets one.
  const sandbox = createPool(sandboxUrl)
  try {
    // 5. The article's opening position, and the two invoices the race is about.
    const invoices = await resetAndSeed(sandbox)
    const before = await figures(sandbox)

    // 6. The race itself.
    const attempts = await race(sandbox, invoices)

    // 7. What it left behind.
    const after = await figures(sandbox)
    return {
      database: SANDBOX_DATABASE,
      availableBefore: before.available,
      attempts,
      reserves: await countReserves(sandbox),
      availableAfter: after.available,
      reservedAfter: after.reserved,
    }
  } finally {
    await sandbox.end()
  }
}

/**
 * The api's own connection string with the database swapped for the sandbox.
 *
 * The name checked below is a literal and not the constant that built the URL, on purpose: step 5
 * empties every table in the database this is pointed at, and the demo's books would otherwise be
 * one constant away. Point `SANDBOX_DATABASE` at `payments` and this refuses instead of truncating.
 */
function sandboxDatabaseUrl(): string {
  const url = new URL(readDatabaseUrl())
  url.pathname = `/${SANDBOX_DATABASE}`
  const database = url.pathname.replace(/^\//, '')
  if (database !== 'payments_experiment') {
    throw new Error(
      `refusing to run the race against "${database}": it empties the ledger, the payments and the invoices ` +
        'of the database it is pointed at, and it only does that to payments_experiment.',
    )
  }
  return url.toString()
}

/**
 * The only statement this endpoint ever sends to the demo database. `pg_database` is asked first,
 * so a run that finds the sandbox already there sends nothing at all; `42P04` covers two presses
 * arriving at once.
 */
async function createSandboxDatabase(demo: Pool): Promise<void> {
  const existing = await demo.query('SELECT 1 FROM pg_database WHERE datname = $1', [SANDBOX_DATABASE])
  if (existing.rowCount === 1) {
    return
  }
  try {
    // Not a parameter: a database name cannot be one. It is the constant the guard above cleared.
    await demo.query(`CREATE DATABASE ${SANDBOX_DATABASE}`)
  } catch (error) {
    if ((error as { code?: unknown }).code !== '42P04') {
      throw error
    }
  }
}

/**
 * Back to the article's opening position, in one transaction: the ledger, the payments and the
 * invoices emptied (`ledger:seed`'s reset, plus the partners this one writes), then §9's Available
 * 1,500 and two invoices of 1,000 to pay it with.
 *
 * TRUNCATE does not fire the append-only triggers, which is the only reason the ledger can be
 * emptied at all; `ledger_accounts` keeps the chart the migration inserted and only its balances
 * go back to zero.
 */
async function resetAndSeed(sandbox: Pool): Promise<readonly string[]> {
  return withClient(sandbox, (client) =>
    inTransaction(client, async () => {
      await client.query('TRUNCATE allowlist, ledger_entries, ledger_transactions, audit_log, payments, payables, partners RESTART IDENTITY CASCADE')
      await client.query('UPDATE ledger_accounts SET balance_minor = 0')
      await seedRace(client)

      // One partner, two invoices pointing at it, and its payout address on the allowlist the
      // payment door reads: without that row both attempts would be refused before the race.
      const partner = await client.query<{ id: string }>(
        `INSERT INTO partners (name, derivation_index, deposit_address, payout_address)
         VALUES ($1, 1, $2, $3) RETURNING id`,
        [PARTNER.name, PARTNER.depositAddress, PARTNER.payoutAddress],
      )
      await client.query('INSERT INTO allowlist (address, label, partner_id) VALUES ($1, $2, $3)', [
        PARTNER.payoutAddress,
        PARTNER.name,
        partner.rows[0]?.id,
      ])
      const invoices = await client.query<{ id: string }>(
        `INSERT INTO payables (partner_id, destination, amount_minor, description)
         VALUES ($1, $2, $3, 'Race: the first of two'), ($1, $2, $3, 'Race: the second of two') RETURNING id`,
        [partner.rows[0]?.id, PARTNER.payoutAddress, PAYMENT.toString()],
      )
      return invoices.rows.map((row) => row.id)
    }),
  )
}

/**
 * Both payments at the same instant, each on its own connection inside its own transaction, both
 * held at the latch until the other has arrived. There is no dispatch: a sandbox has no chain
 * behind it, so nothing is signed and nothing is sent.
 */
async function race(sandbox: Pool, invoices: readonly string[]): Promise<RaceAttempt[]> {
  const startTogether = barrier(invoices.length)
  return Promise.all(invoices.map((payableId) => attempt(sandbox, payableId, startTogether)))
}

async function attempt(sandbox: Pool, payableId: string, startTogether: () => Promise<void>): Promise<RaceAttempt> {
  return withClient(sandbox, (client) =>
    inTransaction(client, async () => {
      await startTogether()
      // The same function `POST /payments` runs, with a key of its own: these are two payments, not
      // one clicked twice.
      return answerFor(await createPayment(client, { idempotencyKey: randomUUID(), payableId }))
    }),
  )
}

/** What the api would have answered, body and code, from the payment door's own rule. */
function answerFor(outcome: PaymentOutcome): RaceAttempt {
  if (outcome.kind !== 'recorded') {
    throw new Error(`the payment door answered "${outcome.kind}", in a sandbox where every key and every invoice is new`)
  }
  const { reference, amount, status, reason } = outcome.payment
  return { reference, amount, status, reason, code: statusCodeOf(outcome) }
}

/**
 * Holds its callers until `parties` of them have arrived, then releases them all at once. This is
 * what makes "at the same instant" mean something: two connections that merely start together
 * usually end up serialized by chance, and a race that never races proves nothing. Copied from
 * `tests/db/helpers/database.ts`, which is where the same latch proves the same claim.
 */
function barrier(parties: number): () => Promise<void> {
  let arrived = 0
  let release: (() => void) | undefined
  const open = new Promise<void>((resolve) => {
    release = resolve
  })

  return async () => {
    arrived += 1
    if (arrived >= parties) {
      release?.()
    }
    await open
  }
}

/** The two figures §9 quotes, as the api writes every amount: decimal strings in whole USDC. */
async function figures(sandbox: Pool): Promise<{ available: string; reserved: string }> {
  return withClient(sandbox, async (client) => {
    const balances = new Map((await getBalances(client)).map((balance) => [balance.code, balance.balanceMinor]))
    return {
      available: formatMinor(balances.get(ACCOUNTS.treasuryAvailable) ?? 0n),
      reserved: formatMinor(balances.get(ACCOUNTS.treasuryReserved) ?? 0n),
    }
  })
}

/** How many of the two payments set money aside. The article's answer is one. */
async function countReserves(sandbox: Pool): Promise<number> {
  const result = await sandbox.query<{ count: string }>(
    `SELECT count(*) AS count FROM ledger_transactions WHERE kind = 'reserve'`,
  )
  return Number(result.rows[0]?.count)
}

async function withClient<T>(pool: Pool, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    return await body(client)
  } finally {
    client.release()
  }
}
