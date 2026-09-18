import { activityInfo, heartbeat, log, sleep } from '@temporalio/activity'

/**
 * Everything the worker can be asked to do, in one file, because that is the map: here are
 * the activities. The watcher's tick is the only one with a real body so far, and it lives
 * in its own file — it is the longest thing this worker does.
 */
export { watchChain } from './watcher'

/**
 * The four chain-side steps of a payment, in the order the spec fixes them:
 * sign → execute (store the hash BEFORE broadcasting) → watch (finality + the Transfer
 * event) → settle (move the money in the ledger).
 *
 * Their bodies are placeholders: each one only sleeps and reports its attempt number.
 * The names and the shape are final, so Phase 5 fills these functions in rather than
 * replacing them. Nothing here touches a key, a chain or the database yet — when it
 * does, every step will start by reading the payment row and skipping work that is
 * already recorded, which is what makes retry, crash recovery and resume one code path.
 */

/** Long enough to give you time to kill the worker while a step is running. */
const STEP_DURATION_MS = 10_000

/**
 * Heartbeats are what make a dead worker cheap to detect. Without them Temporal only
 * learns the process died when `startToCloseTimeout` expires; with them it reschedules
 * the step a few seconds after the last beat.
 */
const HEARTBEAT_INTERVAL_MS = 1_000

export async function sign(reference: string): Promise<string> {
  return placeholderStep('sign', reference)
}

export async function execute(reference: string): Promise<string> {
  return placeholderStep('execute', reference)
}

export async function watch(reference: string): Promise<string> {
  return placeholderStep('watch', reference)
}

export async function settle(reference: string): Promise<string> {
  return placeholderStep('settle', reference)
}

/**
 * The attempt number in these logs is the whole point of the restart drill: after a
 * crash, the step that was interrupted comes back as attempt 2 and the steps that had
 * already finished do not come back at all. See docs/dev/restart-survival.md.
 */
async function placeholderStep(step: string, reference: string): Promise<string> {
  const { attempt } = activityInfo()
  log.info(`${reference} ${step}: start (attempt ${attempt})`)

  for (let beat = 1; beat <= STEP_DURATION_MS / HEARTBEAT_INTERVAL_MS; beat += 1) {
    await sleep(HEARTBEAT_INTERVAL_MS)
    heartbeat(beat)
  }

  log.info(`${reference} ${step}: done (attempt ${attempt})`)
  return `${step} (attempt ${attempt})`
}
