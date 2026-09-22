/**
 * Headroom over the chain's gas estimate for a payout: the estimate is priced against a state
 * that then moves, and a transaction that runs out of gas still costs gas and transfers nothing.
 */
export const GAS_HEADROOM_PERCENT = 20n

/**
 * How far above `estimateFeesPerGas()` a payout's fee cap is set. The signed bytes are never
 * re-priced (a retry sends the same ones), and EIP-1559 charges the base fee actually in force,
 * not the cap, so a high cap costs nothing until fees rise.
 */
export const FEE_CAP_MULTIPLIER = 10n
