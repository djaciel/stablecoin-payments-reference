import { testDatabaseUrl } from './connection'

/**
 * Runs inside every test worker before its tests.
 *
 * Repointing DATABASE_URL here means `createPool()` — the only sanctioned way to reach
 * Postgres in this repo — lands on the test database without any test having to remember to
 * say so. It also means a test that forgets cannot reach the demo's own database by
 * accident.
 */
process.env['DATABASE_URL'] = testDatabaseUrl()
