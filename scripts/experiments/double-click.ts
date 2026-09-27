import type { AuditStep, PaymentTimeline, PaymentView } from '@payments/domain'
import { books, died, field, heading, nothingElseInFlight, postAnswering, section, waitUntilResting, writeOwnInvoice, type Answer } from './harness'

/**
 * The double click: one invoice, two `POST /payments` fired at the same instant with the SAME
 * idempotency key, and one payment out of them.
 *
 *   pnpm experiment:double-click
 *
 * It presses the same door the Break it card presses, twice at once, and nothing is armed: this
 * failure is a nervous second click, not an injected fault. It sends real testnet USDC and takes
 * about four minutes, most of it waiting for a final block.
 */

const NAME = 'experiment:double-click'

/** The invoice the run writes for itself, small on purpose. */
const AMOUNT = '0.01'
const DESCRIPTION = 'Double-click run (script)'

async function main(): Promise<void> {
  heading(NAME, 'two calls, one key, one payment')
  await nothingElseInFlight()

  const before = await books()
  field('available before', before.available)

  const payableId = await writeOwnInvoice(AMOUNT, DESCRIPTION)
  // One key, made once, exactly as the screen makes it: a second call carrying it can only replay
  // the first one's payment. Both requests leave before either answers, or this would be two
  // payments in a row and would prove nothing.
  const key = crypto.randomUUID()
  const [first, second] = await Promise.all([pay(payableId, key), pay(payableId, key)])

  section('The two answers')
  field('idempotency-key', key)
  field('first call', answerLine(first))
  field('second call', answerLine(second))

  const timeline = await waitUntilResting(first.body.reference)
  await evidence(timeline, before.available, first.body.reference === second.body.reference)
}

function pay(payableId: string, key: string): Promise<Answer<PaymentView>> {
  return postAnswering<PaymentView>('/payments', { payableId }, { 'idempotency-key': key })
}

function answerLine({ code, body }: Answer<PaymentView>): string {
  return `${String(code)}  ${body.reference}  ${body.status}`
}

/** Everything the story proves, in the order somebody checking it would ask for it. */
async function evidence(timeline: PaymentTimeline, availableBefore: string, oneReference: boolean): Promise<void> {
  const { payment, steps } = timeline
  const created = rows(steps, 'created')
  const reserved = rows(steps, 'reserved')
  const after = await books()

  section('What happened to the payment')
  field('payment', `${payment.reference}  ${payment.amount} USDC  ${payment.status}`)
  field('payment rows', created)
  field('reserve entries', reserved)
  field('sent rows', rows(steps, 'sent'))
  if (payment.transaction !== undefined) {
    field('transfer', payment.transaction.hash)
    field('explorer', payment.transaction.explorerUrl)
  }

  section('What it moved')
  field('available before', availableBefore)
  field('available after', after.available)
  field('reserved after', after.reserved)

  section('What it proves')
  // Four claims, and the last is the one money cares about: both answers naming the same payment,
  // one row, one reserve, and Available down by one payment. Three of them could hold while a
  // second transfer went out on its own.
  const moved = Number(availableBefore) - Number(after.available)
  console.log(
    oneReference && created === 1 && reserved === 1 && moved.toFixed(6) === Number(AMOUNT).toFixed(6)
      ? `  Two requests, two answers, one payment: both calls named ${payment.reference}, it was recorded\n` +
          `  once, its money was set aside once, and Available went down by ${AMOUNT} and no more. The\n` +
          '  second call wrote nothing; it was handed the payment the first one had already made.'
      : `  Not proven: the two calls named ${oneReference ? 'one payment' : 'DIFFERENT payments'}, with\n` +
          `  ${String(created)} payment row(s) and ${String(reserved)} reserve entry(ies) for ${payment.reference},\n` +
          `  and Available moved by ${moved.toFixed(6)}. Read its story on /admin/transfers before\n` +
          '  running anything else.',
  )
  console.log('')
}

function rows(steps: readonly AuditStep[], event: string): number {
  return steps.filter((row) => row.subjectType === 'payment' && row.event === event).length
}

main().catch((error: unknown) => died(NAME, error))
