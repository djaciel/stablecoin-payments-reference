import { execFileSync } from 'node:child_process'
import type { AuditStep, Experiments, PaymentTimeline, PaymentView } from '@payments/domain'
import { died, field, heading, post, put, refuseIfArmed, section, step, waitUntilResting, writeOwnInvoice } from './harness'

/**
 * The crash, end to end: write a small invoice of this script's own, arm the flag for it, pay it,
 * and let the worker kill itself the moment the hash is stored. Nobody restarts anything; the
 * payment finishes with the bytes it had already signed.
 *
 *   pnpm experiment:crash
 *
 * It presses the same api doors the Break it card presses, and adds the one thing a browser
 * cannot read: Docker's own count of how many times the worker has come back.
 * It sends real testnet USDC. About four minutes, most of it waiting for a final block.
 */

const NAME = 'experiment:crash'

/** The invoice the run writes for itself, small on purpose. */
const AMOUNT = '0.01'
const DESCRIPTION = 'Crash run (script)'

/** Compose's name for the worker, which is what `docker inspect` is asked about. */
const WORKER = 'stablecoin-payments-reference-worker-1'

async function main(): Promise<void> {
  heading(NAME, 'the worker dies after signing, and the payment finishes itself')
  await refuseIfArmed('crashAfterSigning')

  const before = workerLife()
  section('The worker before the run')
  printLife(before)

  const payableId = await writeOwnInvoice(AMOUNT, DESCRIPTION)
  // Said before anything is armed, because after that it is too late to stop.
  step('this really stops the worker: other payments in flight lose one attempt and carry on')
  await put<Experiments>('/settings/experiments', { crashAfterSigning: { enabled: true, payableId } })
  step('armed for this invoice: its payment kills the worker the moment its hash is stored')

  let timeline: PaymentTimeline
  try {
    timeline = await waitUntilResting(await pay(payableId))
  } finally {
    await put<Experiments>('/settings/experiments', { crashAfterSigning: { enabled: false } })
    step('disarmed')
  }

  const after = workerLife()
  section('The worker after the run')
  printLife(after)

  evidence(timeline, before, after)
}

/** The door the Pay button presses: one `POST /payments` with a key of its own. */
async function pay(payableId: string): Promise<string> {
  const payment = await post<PaymentView>('/payments', { payableId }, { 'idempotency-key': crypto.randomUUID() })
  if (payment.status === 'FAILED') {
    throw new Error(`the payment was refused: ${payment.reason ?? 'no reason given'}`)
  }
  step(`paid as ${payment.reference}: ${AMOUNT} USDC from Available to Reserved`)
  return payment.reference
}

/** Everything the story proves, in the order somebody checking it would ask for it. */
function evidence(timeline: PaymentTimeline, before: WorkerLife | undefined, after: WorkerLife | undefined): void {
  const { payment, steps } = timeline
  const signed = find(steps, 'signed')
  const sent = find(steps, 'sent')
  const settled = find(steps, 'settled')

  section('What happened to the payment')
  field('payment', `${payment.reference}  ${payment.amount} USDC  ${payment.status}`)
  field('hash stored at', signed?.at ?? 'never')
  field('stored hash', signed?.context.txHash ?? 'none')
  field('killed on purpose', String((signed?.context.failureInjection ?? '').includes('crash_after_signing')))
  field('nonce', signed?.context.nonce ?? 'none')
  field('sent at', sent?.at ?? 'never')
  field('sent on attempt', sent?.context.attempt ?? 'none')
  field('network already knew', sent?.context.networkAlreadyKnew ?? 'none')
  field('landed hash', settled?.context.txHash ?? 'none')
  field('in block', settled?.context.blockNumber ?? 'none')
  const sends = steps.filter((row) => row.event === 'sent').length
  field('sent rows', sends)
  if (payment.transaction !== undefined) {
    field('explorer', payment.transaction.explorerUrl)
  }

  section('What it proves')
  // Two claims, not one: the hash that landed is the hash stored before anything was sent, AND
  // the bytes went out exactly once. The hashes alone would not say the second — both rows read
  // the same stored column, so they would still agree if the payment had been broadcast twice.
  const oneTransfer = signed?.context.txHash !== undefined && signed.context.txHash === settled?.context.txHash && sends === 1
  console.log(
    oneTransfer
      ? '  The hash stored before anything was sent is the hash that landed, and exactly one `sent`\n' +
          '  row was ever written: one transfer on chain, after a crash the payment recovered from\n' +
          '  on its own.'
      : `  Not proven: the payment settled with ${String(settled?.context.txHash ?? 'no hash')} against a stored\n` +
          `  ${String(signed?.context.txHash ?? 'no hash')}, and it was sent ${String(sends)} time(s). Read its story on\n` +
          '  /admin/transfers before running anything else.',
  )
  // The strongest line, and the reason this command exists: the process that stored the hash is
  // not the process that sent it. `sent` is on attempt 1 because `execute` had never run — the
  // crash cost `sign` its first attempt, and Temporal reran that step after its 30 s timeout.
  if (before !== undefined && after !== undefined && signed !== undefined) {
    const restarted = Number(after.restartCount) - Number(before.restartCount)
    const reborn = Date.parse(after.startedAt) > Date.parse(signed.at)
    console.log(
      reborn
        ? `  The worker running now started AFTER that hash was stored, and Docker's restart count\n` +
            `  went up by ${String(restarted)}: the process that signed it is not the process that sent it,\n` +
            '  and nobody typed a command in between.'
        : '  The worker was not restarted during this run, so nothing was proven about the crash.',
    )
  }
  console.log('')
}

function find(steps: readonly AuditStep[], event: string): AuditStep | undefined {
  return steps.find((row) => row.event === event)
}

interface WorkerLife {
  readonly restartCount: string
  readonly startedAt: string
}

/**
 * Docker's own record of the worker's life: how many times it has been restarted, and when this
 * one started. It is the only evidence that the process really died, and the only thing in these
 * scripts a browser could not do for itself.
 */
function workerLife(): WorkerLife | undefined {
  try {
    const answer = execFileSync('docker', ['inspect', '-f', '{{.RestartCount}}|{{.State.StartedAt}}', WORKER], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const [restartCount, startedAt] = answer.trim().split('|')
    return restartCount === undefined || startedAt === undefined ? undefined : { restartCount, startedAt }
  } catch {
    return undefined
  }
}

function printLife(life: WorkerLife | undefined): void {
  if (life === undefined) {
    console.log(`  docker could not be asked about ${WORKER}; the rest of the run still holds.`)
    return
  }
  field('restart count', life.restartCount)
  field('started at', life.startedAt)
}

main().catch((error: unknown) => died(NAME, error))
