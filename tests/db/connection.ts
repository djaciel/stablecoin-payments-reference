import { optionalEnv } from '@payments/domain'

/**
 * Where the database tests connect, decided in one place because two processes need the
 * same answer: the global setup that creates the test database, and every test worker that
 * then talks to it.
 *
 * Resolution order:
 *   1. TEST_DATABASE_URL — an explicit override wins.
 *   2. DATABASE_URL with its database name swapped for the test one.
 *   3. localhost on POSTGRES_PORT, matching docker-compose's published port.
 *
 * Note the absence of a hardcoded 5432 anywhere but the last fallback: a machine that
 * already has something on 5432 runs the stack with POSTGRES_PORT set, and the tests have
 * to follow it there.
 */

/** A database of its own, dropped and recreated on every run, so isolation is total. */
export const TEST_DATABASE = 'payments_test'

/** Used to issue CREATE/DROP DATABASE, which cannot run from inside the target database. */
export const MAINTENANCE_DATABASE = 'payments'

export function testDatabaseUrl(): string {
  return databaseUrlFor(TEST_DATABASE)
}

export function maintenanceDatabaseUrl(): string {
  return databaseUrlFor(MAINTENANCE_DATABASE)
}

function databaseUrlFor(database: string): string {
  const explicit = optionalEnv('TEST_DATABASE_URL') ?? optionalEnv('DATABASE_URL')
  if (explicit !== undefined) {
    return withDatabase(explicit, database)
  }

  const port = optionalEnv('POSTGRES_PORT') ?? '5432'
  return `postgres://payments:payments@localhost:${port}/${database}`
}

function withDatabase(url: string, database: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${database}`
  return parsed.toString()
}

/** Shown whenever the harness cannot reach Postgres, because "ECONNREFUSED" helps nobody. */
export function unreachableMessage(url: string, cause: unknown): string {
  const reason = cause instanceof Error ? cause.message : String(cause)
  return [
    `The database tests need a running Postgres and could not reach ${hideCredentials(url)}.`,
    `  ${reason}`,
    '',
    'Start it with:  docker compose up -d postgres',
    'If port 5432 is taken on your machine, start the stack with POSTGRES_PORT=<free port>',
    'and run the tests with the same variable set.',
    '',
    '`pnpm test` needs none of this — only `pnpm test:db` touches a database.',
  ].join('\n')
}

function hideCredentials(url: string): string {
  try {
    const parsed = new URL(url)
    parsed.password = ''
    parsed.username = ''
    return parsed.toString()
  } catch {
    return '(unparseable connection string)'
  }
}
