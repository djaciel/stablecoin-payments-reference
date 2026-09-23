import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { failedAfterReserving, type LedgerFigures, type PayableSummary, type Payables, type PaymentFailureReason, type PaymentView } from '@payments/domain'
import { createPayable, getPayables, payPayable } from '../api/client'
import { usePolling } from '../api/usePolling'
import { AddressLine, CopyButton } from '../app/AddressLine'

/** Small on purpose: every invoice paid here spends real testnet USDC from the treasury. */
const DEFAULT_AMOUNT = '0.50'

/** What an invoice or a payment with no partner reads, wherever one shows: it is a destination, not a gap. */
export const TO_AN_ADDRESS = 'Pay to an address'

/** Why a payment failed, in the article's words. The api's code stays on screen under it. */
export const REASONS: Record<PaymentFailureReason, string> = {
  insufficient_funds: 'Available was less than this amount.',
  payable_not_open: 'The invoice was already being paid.',
  partner_inactive: 'The partner was not active.',
  destination_not_allowlisted: 'The destination was not on the allowlist.',
  amount_out_of_range: 'The amount was outside the payment limits.',
  compliance_rejected: 'The compliance check refused the destination.',
  reverted: 'The transfer reached the chain and reverted.',
  cancelled: 'The payment was cancelled before anything was signed.',
}

/** Where a signed payment stands, in the article's words (§7). */
const SIGNED_MOMENTS: Partial<Record<PaymentView['status'], string>> = {
  RESERVED: 'Signed, not sent yet.',
  SENT: 'Sent, waiting for the network.',
  SETTLED: 'Paid: its block is final and its receipt carries the official Transfer event. Reserved and Partner debt went down.',
}

/**
 * The invoices the company owes, the books they move, and Pay: paying one records the payment
 * and reserves its amount, and only then does its workflow have it signed and send it.
 */
export function PayablesScreen() {
  const polled = usePolling(getPayables)
  // The poll, a new invoice and a Pay all write here, so what they change shows at once
  // instead of on the next tick.
  const [payables, setPayables] = useState<Payables | undefined>(undefined)

  useEffect(() => {
    if (polled.data !== undefined) {
      setPayables(polled.data)
    }
  }, [polled.data])

  // After a Pay the screen is read again, so the row and the books show what the api holds and
  // never what the browser assumes happened. A failed read is left for the poll to report.
  const refresh = (): Promise<void> => getPayables().then(setPayables, () => undefined)

  if (payables === undefined) {
    return <p className="card-note">{polled.error === undefined ? 'reading…' : `unavailable — ${polled.error}`}</p>
  }

  return (
    <>
      {polled.error !== undefined && (
        <p className="card-value is-bad">unavailable — {polled.error}. What follows is the api's last answer.</p>
      )}

      <Books ledger={payables.ledger} />

      <CreatePayable partners={payables.partners} onCreated={setPayables} />

      {payables.payables.length === 0 ? (
        <p className="card-note">No invoices yet.</p>
      ) : (
        <div className="cards">
          {payables.payables.map((invoice) => (
            <PayableCard key={invoice.id} invoice={invoice} refresh={refresh} />
          ))}
        </div>
      )}
    </>
  )
}

function Books({ ledger }: { readonly ledger: LedgerFigures }) {
  return (
    <section className="panel">
      <h2 className="card-title">Books</h2>
      <dl className="figures">
        <Figure label="Available">{ledger.available} USDC</Figure>
        <Figure label="Reserved">{ledger.reserved} USDC</Figure>
        <Figure label="Partner debt">{ledger.partnerDebt} USDC</Figure>
      </dl>
      <p className="card-note">
        An invoice adds to Partner debt (Dr <code>expense:services</code> / Cr <code>partner:payable</code>). Paying
        it moves its amount from Available to Reserved, before anything is signed.
      </p>
    </section>
  )
}

function PayableCard({ invoice, refresh }: { readonly invoice: PayableSummary; readonly refresh: () => Promise<void> }) {
  const [asking, setAsking] = useState(false)
  const [paying, setPaying] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  // The attempt's idempotency key (§4): made on the first Pay and sent again on every Pay until
  // the api answers, which is why a retry after a lost answer is the same payment, never a second
  // one. Any answer ends the attempt: an invoice that reopens after a revert must be paid with a new
  // key, because the old one would only replay the payment that reverted.
  const attemptKey = useRef<string | undefined>(undefined)

  const pay = (): void => {
    attemptKey.current ??= crypto.randomUUID()
    setPaying(true)
    setFailure(undefined)
    payPayable(invoice.id, attemptKey.current)
      .then(async () => {
        attemptKey.current = undefined
        await refresh()
        setAsking(false)
      })
      .catch((error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        setPaying(false)
      })
  }

  const { payment } = invoice

  return (
    <section className="card">
      <h2 className="card-title">{invoice.partnerName ?? TO_AN_ADDRESS}</h2>
      <p className="card-value">{invoice.description}</p>
      <dl className="figures">
        <Figure label="Amount">{invoice.amount} USDC</Figure>
        <Figure label="Invoice">{invoice.status}</Figure>
        {payment !== null && (
          <>
            <Figure label="Payment">{payment.status}</Figure>
            <Figure label="Reference">
              <Link to={`/admin/transfers/${payment.reference}`}>{payment.reference}</Link> <CopyButton text={payment.reference} />
            </Figure>
          </>
        )}
      </dl>

      {payment?.reason !== undefined && (
        <>
          <p className="card-value is-bad">
            {REASONS[payment.reason]}{' '}
            {failedAfterReserving(payment.reason) ? 'Nothing moved onchain, and the money is back in Available.' : 'Nothing was reserved.'}
          </p>
          <p className="card-note">
            <code>{payment.reason}</code>
          </p>
        </>
      )}

      {/* Signed or not: a REVIEW before the broadcast may have no hash yet, and still holds the money. */}
      {payment?.status === 'REVIEW' && <p className="card-value">In REVIEW: no proof either way, so the money stays reserved.</p>}

      {payment?.transaction !== undefined && (
        <>
          {SIGNED_MOMENTS[payment.status] !== undefined && <p className="card-value">{SIGNED_MOMENTS[payment.status]}</p>}
          <p className="address-sub">The transaction (its hash is stored before anything is sent)</p>
          <AddressLine address={payment.transaction.hash} explorerUrl={payment.transaction.explorerUrl} />
        </>
      )}

      {invoice.status === 'OPEN' && (
        <p className="card-actions">
          <button
            type="button"
            className="button"
            disabled={paying}
            onClick={() => {
              setAsking(true)
            }}
          >
            {paying ? 'paying…' : 'Pay'}
          </button>
        </p>
      )}

      <p className="address-sub">
        {invoice.partnerName === null
          ? 'You pay here (the address typed when the invoice was created)'
          : 'You pay them here (their payout address, copied when the invoice was created)'}
      </p>
      <AddressLine address={invoice.destination.address} explorerUrl={invoice.destination.explorerUrl} />

      {asking && (
        <PayDialog
          invoice={invoice}
          paying={paying}
          failure={failure}
          onPay={pay}
          onClose={() => {
            setAsking(false)
          }}
        />
      )}
    </section>
  )
}

/** Says what Pay does before it does it: the money is held now, and the chain comes later. */
function PayDialog({
  invoice,
  paying,
  failure,
  onPay,
  onClose,
}: {
  readonly invoice: PayableSummary
  readonly paying: boolean
  readonly failure: string | undefined
  readonly onPay: () => void
  readonly onClose: () => void
}) {
  return (
    <div className="modal-backdrop">
      <section className="modal" role="dialog" aria-modal="true" aria-label="Pay invoice">
        <h2 className="card-title">Pay invoice</h2>
        <p className="panel-lead">
          Paying reserves <strong>{invoice.amount} USDC</strong> now: the amount moves from Available to Reserved, so
          no other payment can spend it. Then the payment's workflow has it signed and sends it, and this row follows
          it until it is paid.
        </p>
        <p className="card-note">
          To {invoice.partnerName ?? 'this address'}, for “{invoice.description}”:
        </p>
        <p className="card-value is-address">{invoice.destination.address}</p>

        {failure !== undefined && (
          <>
            <p className="card-value is-bad">{failure}</p>
            <p className="card-note">Pay again to retry: it sends the same idempotency key, so it cannot pay twice.</p>
          </>
        )}

        <p className="card-actions">
          <button type="button" className="button" disabled={paying} onClick={onPay}>
            {paying ? 'paying…' : 'Pay'}
          </button>
          <button type="button" className="link-button" onClick={onClose}>
            Cancel
          </button>
        </p>
      </section>
    </div>
  )
}

function CreatePayable({
  partners,
  onCreated,
}: {
  readonly partners: Payables['partners']
  readonly onCreated: (payables: Payables) => void
}) {
  // Empty until someone picks one: the select then shows the first partner.
  const [partnerId, setPartnerId] = useState('')
  const [amount, setAmount] = useState(DEFAULT_AMOUNT)
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const selected = partnerId === '' ? (partners[0]?.id ?? '') : partnerId

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    createPayable({ partnerId: selected, amount, description })
      .then((payables) => {
        setDescription('')
        onCreated(payables)
      })
      .catch((failure: unknown) => {
        setError(failure instanceof Error ? failure.message : String(failure))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <section className="panel">
      <h2 className="card-title">New invoice</h2>
      <form className="form-row" onSubmit={submit}>
        <select
          className="field"
          value={selected}
          onChange={(event) => {
            setPartnerId(event.target.value)
          }}
          aria-label="Partner"
        >
          {partners.map((partner) => (
            <option key={partner.id} value={partner.id}>
              {partner.name}
            </option>
          ))}
        </select>
        <span className="field-unit">
          <input
            className="field is-short"
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value)
            }}
            inputMode="decimal"
            placeholder="0.50"
            aria-label="Amount in USDC"
          />
          USDC
        </span>
        <input
          className="field"
          value={description}
          onChange={(event) => {
            setDescription(event.target.value)
          }}
          placeholder="Description"
          aria-label="Description"
        />
        <button type="submit" className="button" disabled={busy || selected === ''}>
          {busy ? 'creating…' : 'Create'}
        </button>
      </form>
      {error === undefined ? (
        <p className="card-note">The partner's payout address is copied onto the invoice as its destination.</p>
      ) : (
        <p className="card-value is-bad">{error}</p>
      )}
    </section>
  )
}

/** One line of a figures list: the label a human reads, the value the api sent, unrounded. */
function Figure({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="figure">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}
