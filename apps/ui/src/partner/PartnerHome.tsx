import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { PartnerView } from '@payments/domain'
import { getPartnerView } from '../api/client'
import { usePolling } from '../api/usePolling'
import { AddressLine } from '../app/AddressLine'

/** The selection lives in the address bar, so a reload (or a shared link) keeps the same partner. */
const PARTNER_PARAM = 'partner'

/**
 * What a partner sees: what it owes, the one address it pays at, and the wallet it pays from.
 *
 * The company's own addresses are not here. A partner has no business seeing where the company
 * pays it from, and this screen is the partner's.
 */
export function PartnerHome() {
  const [params, setParams] = useSearchParams()
  const partnerId = params.get(PARTNER_PARAM)

  // Wrapped, because `usePolling` restarts its timer whenever this function changes: it must
  // change when the chosen partner does, and not on every render.
  const read = useCallback(() => getPartnerView(partnerId), [partnerId])
  const polled = usePolling(read)
  // Kept here because one failed poll clears `polled.data`, and a blink of the api must not blank
  // the addresses and the invoices.
  const [kept, setKept] = useState<PartnerView | undefined>(undefined)

  useEffect(() => {
    if (polled.data !== undefined) {
      setKept(polled.data)
    }
  }, [polled.data])

  // The answer says which partner it is about, so a kept copy is never shown under another's name.
  const view = kept !== undefined && (partnerId === null || kept.partner?.id === partnerId) ? kept : undefined

  if (view === undefined) {
    return <p className="card-note">{polled.error === undefined ? 'reading…' : `unavailable — ${polled.error}`}</p>
  }

  const select = (id: string): void => {
    setParams({ [PARTNER_PARAM]: id })
  }

  return (
    <>
      {polled.error !== undefined && (
        <p className="card-value is-bad">unavailable — {polled.error}. What follows is the api's last answer.</p>
      )}

      <PartnerSelector view={view} onSelect={select} />
      {view.chainError !== undefined && <p className="card-value is-bad">{view.chainError}</p>}

      {view.partner === null ? (
        <p className="card-note">No partners yet. The company creates them on its own side.</p>
      ) : (
        <div className="cards">
          <Owed view={view} />

          <section className="card">
            <h2 className="card-title">Where you pay</h2>
            <AddressLine address={view.partner.deposit.address} explorerUrl={view.partner.deposit.explorerUrl} />
            <p className="card-note">
              This address is yours alone. It is how the company knows the money is yours: it does not guess by the
              amount or by who sent it, it knows by where it came in.
            </p>
          </section>

          <section className="card">
            <h2 className="card-title">Your wallet</h2>
            <AddressLine address={view.partnerWallet.address} explorerUrl={view.partnerWallet.explorerUrl} />
            <dl className="figures">
              <div className="figure">
                <dt>USDC</dt>
                <dd>{view.partnerWallet.usdc ?? '—'}</dd>
              </div>
              <div className="figure">
                <dt>ETH</dt>
                <dd>{view.partnerWallet.eth ?? '—'}</dd>
              </div>
            </dl>
            <p className="card-note">
              Demo scaffolding: every partner shares this wallet, and its keys live in this demo. In a real system you
              would sign with your own.
            </p>
          </section>
        </div>
      )}

      <p className="card-note">
        {view.blockNumber === null ? 'Balances unavailable.' : `Balances read at block ${view.blockNumber}.`}
      </p>
    </>
  )
}

function Owed({ view }: { readonly view: PartnerView }) {
  return (
    <section className="card">
      <h2 className="card-title">What you owe</h2>
      {view.receivables.length === 0 ? (
        <p className="card-note">Nothing invoiced to you yet.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Description</th>
                <th className="is-number">Amount</th>
                <th>State</th>
              </tr>
            </thead>
            <tbody>
              {view.receivables.map((invoice) => (
                <tr key={invoice.id}>
                  <td>{invoice.description}</td>
                  <td className="is-number">{invoice.amount} USDC</td>
                  <td>{invoice.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

function PartnerSelector({ view, onSelect }: { readonly view: PartnerView; readonly onSelect: (id: string) => void }) {
  return (
    <section className="panel">
      <h2 className="card-title">You are</h2>
      <form className="form-row">
        <select
          className="field"
          value={view.partner?.id ?? ''}
          onChange={(event) => {
            onSelect(event.target.value)
          }}
          aria-label="Partner"
        >
          {view.partners.map((partner) => (
            <option key={partner.id} value={partner.id}>
              {partner.name}
            </option>
          ))}
        </select>
      </form>
      <p className="card-note">Pick the partner you are playing. A real partner would be signed in as itself.</p>
    </section>
  )
}
