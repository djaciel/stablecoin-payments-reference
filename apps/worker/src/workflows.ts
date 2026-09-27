import { ActivityFailure, continueAsNew, isCancellation, log, proxyActivities, rootCause, sleep } from '@temporalio/workflow'
// Type-only: activity code must never be bundled into the workflow sandbox.
import type * as activities from './activities'
import type { Escalation } from './escalate'

const { watchChain, dispatchPayments } = proxyActivities<typeof activities>({
  // Bounded on purpose: a tick that cannot finish must not hold its loop. Three quick attempts,
  // then the failure comes back to the loop below, which logs it and waits for the next tick.
  // 30 s rather than 10: a watcher tick that promotes several deposits re-reads a receipt for
  // each of them, and a public endpoint takes its time.
  startToCloseTimeout: '30 seconds',
  retry: { maximumAttempts: 3, initialInterval: '1 second', backoffCoefficient: 1 },
})

const { reconcileNow } = proxyActivities<typeof activities>({
  // A run reads one receipt per payment and per deposit, so it is minutes, not seconds. Two
  // attempts: a run that fails is logged, and the next tick does the whole thing again anyway.
  startToCloseTimeout: '3 minutes',
  retry: { maximumAttempts: 2, initialInterval: '5 seconds', backoffCoefficient: 1 },
})

/** Attempts per step, 1 → 2 → 4 → 8 s apart: about 15 s from the first failure to the last. */
const STEP_ATTEMPTS = 5

const { sign, execute, watch, settle, reverse } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  // A step out of attempts, or failing in a way retrying cannot help, sends the payment to REVIEW
  // (the `catch` below), with the money still reserved.
  retry: { maximumAttempts: STEP_ATTEMPTS, initialInterval: '1 second', backoffCoefficient: 2 },
})

const { escalate } = proxyActivities<typeof activities>({
  startToCloseTimeout: '30 seconds',
  // Unbounded, the one step that is: it writes only to our own database, and until it does the
  // payment stays where it is, with its money reserved.
  retry: { initialInterval: '1 second', backoffCoefficient: 2, maximumInterval: '1 minute' },
})

/** 30 minutes of checks 10 s apart (the longest wait measured was ~8): ~2,000 history events, far under Temporal's 51,200. */
const MAX_FINALITY_CHECKS = 180

/**
 * The chain-side half of a payment. The API owns everything before this — validations, the
 * ledger reserve, the CREATED → RESERVED transition — and this workflow starts only once that is
 * committed. The workflow id is the payment reference, and each step gets the reference and
 * nothing else: it reads the row and skips what is already done.
 *
 * Everything awaited here is recorded in Temporal's history, so a worker that dies mid-run
 * replays from it: finished steps return their recorded result instead of running again.
 *
 * It ends one of three ways: settled, reversed with proof, or escalated to REVIEW.
 */
export async function PaymentWorkflow(reference: string): Promise<string[]> {
  const timeline: string[] = []
  let gaveUp: Escalation | undefined

  try {
    // Signed: the hash exists, and is stored on the row, before anything is sent.
    timeline.push(await sign(reference))
    // Sent: a node has the stored bytes. `execute` is the Execution step.
    timeline.push(await execute(reference))

    // Paid: finality AND the event. One short check, then a durable timer, until the chain gives
    // a final answer either way, or 30 minutes pass without one.
    let verdict = await watch(reference)
    let checks = 1
    while (verdict.outcome !== 'paid' && verdict.outcome !== 'reverted' && checks < MAX_FINALITY_CHECKS) {
      await sleep('10 seconds')
      verdict = await watch(reference)
      checks += 1
    }

    if (verdict.outcome === 'paid') {
      timeline.push(`paid in block ${verdict.evidence.blockNumber} (final ${verdict.evidence.finalBlock})`)
      // Only now do the books move: Reserved out, Partner debt cleared, the invoice PAID.
      timeline.push(await settle(reference, verdict.evidence))
    } else if (verdict.outcome === 'reverted') {
      // Reverted: proof it did not land, so it is reversed: Reserved back to Available, the invoice OPEN.
      timeline.push(`reverted in block ${verdict.evidence.blockNumber} (final ${verdict.evidence.finalBlock})`)
      timeline.push(await reverse(reference, verdict.evidence))
    } else {
      const last = verdict.outcome === 'not-final' ? `in block ${verdict.blockNumber}, the final block is ${verdict.finalBlock}` : 'not in a block yet'
      gaveUp = { step: 'watch', retryState: null, attempts: checks, lastError: `no final answer after 30 minutes: ${last}` }
    }
  } catch (failure) {
    gaveUp = stepThatGaveUp(failure)
  }

  // Silence: no proof, the money does not move: REVIEW, with the reason, and Reserved untouched.
  if (gaveUp !== undefined) {
    timeline.push(await escalate(reference, gaveUp))
  }

  log.info(`${reference}: ${timeline.join(' → ')}`)
  return timeline
}

/**
 * A step out of attempts, or failing in a way retrying cannot help. Anything else is rethrown, a
 * cancelled run included: a cancellation is not a failure, and escalates nothing.
 */
function stepThatGaveUp(failure: unknown): Escalation {
  if (!(failure instanceof ActivityFailure) || isCancellation(failure)) {
    throw failure
  }
  return {
    step: failure.activityType,
    retryState: failure.retryState ?? null,
    attempts: failure.retryState === 'MAXIMUM_ATTEMPTS_REACHED' ? STEP_ATTEMPTS : null,
    lastError: rootCause(failure) ?? failure.message,
  }
}

/** 11 history events per iteration (measured), so a run closes under 4,000 — an hour at 10s. */
const TICKS_PER_RUN = 360

/** How often the two loops that follow the chain tick. */
const CHAIN_INTERVAL = '10 seconds'

/** A real reconciliation rhythm is daily; ten minutes here, so a reader can watch a run appear by itself. */
const RECONCILE_INTERVAL = '10 minutes'

/**
 * The watcher: tick, wait ten seconds, tick again. The tick writes its own line and keeps its
 * cursor in the database, so the loop holds nothing but its counter.
 */
export async function WatcherWorkflow(): Promise<void> {
  await forever('watcher', CHAIN_INTERVAL, watchChain)
}

/**
 * The dispatcher: every ten seconds, any RESERVED or SENT payment whose time has come and has no
 * running `PaymentWorkflow` gets one. The rule and its query are in `dispatcher.ts`.
 */
export async function DispatcherWorkflow(): Promise<void> {
  await forever('dispatcher', CHAIN_INTERVAL, dispatchPayments)
}

/**
 * The reconciler: every ten minutes, one run that checks every payment and every deposit
 * against the chain at one block. It writes only its own two tables and repairs nothing.
 */
export async function ReconcilerWorkflow(): Promise<void> {
  await forever('reconciler', RECONCILE_INTERVAL, reconcileNow)
}

/** "Run now": one run, on demand. The api starts it and answers 202 without waiting for the result. */
export async function ReconciliationRun(): Promise<string> {
  return reconcileNow()
}

/** The loop all three share: one workflow that never ends, not one workflow per tick. */
async function forever(name: string, interval: string, tick: () => Promise<string>): Promise<void> {
  for (let count = 0; count < TICKS_PER_RUN; count += 1) {
    try {
      await tick()
    } catch (error) {
      // Each failed attempt is already in the worker's log; this line is the one that matters
      // at 2 a.m. — the loop is still alive.
      log.error(`${name}: tick failed after its attempts, next one in ${interval} — ${rootCause(error)}`)
    }

    // Durable: the timer lives in Temporal, so a worker that dies mid-wait resumes it.
    await sleep(interval)
  }

  // Outside the try, because `continueAsNew` works by throwing. It continues as the same workflow
  // type and takes no arguments: there is no state to carry, which is what makes this safe forever.
  await continueAsNew()
}
