import type { PoolClient } from '@payments/db'
import { EXPERIMENT_KEYS } from '@payments/domain'

/**
 * Takes the one-shot revert flag if it is armed, switching it off in the same statement, inside
 * the caller's transaction. True for exactly one caller however many are signing: a second UPDATE
 * waits for the first to commit, then finds `false`. A rollback leaves the flag armed.
 */
export async function claimRevertNextPayment(client: PoolClient): Promise<boolean> {
  const result = await client.query(
    `UPDATE settings SET value = 'false', updated_at = now()
      WHERE key = $1 AND value = 'true'
      RETURNING key`,
    [EXPERIMENT_KEYS.revertNextPayment],
  )
  return result.rowCount === 1
}
