/**
 * One place decides how this repo talks to Temporal. The worker and the demo script both
 * read from here, so "which queue is this?" has a single answer.
 *
 * The defaults are the host-machine view (published ports). Inside compose the values
 * come from the service's environment block, where the host is the service name.
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

/** An empty variable is a mistake, not a request for the empty string. */
function readEnv(name: string, fallback: string): string {
  const value = process.env[name]
  return value === undefined || value === '' ? fallback : value
}
