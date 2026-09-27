import { useEffect, useState, type FormEvent } from 'react'
import type { ReceivableFigures, Receivables } from '@payments/domain'
import { createReceivable, getReceivables } from '../api/client'
import { usePolling } from '../api/usePolling'
import { formatUsdc } from '../app/usdc'
import { BookCard } from './PayablesScreen'

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

/** The two figures this screen moves, one small card per figure, in one row. */
function Books({ ledger }: { readonly ledger: ReceivableFigures }) {
  return (
    <div className="figure-cards">
      <BookCard label="Partner receivables" amount={ledger.receivable} note="What partners owe you on unpaid invoices." />
      <BookCard label="Deposits" amount={ledger.deposits} note="Partner money that arrived at their internal addresses." />
    </div>
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
              <th>Transaction</th>
            </tr>
          </thead>
          <tbody>
            {receivables.map((invoice) => (
              <tr key={invoice.id}>
                <td>{invoice.partnerName}</td>
                <td>{invoice.description}</td>
                <td className="is-number">{formatUsdc(invoice.amount)} USDC</td>
                <td>{invoice.status}</td>
                <td>
                  {/* The hash the partner stored before broadcasting: the company reads it here
                      before its own watcher has seen a thing. Shortened because it shares a row
                      with four other columns; /partner prints it in full, to paste. */}
                  {invoice.transaction === null ? (
                    '—'
                  ) : (
                    <a href={invoice.transaction.explorerUrl} target="_blank" rel="noreferrer">
                      {shortHash(invoice.transaction.hash)}
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="card-note">Partners pay these from /partner.</p>
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
  const [amount, setAmount] = useState('')
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
            placeholder="0.01"
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
      {error !== undefined && <p className="card-value is-bad">{error}</p>}
    </section>
  )
}

/** Enough of a hash to recognise it next to the explorer, without eating the row. */
function shortHash(hash: string): string {
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`
}
