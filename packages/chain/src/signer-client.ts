import { readEnv } from '@payments/domain'
import { isAddress, isHex, type Address, type Hex } from 'viem'

/**
 * How the api and the worker ask the signing service for something: one typed method per
 * request. The signer is a separate process because it holds the seed; this client holds no
 * key and reads no chain.
 */

/** Long enough for a container starting up, short enough that /treasury still answers. */
const REQUEST_TIMEOUT_MS = 5000

/** The compose-network address: the signer publishes no port, `signer` is its service name. */
const DEFAULT_SIGNER_URL = 'http://signer:3001'

/** The only place that reads SIGNER_URL. Set it to reach a signer started on your machine. */
export function readSignerUrl(): string {
  return readEnv('SIGNER_URL', DEFAULT_SIGNER_URL).replace(/\/+$/, '')
}

/** What the signer answers for an address lookup. */
export interface SignerAddress {
  readonly index: number
  readonly address: Address
}

/**
 * What the signer answers for a signing request: the bytes to broadcast and the hash they
 * already have. The hash is stored before the broadcast, which is what makes a retry re-send
 * the same transaction instead of creating a second one.
 */
export interface SignedTransaction {
  readonly hash: Hex
  readonly signedTransaction: Hex
}

/** Everything the signer is told, because it reads no chain: the caller brings the numbers. */
export interface TransactionToSign {
  readonly to: Address
  /** USDC minor units for a transfer, wei for a native one. */
  readonly amount: bigint
  readonly nonce: number
  readonly gas: bigint
  readonly maxFeePerGas: bigint
  readonly maxPriorityFeePerGas: bigint
}

/** The signer is unreachable or answered something unusable. The api turns this into 503. */
export class SignerUnavailableError extends Error {}

export class SignerClient {
  constructor(private readonly baseUrl: string) {}

  /** Index 0 of the company seed: the address a human funds from a faucet. */
  treasuryAddress(): Promise<SignerAddress> {
    return this.askForAddress('/addresses/treasury', {}, 'the treasury address')
  }

  /** The deposit address of the partner at `index`. Only the signer can derive it. */
  depositAddress(index: number): Promise<SignerAddress> {
    return this.askForAddress(
      '/addresses/deposit',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ index }) },
      `the deposit address at index ${String(index)}`,
    )
  }

  /** A USDC transfer out of the treasury. The signer builds the calldata itself. */
  signTransfer(transaction: TransactionToSign): Promise<SignedTransaction> {
    return this.askToSign('/sign/transfer', { amountMinor: transaction.amount.toString() }, transaction, 'a USDC transfer')
  }

  /** Base Sepolia ETH out of the treasury: gas for an address that has to sign later. */
  signNativeTransfer(transaction: TransactionToSign): Promise<SignedTransaction> {
    return this.askToSign('/sign/native-transfer', { valueWei: transaction.amount.toString() }, transaction, 'a gas transfer')
  }

  private async askToSign(
    path: string,
    amount: Record<string, string>,
    transaction: TransactionToSign,
    what: string,
  ): Promise<SignedTransaction> {
    // Amounts as decimal strings: JSON has no bigint, and money through a float is money
    // rounded. `nonce` stays a number — it is a counter, not an amount.
    const body = {
      ...amount,
      to: transaction.to,
      nonce: transaction.nonce,
      gas: transaction.gas.toString(),
      maxFeePerGas: transaction.maxFeePerGas.toString(),
      maxPriorityFeePerGas: transaction.maxPriorityFeePerGas.toString(),
    }

    const answer = await this.ask(
      path,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
      what,
    )

    if (!isSignedTransaction(answer)) {
      throw new SignerUnavailableError(`the signer at ${this.baseUrl} answered ${what} with a body this client cannot read`)
    }
    return answer
  }

  private async askForAddress(path: string, init: RequestInit, what: string): Promise<SignerAddress> {
    const body = await this.ask(path, init, what)
    if (!isSignerAddress(body)) {
      throw new SignerUnavailableError(`the signer at ${this.baseUrl} answered with a body this client cannot read`)
    }
    return body
  }

  /** One request, one failure type. The answer comes back `unknown` and is checked by the caller. */
  private async ask(path: string, init: RequestInit, what: string): Promise<unknown> {
    const url = `${this.baseUrl}${path}`

    let response: Response
    try {
      // Without a timeout a signer that accepts connections and never answers would hang the
      // caller until it gave up.
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    } catch (error) {
      throw new SignerUnavailableError(`the signer at ${this.baseUrl} did not answer: ${messageOf(error)}`)
    }

    if (!response.ok) {
      throw new SignerUnavailableError(`the signer at ${this.baseUrl} answered ${response.status} for ${what}`)
    }

    return response.json().catch(() => undefined)
  }
}

/** Checked before it is broadcast: these bytes become a transaction the treasury pays for. */
function isSignedTransaction(body: unknown): body is SignedTransaction {
  if (typeof body !== 'object' || body === null) {
    return false
  }
  const candidate = body as { hash?: unknown; signedTransaction?: unknown }
  return (
    typeof candidate.hash === 'string' &&
    isHex(candidate.hash) &&
    typeof candidate.signedTransaction === 'string' &&
    isHex(candidate.signedTransaction)
  )
}

/**
 * The shape, not just the type: an address is passed to viem and printed as an explorer link.
 * Non-strict on purpose — the checksum is the signer's business.
 */
function isSignerAddress(body: unknown): body is SignerAddress {
  if (typeof body !== 'object' || body === null) {
    return false
  }
  const candidate = body as { index?: unknown; address?: unknown }
  return (
    typeof candidate.index === 'number' &&
    typeof candidate.address === 'string' &&
    isAddress(candidate.address, { strict: false })
  )
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
