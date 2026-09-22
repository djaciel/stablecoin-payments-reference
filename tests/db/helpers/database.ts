import { type Pool, type PoolClient, createPool } from '@payments/db'
import { ACCOUNTS, ARTICLE_PARTNER_DEBT, type AccountCode } from '@payments/ledger'

/**
 * A pool aimed at the test database. Built on `createPool()` rather than `new Pool()` so the
 * tests inherit the same settings and the same required `error` listener the services get — a
 * pool without one takes the process down when Postgres restarts.
 */
export function testPool(): Pool {
  return createPool()
}

/** Borrows one connection, always gives it back, even when the body throws. */
export async function withClient<T>(pool: Pool, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    return await body(client)
  } finally {
    client.release()
  }
}

/**
 * Empties every table the migrations created, leaving the schema in place.
 *
 * Two are held back: `schema_migrations`, because wiping it would make the next run think the
 * database was never migrated, and `ledger_accounts`, the chart of accounts seeded by the
 * migration. Its balances are zeroed instead, and any account a test invented is dropped.
 *
 * TRUNCATE does not fire the per-row append-only triggers, which is the only reason the ledger
 * can be emptied here at all.
 */
const PRESERVED_TABLES = ['schema_migrations', 'ledger_accounts']

export async function resetDatabase(pool: Pool): Promise<void> {
  const tables = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> ALL($1)`,
    [PRESERVED_TABLES],
  )
  if (tables.rows.length > 0) {
    const list = tables.rows.map((row) => `public."${row.tablename}"`).join(', ')
    await pool.query(`TRUNCATE ${list} RESTART IDENTITY CASCADE`)
  }

  await pool.query('DELETE FROM ledger_accounts WHERE code <> ALL($1)', [Object.values(ACCOUNTS)])
  await pool.query('UPDATE ledger_accounts SET balance_minor = 0')
}

/** Where the seeded invoices are paid: a partner's payout address, as the table stores it. */
const PAYOUT_ADDRESS = '0x1111111111111111111111111111111111111111'

/**
 * One partner and two invoices of §7's 1,000 each, the Partner debt `seedArticle` put on the books.
 * Written straight to the tables: these tests are about payments, not about how invoices are made.
 */
export async function seedInvoices(pool: Pool): Promise<{ first: string; second: string }> {
  const partner = await pool.query<{ id: string }>(
    `INSERT INTO partners (name, derivation_index, deposit_address, payout_address)
     VALUES ('Bluefin Studio', 1, '0x2222222222222222222222222222222222222222', $1) RETURNING id`,
    [PAYOUT_ADDRESS],
  )
  const payables = await pool.query<{ id: string }>(
    `INSERT INTO payables (partner_id, destination, amount_minor, description)
     VALUES ($1, $2, $3, 'March logistics'), ($1, $2, $3, 'April logistics') RETURNING id`,
    [partner.rows[0]?.id, PAYOUT_ADDRESS, ARTICLE_PARTNER_DEBT.toString()],
  )
  const [first, second] = payables.rows
  if (first === undefined || second === undefined) {
    throw new Error('the two invoices were not written')
  }
  return { first: first.id, second: second.id }
}

/**
 * Reads a balance straight from the column the trigger maintains. On purpose: a test that read
 * balances through the ledger's own reader could not catch a reader that lies.
 */
export async function balanceOf(pool: Pool, code: AccountCode): Promise<bigint> {
  const result = await pool.query<{ balance_minor: string }>(
    'SELECT balance_minor FROM ledger_accounts WHERE code = $1',
    [code],
  )
  const balance = result.rows[0]?.balance_minor
  if (balance === undefined) {
    throw new Error(`${code} is not in the chart of accounts`)
  }
  return BigInt(balance)
}

/**
 * Holds callers until `parties` of them have arrived, then releases them all at once. This is
 * what makes "concurrent" mean something: two connections that merely start at roughly the
 * same time usually end up serialized by chance, and a race test that never produces a race
 * passes for the wrong reason forever.
 */
export function barrier(parties: number): () => Promise<void> {
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
