import { http, createPublicClient } from 'viem'
import { baseSepolia } from 'viem/chains'

/** One place decides which network this repo talks to. Base Sepolia, always; never mainnet. */
export const CHAIN = baseSepolia

const DEFAULT_RPC_URL = 'https://sepolia.base.org'

/** `RPC_URL` exists for a reader with their own endpoint; the demo needs nothing set. */
export function readRpcUrl(): string {
  const url = process.env['RPC_URL']
  // An empty variable is a mistake, not a request for the empty string.
  return url === undefined || url === '' ? DEFAULT_RPC_URL : url
}

/**
 * Reading the chain needs no key, so this client is always available. Nothing here ever signs.
 * The return type is inferred on purpose: viem encodes the chain into it, and writing
 * `PublicClient` by hand costs callers `client.chain` and the chain-aware overloads.
 */
export function createChainClient() {
  return createPublicClient({ chain: CHAIN, transport: http(readRpcUrl()) })
}

/** The inferred client type, so a caller can hold one without rebuilding the expression. */
export type ChainClient = ReturnType<typeof createChainClient>

/**
 * The host, never the URL: provider endpoints carry the API key in the path, and these lines
 * end up in logs and articles.
 */
export function rpcHost(): string {
  try {
    return new URL(readRpcUrl()).host
  } catch {
    return '(unparseable RPC_URL)'
  }
}

/** The explorer link that turns evidence into something a reader can click. */
export function explorerTransactionUrl(hash: string): string {
  return `${CHAIN.blockExplorers.default.url}/tx/${hash}`
}

/** The same, for an address: the page where a human checks a balance by hand. */
export function explorerAddressUrl(address: string): string {
  return `${CHAIN.blockExplorers.default.url}/address/${address}`
}
