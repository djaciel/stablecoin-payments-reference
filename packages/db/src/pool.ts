import { requireEnv } from '@payments/domain'
import { Pool } from 'pg'

// Give up on a connection instead of hanging forever: /health has to be able to answer
// "the database is unreachable" rather than never answering at all.
const CONNECTION_TIMEOUT_MS = 5000

/**
 * Every service talks to Postgres through a pool built here, so there is one place
 * that decides how the connection is configured.
 */
export function createPool(): Pool {
  const pool = new Pool({
    connectionString: readDatabaseUrl(),
    connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
  })

  // node-postgres re-emits errors that happen on idle clients. With no listener here,
  // Postgres restarting would take the whole service down with an unhandled 'error'
  // event, which is the opposite of what a health endpoint is for.
  pool.on('error', (error) => {
    console.error('postgres: idle client error, the pool will replace the connection:', error)
  })

  return pool
}

export function readDatabaseUrl(): string {
  return requireEnv('DATABASE_URL', 'Copy .env.example to .env, or run the service through docker compose.')
}
