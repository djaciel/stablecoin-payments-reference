import { createPool, type Pool } from '@payments/db'

/**
 * One pool for the process: a plain Node process has no Nest container to own the lifetime,
 * so it is written here — created on first use, closed by `index.ts` at shutdown. A pool per
 * activity would open a new set of connections every ten seconds.
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
