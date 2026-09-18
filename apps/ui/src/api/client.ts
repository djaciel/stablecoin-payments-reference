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

/** What `GET /treasury` answers: the address a human funds from a faucet. */
export interface Treasury {
  readonly address: string
}

export function getHealth(): Promise<Health> {
  return read<Health>('/health')
}

export function getTreasury(): Promise<Treasury> {
  return read<Treasury>('/treasury')
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
