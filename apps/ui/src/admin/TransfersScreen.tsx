import { useCallback, useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { AuditStep, DepositSummary, PaymentReview, PaymentSummary, PaymentTimeline } from '@payments/domain'
import { getPaymentTimeline, readTransfers, resumePayment } from '../api/client'
import { usePolling } from '../api/usePolling'
import { CopyButton } from '../app/AddressLine'
import { REASONS, TO_AN_ADDRESS } from './PayablesScreen'

/**
 * Every payment, and each one's story step by step. The story is the audit log read back and
 * nothing else: a step shows once the row that proves it exists, and until then it is waiting.
 */
export function TransfersScreen() {
  const { reference } = useParams()
  return reference === undefined ? <PaymentList /> : <PaymentStory reference={reference} />
}

function PaymentList() {
  const { data, error } = usePolling(readTransfers)

  if (data === undefined) {
    return <p className="card-note">{error === undefined ? 'reading…' : `unavailable — ${error}`}</p>
  }
  const { payments } = data.payments
  const { deposits } = data.deposits
  if (payments.length === 0 && deposits.length === 0) {
    return <p className="card-note">Nothing yet. Press Pay on an invoice in Payables, or have a partner pay one in Receivables.</p>
  }
  // Oldest first by creation time (the list reversed), not by nonce: each held nonce is on its row.
  const queue = payments.filter((payment) => payment.review !== undefined).reverse()
  const waiting = payments.filter(isWaitingForItsTime).sort(soonestFirst)

  return (
    <>
      {queue.length > 0 && <ReviewQueue payments={queue} />}
      {waiting.length > 0 && <WaitingForTheirTime payments={waiting} />}
      <PaymentTable payments={payments} />
      <DepositTable deposits={deposits} />
    </>
  )
}

/**
 * Money coming in. Two states only: seen, and credited. The gap between them is the whole
 * lesson — a transfer everybody can see on the explorer is still not on the books.
 */
function DepositTable({ deposits }: { readonly deposits: readonly DepositSummary[] }) {
  return (
    <section className="panel">
      <h2 className="card-title">Money that arrived, newest first</h2>
      <p className="panel-lead">
        Each partner pays at an address of its own, so what says whose money this is, is where it came in. Nothing here
        was typed by anyone: the watcher wrote every row from the chain.
      </p>
      {deposits.length === 0 ? (
        <p className="card-note">Nothing has arrived yet. Have a partner pay an invoice on the partner side.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Partner</th>
                <th className="is-number">Amount</th>
                <th>Arrived at</th>
                <th>State</th>
                <th>Whose money it is</th>
                <th>Transaction</th>
              </tr>
            </thead>
            <tbody>
              {deposits.map((money) => (
                <tr key={money.id}>
                  <td>{money.partnerName}</td>
                  <td className="is-number">{money.amount} USDC</td>
                  <td className="is-mono">{shortAddress(money.depositAddress)}</td>
                  <td>
                    {money.status}
                    <span className="cell-note">{stateOf(money)}</span>
                  </td>
                  <td>{attributionOf(money)}</td>
                  <td className="is-mono">
                    <a href={money.transaction.explorerUrl} target="_blank" rel="noreferrer">
                      {shortHash(money.transaction.hash)}
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="card-note">
        The money stays on the deposit addresses in this demo. Moving it into the treasury would be a transaction of its
        own, and the address it leaves from needs a little of the network's own currency to pay for it.
      </p>
    </section>
  )
}

/** DETECTED says what has NOT happened yet, which is the part that is easy to read as done. */
function stateOf(money: DepositSummary): string {
  if (money.status === 'DETECTED') {
    return `Seen in block ${money.blockNumber}. That block can still be replaced, so nothing has been credited.`
  }
  return `Block ${money.blockNumber} can no longer be replaced, and the official contract's transfer says the exact amount at this exact address, so the books have it.`
}

/** Which of the three rules found the invoice, in words rather than in the code stored on the row. */
function attributionOf(money: DepositSummary): ReactNode {
  if (money.matchedBy === null) {
    return <span className="cell-note">{money.partnerName}'s, by the address. Which invoice it pays is decided when it is credited.</span>
  }
  if (money.receivable === null) {
    return (
      <>
        {money.partnerName}'s, by the address
        <span className="cell-note">No invoice matched: credited anyway, and it shows as owing them until one is written.</span>
      </>
    )
  }
  return (
    <>
      {money.receivable.description}
      <span className="cell-note">
        {money.matchedBy === 'hash'
          ? 'Matched by the transaction the partner recorded before sending it.'
          : 'Matched by the exact amount, on their oldest open invoice.'}
      </span>
    </>
  )
}

/** Every payment in REVIEW: where it was, the step that gave up and why, since when, and Resume. */
function ReviewQueue({ payments }: { readonly payments: readonly PaymentSummary[] }) {
  return (
    <section className="panel">
      <h2 className="card-title">In REVIEW: no proof either way, so the money stays reserved</h2>
      <p className="panel-lead">
        Resume one once the cause is gone: it goes back to where it was, and its workflow looks for the proof again,
        sending the same signed bytes if they never left.
      </p>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Reference</th>
              <th className="is-number">Amount</th>
              <th>Partner</th>
              <th>Where it was</th>
              <th>The step that gave up</th>
              <th>Since</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {payments.map(({ reference, amount, partnerName, review }) =>
              review === undefined ? null : (
                <tr key={reference}>
                  <td>
                    <Link to={`/admin/transfers/${reference}`}>{reference}</Link>
                  </td>
                  <td className="is-number">{amount} USDC</td>
                  <td>{partnerName ?? TO_AN_ADDRESS}</td>
                  <td>{whereItWas(review)}</td>
                  <td>
                    <code>{review.step}</code>
                    <span className="cell-note">{review.reason}</span>
                  </td>
                  <td>{MOMENT.format(new Date(review.at))}</td>
                  <td>
                    <ResumeButton reference={reference} />
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** Where resume sends it back to. The nonce sentence only where the nonce is really held. */
function whereItWas(review: PaymentReview): ReactNode {
  if (review.fromStatus === 'SENT') {
    return 'Was SENT: a node took the transfer.'
  }
  if (review.nonce === undefined) {
    return 'Was RESERVED, never signed.'
  }
  return (
    <>
      Signed, never sent: <strong>holds nonce {review.nonce}</strong>. Payouts signed after it wait until it is resumed.
    </>
  )
}

/** `POST /payments/:reference/resume`; the next poll shows where the payment went. A refusal shows its sentence. */
function ResumeButton({ reference }: { readonly reference: string }) {
  const [state, setState] = useState<'ready' | 'resuming' | 'resumed'>('ready')
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const resume = (): void => {
    setState('resuming')
    setFailure(undefined)
    resumePayment(reference)
      .then(() => {
        setState('resumed')
      })
      .catch((refused: unknown) => {
        setFailure(refused instanceof Error ? refused.message : String(refused))
        setState('ready')
      })
  }

  return (
    <>
      <button type="button" className="button" disabled={state !== 'ready'} onClick={resume}>
        {state === 'ready' ? 'Resume' : state === 'resuming' ? 'resuming…' : 'resumed'}
      </button>
      {failure !== undefined && <span className="cell-note">{failure}</span>}
    </>
  )
}

type Scheduled = PaymentSummary & { readonly executeAt: string }

/** Promised for later: RESERVED, with a time still ahead. At its time the dispatcher takes it. */
function isWaitingForItsTime(payment: PaymentSummary): payment is Scheduled {
  return payment.status === 'RESERVED' && payment.executeAt !== undefined && new Date(payment.executeAt) > new Date()
}

/** ISO times sort as text, and they all carry the same time zone. */
function soonestFirst(one: Scheduled, other: Scheduled): number {
  return one.executeAt.localeCompare(other.executeAt)
}

/** The payments promised for later: what the money is doing while they wait, and when they go. */
function WaitingForTheirTime({ payments }: { readonly payments: readonly Scheduled[] }) {
  return (
    <section className="panel">
      <h2 className="card-title">Waiting for their time</h2>
      <p className="panel-lead">
        The money is already reserved: it left Available when the payment was made, and nothing else can spend it.
        Nothing is signed until the payment runs, which happens within about ten seconds of its time.
      </p>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Reference</th>
              <th className="is-number">Amount</th>
              <th>Where it goes</th>
              <th>Runs at</th>
              <th>Promised</th>
            </tr>
          </thead>
          <tbody>
            {payments.map(({ reference, amount, partnerName, executeAt, createdAt }) => (
              <tr key={reference}>
                <td>
                  <Link to={`/admin/transfers/${reference}`}>{reference}</Link>
                </td>
                <td className="is-number">{amount} USDC</td>
                <td>{partnerName ?? TO_AN_ADDRESS}</td>
                <td>
                  {MOMENT.format(new Date(executeAt))}
                  <span className="cell-note">{fromNow(executeAt)}</span>
                </td>
                <td>{MOMENT.format(new Date(createdAt))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** "in 2 minutes" next to the exact time: the exact one is the promise, this one is the wait. */
function fromNow(at: string): string {
  const seconds = Math.round((new Date(at).getTime() - Date.now()) / 1000)
  return Math.abs(seconds) < 60 ? COUNTDOWN.format(seconds, 'second') : COUNTDOWN.format(Math.round(seconds / 60), 'minute')
}

function PaymentTable({ payments }: { readonly payments: readonly PaymentSummary[] }) {
  return (
    <section className="panel">
      <h2 className="card-title">Payments, newest first</h2>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Reference</th>
              <th>State</th>
              <th className="is-number">Amount</th>
              <th>Partner</th>
              <th>Transaction</th>
              <th>Last change</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((payment) => (
              <tr key={payment.reference}>
                <td>
                  <Link to={`/admin/transfers/${payment.reference}`}>{payment.reference}</Link>
                </td>
                <td>
                  {payment.status}
                  {payment.reason !== undefined && <span className="cell-note">{REASONS[payment.reason]}</span>}
                  {payment.status === 'REVIEW' && <span className="cell-note">No proof either way, so the money stays reserved.</span>}
                </td>
                <td className="is-number">{payment.amount} USDC</td>
                <td>{payment.partnerName ?? TO_AN_ADDRESS}</td>
                <td className="is-mono">
                  {payment.transaction !== undefined && (
                    <a href={payment.transaction.explorerUrl} target="_blank" rel="noreferrer">
                      {shortHash(payment.transaction.hash)}
                    </a>
                  )}
                </td>
                <td>{MOMENT.format(new Date(payment.lastChangeAt))}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** A finished payment has nothing left to arrive, so the view stops asking. */
function isFinished(timeline: PaymentTimeline): boolean {
  return timeline.payment.status === 'SETTLED' || timeline.payment.status === 'FAILED'
}

function PaymentStory({ reference }: { readonly reference: string }) {
  const read = useCallback(() => getPaymentTimeline(reference), [reference])
  const { data, error } = usePolling(read, isFinished)

  return (
    <>
      <p className="back-link">
        <Link to="/admin/transfers">All payments</Link>
      </p>
      {data === undefined ? (
        <p className="card-note">{error === undefined ? 'reading…' : `unavailable — ${error}`}</p>
      ) : (
        <Story timeline={data} />
      )}
    </>
  )
}

function Story({ timeline }: { readonly timeline: PaymentTimeline }) {
  const { payment } = timeline
  const lines = storyOf(timeline)
  const times = timesOf(lines)

  return (
    <section className="panel">
      <h2 className="card-title">
        {payment.reference} · {payment.partnerName ?? TO_AN_ADDRESS}
      </h2>
      <dl className="figures">
        <div className="figure">
          <dt>State</dt>
          <dd>{payment.status}</dd>
        </div>
        <div className="figure">
          <dt>Amount</dt>
          <dd>{payment.amount} USDC</dd>
        </div>
      </dl>
      {payment.review !== undefined && (
        <>
          <p className="card-value">
            In REVIEW since {MOMENT.format(new Date(payment.review.at))}. {whereItWas(payment.review)} No proof either way, so
            the money stays reserved.
          </p>
          <p className="card-actions">
            <ResumeButton reference={payment.reference} />
          </p>
        </>
      )}
      {timeline.workflowUrl !== undefined && (
        <p className="card-actions">
          {payment.transaction !== undefined && (
            <a href={payment.transaction.explorerUrl} target="_blank" rel="noreferrer">
              The transfer on Base Sepolia
            </a>
          )}
          <a href={timeline.workflowUrl} target="_blank" rel="noreferrer">
            Its runs in Temporal
          </a>
        </p>
      )}

      <ol className="story">
        {lines.map((line, index) => (
          <li key={`${String(index)}-${line.name}`} className={line.rows.length === 0 ? 'story-line is-waiting' : 'story-line'}>
            <span className="story-name">{line.name}</span>
            <span className="story-time">{times[index]}</span>
            <div>
              <p className="story-text">{line.text}</p>
              {line.rows.length > 0 && (
                <p className="story-rows">
                  {line.rows.map((row, rowIndex) => (
                    <code key={String(rowIndex)}>
                      {row.actor} · {row.subjectType === 'invoice' ? `invoice ${row.event}` : row.event}
                    </code>
                  ))}
                </p>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

/** One line of the story: the article's word for the step, and the audit rows that prove it. */
interface Line {
  readonly name: string
  /** Empty while the step is waiting. */
  readonly rows: readonly AuditStep[]
  readonly text: ReactNode
}

/** The steps of a payment that goes well, in the article's words (§6, §7). */
const STEPS = ['Created', 'Reserved', 'Signed', 'Sent', 'Paid', 'Settled'] as const

/** What the first step not reached yet is waiting for. Between Sent and Paid: §6's SENT row. */
const WAITING: Partial<Record<(typeof STEPS)[number], string>> = {
  Signed: 'Waiting to be signed.',
  Sent: 'Signed, not sent yet.',
  Paid: 'Waiting for the network: finality and the Transfer event.',
}

/** The invoice's rows: written in the same transaction as the step before them, so a note on it. */
const INVOICE_NOTES: Record<string, string | undefined> = {
  'payment-linked': 'The invoice is PAYING.',
  paid: 'The invoice is PAID.',
  reopened: 'The invoice is OPEN again: it can be paid with a new key.',
}

/**
 * The log's rows turned into the article's steps, in the order they were written. `settled` is
 * two lines, Paid (the chain's evidence) and Settled (the books), because §7 tells them apart. An
 * event this screen has no words for still shows, under its own name. The names are the ones
 * `packages/ledger/src/audit.ts` writes; the browser cannot import that package (it needs Postgres).
 */
function storyOf({ payment, steps }: PaymentTimeline): Line[] {
  const lines: Line[] = []
  const signedHash = steps.find((step) => step.subjectType === 'payment' && step.event === 'signed')?.context.txHash
  const wasReserved = steps.some((step) => step.subjectType === 'payment' && step.event === 'reserved')
  // Written by the door on the `created` row: present only for a payment promised for later.
  const promisedFor = steps.find((step) => step.subjectType === 'payment' && step.event === 'created')?.context.executeAt

  for (const step of steps) {
    const previous = lines.at(-1)
    if (step.subjectType === 'invoice' && previous !== undefined) {
      lines[lines.length - 1] = { ...previous, rows: [...previous.rows, step], text: <>{previous.text} {INVOICE_NOTES[step.event]}</> }
      continue
    }
    const { context } = step
    switch (step.event) {
      case 'created':
        lines.push({
          name: 'Created',
          rows: [step],
          text: (
            <>
              The payment intent, recorded with its idempotency key <code>{context.idempotencyKey}</code>.
              {promisedFor !== undefined && ` Promised for ${MOMENT.format(new Date(promisedFor))}: nothing is signed until then.`}
            </>
          ),
        })
        break
      case 'reserved':
        lines.push({ name: 'Reserved', rows: [step], text: `${payment.amount} USDC moved from Available to Reserved.` })
        break
      case 'signed':
        lines.push({
          name: 'Signed',
          rows: [step],
          // The gap above this line was the wait, not the chain: worth saying where the story shows it.
          text: <>{promisedFor === undefined ? '' : 'Its time came. '}{gasTooLowText(context)}Its hash and nonce {context.nonce}, stored before anything was sent: <Hash hash={context.txHash} /></>,
        })
        break
      case 'sent':
        lines.push({ name: 'Sent', rows: [step], text: sentText(context, signedHash) })
        break
      case 'settled':
        lines.push(
          {
            name: 'Paid',
            rows: [step],
            text: (
              <>
                In block {context.blockNumber}, final by block {context.finalBlock}, with the Transfer event from the official
                contract: exact amount and destination.
              </>
            ),
          },
          {
            name: 'Settled',
            rows: [step],
            text: (
              <>
                Reserved went down by {payment.amount} USDC and this invoice's debt to {payment.partnerName ?? 'that address'} was
                cleared (Dr Partner debt / Cr Reserved), ledger transaction <code>{context.ledgerTransactionId}</code>.
              </>
            ),
          },
        )
        break
      case 'failed':
        lines.push({ name: 'Failed', rows: [step], text: failedText(context, wasReserved) })
        break
      case 'released': {
        const proof = proofOf(context)
        lines.push({
          name: 'Released',
          rows: [step],
          text: (
            <>
              {payment.amount} USDC went from Reserved back to Available (Dr Available / Cr Reserved), with the proof: the
              transaction{' '}
              <Hash hash={proof.txHash} /> in block {proof.blockNumber}. Ledger transaction <code>{context.ledgerTransactionId}</code>.
            </>
          ),
        })
        break
      }
      case 'escalated':
        lines.push({ name: 'Escalated', rows: [step], text: escalatedText(context) })
        break
      case 'resumed':
        lines.push({ name: 'Resumed', rows: [step], text: `Resumed by an operator: back to ${context.to ?? 'where it was'}; its workflow runs again.` })
        break
      default:
        lines.push({ name: step.event, rows: [step], text: '' })
    }
  }

  // Only a payment on its way has steps still to come; a finished one, or one in REVIEW, shows what happened.
  if (payment.status === 'RESERVED' || payment.status === 'SENT') {
    const missing = STEPS.filter((name) => !lines.some((line) => line.name === name))
    missing.forEach((name, index) => {
      lines.push({ name, rows: [], text: index === 0 ? (waitingFor(name, promisedFor) ?? 'Waiting.') : 'Waiting.' })
    })
  }
  return lines
}

/** A payment promised for later is not waiting for a signer: it is waiting for its own time. */
function waitingFor(name: (typeof STEPS)[number], promisedFor: string | undefined): string | undefined {
  if (name === 'Signed' && promisedFor !== undefined && new Date(promisedFor) > new Date()) {
    return `Waiting for its time, ${MOMENT.format(new Date(promisedFor))}: the money is reserved and nothing is signed until then.`
  }
  return WAITING[name]
}

function sentText(context: AuditStep['context'], signedHash: string | undefined): ReactNode {
  const sameHash = context.txHash === signedHash
  if (context.resent === 'true') {
    return sameHash ? 'The network did not have it: the same bytes, sent again, the same hash.' : <>The network did not have it: the same bytes, sent again as <Hash hash={context.txHash} /></>
  }
  if (context.networkAlreadyKnew === 'true') {
    return sameHash ? 'The network already had it, the same hash, so nothing was sent again.' : <>The network already had <Hash hash={context.txHash} /></>
  }
  return sameHash ? 'A node accepted it, the same hash.' : <>A node accepted <Hash hash={context.txHash} /></>
}

/** Break it's revert flag, as the `signed` row records it: the gas signed, and what the payout would have had. */
function gasTooLowText(context: AuditStep['context']): string {
  // A signature can have taken more than one Break it flag, and the row names every one it took.
  if (!(context.failureInjection ?? '').includes('revert_next_payment')) {
    return ''
  }
  return `The gas limit was set too low on purpose (Break it): ${context.gas} instead of ${context.estimatedGas ?? 'its estimate'}, so it runs out of gas and reverts onchain. `
}

/** Why the run gave up, in one sentence: out of attempts, out of time, or not worth retrying. */
function escalatedText(context: AuditStep['context']): ReactNode {
  const step = <code>{context.step}</code>
  let why: ReactNode
  if (context.retryState === 'MAXIMUM_ATTEMPTS_REACHED') {
    why = <>To REVIEW because {step} ran out of its {context.attempts} attempts: {context.lastError}.</>
  } else if (context.retryState === 'null') {
    // No retry state: the wait for finality ran out of time (a stored null arrives as the string "null").
    // The last verdict is what `workflows.ts` wrote after its "no final answer after 30 minutes: ".
    const lastVerdict = (context.lastError ?? '').replace(/^no final answer after 30 minutes: /, '')
    why = <>To REVIEW: {step} got no final answer in 30 minutes ({context.attempts} checks): {lastVerdict}.</>
  } else {
    why = <>To REVIEW because {step} failed in a way retrying cannot help: {context.lastError}.</>
  }
  return <>{why} No proof either way, so the money stays reserved.</>
}

/** A revert names its block and says it is final: a revert that is not final proves nothing yet (§6). */
function failedText(context: AuditStep['context'], wasReserved: boolean): ReactNode {
  if (context.reason === 'reverted') {
    return (
      <>
        The transfer reached the chain and reverted in block {context.blockNumber}, final by block {context.finalBlock}: no USDC
        moved. <code>{context.reason}</code>
      </>
    )
  }
  return (
    <>
      {reasonInWords(context.reason)}
      {wasReserved ? '' : ' Nothing was reserved.'} <code>{context.reason}</code>
    </>
  )
}

function reasonInWords(code: string | undefined): string {
  return (REASONS as Record<string, string | undefined>)[code ?? ''] ?? ''
}

/** A reversal's proof is stored as an object, so its row carries it as JSON. */
function proofOf(context: AuditStep['context']): { readonly txHash?: string; readonly blockNumber?: number } {
  try {
    return JSON.parse(context.proof ?? '{}') as { txHash?: string; blockNumber?: number }
  } catch {
    return {}
  }
}

function Hash({ hash }: { readonly hash: string | undefined }) {
  if (hash === undefined) {
    return null
  }
  return (
    <>
      <span className="is-mono is-hash">{hash}</span> <CopyButton text={hash} />
    </>
  )
}

function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`
}

function shortAddress(address: string): string {
  return `${address.slice(0, 8)}…${address.slice(-6)}`
}

/** The date where it changes and the time on every line: a payment's story can span days. */
function timesOf(lines: readonly Line[]): string[] {
  let day = ''
  return lines.map((line) => {
    const at = line.rows[0]?.at
    if (at === undefined) {
      return ''
    }
    const date = new Date(at)
    const today = DAY.format(date)
    const label = today === day ? TIME.format(date) : `${today}, ${TIME.format(date)}`
    day = today
    return label
  })
}

// Milliseconds on the story's lines: signed and sent are often under a second apart, in that order.
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const TIME = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hourCycle: 'h23' })
/** Exported so the screen that schedules a payment prints its time the way this one does. */
export const MOMENT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
const COUNTDOWN = new Intl.RelativeTimeFormat('en-US', { numeric: 'auto' })
