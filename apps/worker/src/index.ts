import { Client, Connection } from '@temporalio/client'
import { NativeConnection, Runtime, Worker } from '@temporalio/worker'
import * as activities from './activities'
import { readTemporalConfig, type TemporalConfig } from './config'
import { closeWorkerPool } from './db'

/** The watcher's workflow id: one name, one watcher, whoever starts the worker. */
const WATCHER_WORKFLOW_ID = 'watcher'

async function main(): Promise<void> {
  const config = readTemporalConfig()
  const { address, namespace, taskQueue } = config

  // The SDK's own signal handlers, turned off so the shutdown path is visible in this file
  // and only one handler ever calls `shutdown()`. Must run before anything else touches the
  // runtime: installing it later throws.
  Runtime.install({ shutdownSignals: [] })

  const connection = await NativeConnection.connect({ address })

  try {
    const worker = await Worker.create({
      connection,
      namespace,
      taskQueue,
      // A path, not an import: workflow code is bundled and run in its own sandbox, so
      // the worker process never loads it directly.
      workflowsPath: require.resolve('./workflows'),
      activities,
    })

    stopOnSignal(worker)

    // Before the first poll, so the watcher is up by the time the queue is being served. It
    // is also the only thing that revives a watcher somebody terminated: nothing else watches
    // the watcher.
    await startWatcher(config)

    console.log(`worker: polling task queue "${taskQueue}" on ${address} (namespace ${namespace})`)

    // Resolves once the worker has drained, which is what `stopOnSignal` asks for.
    await worker.run()
    console.log('worker: shut down')
  } finally {
    // Without the pool's close, `docker compose stop worker` waits for its idle connections
    // to time out before Node has nothing left to do.
    await connection.close()
    await closeWorkerPool()
  }
}

/**
 * PID 1 in a container does not get Linux's default "die on SIGTERM", so without this handler
 * compose waits out its grace period and kills us; `worker.shutdown()` also tells Temporal to
 * reschedule the work at once instead of waiting for the heartbeat timeout.
 *
 * Draining CANCELS in-flight steps rather than letting them finish — orderly, not graceful.
 * Running a step to completion first is Phase 5's decision about the real broadcast step.
 */
function stopOnSignal(worker: Worker): void {
  let stopping = false

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      // A second Ctrl-C while the first shutdown is still draining would throw.
      if (stopping) {
        return
      }
      stopping = true
      console.log(`worker: ${signal} received, draining in-flight steps`)
      worker.shutdown()
    })
  }
}

/**
 * Starts the watcher unless it is already running. The connection is the CLIENT's, not the
 * worker's `NativeConnection`: different objects with different jobs, and this one is opened
 * for the errand and closed straight after.
 */
async function startWatcher({ address, namespace, taskQueue }: TemporalConfig): Promise<void> {
  const connection = await Connection.connect({ address })

  try {
    const client = new Client({ connection, namespace })

    const handle = await client.workflow.start('WatcherWorkflow', {
      workflowId: WATCHER_WORKFLOW_ID,
      taskQueue,
      // Start if absent, attach if present. Without it a worker restarting next to a live
      // watcher would either fail here or — worse — leave two watchers scanning the chain.
      workflowIdConflictPolicy: 'USE_EXISTING',
      // No `workflowExecutionTimeout` and no `workflowRunTimeout`, on purpose: this workflow
      // is meant never to end, and a deadline on it is a bug with a clock in it.
    })

    // "since" is what tells the two cases apart in the log: a time a second old means this
    // worker started it, an older one means it found it already running and left it alone.
    const { startTime } = await handle.describe()
    console.log(`worker: watcher workflow "${WATCHER_WORKFLOW_ID}" running since ${startTime.toISOString()}, run ${handle.firstExecutionRunId}`)
  } finally {
    await connection.close()
  }
}

main().catch((error: unknown) => {
  // `restart: unless-stopped` in compose means a startup failure shows up as this line
  // repeating every few seconds rather than as a container that stays down.
  console.error('worker: could not start — the container will be restarted, so expect this to repeat', error)
  process.exit(1)
})
