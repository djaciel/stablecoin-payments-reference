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

const DEFAULT_UI_PORT = '8080'

/**
 * The payment's runs in the Temporal UI, the one place that link is built: the list filtered by
 * workflow id, because a payment can have more than one run and `/workflows/<id>` opens only the
 * newest. The browser that follows it is on the host, so it uses the port compose publishes.
 */
export function workflowUrl(reference: string): string {
  const port = readEnv('TEMPORAL_UI_PORT', DEFAULT_UI_PORT)
  const namespace = readEnv('TEMPORAL_NAMESPACE', DEFAULT_NAMESPACE)
  return `http://localhost:${port}/namespaces/${namespace}/workflows?query=${encodeURIComponent(`WorkflowId="${reference}"`)}`
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

/** The one-shot reconciliation run's type name, started by "Run now". */
export const RECONCILIATION_WORKFLOW = 'ReconciliationRun'

/**
 * How that one-shot is started. The id is the second it was asked for, so two presses in the same
 * second are one run, and every run still has its own page in the Temporal UI.
 */
export function reconciliationRunStart(askedAt: Date, taskQueue: string) {
  return {
    workflowId: `reconciliation-${askedAt.toISOString().replace(/\.\d+Z$/, 'Z')}`,
    taskQueue,
    args: [] as [],
    workflowIdConflictPolicy: 'USE_EXISTING' as const,
  }
}
