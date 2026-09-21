import { useState } from 'react'

/**
 * An address the way every screen shows one: the full string, a copy button and an explorer
 * link. Full and never shortened — a truncated address is one you cannot paste into a
 * faucet, and pasting it into a faucet is the first thing this demo asks of anyone.
 */
export function AddressLine({ address, explorerUrl }: { readonly address: string; readonly explorerUrl: string }) {
  return (
    <>
      <p className="card-value is-address">{address}</p>
      <p className="card-actions">
        <CopyButton text={address} />
        <a href={explorerUrl} target="_blank" rel="noreferrer">
          explorer
        </a>
      </p>
    </>
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
