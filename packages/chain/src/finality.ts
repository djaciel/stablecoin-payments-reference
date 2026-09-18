import { readEnv } from '@payments/domain'
import type { ChainClient } from './clients'

/**
 * Which block this repo is willing to call settled.
 *
 * "The transaction is in a block" is not the same statement as "the money moved". A block
 * near the tip of the chain can still be replaced by a reorganisation, and everything that
 * descended from it goes with it. So every number this system posts to the books is read
 * from a block the network has already agreed it will not take back.
 *
 * Measured on `https://sepolia.base.org` (2026-09-17), because the spec left it an open
 * question: `safe` trails `latest` by ~43 blocks (~1.5 minutes at 2 s blocks) and
 * `finalized` by ~666 (~22 minutes). `safe` is the default — it is the cheapest tag that
 * means "this will not be reorganised in practice", and twenty minutes of waiting would
 * make the demo's first lesson a lesson in patience.
 */
export type FinalityMode = 'safe' | 'finalized' | 'depth'

const DEFAULT_MODE: FinalityMode = 'safe'

/**
 * How many blocks back from the tip `depth` mode goes. Only used by that mode, which
 * exists for a chain or an endpoint that serves no block tags at all — nothing needs it on
 * Base Sepolia today.
 */
const DEFAULT_DEPTH = 20n

export function readFinalityMode(): FinalityMode {
  const value = readEnv('FINALITY_MODE', DEFAULT_MODE)
  if (value === 'safe' || value === 'finalized' || value === 'depth') {
    return value
  }
  throw new Error(`FINALITY_MODE must be safe, finalized or depth, got: ${value}`)
}

export function readFinalityDepth(): bigint {
  const value = readEnv('FINALITY_DEPTH', DEFAULT_DEPTH.toString())
  const depth = BigInt(value)
  if (depth < 0n) {
    throw new Error(`FINALITY_DEPTH cannot be negative, got: ${value}`)
  }
  return depth
}

/**
 * The highest block this repo treats as settled. Everything the watcher scans, and every
 * balance reconciliation compares, stops here.
 *
 * One RPC request in every mode.
 */
export async function finalBlockNumber(client: ChainClient): Promise<bigint> {
  const mode = readFinalityMode()

  if (mode === 'depth') {
    const tip = await client.getBlockNumber()
    const depth = readFinalityDepth()
    // A chain younger than the depth is only a thing on a fresh local node, but the
    // subtraction would go negative and every range built from it would be nonsense.
    return tip > depth ? tip - depth : 0n
  }

  // `getBlock` rather than `getBlockNumber`: the latter only takes `latest`. The block
  // header is a few hundred bytes and this runs once per tick.
  const block = await client.getBlock({ blockTag: mode })
  return block.number
}
