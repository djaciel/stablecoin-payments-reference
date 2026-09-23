import { getClient, log } from '@temporalio/activity'
import { WorkflowNotFoundError, type Client } from '@temporalio/client'
import { PAYMENT_WORKFLOW, paymentWorkflowStart, readTemporalConfig } from '@payments/domain'
import { workerPool } from './db'

/**
 * The dispatcher's one rule: every RESERVED or SENT payment whose time has come has a running
 * workflow. The api starts one right after COMMIT and leaves a payment promised for later to this
 * query. REVIEW is left alone on purpose: a human resumes it (`POST /payments/:reference/resume`).
 */
const DUE = "SELECT reference, status FROM payments WHERE status IN ('RESERVED', 'SENT') AND (execute_at IS NULL OR execute_at <= now()) ORDER BY created_at"

const { taskQueue } = readTemporalConfig()

/** One tick. Returns its line so the Temporal UI shows it; only a start is logged, not every quiet tick. */
export async function dispatchPayments(): Promise<string> {
  const { rows } = await workerPool().query<{ reference: string; status: string }>(DUE)
  // The worker's own client, over the connection it already polls with.
  const client = getClient()

  let started = 0
  for (const { reference, status } of rows) {
    if (await hasRunningWorkflow(client, reference)) {
      continue
    }
    await client.workflow.start(PAYMENT_WORKFLOW, paymentWorkflowStart(reference, taskQueue))
    log.info(`dispatcher: started ${reference} (${status}, had no running workflow)`)
    started += 1
  }
  return `${rows.length} payment(s) RESERVED or SENT and due, ${started} started`
}

/** Never started, or its last run ended (failed, terminated, or completed early): both mean no. */
async function hasRunningWorkflow(client: Client, reference: string): Promise<boolean> {
  try {
    const { status } = await client.workflow.getHandle(reference).describe()
    return status.name === 'RUNNING'
  } catch (error) {
    if (error instanceof WorkflowNotFoundError) {
      return false
    }
    throw error
  }
}
