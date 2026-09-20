import { createPool, migrate } from '@payments/db'
import {
  MAINTENANCE_DATABASE,
  TEST_DATABASE,
  maintenanceDatabaseUrl,
  testDatabaseUrl,
  unreachableMessage,
} from './connection'

/**
 * Runs once, before any database test: drops and recreates the test database, then migrates it
 * with the REAL runner over the REAL migration files. The schema under test is the schema that
 * ships, and every rerun starts from exactly the same place.
 */
export async function setup(): Promise<void> {
  const maintenanceUrl = maintenanceDatabaseUrl()

  process.env['DATABASE_URL'] = maintenanceUrl
  const maintenance = createPool()

  try {
    // WITH (FORCE) evicts connections left over from a previous run, so a stray psql session
    // cannot make the suite fail with "database is being accessed by other users".
    await maintenance.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`)
    await maintenance.query(`CREATE DATABASE ${TEST_DATABASE}`)
  } catch (error) {
    throw new Error(unreachableMessage(maintenanceUrl, error), { cause: error })
  } finally {
    await maintenance.end().catch(() => undefined)
  }

  // The runner reads DATABASE_URL too. The workers resolve the same URL independently through
  // connection.ts, so nothing has to be handed across process boundaries.
  process.env['DATABASE_URL'] = testDatabaseUrl()
  await migrate()

  console.log(`test setup: ${TEST_DATABASE} recreated and migrated (${MAINTENANCE_DATABASE} untouched)`)
}
