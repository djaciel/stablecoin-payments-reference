import { activityInfo, heartbeat, log, sleep } from '@temporalio/activity'

/** Everything the worker can be asked to do. The tick is long enough to have its own file. */
export { watchChain } from './watcher'

/**
 * The four chain-side steps of a payment, in the order the spec fixes them: sign → execute
 * (store the hash BEFORE broadcasting) → watch (finality + the Transfer event) → settle.
 * The names and the shape are final; Phase 5 fills these bodies in rather than replacing them.
 */

/** Long enough to give you time to kill the worker while a step is running. */
const STEP_DURATION_MS = 10_000

/**
 * Without heartbeats Temporal only learns the process died when `startToCloseTimeout`
 * expires; with them it reschedules the step a few seconds after the last beat.
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
 * The attempt number is the point of the restart drill: after a crash the interrupted step
 * comes back as attempt 2 and the finished ones do not come back at all.
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
