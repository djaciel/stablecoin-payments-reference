import { log, proxyActivities } from '@temporalio/workflow'
// Type-only: activity code must never be bundled into the workflow sandbox.
import type * as activities from './activities'

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
