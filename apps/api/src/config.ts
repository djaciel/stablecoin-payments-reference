/**
 * The api's tunables: the numbers a reader would change, in one place. Amounts are written in
 * whole USDC, the way a person types them; the code reads them into minor units.
 */

/** The range an invoice amount must fall in. */
export const MIN_INVOICE_USDC = '0.01'
export const MAX_INVOICE_USDC = '1000'
