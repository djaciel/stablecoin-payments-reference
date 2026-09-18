import { http, createPublicClient } from 'viem'
import { baseSepolia } from 'viem/chains'

/**
 * Everything chain-side is built from here, so there is one place that decides which
 * network this repo talks to. Base Sepolia, always: this repo never points at mainnet.
 */
export const CHAIN = baseSepolia

const DEFAULT_RPC_URL = 'https://sepolia.base.org'

/**
 * The RPC endpoint, with a default that works. `RPC_URL` exists for the reader who has a
 * provider endpoint of their own; nothing in the demo requires it to be set.
 */
export function readRpcUrl(): string {
  const url = process.env['RPC_URL']
  // An empty variable is a mistake, not a request for the empty string.
  return url === undefined || url === '' ? DEFAULT_RPC_URL : url
}

/**
 * Reading the chain needs no key, so this client is always available. Nothing in this
 * package ever signs: the company seed lives in the signer, and this repo broadcasts
 * bytes that were signed there.
 *
 * The return type is inferred on purpose: viem encodes the chain into it, and writing
 * `PublicClient` by hand throws that away — callers then lose `client.chain` and the
 * chain-aware overloads.
 */
export function createChainClient() {
  return createPublicClient({ chain: CHAIN, transport: http(readRpcUrl()) })
}

/** The inferred client type, so a caller can hold one without rebuilding the expression. */
export type ChainClient = ReturnType<typeof createChainClient>

/**
 * The RPC endpoint's host, which is what evidence prints. Never the URL: provider
 * endpoints carry the API key in the path, and these lines end up in logs and articles.
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
