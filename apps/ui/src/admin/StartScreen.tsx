import { useState } from 'react'
import type { PartnerWalletFunding, Treasury } from '@payments/domain'
import { fundPartnerWallet, getTreasury } from '../api/client'
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
        <PartnerWalletCard treasury={data} error={error} />
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

/**
 * The other side of the demo, on the company's screen on purpose: the partner wallet is the
 * one address this repo funds from the treasury instead of from a faucet, and the entry that
 * pays for it is the only movement in the books that is not a payment.
 */
function PartnerWalletCard({ treasury, error }: CardProps) {
  const [asking, setAsking] = useState(false)

  if (error !== undefined || treasury === undefined) {
    return <Card title="Partner wallet">{placeholder(error)}</Card>
  }

  const wallet = treasury.partnerWallet
  const onchain = treasury.onchain
  // Disabled rather than hidden when the treasury is short: the button is how a reader finds
  // out that this money comes from the treasury and not from a faucet. The three comparisons
  // are the api's own refusal, on the thresholds the api publishes in `funding.requires`
  // (more ether than it sends: the two transactions pay for themselves); when the screen is
  // wrong about them anyway, its 422 says by how much.
  const requires = wallet.funding.requires
  const canFund =
    onchain !== null &&
    Number(onchain.usdc) >= Number(requires.usdc) &&
    Number(onchain.eth) >= Number(requires.eth) &&
    Number(treasury.ledger.available) >= Number(requires.usdc)

  return (
    <Card title="Partner wallet">
      <AddressLine address={wallet.address} explorerUrl={wallet.explorerUrl} />
      <Figures
        rows={[
          ['USDC', wallet.usdc ?? '—'],
          ['ETH', wallet.eth ?? '—'],
        ]}
      />
      <p className="card-actions">
        <button
          type="button"
          className="button"
          disabled={!canFund}
          onClick={() => {
            setAsking(true)
          }}
        >
          Fund partner wallet
        </button>
      </p>
      <p className="card-note">
        Demo scaffolding: the wallet every partner pays you from. In a real system its keys would
        belong to somebody else.{' '}
        {canFund
          ? `One click sends ${wallet.funding.usdc} USDC and ${wallet.funding.eth} ETH from the treasury.`
          : `The treasury has to hold ${requires.usdc} USDC and ${requires.eth} ETH on chain, and the USDC in the books, before it can send any.`}
      </p>

      {asking && (
        <FundingModal
          funding={wallet.funding}
          onClose={() => {
            setAsking(false)
          }}
        />
      )}
    </Card>
  )
}

/** What the four steps are, in the order they happen. Shown before, not narrated during. */
const FUNDING_STEPS = [
  'sign — the signer builds both transactions and signs them; nothing leaves the api with a key in it',
  'send — the api broadcasts the raw bytes; each hash was already known, from the signature',
  'confirm — both receipts, and the USDC one checked against the official contract’s Transfer event',
  'post — one entry in the books, Dr demo:partner-funding / Cr treasury:available, for the USDC only',
]

/**
 * The modal says what is about to happen before it happens, and shows what did happen after.
 *
 * The steps are a list and not a progress bar: the api does all four inside one request, so a
 * bar would be an animation rather than a report. The real step-by-step view belongs to the
 * payment flow, where each step is a durable activity.
 */
function FundingModal({
  funding,
  onClose,
}: {
  readonly funding: Treasury['partnerWallet']['funding']
  readonly onClose: () => void
}) {
  const [sending, setSending] = useState(false)
  const [result, setResult] = useState<PartnerWalletFunding | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const send = (): void => {
    setSending(true)
    setFailure(undefined)
    fundPartnerWallet()
      .then(setResult)
      .catch((error: unknown) => {
        setFailure(error instanceof Error ? error.message : String(error))
      })
      .finally(() => {
        setSending(false)
      })
  }

  return (
    <div className="modal-backdrop">
      <section className="modal" role="dialog" aria-modal="true" aria-label="Fund partner wallet">
        <h2 className="card-title">Fund partner wallet</h2>
        <p className="panel-lead">
          This sends <strong>{funding.usdc} USDC</strong> and <strong>{funding.eth} ETH</strong> from the treasury to
          the partner wallet: two transactions, signed by the signer and broadcast by the api. It is not a payment,
          so the USDC leaves the books as <code>demo:partner-funding</code> and the gas is not posted at all.
        </p>

        <ol className="steps">
          {FUNDING_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>

        {failure !== undefined && <p className="card-value is-bad">{failure}</p>}
        {result !== undefined && <FundingResult result={result} />}

        <p className="card-actions">
          {result === undefined && (
            <button type="button" className="button" disabled={sending} onClick={send}>
              {sending ? 'sending…' : 'Send'}
            </button>
          )}
          <button type="button" className="link-button" onClick={onClose}>
            {result === undefined ? 'Cancel' : 'Close'}
          </button>
        </p>
      </section>
    </div>
  )
}

/** Copy-paste-clean on purpose: hashes, links and the ledger reference, in plain text. */
function FundingResult({ result }: { readonly result: PartnerWalletFunding }) {
  return (
    <div className="result">
      <p className="card-note">
        {result.usdc.amount} USDC, block {result.usdc.blockNumber}
      </p>
      <p className="card-value is-address">{result.usdc.hash}</p>
      <p className="card-actions">
        <a href={result.usdc.explorerUrl} target="_blank" rel="noreferrer">
          explorer
        </a>
      </p>

      <p className="card-note">
        {result.gas.amount} ETH for gas, block {result.gas.blockNumber}
      </p>
      <p className="card-value is-address">{result.gas.hash}</p>
      <p className="card-actions">
        <a href={result.gas.explorerUrl} target="_blank" rel="noreferrer">
          explorer
        </a>
      </p>

      <p className="card-note">
        Books: {result.ledger.posted ? 'one scaffolding entry' : 'already posted, nothing written'},{' '}
        <code>{result.ledger.reference}</code>. Running the two transactions cost {result.gasSpent.totalEth} ETH,
        which the books never see: {result.gasSpent.l2Eth} on Base plus {result.gasSpent.l1Eth} to post the bytes to
        Ethereum, {result.gasSpent.basis}.
      </p>

      {result.balances !== null && (
        <p className="card-note">
          At block {result.balances.blockNumber}: treasury {result.balances.treasury.usdc} USDC /{' '}
          {result.balances.treasury.eth} ETH · partner wallet {result.balances.partnerWallet.usdc} USDC /{' '}
          {result.balances.partnerWallet.eth} ETH.
        </p>
      )}
    </div>
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
