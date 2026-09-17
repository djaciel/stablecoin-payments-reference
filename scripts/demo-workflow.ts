import { Client, Connection } from '@temporalio/client'
import { readTemporalConfig } from '../apps/worker/src/config'
import { PaymentWorkflow } from '../apps/worker/src/workflows'

/**
 * `pnpm demo:workflow` — start one payment workflow and wait for it.
 *
 * It exists to make durable execution visible before there is a payment to make it with:
 * start this, kill the worker while a step is running, and watch the workflow finish
 * anyway. The procedure is in docs/dev/restart-survival.md.
 *
 * This script keeps waiting through the kill, because the workflow lives in Temporal —
 * not in this process, and not in the worker either.
 *
 * Phase 5 turns the real thing on: the reference comes from `POST /payments`, the api
 * starts the workflow after the ledger reserve is committed, and the crash is injected
 * between signing and broadcasting instead of being triggered by hand. That script is
 * `pnpm experiment:crash`; this one stays as the shortest way to see the mechanism.
 */

/**
 * Where the `temporal-ui` service is published (docker-compose.yml). `.env` can move that
 * port with TEMPORAL_UI_PORT, and a printed link that ignores it sends you to a page that
 * is not there. Empty means unset, same rule as the Temporal variables in the worker.
 */
function temporalUiUrl(): string {
  const port = process.env['TEMPORAL_UI_PORT']
  return `http://localhost:${port === undefined || port === '' ? '8080' : port}`
}

async function main(): Promise<void> {
  const { address, namespace, taskQueue } = readTemporalConfig()
  const connection = await Connection.connect({ address })

  try {
    const client = new Client({ connection, namespace })
    // Phase 5 takes this reference from the api. Until then the demo makes one up, in the
    // article's published format. It is also the workflow id, as it will be later.
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
