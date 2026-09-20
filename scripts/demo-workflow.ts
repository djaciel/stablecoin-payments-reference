import { readEnv } from '@payments/domain'
import { Client, Connection } from '@temporalio/client'
import { readTemporalConfig } from '../apps/worker/src/config'
import { PaymentWorkflow } from '../apps/worker/src/workflows'

/**
 * `pnpm demo:workflow` — start one payment workflow and wait for it.
 *
 * It makes durable execution visible before there is a payment to make it with: start this,
 * kill the worker mid-step, and watch it finish anyway (docs/dev/restart-survival.md). The
 * script keeps waiting through the kill because the workflow lives in Temporal, not here.
 */

/** `.env` can move this port, and a printed link that ignores it sends you to a dead page. */
function temporalUiUrl(): string {
  return `http://localhost:${readEnv('TEMPORAL_UI_PORT', '8080')}`
}

async function main(): Promise<void> {
  const { address, namespace, taskQueue } = readTemporalConfig()
  const connection = await Connection.connect({ address })

  try {
    const client = new Client({ connection, namespace })
    // Made up here in the article's format until Phase 5 takes it from the api. It is also
    // the workflow id, as it will be later.
    const reference = `PAY-${String(Date.now() % 10_000).padStart(4, '0')}`

    const handle = await client.workflow.start(PaymentWorkflow, {
      taskQueue,
      workflowId: reference,
      args: [reference],
    })
    console.log(`demo: started ${reference} on task queue "${taskQueue}", waiting for the result...`)
    console.log(`demo: follow it at ${temporalUiUrl()}/namespaces/${namespace}/workflows/${reference}`)

    const timeline = await handle.result()
    console.log(`demo: ${reference} finished`)
    for (const entry of timeline) {
      console.log(`  ${entry}`)
    }
  } finally {
    await connection.close()
  }
}

main().catch((error: unknown) => {
  console.error('demo: the workflow could not be run', error)
  process.exit(1)
})
