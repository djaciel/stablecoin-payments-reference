import { readEnv } from '@payments/domain'
import type { ChainClient } from './clients'

/**
 * Which block this repo is willing to call settled. A block near the tip can still be
 * replaced by a reorganisation, so every number posted to the books is read from a block the
 * network has agreed it will not take back.
 *
 * Measured on `https://sepolia.base.org` (2026-09-17): `safe` trails `latest` by ~43 blocks
 * (~1.5 min), `finalized` by ~666 (~22 min). `safe` is the default — twenty minutes of
 * waiting would make the demo's first lesson a lesson in patience.
 */
export type FinalityMode = 'safe' | 'finalized' | 'depth'

const DEFAULT_MODE: FinalityMode = 'safe'

/** `depth` mode exists for an endpoint that serves no block tags at all. Unused here today. */
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

/** The highest block this repo treats as settled. One RPC request in every mode. */
export async function finalBlockNumber(client: ChainClient): Promise<bigint> {
  const mode = readFinalityMode()

  if (mode === 'depth') {
    const tip = await client.getBlockNumber()
    const depth = readFinalityDepth()
    // A chain younger than the depth only happens on a fresh local node, but the subtraction
    // would go negative and every range built from it would be nonsense.
    return tip > depth ? tip - depth : 0n
  }

  // `getBlock` rather than `getBlockNumber`: the latter only takes `latest`. The block
  // header is a few hundred bytes and this runs once per tick.
  const block = await client.getBlock({ blockTag: mode })
  return block.number
}
