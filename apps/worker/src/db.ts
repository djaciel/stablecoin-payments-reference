import { createPool, type Pool } from '@payments/db'

/**
 * The worker's connection to Postgres: one pool for the process, closed when it shuts down.
 *
 * The api gets the same thing through Nest (`apps/api/src/db/db.module.ts`), which owns the
 * lifetime of its providers. A plain Node process has no container to do that, so the
 * lifetime is written here: created on first use, closed by `index.ts` next to the worker's
 * own shutdown. A pool per activity would open a new set of connections every ten seconds.
 */
let pool: Pool | undefined

export function workerPool(): Pool {
  pool ??= createPool()
  return pool
}

export async function closeWorkerPool(): Promise<void> {
  await pool?.end()
  pool = undefined
}
