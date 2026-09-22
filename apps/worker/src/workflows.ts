import { continueAsNew, log, proxyActivities, rootCause, sleep } from '@temporalio/workflow'
// Type-only: activity code must never be bundled into the workflow sandbox.
import type * as activities from './activities'

const { watchChain, dispatchPayments } = proxyActivities<typeof activities>({
  // Bounded on purpose: a tick that cannot finish must not hold its loop. Three quick attempts,
  // then the failure comes back to the loop below, which logs it and waits for the next tick.
  startToCloseTimeout: '10 seconds',
  retry: { maximumAttempts: 3, initialInterval: '1 second', backoffCoefficient: 1 },
})

const { sign, execute, watch, settle } = proxyActivities<typeof activities>({
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
  const timeline = [await sign(reference)]
  // Sent (§7): a node has the stored bytes. `execute` is §3's "Execution" box.
  timeline.push(await execute(reference))

  // Paid (§7): finality AND the event. One short check, then a durable timer, until both hold. No
  // bound yet: Phase 6 caps it and escalates to REVIEW, with the money still reserved.
  let verdict = await watch(reference)
  while (verdict.outcome !== 'paid') {
    await sleep('10 seconds')
    verdict = await watch(reference)
  }
  timeline.push(`paid in block ${verdict.evidence.blockNumber} (final ${verdict.evidence.finalBlock})`)

  // Only now do the books move: Reserved out, Partner debt cleared, the invoice PAID.
  timeline.push(await settle(reference, verdict.evidence))

  log.info(`${reference}: ${timeline.join(' → ')}`)
  return timeline
}

/** 11 history events per iteration (measured), so a run closes under 4,000 — an hour at 10s. */
const TICKS_PER_RUN = 360

/**
 * The watcher: tick, wait ten seconds, tick again. The tick writes its own line and keeps its
 * cursor in the database, so the loop holds nothing but its counter.
 */
export async function WatcherWorkflow(): Promise<void> {
  await everyTenSeconds('watcher', watchChain)
}

/**
 * The dispatcher: every ten seconds, any RESERVED or SENT payment without a running
 * `PaymentWorkflow` gets one. The rule and its query are in `dispatcher.ts`.
 */
export async function DispatcherWorkflow(): Promise<void> {
  await everyTenSeconds('dispatcher', dispatchPayments)
}

/** The loop both share: one workflow that never ends, not one workflow per tick. */
async function everyTenSeconds(name: string, tick: () => Promise<string>): Promise<void> {
  for (let count = 0; count < TICKS_PER_RUN; count += 1) {
    try {
      await tick()
    } catch (error) {
      // Each failed attempt is already in the worker's log; this line is the one that matters
      // at 2 a.m. — the loop is still alive.
      log.error(`${name}: tick failed after its attempts, next one in 10s — ${rootCause(error)}`)
    }

    // Durable: the timer lives in Temporal, so a worker that dies mid-wait resumes it.
    await sleep('10 seconds')
  }

  // Outside the try, because `continueAsNew` works by throwing. It continues as the same workflow
  // type and takes no arguments: there is no state to carry, which is what makes this safe forever.
  await continueAsNew()
}
