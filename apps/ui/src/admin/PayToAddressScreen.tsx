import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import type { PayableSummary, PaymentSummary, PaymentView } from '@payments/domain'
import { addToAllowlist, createPayable, getPayables, getPayments, payPayable } from '../api/client'
import { usePolling } from '../api/usePolling'
import { AddressLine, CopyButton } from '../app/AddressLine'
import { formatUsdc } from '../app/usdc'
import { Figure, inFlight, REASONS, TO_AN_ADDRESS } from './PayablesScreen'
import { CancelDialog, fromNow, isWaitingForItsTime, MOMENT, type Scheduled } from './TransfersScreen'

/** Far enough ahead to watch the money sit in Reserved, near enough to not have to come back. */
const DEFAULT_MINUTES_AHEAD = 2

/** What the form was holding when it was submitted, which is what the invoice must match. */
interface Typed {
  readonly destination: string
  readonly amount: string
  readonly note: string
}

/**
 * Paying an address somebody typed, and the rule that makes it safe. The invoice is written
 * first and paid through the door every other invoice goes through, so a destination that is not
 * on the allowlist is refused there, with nothing reserved and the invoice still open.
 */
export function PayToAddressScreen() {
  const polled = usePolling(readSent)
  // The poll and a new payment both write here, so a payment made here shows at once.
  const [sent, setSent] = useState<readonly Sent[] | undefined>(undefined)
  const [destination, setDestination] = useState('')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [runsNow, setRunsNow] = useState(true)
  const [runAt, setRunAt] = useState(minutesAhead(DEFAULT_MINUTES_AHEAD))
  const [invoice, setInvoice] = useState<PayableSummary | undefined>(undefined)
  const [payment, setPayment] = useState<PaymentView | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  // The attempt's idempotency key (§4): kept while a call is in flight, so a retry after a lost
  // answer is the same payment. Dropped on any answer, because an invoice refused at the door is
  // paid again with a NEW key; the old one would only replay the refusal.
  const attemptKey = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (polled.data !== undefined) {
      setSent(polled.data)
    }
  }, [polled.data])

  // A failed read is left for the poll to report.
  const refresh = (): void => {
    readSent().then(setSent, () => undefined)
  }

  const pay = async (payableId: string): Promise<void> => {
    attemptKey.current ??= crypto.randomUUID()
    // The form holds local time and the api is told the exact moment, time zone and all. It is read
    // when Pay is pressed, so a retry after a refusal runs at the time the form says then.
    const answer = await payPayable(payableId, attemptKey.current, runsNow ? undefined : new Date(runAt).toISOString())
    attemptKey.current = undefined
    setPayment(answer)
  }

  // The default is the time of the click that picked it, and typing an address takes minutes: a
  // value already in the past is refreshed rather than sent, because the invoice is written before
  // the payment and a refused time would leave it open on the books.
  const freshTime = (): void => {
    setRunAt(minutesAhead(DEFAULT_MINUTES_AHEAD))
  }

  const run = (start: Promise<void>): void => {
    setBusy(true)
    setFailure(undefined)
    start
      .catch((error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        setBusy(false)
        refresh()
      })
  }

  const createAndPay = (event: FormEvent): void => {
    event.preventDefault()
    setInvoice(undefined)
    setPayment(undefined)
    attemptKey.current = undefined
    const typed: Typed = { destination, amount, note }
    run(
      createPayable({ destination, amount, description: note }).then(async (payables) => {
        const written = justCreated(payables.payables, typed)
        setInvoice(written)
        await pay(written.id)
      }),
    )
  }

  return (
    <>
      {polled.error !== undefined && (
        <p className="card-value is-bad">unavailable — {polled.error}. What follows is the api's last answer.</p>
      )}

      <section className="panel">
        <h2 className="card-title">{TO_AN_ADDRESS}</h2>
        <form className="form-row" onSubmit={createAndPay}>
          <input
            className="field"
            value={destination}
            onChange={(event) => {
              setDestination(event.target.value)
            }}
            placeholder="0x…"
            aria-label="Destination address"
          />
          <span className="field-unit">
            <input
              className="field is-short"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value)
              }}
              inputMode="decimal"
              placeholder="0.01"
              aria-label="Amount in USDC"
            />
            USDC
          </span>
          <input
            className="field"
            value={note}
            onChange={(event) => {
              setNote(event.target.value)
            }}
            placeholder="Description"
            aria-label="Description"
          />
          <label className="field-unit">
            <input
              type="radio"
              name="when-it-runs"
              checked={runsNow}
              onChange={() => {
                setRunsNow(true)
              }}
            />
            Now
          </label>
          <label className="field-unit">
            <input
              type="radio"
              name="when-it-runs"
              checked={!runsNow}
              onChange={() => {
                setRunsNow(false)
                freshTime()
              }}
            />
            At a time
          </label>
          <input
            className="field"
            type="datetime-local"
            value={runAt}
            onChange={(event) => {
              setRunAt(event.target.value)
            }}
            onFocus={() => {
              if (new Date(runAt) <= new Date()) {
                freshTime()
              }
            }}
            disabled={runsNow}
            required
            aria-label="When it runs"
          />
          <button type="submit" className="button" disabled={busy}>
            {busy ? 'paying…' : 'Create and pay'}
          </button>
        </form>
        <p className="card-note">At a time: the money is reserved now and sent at that time.</p>
        {failure !== undefined && <p className="card-value is-bad">{failure}</p>}
        {invoice !== undefined && payment?.status === 'FAILED' && (
          <Refusal
            invoice={invoice}
            payment={payment}
            busy={busy}
            onPayAgain={() => {
              run(pay(invoice.id))
            }}
          />
        )}
      </section>

      <SentList sent={sent} refresh={refresh} />
    </>
  )
}

/**
 * Only a refusal shows here: a payment that went through is already in the list below. The invoice
 * stays open, so the fix (allowlist the address) and Pay again sit right under the form.
 */
function Refusal({
  invoice,
  payment,
  busy,
  onPayAgain,
}: {
  readonly invoice: PayableSummary
  readonly payment: PaymentView
  readonly busy: boolean
  readonly onPayAgain: () => void
}) {
  return (
    <>
      {payment.reason !== undefined && (
        <p className="card-value is-bad">{REASONS[payment.reason]} Nothing was reserved.</p>
      )}
      {payment.reason === 'destination_not_allowlisted' && <AddToAllowlist address={invoice.destination.address} />}
      <p className="card-actions">
        {/* A new attempt with a new key: the old one would only replay this refusal. */}
        <button type="button" className="button" disabled={busy} onClick={onPayAgain}>
          {busy ? 'paying…' : 'Pay again'}
        </button>
      </p>
    </>
  )
}

/** The one-click fix for the refusal above: the address the invoice already carries, plus a label. */
function AddToAllowlist({ address }: { readonly address: string }) {
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [added, setAdded] = useState(false)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    addToAllowlist({ address, label })
      .then(() => {
        setAdded(true)
      })
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  if (added) {
    return <p className="card-value">On the allowlist now. Press Pay again.</p>
  }

  return (
    <>
      <form className="form-row" onSubmit={submit}>
        <input
          className="field"
          value={label}
          onChange={(event) => {
            setLabel(event.target.value)
          }}
          placeholder="Whose address is this?"
          aria-label="Label"
        />
        <button type="submit" className="button" disabled={busy}>
          {busy ? 'adding…' : 'Add to allowlist'}
        </button>
      </form>
      {error !== undefined && <p className="card-value is-bad">{error}</p>}
    </>
  )
}

/** A payment made from this screen: its invoice, and the payment's row where the list still has it. */
interface Sent {
  readonly invoice: PayableSummary & { readonly payment: NonNullable<PayableSummary['payment']> }
  /** From `GET /payments`, for the time a scheduled payment runs. */
  readonly summary: PaymentSummary | undefined
}

/** The invoices with no partner that were paid, newest first, each with its payment's row. */
async function readSent(): Promise<readonly Sent[]> {
  const [{ payables }, { payments }] = await Promise.all([getPayables(), getPayments()])
  const byReference = new Map(payments.map((payment) => [payment.reference, payment]))
  return payables.flatMap((invoice) => {
    const { payment } = invoice
    return invoice.partnerName === null && payment !== null
      ? [{ invoice: { ...invoice, payment }, summary: byReference.get(payment.reference) }]
      : []
  })
}

function isDone({ invoice }: Sent): boolean {
  return invoice.payment.status === 'SETTLED' || invoice.payment.status === 'FAILED'
}

function SentList({ sent, refresh }: { readonly sent: readonly Sent[] | undefined; readonly refresh: () => void }) {
  if (sent === undefined) {
    return <p className="card-note">reading…</p>
  }
  if (sent.length === 0) {
    return <p className="card-note">No payments to an address yet.</p>
  }

  const waiting = sent.filter(({ summary }) => summary !== undefined && isWaitingForItsTime(summary))
  const done = sent.filter(isDone)
  const moving = sent.filter((one) => !waiting.includes(one) && !done.includes(one))

  return (
    <>
      <SentGroup title="Waiting for their time" sent={waiting} refresh={refresh} />
      <SentGroup title="In flight" sent={moving} refresh={refresh} />
      <SentGroup title="Done" sent={done} refresh={refresh} />
    </>
  )
}

function SentGroup({ title, sent, refresh }: { readonly title: string; readonly sent: readonly Sent[]; readonly refresh: () => void }) {
  if (sent.length === 0) {
    return null
  }
  return (
    <>
      <h2 className="card-title group-title">{title}</h2>
      <div className="cards">
        {sent.map((one) => (
          <SentCard key={one.invoice.id} sent={one} refresh={refresh} />
        ))}
      </div>
    </>
  )
}

function SentCard({ sent, refresh }: { readonly sent: Sent; readonly refresh: () => void }) {
  // Held from the click, so the dialog stays open if the payment's time passes under it.
  const [asking, setAsking] = useState<Scheduled | undefined>(undefined)
  const { invoice, summary } = sent
  const { payment } = invoice
  const scheduled: Scheduled | undefined = summary !== undefined && isWaitingForItsTime(summary) ? summary : undefined

  return (
    <section className="card">
      <div className="card-columns">
        <div>
          <p className="card-value">{invoice.description}</p>
          <dl className="figures">
            <Figure label="Amount">{formatUsdc(invoice.amount)} USDC</Figure>
            <Figure label="Status">{payment.status}</Figure>
            <Figure label="Reference">
              <Link to={`/admin/transfers/${payment.reference}`}>{payment.reference}</Link> <CopyButton text={payment.reference} />
            </Figure>
            {summary?.executeAt !== undefined && (
              <Figure label="Runs at">
                {MOMENT.format(new Date(summary.executeAt))}
                {scheduled !== undefined && ` (${fromNow(scheduled.executeAt)})`}
              </Figure>
            )}
          </dl>

          {inFlight(payment) !== undefined && scheduled === undefined && (
            <p className="card-note is-busy">
              <span className="spinner" aria-hidden="true" />
              {inFlight(payment)}
            </p>
          )}

          {payment.reason !== undefined && <p className="card-value is-bad">{REASONS[payment.reason]}</p>}

          {scheduled !== undefined && (
            <p className="card-actions">
              <button
                type="button"
                className="button"
                onClick={() => {
                  setAsking(scheduled)
                }}
              >
                Cancel
              </button>
            </p>
          )}
        </div>

        <div>
          <p className="address-sub">Pays to</p>
          <AddressLine address={invoice.destination.address} explorerUrl={invoice.destination.explorerUrl} />

          {payment.transaction !== undefined && (
            <>
              <p className="address-sub">Transaction hash</p>
              <AddressLine address={payment.transaction.hash} explorerUrl={payment.transaction.explorerUrl} short />
            </>
          )}
        </div>
      </div>

      {asking !== undefined && (
        <CancelDialog
          payment={asking}
          onClose={() => {
            setAsking(undefined)
            refresh()
          }}
        />
      )}
    </section>
  )
}

/**
 * The invoice just written. `GET /payables` answers newest first, and this checks the row against
 * all four things that were typed, because the next step pays it with real money.
 */
function justCreated(payables: readonly PayableSummary[], typed: Typed): PayableSummary {
  const newest = payables[0]
  const isTheOne =
    newest !== undefined &&
    newest.partnerName === null &&
    newest.description === typed.note &&
    newest.destination.address.toLowerCase() === typed.destination.trim().toLowerCase() &&
    sameAmount(newest.amount, typed.amount)
  if (!isTheOne) {
    throw new Error('the invoice was written, but it is not the newest one on Invoices to pay. Open that screen and pay it there.')
  }
  return newest
}

/** A `datetime-local` value reads local time, which is what a person means, so the UTC one is shifted back. */
function minutesAhead(minutes: number): string {
  const at = new Date(Date.now() + minutes * 60_000)
  return new Date(at.getTime() - at.getTimezoneOffset() * 60_000).toISOString().slice(0, 16)
}

/** What was typed, as the api formats it back: "0.02" and "0.020000" are the same money. */
function sameAmount(formatted: string, typed: string): boolean {
  return Number(formatted.replace(/,/g, '')) === Number(typed.trim())
}
