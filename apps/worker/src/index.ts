import { NativeConnection, Runtime, Worker } from '@temporalio/worker'
import * as activities from './activities'
import { readTemporalConfig } from './config'
import { closeWorkerPool } from './db'
import { ensureWatcherSchedule } from './schedules'

async function main(): Promise<void> {
  const config = readTemporalConfig()
  const { address, namespace, taskQueue } = config

  // The SDK installs signal handlers of its own by default. They are turned off here so
  // that the shutdown path of this service is visible in this file instead of happening
  // somewhere in a dependency — and so that only one handler ever calls `shutdown()`.
  // This has to run before anything else touches the runtime: installing it later throws.
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

    // Before the first poll, so the schedule exists by the time anything could fire it.
    // It is declared in code and reconciled on every start (see schedules.ts), which is why
    // there is no "run this once" step anywhere in the README.
    await ensureWatcherSchedule(config)

    console.log(`worker: polling task queue "${taskQueue}" on ${address} (namespace ${namespace})`)

    // Resolves once the worker has drained, which is what `stopOnSignal` asks for.
    await worker.run()
    console.log('worker: shut down')
  } finally {
    // Whoever opens a resource closes it: the Temporal connection and the database pool the
    // watcher's activity borrows from. Without the pool's close, `docker compose stop worker`
    // waits for its idle connections to time out before Node has nothing left to do.
    await connection.close()
    await closeWorkerPool()
  }
}

/**
 * `docker compose stop worker` sends SIGTERM. Two reasons this handler exists:
 *
 * - PID 1 in a container does not get Linux's default "die on SIGTERM" behaviour, so
 *   without a handler compose waits out its ten-second grace period and then kills us.
 * - `worker.shutdown()` tells Temporal we are going away, and Temporal reschedules the
 *   work at once instead of waiting for the heartbeat timeout to expire.
 *
 * What it does NOT do is let a running step finish: draining CANCELS in-flight
 * activities so another worker can pick them up immediately, and the step comes back as
 * a retry elsewhere. Orderly, not graceful. Letting a step run to completion first needs
 * `shutdownGraceTime` plus a step that ignores cancellation, and that is a decision about
 * the real broadcast step in Phase 5 — not a default worth taking now.
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
  // The worker restarts automatically (`restart: unless-stopped` in compose, which the
  // crash experiment depends on), so a startup failure shows up as this line repeating
  // every few seconds rather than as a container that stays down.
  console.error('worker: could not start — the container will be restarted, so expect this to repeat', error)
  process.exit(1)
})
