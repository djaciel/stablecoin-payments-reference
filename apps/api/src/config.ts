/**
 * The api's tunables: the numbers a reader would change, in one place. Amounts are written in
 * whole USDC, the way a person types them; the code reads them into minor units.
 */

/** The range an invoice amount must fall in. */
export const MIN_INVOICE_USDC = '0.01'
export const MAX_INVOICE_USDC = '1000'

/**
 * The range one payment must fall in: "the amount fits within the limits". Checked when the
 * payment is made, not when the invoice is written, so lowering it refuses with `amount_out_of_range`.
 */
export const MIN_PAYMENT_USDC = '0.01'
export const MAX_PAYMENT_USDC = '1000'

/**
 * How far ahead a payment may be scheduled. A demo caps it because a scheduled payment holds real
 * testnet money under Reserved from the moment it is made, and one forgotten would hold it for ever.
 */
export const MAX_SCHEDULE_AHEAD_HOURS = 24

/** Destinations the compliance mock refuses (`payments/compliance.ts`). Add one to see `compliance_rejected`. */
export const COMPLIANCE_DENYLIST: readonly string[] = []
