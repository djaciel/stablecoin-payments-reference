import type { PoolClient } from '@payments/db'
import { EXPERIMENT_KEYS, type BlackholeStep } from '@payments/domain'

/** Takes the one-shot revert flag: the payment that gets it is signed with a gas limit too low. */
export async function claimRevertNextPayment(client: PoolClient): Promise<boolean> {
  return claimOneShot(client, EXPERIMENT_KEYS.revertNextPayment)
}

/**
 * Takes the one-shot crash flag. It MUST be claimed in the transaction that stores the hash: the
 * caller is about to kill its own process, and a flag still armed when the worker comes back would
 * make the next attempt sign and die again, for ever, with nobody watching (the crash restarts the
 * worker silently — only a failure to start says anything).
 */
export async function claimCrashAfterSigning(client: PoolClient): Promise<boolean> {
  return claimOneShot(client, EXPERIMENT_KEYS.crashAfterSigning)
}

/**
 * Switches a one-shot flag off in the same statement that reads it, inside the caller's
 * transaction. True for exactly one caller however many are signing: a second UPDATE waits for the
 * first to commit, then finds `false`. A rollback leaves the flag armed.
 */
async function claimOneShot(client: PoolClient, key: string): Promise<boolean> {
  const result = await client.query(
    `UPDATE settings SET value = 'false', updated_at = now()
      WHERE key = $1 AND value = 'true'
      RETURNING key`,
    [key],
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
