import { useCallback, useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { PartnerPaymentReceipt, PartnerView, ReceivableSummary } from '@payments/domain'
import { getPartnerView, payReceivable } from '../api/client'
import { usePolling } from '../api/usePolling'
import { AddressLine } from '../app/AddressLine'

/** The selection lives in the address bar, so a reload (or a shared link) keeps the same partner. */
const PARTNER_PARAM = 'partner'

/** What paying does, in the order it happens. Shown before, not narrated during. */
const PAYMENT_STEPS = [
  'signed — the transfer is signed with the wallet below, and its hash goes on the invoice before anything is sent',
  'sent — the raw bytes go to the chain under that same hash, and the invoice turns PAYING',
  'paid — paid is the company’s to decide: it credits this when its own watcher sees the money and the event checks out',
]

/**
 * The sentence that keeps "sent" and "paid" apart, for a PAYING row on a screen that was just
 * reloaded. A fresh receipt carries the api's own copy of it (`PartnerPaymentReceipt.credit`).
 */
const NOT_CREDITED_YET =
  'The company has not credited anything yet: its watcher credits this once the block is final and the event checks out.'

/**
 * What a partner sees: what it owes, the one address it pays at, the wallet it pays from, and
 * the button that actually pays.
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
  // The invoice the confirmation is open for, and whether its payment is on its way.
  const [asking, setAsking] = useState<ReceivableSummary | undefined>(undefined)
  const [paying, setPaying] = useState(false)

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

  // After a payment the screen is read again, so the row and the balances show what the api
  // holds and never what the browser assumes happened. A failed read is left for the poll.
  const refresh = (): Promise<void> => getPartnerView(partnerId).then(setKept, () => undefined)

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
          <Owed view={view} paying={paying} onPay={setAsking} />

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
              would sign with your own. The ETH is there to pay the fees, which are never paid in stablecoin.
            </p>
          </section>
        </div>
      )}

      <p className="card-note">
        {view.blockNumber === null ? 'Balances unavailable.' : `Balances read at block ${view.blockNumber}.`}
      </p>

      {asking !== undefined && view.partner !== null && (
        <PayDialog
          invoice={asking}
          depositAddress={view.partner.deposit.address}
          onPaying={setPaying}
          onPaid={refresh}
          onClose={() => {
            setAsking(undefined)
          }}
        />
      )}
    </>
  )
}

function Owed({
  view,
  paying,
  onPay,
}: {
  readonly view: PartnerView
  readonly paying: boolean
  readonly onPay: (invoice: ReceivableSummary) => void
}) {
  const sent = view.receivables.filter((invoice) => invoice.status === 'PAYING')

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
                <th aria-label="Pay" />
              </tr>
            </thead>
            <tbody>
              {view.receivables.map((invoice) => (
                <tr key={invoice.id}>
                  <td>{invoice.description}</td>
                  <td className="is-number">{invoice.amount} USDC</td>
                  <td>{invoice.status}</td>
                  <td>
                    {invoice.status === 'OPEN' && (
                      <button
                        type="button"
                        className="button"
                        // One wallet, one nonce: while a payment is on its way the api refuses a
                        // second one anyway, and a disabled button says so before the click.
                        disabled={paying}
                        onClick={() => {
                          onPay(invoice)
                        }}
                      >
                        Pay
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {sent.map((invoice) =>
        invoice.transaction === null ? null : (
          <div key={invoice.id}>
            <p className="address-sub">
              “{invoice.description}”, sent (its hash was stored before anything was broadcast)
            </p>
            <AddressLine address={invoice.transaction.hash} explorerUrl={invoice.transaction.explorerUrl} />
          </div>
        ),
      )}
      {sent.length > 0 && <p className="card-note">{NOT_CREDITED_YET}</p>}
    </section>
  )
}

/**
 * Says what paying does before it does it, and shows what it did afterwards.
 *
 * The steps are a list and not a progress bar: the api does all of it inside one request, so a
 * bar would be an animation rather than a report.
 */
function PayDialog({
  invoice,
  depositAddress,
  onPaying,
  onPaid,
  onClose,
}: {
  readonly invoice: ReceivableSummary
  readonly depositAddress: string
  readonly onPaying: (paying: boolean) => void
  readonly onPaid: () => Promise<void>
  readonly onClose: () => void
}) {
  const [sending, setSending] = useState(false)
  const [receipt, setReceipt] = useState<PartnerPaymentReceipt | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const pay = (): void => {
    setSending(true)
    onPaying(true)
    setFailure(undefined)
    payReceivable(invoice.id)
      .then(async (paid) => {
        setReceipt(paid)
        await onPaid()
      })
      .catch((error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error))
        void onPaid()
      })
      .finally(() => {
        setSending(false)
        onPaying(false)
      })
  }

  return (
    <div className="modal-backdrop">
      <section className="modal" role="dialog" aria-modal="true" aria-label="Pay invoice">
        <h2 className="card-title">Pay invoice</h2>
        <p className="panel-lead">
          This sends <strong>{invoice.amount} USDC</strong> from the shared partner wallet to your own deposit
          address, in one transaction. In a real system you would sign this in your own wallet; this demo signs it
          for you with a second seed it keeps for the partners.
        </p>
        <p className="card-note">For “{invoice.description}”, to:</p>
        <p className="card-value is-address">{depositAddress}</p>

        <ol className="steps">
          {PAYMENT_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>

        {failure !== undefined && <p className="card-value is-bad">{failure}</p>}
        {receipt !== undefined && <PaymentReceipt receipt={receipt} />}

        <p className="card-actions">
          {receipt === undefined && (
            <button type="button" className="button" disabled={sending} onClick={pay}>
              {sending ? 'paying…' : 'Pay'}
            </button>
          )}
          <button type="button" className="link-button" onClick={onClose}>
            {receipt === undefined ? 'Cancel' : 'Close'}
          </button>
        </p>
      </section>
    </div>
  )
}

/** Copy-paste-clean on purpose: the hash, the link and the two figures, in plain text. */
function PaymentReceipt({ receipt }: { readonly receipt: PartnerPaymentReceipt }) {
  return (
    <div className="result">
      <p className="card-note">
        {receipt.amount} USDC, block {receipt.transaction.blockNumber}
      </p>
      <p className="card-value is-address">{receipt.transaction.hash}</p>
      <p className="card-actions">
        <a href={receipt.transaction.explorerUrl} target="_blank" rel="noreferrer">
          explorer
        </a>
      </p>
      {/* The two sentences come from the api, which is the side that knows: what it did about
          the money (nothing) and where its gas figure comes from. */}
      <p className="card-note">{receipt.credit} Until then the invoice stays PAYING.</p>
      <p className="card-note">
        Sending it cost {receipt.gasEth} ETH, paid in the network's own currency and never in stablecoin (
        {receipt.gasBasis}).
        {receipt.partnerWallet !== null &&
          ` The wallet now holds ${receipt.partnerWallet.usdc} USDC and ${receipt.partnerWallet.eth} ETH.`}
      </p>
    </div>
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
