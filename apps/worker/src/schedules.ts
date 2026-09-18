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
 * The repeating work this system does, declared where the worker starts.
 *
 * A Temporal Schedule is the second Temporal concept in this repo, after the Workflow: a
 * server-side timer that starts a workflow on a spec, survives every restart of this
 * process, and records every run it took. It is not a `setInterval` — nothing here keeps
 * time, and a worker that is down for an hour finds the schedule waiting for it rather than
 * a gap nobody can prove. The payment dispatcher and the reconciler are the same shape.
 *
 * A Schedule starts a WORKFLOW, never an activity, which is the whole reason
 * `WatcherWorkflow` exists: three lines whose only job is to be startable.
 */

export const WATCHER_SCHEDULE_ID = 'watcher'

/**
 * Every 10 seconds, as the spec fixes it. The watcher decides for itself whether a tick
 * costs an RPC round trip (`apps/worker/src/watcher.ts`, the adaptive skip), so a short,
 * fixed interval buys a fast first sighting without buying traffic.
 */
const WATCHER_SPEC: ScheduleSpec = { intervals: [{ every: '10s' }] }

function watcherAction(taskQueue: string): ScheduleOptionsAction {
  return { type: 'startWorkflow', workflowType: 'WatcherWorkflow', taskQueue }
}

/**
 * Makes sure the `watcher` schedule exists and matches this code, every time the worker
 * starts.
 *
 * Creating it is a one-off in the server's lifetime, so the normal path on any restart is
 * `ScheduleAlreadyRunning` — a startup line, not a failure. It is followed by an `update()`
 * rather than a shrug: a schedule keeps the spec it was created with, so without this line
 * changing the interval in this file would change nothing until somebody deleted the
 * schedule by hand, and the code would quietly stop describing what is running.
 *
 * The connection is the CLIENT's (`@temporalio/client`), not the worker's
 * `NativeConnection`: they are different objects with different jobs. It is opened for this
 * one errand and closed straight after, which is the smallest honest version — the worker
 * itself talks to Temporal through its own connection.
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
        // A tick that takes longer than the interval must not have a second one started on
        // top of it: two watchers scanning the same range at once is the one way this design
        // could post the same money twice, and SKIP is what makes that impossible. (It is
        // also the SDK default; written out because it is a decision, not a default.)
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
