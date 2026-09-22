import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { ReceivableFigures, Receivables } from '@payments/domain'
import { createReceivable, getReceivables } from '../api/client'
import { usePolling } from '../api/usePolling'

/** Small on purpose: the partner pays these with real testnet USDC from the shared wallet. */
const DEFAULT_AMOUNT = '0.05'

/**
 * The money partners owe the company. Writing one puts it on the books right away; nothing has
 * moved yet, and nothing moves here: these invoices are paid from the partner's side.
 */
export function ReceivablesScreen() {
  const polled = usePolling(getReceivables)
  // Both the poll and a new invoice write here, so what they change shows at once.
  const [receivables, setReceivables] = useState<Receivables | undefined>(undefined)

  useEffect(() => {
    if (polled.data !== undefined) {
      setReceivables(polled.data)
    }
  }, [polled.data])

  if (receivables === undefined) {
    return <p className="card-note">{polled.error === undefined ? 'reading…' : `unavailable — ${polled.error}`}</p>
  }

  return (
    <>
      {polled.error !== undefined && (
        <p className="card-value is-bad">unavailable — {polled.error}. What follows is the api's last answer.</p>
      )}

      <Books ledger={receivables.ledger} />

      <CreateReceivable partners={receivables.partners} onCreated={setReceivables} />

      <ReceivableTable receivables={receivables.receivables} />
    </>
  )
}

function Books({ ledger }: { readonly ledger: ReceivableFigures }) {
  return (
    <section className="panel">
      <h2 className="card-title">Books</h2>
      <dl className="figures">
        <Figure label="Partner receivables">{ledger.receivable} USDC</Figure>
        <Figure label="Deposits">{ledger.deposits} USDC</Figure>
      </dl>
      <p className="card-note">
        An invoice here adds to Partner receivables (Dr <code>partner:receivable</code> / Cr{' '}
        <code>revenue:services</code>): money a partner owes you, written down the moment you invoice it. It is not a
        payment, so Available and Reserved do not move. They move when the money actually arrives at that partner's
        deposit address.
      </p>
    </section>
  )
}

function ReceivableTable({ receivables }: { readonly receivables: Receivables['receivables'] }) {
  if (receivables.length === 0) {
    return <p className="card-note">No invoices yet.</p>
  }

  return (
    <section className="panel">
      <h2 className="card-title">Invoices, newest first</h2>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Partner</th>
              <th>Description</th>
              <th className="is-number">Amount</th>
              <th>State</th>
            </tr>
          </thead>
          <tbody>
            {receivables.map((invoice) => (
              <tr key={invoice.id}>
                <td>{invoice.partnerName}</td>
                <td>{invoice.description}</td>
                <td className="is-number">{invoice.amount} USDC</td>
                <td>{invoice.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="card-note">There is no Pay button here: the partner pays these from its own side, on /partner.</p>
    </section>
  )
}

function CreateReceivable({
  partners,
  onCreated,
}: {
  readonly partners: Receivables['partners']
  readonly onCreated: (receivables: Receivables) => void
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
    createReceivable({ partnerId: selected, amount, description })
      .then((receivables) => {
        setDescription('')
        onCreated(receivables)
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
            placeholder="0.05"
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
        <p className="card-note">The partner sees it on its own screen, next to the deposit address it pays at.</p>
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
