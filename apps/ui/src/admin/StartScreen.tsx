import { getTreasury, type Treasury } from '../api/client'
import { usePolling } from '../api/usePolling'
import { AddressLine } from '../app/AddressLine'
import { HealthCard } from '../app/HealthCard'

/**
 * The two halves can disagree, and the screen says so rather than hiding it: money on chain is
 * not money in the books until the watcher posts it, and that gap closing is the first thing
 * this demo teaches.
 *
 * One poll for the whole screen — a card per request would show figures read at three moments.
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

      {isFunded(data) ? <FaucetNote /> : <FaucetPanel />}
    </>
  )
}

/**
 * Both or nothing: USDC is the money and ETH is the gas that moves it, so a treasury holding
 * one of them still cannot send anything. Unknown balances (RPC down) count as not funded —
 * the instructions are the safer thing to show when the screen cannot tell.
 */
function isFunded(treasury: Treasury | undefined): boolean {
  const onchain = treasury?.onchain
  if (onchain === undefined || onchain === null) {
    return false
  }
  return Number(onchain.usdc) > 0 && Number(onchain.eth) > 0
}

/** The first thing a reader has to do, for as long as it is still undone. */
function FaucetPanel() {
  return (
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
  )
}

/** Once the money is there the faucets are a footnote, not a step. */
function FaucetNote() {
  return (
    <p className="card-note">
      Need more test funds?{' '}
      <a href={USDC_FAUCET_URL} target="_blank" rel="noreferrer">
        Circle faucet
      </a>{' '}
      (USDC) ·{' '}
      <a href={GAS_FAUCET_URL} target="_blank" rel="noreferrer">
        CDP faucet
      </a>{' '}
      (gas) — see <code>{FAUCET_DOC}</code>
    </p>
  )
}

interface CardProps {
  readonly treasury: Treasury | undefined
  readonly error: string | undefined
}

function TreasuryCard({ treasury, error }: CardProps) {
  if (error !== undefined || treasury === undefined) {
    return <Card title="Treasury address">{placeholder(error)}</Card>
  }

  return (
    <Card title="Treasury address">
      <AddressLine address={treasury.address} explorerUrl={treasury.explorerUrl} />
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
        The ledger, in USDC. It only changes by a posting — the watcher writes one entry per transfer that arrives,
        at the amount the chain actually carried.
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
