import { useState } from 'react'
import { getTreasury, type Treasury } from '../api/client'
import { usePolling } from '../api/usePolling'
import { HealthCard } from '../app/HealthCard'

/**
 * Where the demo starts: the one address a human has to fund, what the chain says it holds, and
 * what the books say about it.
 *
 * The two halves disagree on purpose while the ledger is empty, and the screen says so rather
 * than hiding it: money on chain is not money in the books until something posts it.
 *
 * One poll for the whole screen, so the three figures are read at the same moment.
 */

const USDC_FAUCET_URL = 'https://faucet.circle.com'
const GAS_FAUCET_URL = 'https://portal.cdp.coinbase.com/products/faucet'
const FAUCET_DOC = 'docs/dev/faucets.md'

export function StartScreen() {
  const { data, error } = usePolling(getTreasury)

  return (
    <>
      <div className="cards">
        <HealthCard />
        <TreasuryCard treasury={data} error={error} />
        <OnchainCard treasury={data} error={error} />
        <BooksCard treasury={data} error={error} />
      </div>

      <section className="panel">
        <h2 className="card-title">Fund the treasury</h2>
        <p className="panel-lead">
          The treasury needs <strong>both</strong>: testnet USDC, which is the money being moved, and Base Sepolia
          ETH, which pays the gas to move it. One without the other gets you a demo that cannot send anything.
        </p>
        <ul className="panel-links">
          <li>
            <a href={USDC_FAUCET_URL} target="_blank" rel="noreferrer">
              Circle faucet
            </a>{' '}
            — testnet USDC. Pick Base Sepolia and paste the treasury address.
          </li>
          <li>
            <a href={GAS_FAUCET_URL} target="_blank" rel="noreferrer">
              Coinbase Developer Platform faucet
            </a>{' '}
            — Base Sepolia ETH for gas.
          </li>
        </ul>
        <p className="card-note">
          More faucets, and what to do when one of them refuses you: <code>{FAUCET_DOC}</code> in this repo.
        </p>
      </section>
    </>
  )
}

interface CardProps {
  readonly treasury: Treasury | undefined
  readonly error: string | undefined
}

function TreasuryCard({ treasury, error }: CardProps) {
  const [copied, setCopied] = useState(false)

  if (error !== undefined || treasury === undefined) {
    return <Card title="Treasury address">{placeholder(error)}</Card>
  }

  const copy = (): void => {
    void navigator.clipboard.writeText(treasury.address).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <Card title="Treasury address">
      <p className="card-value is-address">{treasury.address}</p>
      <p className="card-actions">
        <button type="button" className="link-button" onClick={copy}>
          {copied ? 'copied' : 'copy'}
        </button>
        <a href={treasury.explorerUrl} target="_blank" rel="noreferrer">
          explorer
        </a>
      </p>
      <p className="card-note">Derived from the company seed by the signer. This is the address the faucets fund.</p>
    </Card>
  )
}

function OnchainCard({ treasury, error }: CardProps) {
  if (error !== undefined || treasury === undefined) {
    return <Card title="Onchain">{placeholder(error)}</Card>
  }

  if (treasury.onchain === null) {
    return (
      <Card title="Onchain">
        <p className="card-value is-bad">{treasury.chainError ?? 'the chain is unreachable.'}</p>
        <p className="card-note">Everything else on this page comes from the api and its database, and is unaffected.</p>
      </Card>
    )
  }

  return (
    <Card title="Onchain">
      <Figures rows={[['USDC', treasury.onchain.usdc], ['ETH', treasury.onchain.eth]]} />
      <p className="card-note">
        ETH pays the gas, USDC is the money. Read at block {treasury.onchain.blockNumber}.
      </p>
    </Card>
  )
}

function BooksCard({ treasury, error }: CardProps) {
  if (error !== undefined || treasury === undefined) {
    return <Card title="Books">{placeholder(error)}</Card>
  }

  return (
    <Card title="Books">
      <Figures
        rows={[
          ['Available', treasury.ledger.available],
          ['Reserved', treasury.ledger.reserved],
          ['Partner debt', treasury.ledger.partnerDebt],
        ]}
      />
      <p className="card-note">
        The ledger, in USDC. It does not follow the chain on its own: only a posting changes these figures, which is
        why they can sit still while the balance above changes.
      </p>
    </Card>
  )
}

function Card({ title, children }: { readonly title: string; readonly children: React.ReactNode }) {
  return (
    <section className="card">
      <h2 className="card-title">{title}</h2>
      {children}
    </section>
  )
}

/** Two columns of money: the label a human reads, the figure the api sent, unrounded. */
function Figures({ rows }: { readonly rows: readonly (readonly [string, string])[] }) {
  return (
    <dl className="figures">
      {rows.map(([label, value]) => (
        <div className="figure" key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** Before the first answer, and after a failed one: the same two states for every card. */
function placeholder(error: string | undefined) {
  return error === undefined ? (
    <p className="card-value">reading…</p>
  ) : (
    <p className="card-value is-bad">unavailable — {error}</p>
  )
}
