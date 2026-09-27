import { USDC_DECIMALS_SHOWN } from '../config'

/**
 * A USDC amount as the screens show it: the api's string (`"1,000.500000"`) cut to
 * `USDC_DECIMALS_SHOWN` decimals. Cut, not rounded, so a balance never reads as more than it is.
 * Done on the string, never through a float, so no amount loses a digit on the way.
 */
export function formatUsdc(amount: string): string {
  const [whole = '', fraction = ''] = amount.split('.')
  if (USDC_DECIMALS_SHOWN <= 0) {
    return whole
  }
  return `${whole}.${fraction.padEnd(USDC_DECIMALS_SHOWN, '0').slice(0, USDC_DECIMALS_SHOWN)}`
}
