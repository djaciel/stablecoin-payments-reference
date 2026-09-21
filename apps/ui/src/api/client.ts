/**
 * The browser's view of the api: one typed function per endpoint it reads.
 *
 * The shapes come from `@payments/domain`, where the api writes them too, so the two sides
 * cannot drift. What is here is how the browser asks: the base path and the two rules for
 * reading an answer.
 *
 * There is no host and no port here on purpose: `/api` is served by the Vite dev server,
 * which forwards it to the api container (see vite.config.ts). The browser never learns that
 * the api is a different process, so the demo runs with no CORS setup and no environment
 * variable.
 */

import type { Health, Partners, PartnerWalletFunding, Treasury } from '@payments/domain'

const API_BASE_PATH = '/api'

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
