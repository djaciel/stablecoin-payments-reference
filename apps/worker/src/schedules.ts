import {
  Client,
  Connection,
  ScheduleAlreadyRunning,
  ScheduleOverlapPolicy,
  type ScheduleOptionsAction,
  type ScheduleSpec,
} from '@temporalio/client'
import type { TemporalConfig } from './config'

/**
 * A Temporal Schedule is a server-side timer, not a `setInterval`: it survives every restart
 * of this process and records every run it took, so a worker that was down for an hour finds
 * the schedule waiting rather than a gap nobody can prove. It can only start a WORKFLOW,
 * which is the whole reason `WatcherWorkflow` exists.
 */

export const WATCHER_SCHEDULE_ID = 'watcher'

/** Every 10s, as the spec fixes it; the watcher itself decides whether a tick costs an RPC. */
const WATCHER_SPEC: ScheduleSpec = { intervals: [{ every: '10s' }] }

function watcherAction(taskQueue: string): ScheduleOptionsAction {
  return {
    type: 'startWorkflow',
    workflowType: 'WatcherWorkflow',
    taskQueue,
    // The backstop for a run that can never end on its own: a workflow whose TYPE is not
    // registered on the worker fails its workflow task and Temporal retries that forever,
    // which SKIP below then turns into a watcher silently stopped for good. Comfortably above
    // one tick's worst case (three activity attempts, ~32 s), and at most four skipped ticks.
    workflowExecutionTimeout: '45 seconds',
  }
}

/**
 * Makes sure the `watcher` schedule exists and matches this code, every time the worker
 * starts.
 *
 * Creating it is a one-off in the server's lifetime, so `ScheduleAlreadyRunning` is the
 * normal path and is followed by an `update()` rather than a shrug: a schedule keeps the spec
 * it was created with, so without that line changing this file would change nothing until
 * somebody deleted the schedule by hand.
 *
 * The connection is the CLIENT's, not the worker's `NativeConnection`: different objects with
 * different jobs. Opened for this one errand and closed straight after.
 */
export async function ensureWatcherSchedule({ address, namespace, taskQueue }: TemporalConfig): Promise<void> {
  const connection = await Connection.connect({ address })

  try {
    const client = new Client({ connection, namespace })

    try {
      await client.schedule.create({
        scheduleId: WATCHER_SCHEDULE_ID,
        spec: WATCHER_SPEC,
        action: watcherAction(taskQueue),
        // Two watchers scanning the same range at once is the one way this design could post
        // the same money twice, and SKIP is what makes that impossible. (Also the SDK
        // default; written out because it is a decision, not a default.)
        policies: { overlap: ScheduleOverlapPolicy.SKIP },
      })
      console.log(`worker: schedule "${WATCHER_SCHEDULE_ID}" created, starting WatcherWorkflow every 10s`)
    } catch (error) {
      if (!(error instanceof ScheduleAlreadyRunning)) {
        throw error
      }
      await client.schedule.getHandle(WATCHER_SCHEDULE_ID).update((previous) => ({
        ...previous,
        spec: WATCHER_SPEC,
        action: watcherAction(taskQueue),
      }))
      console.log(`worker: schedule "${WATCHER_SCHEDULE_ID}" already exists, updated to the spec in this code`)
    }
  } finally {
    await connection.close()
  }
}
