import { readEnv } from '@payments/domain'

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
 * One place decides how the worker talks to Temporal. The defaults are the host-machine view
 * (published ports); inside compose the values come from the service's environment block.
 */
export interface TemporalConfig {
  readonly address: string
  readonly namespace: string
  readonly taskQueue: string
}

const DEFAULT_PORT = '7233'
const DEFAULT_NAMESPACE = 'default'
const DEFAULT_TASK_QUEUE = 'payments'

export function readTemporalConfig(): TemporalConfig {
  return {
    // TEMPORAL_ADDRESS is the explicit override and wins whenever it is set — that is what
    // compose passes. Without it the address is the host-machine view, built from the port
    // compose publishes, so moving TEMPORAL_PORT in .env does not need a second variable.
    address: readEnv('TEMPORAL_ADDRESS', `localhost:${readEnv('TEMPORAL_PORT', DEFAULT_PORT)}`),
    namespace: readEnv('TEMPORAL_NAMESPACE', DEFAULT_NAMESPACE),
    taskQueue: readEnv('TEMPORAL_TASK_QUEUE', DEFAULT_TASK_QUEUE),
  }
}
