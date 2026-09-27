import type { AuditStep, BlackholeStep, Experiments, LedgerFigures, PaymentTimeline, PaymentView } from '@payments/domain'
import { books, died, field, heading, post, put, refuseIfArmed, section, step, waitUntilResting, writeOwnInvoice } from './harness'

/**
 * §9's stuck one: the node stops answering after the broadcast, the step runs out of its attempts,
 * and the payment escalates to REVIEW with its money still reserved. Then it is resumed and finishes.
 *
 *   pnpm experiment:stuck
 *
 * The transfer is really on the chain while the payment sits in REVIEW: the system has no proof it
 * can see, so it releases nothing. It sends real testnet USDC and takes about five minutes.
 *
 * The flag names this run's own invoice, so other payments keep moving; it is switched off in a
 * `finally`, whatever the payment does.
 */

const NAME = 'experiment:stuck'

/** The invoice the run writes for itself, small on purpose. */
const AMOUNT = '0.01'
const DESCRIPTION = 'Stuck run (script)'

/** After the broadcast: the transfer lands while the workflow cannot see it, which is §9's stuck one. */
const STEP: BlackholeStep = 'watch'

async function main(): Promise<void> {
  heading(NAME, 'the node stops answering, and the money stays reserved')
  await refuseIfArmed('blackholeRpc')

  const before = await books()
  field('available before', before.available)
  field('reserved before', before.reserved)

  const payableId = await writeOwnInvoice(AMOUNT, DESCRIPTION)
  await arm(true, payableId)
  step(`armed for this invoice: the node stops answering after the broadcast (${STEP})`)

  let review: PaymentTimeline
  try {
    review = await waitUntilResting(await pay(payableId))
  } finally {
    await arm(false)
    step('disarmed')
  }

  const held = await books()
  escalation(review, held)
  if (review.payment.status !== 'REVIEW') {
    throw new Error(`${review.payment.reference} ended ${review.payment.status} instead of REVIEW, so there is nothing to resume`)
  }

  section('Resume')
  await post<PaymentView>(`/payments/${encodeURIComponent(review.payment.reference)}/resume`)
  step('resumed: back where it was, looking for the proof again with the same signed bytes')
  evidence(await waitUntilResting(review.payment.reference), await books())
}

function arm(enabled: boolean, payableId?: string): Promise<Experiments> {
  return put<Experiments>('/settings/experiments', { blackholeRpc: { enabled, step: STEP, payableId } })
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

/** Why it gave up, and where the money is while it waits: the whole point of REVIEW. */
function escalation(timeline: PaymentTimeline, held: LedgerFigures): void {
  const { payment, steps } = timeline
  const escalated = find(steps, 'escalated')
  const sent = find(steps, 'sent')

  section('Where it stopped')
  field('payment', `${payment.reference}  ${payment.amount} USDC  ${payment.status}`)
  field('step that gave up', escalated?.context.step ?? 'none')
  field('attempts', escalated?.context.attempts ?? 'none')
  field('why', escalated?.context.lastError ?? 'none')
  field('sent at', sent?.at ?? 'never')
  field('transfer', sent?.context.txHash ?? 'none')

  section('Where the money is')
  field('available', held.available)
  field('reserved', held.reserved)
  console.log(
    Number(held.reserved) >= Number(payment.amount)
      ? `  The transfer is on the chain and the payment cannot see it, so nothing was released: the\n` +
          `  ${payment.amount} USDC is still in Reserved, and a person with the whole story decides what happens next.`
      : `  Not proven: Reserved holds ${held.reserved} USDC, which does not cover this payment's ${payment.amount}.`,
  )
}

/** What the resume ended with: one transfer, and the books back to rest. */
function evidence(timeline: PaymentTimeline, after: LedgerFigures): void {
  const { payment, steps } = timeline

  section('How it ended')
  field('payment', `${payment.reference}  ${payment.amount} USDC  ${payment.status}`)
  field('sent rows', steps.filter((row) => row.event === 'sent').length)
  field('landed hash', find(steps, 'settled')?.context.txHash ?? 'none')
  if (payment.transaction !== undefined) {
    field('explorer', payment.transaction.explorerUrl)
  }
  field('available after', after.available)
  field('reserved after', after.reserved)

  section('What it proves')
  console.log(
    payment.status === 'SETTLED'
      ? '  The money waited for proof instead of being guessed at: the same bytes, the same hash, one\n' +
          '  transfer, and the books moved only once the payment could see it had landed.'
      : `  Not proven: ${payment.reference} is ${payment.status} after the resume. Read its story on /admin/transfers.`,
  )
  console.log('')
}

function find(steps: readonly AuditStep[], event: string): AuditStep | undefined {
  return steps.find((row) => row.event === event)
}

main().catch((error: unknown) => died(NAME, error))
