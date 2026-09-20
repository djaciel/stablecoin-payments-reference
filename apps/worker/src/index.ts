import { NativeConnection, Runtime, Worker } from '@temporalio/worker'
import * as activities from './activities'
import { readTemporalConfig } from './config'
import { closeWorkerPool } from './db'
import { ensureWatcherSchedule } from './schedules'

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

    // Before the first poll, so the schedule exists by the time anything could fire it, and
    // reconciled on every start — which is why no README step says "run this once".
    await ensureWatcherSchedule(config)

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

main().catch((error: unknown) => {
  // `restart: unless-stopped` in compose means a startup failure shows up as this line
  // repeating every few seconds rather than as a container that stays down.
  console.error('worker: could not start — the container will be restarted, so expect this to repeat', error)
  process.exit(1)
})
