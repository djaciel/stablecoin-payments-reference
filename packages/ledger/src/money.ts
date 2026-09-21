import type { MinorUnits } from './types'

/**
 * Every amount in this repo is stored and moved in minor units; whole tokens exist only where a
 * human reads them. A constant rather than an argument: the ledger is USDC-only.
 */
export const USDC_DECIMALS = 6

const SCALE = 10n ** BigInt(USDC_DECIMALS)

/** All of the conversion lives here so no caller divides money by 10 ** 6 in a template string. */
export function formatMinor(amount: MinorUnits): string {
  const negative = amount < 0n
  const absolute = negative ? -amount : amount

  const whole = absolute / SCALE
  const fraction = absolute % SCALE

  const groupedWhole = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const paddedFraction = fraction.toString().padStart(USDC_DECIMALS, '0')

  return `${negative ? '-' : ''}${groupedWhole}.${paddedFraction}`
}

/** `toMinor(1_000)` is 1_000_000_000n. Fractional tokens throw on their own via `BigInt`. */
export function toMinor(wholeTokens: number | bigint): MinorUnits {
  return BigInt(wholeTokens) * SCALE
}

const PLAIN_DECIMAL = new RegExp(`^\\d+(\\.\\d{1,${USDC_DECIMALS}})?$`)

/**
 * The one place a typed amount becomes money: `"0.50"` is 500_000n. Strings and bigints only,
 * never a float, because `0.1 + 0.2` is not `0.3` and a form that loses a cent loses the reader.
 * No sign, no exponent, no more decimals than USDC has, and not zero.
 */
export function toMinorFromDecimal(value: string): MinorUnits {
  if (!PLAIN_DECIMAL.test(value)) {
    throw new RangeError(`"${value}" is not an amount: a plain decimal with at most ${USDC_DECIMALS} decimals, like "0.50"`)
  }

  const [whole = '', fraction = ''] = value.split('.')
  const amount = BigInt(whole) * SCALE + BigInt(fraction.padEnd(USDC_DECIMALS, '0'))

  if (amount === 0n) {
    throw new RangeError('an amount must be more than zero')
  }
  return amount
}
