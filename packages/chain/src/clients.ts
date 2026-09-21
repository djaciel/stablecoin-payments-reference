import { readEnv } from '@payments/domain'
import { http, createPublicClient } from 'viem'
import { baseSepolia } from 'viem/chains'

/** One place decides which network this repo talks to. Base Sepolia, always; never mainnet. */
export const CHAIN = baseSepolia

const DEFAULT_RPC_URL = 'https://sepolia.base.org'

/** `RPC_URL` exists for a reader with their own endpoint; the demo needs nothing set. */
export function readRpcUrl(): string {
  return readEnv('RPC_URL', DEFAULT_RPC_URL)
}

/**
 * Reading the chain needs no key; nothing here ever signs. The return type is inferred on
 * purpose — writing `PublicClient` by hand costs callers the chain-aware overloads.
 */
export function createChainClient() {
  return createPublicClient({ chain: CHAIN, transport: http(readRpcUrl()) })
}

/** The inferred client type, so a caller can hold one without rebuilding the expression. */
export type ChainClient = ReturnType<typeof createChainClient>

/** The host, never the URL: provider endpoints carry the API key in the path. */
export function rpcHost(): string {
  return hostOf(readRpcUrl())
}

/**
 * A chain failure as it is safe to print or log.
 *
 * Two things happen here. viem's errors run to five lines and quote the endpoint they called
 * (`URL: https://…`), which for a provider endpoint carries the API key; and only the first
 * line says anything a reader can act on. So: first line, every URL in it replaced by its
 * host. Use it in every path that reports a chain error, response or log alike.
 */
export function chainErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  const firstLine = message.split('\n')[0] ?? message
  return firstLine.replace(/https?:\/\/[^\s'")]+/g, hostOf)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return '(unparseable URL)'
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
