import { useState } from 'react'

/**
 * An address the way every screen shows one, with a copy button and an explorer link on the same
 * row. Addresses stay full (a reader pastes them into a faucet); `short` is for transaction
 * hashes, where copy still takes the whole string.
 */
export function AddressLine({
  address,
  explorerUrl,
  short = false,
}: {
  readonly address: string
  readonly explorerUrl: string
  readonly short?: boolean
}) {
  return (
    <div className="address-line">
      <p className="card-value is-address" title={short ? address : undefined}>
        {short ? `${address.slice(0, 10)}…${address.slice(-8)}` : address}
      </p>
      <p className="card-actions">
        <CopyButton text={address} />
        <a href={explorerUrl} target="_blank" rel="noreferrer">
          explorer
        </a>
      </p>
    </div>
  )
}

/** For strings a reader pastes somewhere else: an address, a payment reference. */
export function CopyButton({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false)

  const copy = (): void => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <button type="button" className="link-button" onClick={copy}>
      {copied ? 'copied' : 'copy'}
    </button>
  )
}
