import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import type { Allowlist, PayableSummary, PaymentView } from '@payments/domain'
import { addToAllowlist, createPayable, getAllowlist, payPayable } from '../api/client'
import { usePolling } from '../api/usePolling'
import { REASONS, TO_AN_ADDRESS } from './PayablesScreen'
import { MOMENT } from './TransfersScreen'

/** Small on purpose: every payment from here spends real testnet USDC from the treasury. */
const DEFAULT_AMOUNT = '0.02'

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
  const polled = usePolling(getAllowlist)
  // The poll and a new address both write here, so what they change shows at once.
  const [allowlist, setAllowlist] = useState<Allowlist | undefined>(undefined)
  const [destination, setDestination] = useState('')
  const [amount, setAmount] = useState(DEFAULT_AMOUNT)
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
      setAllowlist(polled.data)
    }
  }, [polled.data])

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
              placeholder={DEFAULT_AMOUNT}
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
            placeholder="What it is for"
            aria-label="What it is for"
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
        <p className="card-note">
          This writes the invoice first and then pays it: the demo has one path to a payment, so an amount typed here
          becomes a debt on the books and goes through the same checks as an invoice to a partner. At a time, the checks
          run and the money is set aside right now; only the transfer waits, and it leaves within about ten seconds of
          the time you pick.
        </p>
        {failure !== undefined && <p className="card-value is-bad">{failure}</p>}
      </section>

      {invoice !== undefined && (
        <Attempt
          invoice={invoice}
          payment={payment}
          busy={busy}
          onAdded={setAllowlist}
          onPayAgain={() => {
            run(pay(invoice.id))
          }}
        />
      )}

      <AllowlistPanel allowlist={allowlist} onUse={setDestination} />
    </>
  )
}

/** The invoice and what the door answered: refused with nothing reserved, or the money set aside. */
function Attempt({
  invoice,
  payment,
  busy,
  onAdded,
  onPayAgain,
}: {
  readonly invoice: PayableSummary
  readonly payment: PaymentView | undefined
  readonly busy: boolean
  readonly onAdded: (allowlist: Allowlist) => void
  readonly onPayAgain: () => void
}) {
  return (
    <section className="panel">
      {/* Not "Pay to an address" again: the form above carries that title, and this panel is what
          came back from it. */}
      <h2 className="card-title">The invoice, and what the door said</h2>
      {/* The invoice's own status is not repeated here: it is read once, when it is written, and
          where it stands afterwards is what the payment below says. */}
      <p className="card-value">
        {invoice.amount} USDC for “{invoice.description}”
      </p>
      <p className="card-value is-address">{invoice.destination.address}</p>

      {payment?.status === 'FAILED' && payment.reason !== undefined && (
        <>
          <p className="card-value is-bad">
            {REASONS[payment.reason]} Nothing was reserved, and the invoice is still open.
          </p>
          <p className="card-note">
            <code>{payment.reason}</code> · payment {payment.reference}
          </p>
          {payment.reason === 'destination_not_allowlisted' && (
            <AddToAllowlist address={invoice.destination.address} onAdded={onAdded} />
          )}
          <p className="card-actions">
            <button type="button" className="button" disabled={busy} onClick={onPayAgain}>
              {busy ? 'paying…' : 'Pay again'}
            </button>
          </p>
          <p className="card-note">Pay again is a new attempt with a new key: the old one would only replay this refusal.</p>
        </>
      )}

      {payment !== undefined && payment.status !== 'FAILED' && (
        <p className="card-value">
          Payment <Link to={`/admin/transfers/${payment.reference}`}>{payment.reference}</Link> is {payment.status}:{' '}
          {payment.amount} USDC moved from Available to Reserved
          {payment.executeAt === undefined
            ? ', and only then is it signed and sent.'
            : ` now, and it runs at ${MOMENT.format(new Date(payment.executeAt))}. Nothing is signed until then.`}
        </p>
      )}
    </section>
  )
}

/** The one-click fix for the refusal above: the address the invoice already carries, plus a label. */
function AddToAllowlist({ address, onAdded }: { readonly address: string; readonly onAdded: (allowlist: Allowlist) => void }) {
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [added, setAdded] = useState(false)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    addToAllowlist({ address, label })
      .then((allowlist) => {
        onAdded(allowlist)
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
    return <p className="card-value">On the allowlist now. Pay again and the door will let it through.</p>
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

function AllowlistPanel({
  allowlist,
  onUse,
}: {
  readonly allowlist: Allowlist | undefined
  readonly onUse: (address: string) => void
}) {
  if (allowlist === undefined) {
    return <p className="card-note">reading…</p>
  }

  return (
    <section className="panel">
      <h2 className="card-title">Addresses the company may pay</h2>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Partner</th>
              <th>Address</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {allowlist.addresses.map((allowed) => (
              <tr key={allowed.address}>
                <td>{allowed.label}</td>
                <td>{allowed.partnerName ?? 'typed in'}</td>
                <td className="is-mono">{allowed.address}</td>
                <td>
                  <button
                    type="button"
                    className="link-button"
                    onClick={() => {
                      onUse(allowed.address)
                    }}
                  >
                    use it
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="card-note">
        A partner's payout address is registered here when the partner is created; anything else somebody added by
        hand. In a real system this list is a reviewed control, with approval and someone answering for each row; this
        demo has no auth, and where it plugs in is documented like compliance and custody.
      </p>
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
    throw new Error('the invoice was written, but it is not the newest one on Payables. Open that screen and pay it there.')
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
