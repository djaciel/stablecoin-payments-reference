import type { PoolClient } from '@payments/db'
import { EXPERIMENT_KEYS, type BlackholeStep } from '@payments/domain'

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

/** What a step throws instead of asking the node while "Node not responding" is armed for it. */
export class RpcBlackholed extends Error {
  constructor(step: BlackholeStep) {
    super(`the node did not answer (failure injection: node not responding is armed for ${step})`)
    this.name = 'RpcBlackholed'
  }
}

/**
 * Break it's "Node not responding", checked right before a step asks the node. Read on every
 * attempt, so disarming it lets the very next attempt through. Only `execute` and `watch` call
 * this: the api's reads and the watcher never see the flag.
 */
export async function failIfNodeBlackholed(client: PoolClient, step: BlackholeStep): Promise<void> {
  const result = await client.query(
    `SELECT 1 FROM settings WHERE key = $1 AND value->>'enabled' = 'true' AND value->>'step' = $2`,
    [EXPERIMENT_KEYS.blackholeRpc, step],
  )
  if (result.rowCount === 1) {
    throw new RpcBlackholed(step)
  }
}
