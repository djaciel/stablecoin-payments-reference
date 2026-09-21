import { useEffect, useState, type FormEvent } from 'react'
import { createPartner, getPartners, type AddressBalance, type Partners } from '../api/client'
import { usePolling } from '../api/usePolling'
import { AddressLine } from '../app/AddressLine'

/**
 * Two addresses per partner, from two different seeds, side by side — which is the whole
 * lesson of this screen: the company controls where a partner PAYS (so an arriving transfer
 * says who paid), and the partner controls where it GETS paid. The payout column is demo
 * scaffolding: in a real system those keys belong to somebody else entirely.
 */
export function PartnersScreen() {
  const polled = usePolling(getPartners)
  // Both the poll and a successful creation write here, so the new partner shows up at once
  // instead of on the next tick, and the poll takes over again from the answer after it.
  const [partners, setPartners] = useState<Partners | undefined>(undefined)

  useEffect(() => {
    if (polled.data !== undefined) {
      setPartners(polled.data)
    }
  }, [polled.data])

  return (
    <>
      <CreatePartner onCreated={setPartners} />

      {partners === undefined ? (
        <p className="card-note">{polled.error === undefined ? 'reading…' : `unavailable — ${polled.error}`}</p>
      ) : (
        <>
          {partners.chainError !== undefined && <p className="card-value is-bad">{partners.chainError}</p>}
          <div className="cards">
            {partners.partners.map((partner) => (
              <section className="card" key={partner.id}>
                <h2 className="card-title">
                  {partner.name} · index {partner.derivationIndex}
                </h2>

                <AddressBlock
                  heading="They pay you here"
                  sub="deposit address, derived from the company seed"
                  address={partner.deposit}
                  emptyNote="Nothing paid in yet."
                  fundedNote="On chain, and not in the books yet: crediting a deposit to the partner it belongs to arrives with receivables."
                />

                <AddressBlock
                  heading="You pay them here"
                  sub="their wallet, on the allowlist"
                  address={partner.payout}
                  secondary
                  emptyNote="Nothing paid out yet."
                  fundedNote="The partner's own money. It never appears on the company's books."
                />
              </section>
            ))}
          </div>

          <p className="card-note">
            {partners.blockNumber === null
              ? 'Addresses from the database; balances unavailable.'
              : `Balances read at block ${partners.blockNumber}.`}{' '}
            Payout addresses come from the partner seed, which this demo holds only because one machine has to
            play both sides.
          </p>
        </>
      )}
    </>
  )
}

interface AddressBlockProps {
  readonly heading: string
  readonly sub: string
  readonly address: AddressBalance
  /** The payout address: still shown, but it is not the one this screen is teaching. */
  readonly secondary?: boolean
  readonly emptyNote: string
  readonly fundedNote: string
}

function AddressBlock({ heading, sub, address, secondary = false, emptyNote, fundedNote }: AddressBlockProps) {
  // Three states, not two: unknown is not zero. When the RPC is down the note has to say the
  // balance could not be read, or the screen quietly claims nobody has paid.
  const note = address.usdc === null ? 'Balance unknown: the chain could not be read.' : Number(address.usdc) === 0 ? emptyNote : fundedNote

  return (
    <div className={secondary ? 'address-block is-secondary' : 'address-block'}>
      <h3 className="address-heading">{heading}</h3>
      <p className="address-sub">{sub}</p>
      <AddressLine address={address.address} explorerUrl={address.explorerUrl} />
      <dl className="figures">
        <div className="figure">
          <dt>USDC</dt>
          <dd>{address.usdc ?? '—'}</dd>
        </div>
      </dl>
      <p className="card-note">{note}</p>
    </div>
  )
}

/**
 * One field, because a partner is a name: both addresses are derived from it by the api,
 * the deposit one by the signer and the payout one by the demo scaffolding.
 */
function CreatePartner({ onCreated }: { readonly onCreated: (partners: Partners) => void }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    setBusy(true)
    setError(undefined)
    createPartner(name)
      .then((partners) => {
        setName('')
        onCreated(partners)
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
      <h2 className="card-title">Add a partner</h2>
      <form className="form-row" onSubmit={submit}>
        <input
          className="field"
          value={name}
          onChange={(event) => {
            setName(event.target.value)
          }}
          placeholder="Partner name"
          aria-label="Partner name"
        />
        <button type="submit" className="button" disabled={busy}>
          {busy ? 'creating…' : 'Create'}
        </button>
      </form>
      {error === undefined ? (
        <p className="card-note">
          Creating one takes the next index, asks the signer for the deposit address at that index, derives the
          payout address from the partner seed, and starts watching the deposit address — all at once, or not at all.
        </p>
      ) : (
        <p className="card-value is-bad">{error}</p>
      )}
    </section>
  )
}
