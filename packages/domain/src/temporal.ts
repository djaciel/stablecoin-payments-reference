import { readEnv } from './env'

/**
 * One place decides how this repo talks to Temporal: the api and the worker read the same answer.
 * The defaults are the host-machine view (published ports); inside compose the values come from
 * each service's environment block.
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

/** The payment workflow's type name. The api starts it by name, because it must not import worker code. */
export const PAYMENT_WORKFLOW = 'PaymentWorkflow'

/**
 * How a payment's workflow is started, by the api after COMMIT and by the dispatcher. The id is
 * the reference, so a second start while one runs attaches to it instead of starting another; a
 * run that has ended does not block a new one, which is how a payment left half-way gets going again.
 */
export function paymentWorkflowStart(reference: string, taskQueue: string) {
  return {
    workflowId: reference,
    taskQueue,
    args: [reference] as [string],
    workflowIdConflictPolicy: 'USE_EXISTING' as const,
  }
}
