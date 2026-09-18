import { log, proxyActivities } from '@temporalio/workflow'
// Type-only: activity code must never be bundled into the workflow sandbox.
import type * as activities from './activities'

const { watchChain } = proxyActivities<typeof activities>({
  // One tick, and one attempt at it. A tick that fails does not need a retry policy: the
  // schedule starts a new run ten seconds later, from a cursor that did not move, so the
  // range is simply scanned again. Retrying inside the workflow would only put two attempts
  // where the schedule already puts one.
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 1 },
})

const { sign, execute, watch, settle } = proxyActivities<typeof activities>({
  // Generous on purpose: the heartbeat timeout, not this one, is what detects a dead
  // worker. Retries use the SDK defaults, which means unlimited attempts — acceptable
  // while the steps only sleep. Phase 5 bounds them and escalates to REVIEW instead.
  startToCloseTimeout: '1 minute',
  heartbeatTimeout: '5 seconds',
})

/**
 * The chain-side half of a payment. The API owns everything before this — validations,
 * the ledger reserve, the CREATED → RESERVED transition — and starts this workflow only
 * once that has been committed. The workflow id is the payment reference (`PAY-XXXX`),
 * which is also what makes dispatching twice a no-op.
 *
 * Everything awaited here is recorded in Temporal's history, so a worker that dies
 * mid-run is replayed from that history on restart: finished steps return their recorded
 * result instead of running again.
 *
 * Phase 5 gives the steps real bodies. The shape below is the one the spec fixes, so it
 * does not change: only the activities do.
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
 * What the `watcher` schedule starts, every 10 seconds (see schedules.ts).
 *
 * It is this thin because a Schedule can only start a workflow, and everything the tick does
 * — reading the cursor, asking the chain, writing the books — belongs in an activity, where
 * it may talk to the network and the database. The workflow is the handle Temporal holds:
 * one run per tick, each one visible in the UI with the line the tick logged as its result.
 */
export async function WatcherWorkflow(): Promise<string> {
  // Returned, not logged: the activity already wrote the line, and a workflow that repeats
  // it would double every tick in `docker compose logs worker`. The return value is what the
  // Temporal UI shows next to the run.
  return watchChain()
}
