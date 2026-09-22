import { Logger } from '@nestjs/common'
import { PAYMENT_WORKFLOW, paymentWorkflowStart, readTemporalConfig } from '@payments/domain'
import type { Client } from '@temporalio/client'

const { taskQueue } = readTemporalConfig()

/**
 * How long a Pay waits for Temporal before answering anyway. Without it a Temporal that is down
 * holds the answer for the client's own retries, about twenty seconds.
 */
const START_DEADLINE_MS = 3_000

const logger = new Logger('dispatch')

/**
 * Starts the payment's workflow, called only after the payment is committed. It never throws: the
 * money is reserved whatever happens here, so a start that fails is logged and left to the
 * dispatcher, and the answer to the caller does not change.
 */
export async function dispatchPayment(client: Client, reference: string): Promise<void> {
  try {
    await client.withDeadline(Date.now() + START_DEADLINE_MS, () =>
      client.workflow.start(PAYMENT_WORKFLOW, paymentWorkflowStart(reference, taskQueue)),
    )
  } catch (error) {
    logger.warn(`${reference}: its workflow could not be started, the dispatcher will start it — ${reason(error)}`)
  }
}

/** The SDK's message says what failed ("Failed to start Workflow"); its cause says why. */
function reason(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error)
  }
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message
}
