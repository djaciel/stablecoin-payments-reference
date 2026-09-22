import { useCallback, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { AuditStep, PaymentTimeline } from '@payments/domain'
import { getPaymentTimeline, getPayments } from '../api/client'
import { usePolling } from '../api/usePolling'
import { CopyButton } from '../app/AddressLine'
import { REASONS } from './PayablesScreen'

/**
 * Every payment, and each one's story step by step. The story is the audit log read back and
 * nothing else: a step shows once the row that proves it exists, and until then it is waiting.
 */
export function TransfersScreen() {
  const { reference } = useParams()
  return reference === undefined ? <PaymentList /> : <PaymentStory reference={reference} />
}

function PaymentList() {
  const { data, error } = usePolling(getPayments)

  if (data === undefined) {
    return <p className="card-note">{error === undefined ? 'reading…' : `unavailable — ${error}`}</p>
  }
  if (data.payments.length === 0) {
    return <p className="card-note">No payments yet. Press Pay on an invoice in Payables.</p>
  }

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
            {data.payments.map((payment) => (
              <tr key={payment.reference}>
                <td>
                  <Link to={`/admin/transfers/${payment.reference}`}>{payment.reference}</Link>
                </td>
                <td>
                  {payment.status}
                  {payment.reason !== undefined && <span className="cell-note">{REASONS[payment.reason]}</span>}
                </td>
                <td className="is-number">{payment.amount} USDC</td>
                <td>{payment.partnerName ?? 'no partner'}</td>
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
        {payment.reference} · {payment.partnerName ?? 'no partner'}
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

  for (const step of steps) {
    const previous = lines.at(-1)
    if (step.subjectType === 'invoice' && previous !== undefined) {
      lines[lines.length - 1] = { ...previous, rows: [...previous.rows, step], text: <>{previous.text} {INVOICE_NOTES[step.event]}</> }
      continue
    }
    const { context } = step
    switch (step.event) {
      case 'created':
        lines.push({ name: 'Created', rows: [step], text: <>The payment intent, recorded with its idempotency key <code>{context.idempotencyKey}</code>.</> })
        break
      case 'reserved':
        lines.push({ name: 'Reserved', rows: [step], text: `${payment.amount} USDC moved from Available to Reserved.` })
        break
      case 'signed':
        lines.push({ name: 'Signed', rows: [step], text: <>{gasTooLowText(context)}Its hash and nonce {context.nonce}, stored before anything was sent: <Hash hash={context.txHash} /></> })
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
                Reserved went down by {payment.amount} USDC and this invoice's debt to {payment.partnerName ?? 'the partner'} was
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
      default:
        lines.push({ name: step.event, rows: [step], text: '' })
    }
  }

  // Only a payment on its way has steps still to come; a finished one, or one in REVIEW, shows what happened.
  if (payment.status === 'RESERVED' || payment.status === 'SENT') {
    const missing = STEPS.filter((name) => !lines.some((line) => line.name === name))
    missing.forEach((name, index) => {
      lines.push({ name, rows: [], text: index === 0 ? (WAITING[name] ?? 'Waiting.') : 'Waiting.' })
    })
  }
  return lines
}

function sentText(context: AuditStep['context'], signedHash: string | undefined): ReactNode {
  const sameHash = context.txHash === signedHash
  if (context.networkAlreadyKnew === 'true') {
    return sameHash ? 'The network already had it, the same hash, so nothing was sent again.' : <>The network already had <Hash hash={context.txHash} /></>
  }
  return sameHash ? 'A node accepted it, the same hash.' : <>A node accepted <Hash hash={context.txHash} /></>
}

/** Break it's revert flag, as the `signed` row records it: the gas signed, and what the payout would have had. */
function gasTooLowText(context: AuditStep['context']): string {
  if (context.failureInjection !== 'revert_next_payment') {
    return ''
  }
  return `The gas limit was set too low on purpose (Break it): ${context.gas} instead of ${context.estimatedGas ?? 'its estimate'}, so it runs out of gas and reverts onchain. `
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
const MOMENT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })
