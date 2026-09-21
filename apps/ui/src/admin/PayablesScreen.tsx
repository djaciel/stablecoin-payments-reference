import { useEffect, useState, type FormEvent } from 'react'
import type { Payables } from '@payments/domain'
import { createPayable, getPayables } from '../api/client'
import { usePolling } from '../api/usePolling'
import { AddressLine } from '../app/AddressLine'

/** Small on purpose: the books on this machine hold about 2 USDC, and paying comes next. */
const DEFAULT_AMOUNT = '0.50'

/**
 * The invoices the company owes, and the figure they add up to on the books. Nothing is paid
 * here: an invoice is a debt, and the money only moves when somebody pays it.
 */
export function PayablesScreen() {
  const polled = usePolling(getPayables)
  // Both the poll and a successful creation write here, so the new invoice and the higher
  // debt show at once instead of on the next tick.
  const [payables, setPayables] = useState<Payables | undefined>(undefined)

  useEffect(() => {
    if (polled.data !== undefined) {
      setPayables(polled.data)
    }
  }, [polled.data])

  if (payables === undefined) {
    return <p className="card-note">{polled.error === undefined ? 'reading…' : `unavailable — ${polled.error}`}</p>
  }

  return (
    <>
      <section className="panel">
        <h2 className="card-title">Partner debt</h2>
        <p className="card-value">{payables.partnerDebt} USDC</p>
        <p className="card-note">
          Creating an invoice puts it on the books: the company owes this now (Dr <code>expense:services</code> / Cr{' '}
          <code>partner:payable</code>). The same figure is on the Start screen.
        </p>
      </section>

      <CreatePayable partners={payables.partners} onCreated={setPayables} />

      {payables.payables.length === 0 ? (
        <p className="card-note">No invoices yet.</p>
      ) : (
        <div className="cards">
          {payables.payables.map((invoice) => (
            <section className="card" key={invoice.id}>
              <h2 className="card-title">{invoice.partnerName ?? 'no partner'}</h2>
              <p className="card-value">{invoice.description}</p>
              <dl className="figures">
                <div className="figure">
                  <dt>Amount</dt>
                  <dd>{invoice.amount} USDC</dd>
                </div>
                <div className="figure">
                  <dt>Status</dt>
                  <dd>{invoice.status}</dd>
                </div>
              </dl>
              <p className="address-sub">You pay them here (their payout address, copied when the invoice was created)</p>
              <AddressLine address={invoice.destination.address} explorerUrl={invoice.destination.explorerUrl} />
            </section>
          ))}
        </div>
      )}
    </>
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
