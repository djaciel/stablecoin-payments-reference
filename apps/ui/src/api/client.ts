/**
 * The browser's view of the api: one typed function per endpoint it reads.
 *
 * Everything the UI knows about the api is in this file — the base path, the shape of
 * each answer. There is no host and no port here on purpose: `/api` is served by the Vite
 * dev server, which forwards it to the api container (see vite.config.ts). The browser
 * never learns that the api is a different process, so the demo runs with no CORS setup
 * and no environment variable.
 */

const API_BASE_PATH = '/api'

/** What `GET /health` answers: the api and its database. */
export interface Health {
  readonly status: string
  readonly database: string
}

/**
 * What `GET /treasury` answers: everything the Start screen shows, read in one go.
 *
 * `onchain` is null when the api could not reach the RPC — a public endpoint having a bad
 * minute is not a reason to blank the rest of the page, so that one failure arrives as
 * data rather than as an error.
 *
 * Every amount is a decimal string in whole tokens, formatted by the api. The browser
 * never does arithmetic on money.
 */
export interface Treasury {
  readonly address: string
  readonly explorerUrl: string
  readonly onchain: { readonly usdc: string; readonly eth: string; readonly blockNumber: string } | null
  readonly chainError?: string
  readonly ledger: { readonly available: string; readonly reserved: string; readonly partnerDebt: string }
  /** The wallet the partners pay from, and what one click of the button sends to it. */
  readonly partnerWallet: {
    readonly address: string
    readonly explorerUrl: string
    readonly usdc: string | null
    readonly eth: string | null
    /**
     * What one click sends, and under `requires` the minimum the api refuses below — the
     * button reads those, so it is never enabled on a treasury the api would turn away.
     */
    readonly funding: {
      readonly usdc: string
      readonly eth: string
      readonly requires: { readonly usdc: string; readonly eth: string }
    }
  }
}

/** One of the two transactions "Fund partner wallet" sends. */
export interface FundingTransfer {
  readonly hash: string
  readonly explorerUrl: string
  readonly amount: string
  readonly blockNumber: string
}

/**
 * What `POST /treasury/fund-partner-wallet` answers once both transactions have landed and
 * the entry is in the books. The whole thing arrives in one answer because the endpoint is
 * synchronous: there is nothing to poll for.
 */
export interface PartnerWalletFunding {
  readonly usdc: FundingTransfer
  readonly gas: FundingTransfer
  /**
   * What the two transactions cost, split into the Base fee and the fee for posting their
   * bytes to Ethereum. `basis` is the api's own caveat about the second one; the screen
   * prints it rather than presenting the total as a settled figure.
   */
  readonly gasSpent: {
    readonly totalEth: string
    readonly l2Eth: string
    readonly l1Eth: string
    readonly basis: string
  }
  readonly ledger: { readonly reference: string; readonly posted: boolean }
  readonly balances: {
    readonly treasury: { readonly usdc: string; readonly eth: string }
    readonly partnerWallet: { readonly usdc: string; readonly eth: string }
    readonly blockNumber: string
  } | null
}

/** One address on a screen: the text, the link, and what it holds at `blockNumber`. */
export interface AddressBalance {
  readonly address: string
  readonly explorerUrl: string
  /** Decimal USDC in whole tokens, or null when the api could not reach the chain. */
  readonly usdc: string | null
}

/**
 * What `GET /partners` answers: every partner with its two addresses, and the one block all
 * the balances were read at — figures read at different heights would not be comparable.
 */
export interface Partners {
  readonly partners: readonly {
    readonly id: string
    readonly name: string
    readonly derivationIndex: number
    readonly deposit: AddressBalance
    readonly payout: AddressBalance
  }[]
  readonly blockNumber: string | null
  readonly chainError?: string
}

export function getHealth(): Promise<Health> {
  return read<Health>('/health')
}

export function getTreasury(): Promise<Treasury> {
  return read<Treasury>('/treasury')
}

export function getPartners(): Promise<Partners> {
  return read<Partners>('/partners')
}

/** Answers with the whole list, so the screen shows the new partner without waiting a poll. */
export function createPartner(name: string): Promise<Partners> {
  return send<Partners>('/partners', { name })
}

/**
 * Sends USDC and gas from the treasury to the partner wallet. It takes as long as two
 * transactions take to land (a few seconds on Base Sepolia) because the answer is the
 * evidence: both hashes, the gas that was spent, and the entry written to the books.
 */
export function fundPartnerWallet(): Promise<PartnerWalletFunding> {
  return send<PartnerWalletFunding>('/treasury/fund-partner-wallet', undefined)
}

/**
 * One rule for every endpoint: anything but a 2xx is a failure the screen shows as-is.
 * A degraded api (503 with a body) and an api that is not there at all (the proxy's own
 * error) both land here, and both mean the same thing to a card: this is not live data.
 */
async function read<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_PATH}${path}`)
  if (!response.ok) {
    throw new Error(`the api answered ${String(response.status)}`)
  }
  return (await response.json()) as T
}

/**
 * The same rule for writes, with one addition: a refused write has a reason the person who
 * typed it needs to read ("name must be text of 1 to 80 characters"), and Nest puts that
 * sentence in the body. A bare status code would send them to the logs for a typo.
 */
async function send<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${API_BASE_PATH}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // Some of these endpoints are a verb with no arguments; they send no body at all.
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  if (!response.ok) {
    throw new Error(await refusalMessage(response))
  }
  return (await response.json()) as T
}

async function refusalMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined)
  const message = typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : undefined
  return typeof message === 'string' ? message : `the api answered ${String(response.status)}`
}
