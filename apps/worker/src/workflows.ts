import { log, proxyActivities } from '@temporalio/workflow'
// Type-only: activity code must never be bundled into the workflow sandbox.
import type * as activities from './activities'

const { watchChain } = proxyActivities<typeof activities>({
  // Bounded on purpose, and the reason is a real incident: an unbounded tick retried for two
  // days, and because the schedule's overlap policy is SKIP (a tick must never run beside
  // itself) every later tick was skipped in silence — 22,897 of them. Three quick attempts
  // instead, so a broken tick ends its run FAILED and the next scheduled one starts clean.
  startToCloseTimeout: '10 seconds',
  retry: { maximumAttempts: 3, initialInterval: '1 second', backoffCoefficient: 1 },
})

const { sign, execute, watch, settle } = proxyActivities<typeof activities>({
  // Generous on purpose: the heartbeat timeout, not this one, is what detects a dead
  // worker. Retries use the SDK defaults, which means unlimited attempts — acceptable
  // while the steps only sleep. Phase 5 bounds them and escalates to REVIEW instead.
  startToCloseTimeout: '1 minute',
  heartbeatTimeout: '5 seconds',
})

/**
 * The chain-side half of a payment. The API owns everything before this — validations, the
 * ledger reserve, the CREATED → RESERVED transition — and starts this workflow only once
 * that is committed. The workflow id is the payment reference, which is what makes
 * dispatching twice a no-op.
 *
 * Everything awaited here is recorded in Temporal's history, so a worker that dies mid-run
 * replays from it: finished steps return their recorded result instead of running again.
 */
export async function PaymentWorkflow(reference: string): Promise<string[]> {
  const timeline: string[] = []

  timeline.push(await sign(reference))
  timeline.push(await execute(reference))
  timeline.push(await watch(reference))
  timeline.push(await settle(reference))

  log.info(`${reference}: ${timeline.join(' → ')}`)
  return timeline
}

/**
 * What the `watcher` schedule starts every 10 seconds. It is this thin because a Schedule
 * can only start a workflow, and everything the tick does belongs in an activity.
 */
export async function WatcherWorkflow(): Promise<string> {
  // Returned, not logged: the activity already wrote the line, and repeating it here would
  // double every tick in `docker compose logs worker`. The Temporal UI shows the return.
  return watchChain()
}
