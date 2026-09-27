import { useState } from 'react'
import type { PartnerView, PartnerWalletFunding, Treasury } from '@payments/domain'
import { fundPartnerWallet, getTreasury } from '../api/client'
import { usePolling } from '../api/usePolling'
import { AddressLine } from '../app/AddressLine'

/**
 * The shared wallet the partners pay from, and the button that funds it from the treasury: the
 * one address this repo funds from the treasury instead of from a faucet, and the entry that
 * pays for it is the only movement in the books that is not a payment.
 *
 * The balances come from the partner screen's own read, so a payment shows here as soon as that
 * screen reads again. The treasury is read only to decide whether the button can work.
 */
export function PartnerWalletCard({ wallet }: { readonly wallet: PartnerView['partnerWallet'] }) {
  const treasury = usePolling(getTreasury)
  const [asking, setAsking] = useState(false)

  const funding = treasury.data?.partnerWallet.funding
  const canFund = treasury.data !== undefined && hasEnough(treasury.data)

  return (
    <section className="card">
      <h2 className="card-title">Partner wallet</h2>
      <AddressLine address={wallet.address} explorerUrl={wallet.explorerUrl} />
      <dl className="figures">
        <div className="figure">
          <dt>USDC</dt>
          <dd>{wallet.usdc ?? 'unknown'}</dd>
        </div>
        <div className="figure">
          <dt>ETH</dt>
          <dd>{wallet.eth ?? 'unknown'}</dd>
        </div>
      </dl>
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
        Demo only: the shared wallet every partner pays from.{' '}
        {funding === undefined
          ? treasury.error === undefined
            ? 'Reading the treasury…'
            : `Cannot read the treasury: ${treasury.error}`
          : canFund
            ? 'Fund it from the treasury with one click.'
            : `The treasury has to hold ${funding.requires.usdc} USDC and ${funding.requires.eth} ETH on chain, and the USDC in the books, before it can send any.`}
      </p>

      {asking && funding !== undefined && (
        <FundingModal
          funding={funding}
          onClose={() => {
            setAsking(false)
          }}
        />
      )}
    </section>
  )
}

/**
 * Disabled rather than hidden when the treasury is short: the button is how a reader finds out
 * that this money comes from the treasury and not from a faucet. The three comparisons are the
 * api's own refusal, on the thresholds the api publishes in `funding.requires` (more ether than
 * it sends: the two transactions pay for themselves); when the screen is wrong about them
 * anyway, its 422 says by how much.
 */
function hasEnough(treasury: Treasury): boolean {
  const onchain = treasury.onchain
  const requires = treasury.partnerWallet.funding.requires
  return (
    onchain !== null &&
    Number(onchain.usdc) >= Number(requires.usdc) &&
    Number(onchain.eth) >= Number(requires.eth) &&
    Number(treasury.ledger.available) >= Number(requires.usdc)
  )
}

/** What the four steps are, in the order they happen. Shown before, not narrated during. */
const FUNDING_STEPS = [
  'sign: the signer builds both transactions and signs them; nothing leaves the api with a key in it',
  'send: the api broadcasts the raw bytes; each hash was already known, from the signature',
  'confirm: both receipts, and the USDC one checked against the official contract’s Transfer event',
  'post: one entry in the books, Dr demo:partner-funding / Cr treasury:available, for the USDC only',
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
