import type { MinorUnits } from './types'

/**
 * USDC has six decimals, so one token is 1,000,000 minor units. Every amount in this repo is
 * stored and moved in minor units; whole tokens exist only where a human reads them.
 */
export const USDC_DECIMALS = 6

/**
 * Formats minor units for a human: 1_000_000_000n becomes "1,000.000000".
 *
 * All of the conversion lives here so no caller is ever tempted to divide money by 10 ** 6
 * in a template string, which is exactly how amounts start drifting from the ledger.
 */
export function formatMinor(amount: MinorUnits, decimals = USDC_DECIMALS): string {
  const scale = 10n ** BigInt(decimals)
  const negative = amount < 0n
  const absolute = negative ? -amount : amount

  const whole = absolute / scale
  const fraction = absolute % scale

  const groupedWhole = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const paddedFraction = fraction.toString().padStart(decimals, '0')

  return `${negative ? '-' : ''}${groupedWhole}.${paddedFraction}`
}

/** Whole tokens as minor units: `toMinor(1_000)` is 1_000_000_000n for USDC. */
export function toMinor(wholeTokens: number | bigint, decimals = USDC_DECIMALS): MinorUnits {
  if (typeof wholeTokens === 'number' && !Number.isInteger(wholeTokens)) {
    throw new Error(`whole token amounts must be integers here; ${wholeTokens} is not. Pass minor units instead.`)
  }
  return BigInt(wholeTokens) * 10n ** BigInt(decimals)
}
