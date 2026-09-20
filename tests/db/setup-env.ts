import { testDatabaseUrl } from './connection'

/**
 * Runs inside every test worker before its tests. Repointing DATABASE_URL here means
 * `createPool()` lands on the test database without any test having to remember to say so —
 * and that a test which forgets cannot reach the demo's own database by accident.
 */
process.env['DATABASE_URL'] = testDatabaseUrl()
