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

/**
 * The gas limit of the payment that takes the revert flag (Break it). Above the ~22,500 a node
 * demands for a transfer's calldata, so it is accepted and included; below the ~45,400 the USDC
 * transfer uses (estimated at 45,438; signed normally with 54,526, the estimate + 20 %), so it
 * runs out of gas inside the contract and reverts, spending only gas.
 */
export const REVERT_GAS_LIMIT = 30_000n
