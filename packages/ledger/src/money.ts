import type { MinorUnits } from './types'

/**
 * USDC has six decimals, so one token is 1,000,000 minor units. Every amount in this repo is
 * stored and moved in minor units; whole tokens exist only where a human reads them.
 *
 * The ledger is USDC-only (spec assumption 2), so this is a constant rather than an argument
 * these two functions take. A second currency would bring its own scale and a decision about
 * where that scale is looked up — and that is the phase that adds it.
 */
export const USDC_DECIMALS = 6

const SCALE = 10n ** BigInt(USDC_DECIMALS)

/**
 * Formats minor units for a human: 1_000_000_000n becomes "1,000.000000".
 *
 * All of the conversion lives here so no caller is ever tempted to divide money by 10 ** 6 in
 * a template string, which is exactly how amounts start drifting from the ledger.
 */
export function formatMinor(amount: MinorUnits): string {
  const negative = amount < 0n
  const absolute = negative ? -amount : amount

  const whole = absolute / SCALE
  const fraction = absolute % SCALE

  const groupedWhole = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const paddedFraction = fraction.toString().padStart(USDC_DECIMALS, '0')

  return `${negative ? '-' : ''}${groupedWhole}.${paddedFraction}`
}

/**
 * Whole tokens as minor units: `toMinor(1_000)` is 1_000_000_000n.
 *
 * Fractional tokens are not accepted, and nothing here has to say so: `BigInt(1.5)` throws on
 * its own. Amounts that are not whole tokens are passed in minor units, which is what the
 * rest of the repo uses anyway.
 */
export function toMinor(wholeTokens: number | bigint): MinorUnits {
  return BigInt(wholeTokens) * SCALE
}
