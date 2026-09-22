import { continueAsNew, log, proxyActivities, rootCause, sleep } from '@temporalio/workflow'
// Type-only: activity code must never be bundled into the workflow sandbox.
import type * as activities from './activities'

const { watchChain } = proxyActivities<typeof activities>({
  // Bounded on purpose: a tick that cannot finish must not hold the loop. Three quick attempts,
  // then the failure comes back to the loop below, which logs it and waits for the next tick.
  startToCloseTimeout: '10 seconds',
  retry: { maximumAttempts: 3, initialInterval: '1 second', backoffCoefficient: 1 },
})

const { sign, execute } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  // No `maximumAttempts`, on purpose and unlike the watcher: a failing step waits, visibly in the
  // Temporal UI, with the money still reserved. Phase 6 bounds it and escalates to REVIEW.
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '30 seconds' },
})

/**
 * The chain-side half of a payment. The API owns everything before this — validations, the
 * ledger reserve, the CREATED → RESERVED transition — and this workflow starts only once that is
 * committed. The workflow id is the payment reference, and each step gets the reference and
 * nothing else: it reads the row and skips what is already done.
 *
 * Everything awaited here is recorded in Temporal's history, so a worker that dies mid-run
 * replays from it: finished steps return their recorded result instead of running again.
 */
export async function PaymentWorkflow(reference: string): Promise<string[]> {
  // Signed (§7): the hash exists, and is stored on the row, before anything is sent.
  const signed = await sign(reference)
  // Sent (§7): a node has the stored bytes. `execute` is §3's "Execution" box.
  const sent = await execute(reference)

  log.info(`${reference}: ${signed} → ${sent}`)
  return [signed, sent]
}

/** 11 history events per iteration (measured), so a run closes under 4,000 — an hour at 10s. */
const TICKS_PER_RUN = 360

/**
 * The watcher: tick, wait ten seconds, tick again, and start a fresh run after an hour. One
 * workflow that never ends, not one workflow per tick.
 *
 * Nothing is returned or accumulated: the tick writes its own line and keeps its cursor in the
 * database, so a loop that runs for an hour holds nothing but its counter.
 */
export async function WatcherWorkflow(): Promise<void> {
  for (let tick = 0; tick < TICKS_PER_RUN; tick += 1) {
    try {
      await watchChain()
    } catch (error) {
      // The activity already said which attempt failed and against which RPC host; this line
      // is the one that matters at 2 a.m. — the watcher is still alive.
      log.error(`watcher: tick failed after its attempts, next one in 10s — ${rootCause(error)}`)
    }

    // Durable: the timer lives in Temporal, so a worker that dies mid-wait resumes it.
    await sleep('10 seconds')
  }

  // Outside the try, because `continueAsNew` works by throwing. It takes no arguments here —
  // there is no state to carry into the next run, which is what makes this safe to do forever.
  await continueAsNew<typeof WatcherWorkflow>()
}
