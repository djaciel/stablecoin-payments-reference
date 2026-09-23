import { readdir, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { readEnv } from '@payments/domain'
import { Client } from 'pg'
import { readDatabaseUrl } from './pool'

// Services can start at the same time (the api and, later, the worker). Whoever gets this
// lock migrates, the others wait, so the same file is never applied twice.
const MIGRATION_LOCK_KEY = 8240115

/** Override with MIGRATIONS_DIR to point the runner at a different set of files. */
export function migrationsDirectory(): string {
  return readEnv('MIGRATIONS_DIR', resolve(__dirname, '../../../migrations'))
}

/**
 * Migrations run in file-name order, sorted as plain text rather than locale-aware, so
 * the order never depends on the machine. Zero-padded numeric prefixes are what make
 * that text order the intended order: 0002 before 0010.
 */
export function orderMigrationFiles(entries: readonly string[]): string[] {
  return entries.filter((name) => name.endsWith('.sql')).sort()
}

/**
 * Migrates the database `DATABASE_URL` points at, or another one when it is named: the race
 * endpoint migrates its sandbox from inside a running api, where changing that variable would
 * change it for every other request too.
 */
export async function migrate(connectionString: string = readDatabaseUrl()): Promise<void> {
  const directory = migrationsDirectory()
  const client = new Client({ connectionString })

  // A dropped connection arrives here. Without a listener, node-postgres turns it into an
  // unhandled 'error' event and the process dies before it can say which file was running.
  client.on('error', (error) => {
    console.error('migrate: connection error:', error)
  })

  await client.connect()

  try {
    await acquireLock(client)
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `)

    const previous = await client.query<{ filename: string }>('SELECT filename FROM schema_migrations')
    const applied = new Set(previous.rows.map((row) => row.filename))
    const files = orderMigrationFiles(await readdir(directory))

    if (files.length === 0) {
      console.log(`migrate: no .sql files in ${directory}`)
      return
    }

    let appliedCount = 0
    for (const file of files) {
      if (applied.has(file)) {
        console.log(`migrate: skip    ${file}`)
        continue
      }
      await applyOne(client, directory, file)
      appliedCount += 1
      console.log(`migrate: applied ${file}`)
    }
    console.log(`migrate: ${appliedCount} applied, ${files.length - appliedCount} already there`)
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined)
    await client.end().catch(() => undefined)
  }
}

/**
 * Take the lock before reading schema_migrations, so a runner that waited sees the rows
 * written by the one that went first.
 */
async function acquireLock(client: Client): Promise<void> {
  const attempt = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock($1) AS locked', [
    MIGRATION_LOCK_KEY,
  ])
  if (attempt.rows[0]?.locked === true) {
    return
  }
  console.log('migrate: another service is migrating, waiting for it to finish')
  await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY])
}

/** One transaction per file: a migration either lands whole or does not land at all. */
async function applyOne(client: Client, directory: string, file: string): Promise<void> {
  const sql = await readFile(join(directory, file), 'utf8')
  try {
    await client.query('BEGIN')
    await client.query(sql)
    await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file])
    await client.query('COMMIT')
  } catch (error) {
    // If the connection itself died, the rollback cannot be sent and Postgres discards the
    // open transaction on its own. Either way the file name has to survive into the error.
    await client.query('ROLLBACK').catch(() => undefined)
    throw new Error(`migration failed: ${file}`, { cause: error })
  }
}

if (require.main === module) {
  migrate().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
