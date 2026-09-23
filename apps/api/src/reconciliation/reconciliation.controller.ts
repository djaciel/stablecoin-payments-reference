import { Controller, Get, HttpCode, HttpStatus, Inject, NotFoundException, Param, Post, ServiceUnavailableException } from '@nestjs/common'
import type { Pool } from '@payments/db'
import {
  RECONCILIATION_WORKFLOW,
  readTemporalConfig,
  reconciliationRunStart,
  workflowUrl,
  type ReconciliationRunView,
  type ReconciliationRuns,
} from '@payments/domain'
import type { Client } from '@temporalio/client'
import { DATABASE_POOL } from '../db/db.module'
import { TEMPORAL_CLIENT } from '../temporal/temporal.module'
import { findRun, listRuns } from './read-reconciliation'

const { taskQueue } = readTemporalConfig()

/** The same deadline `dispatch.ts` gives a Pay: a Temporal that is down must not hold the answer. */
const START_DEADLINE_MS = 3_000

/** What "Run now" answers: the run that was started, and where to watch it. */
interface ReconciliationRunStarted {
  readonly startedAs: string
  readonly temporalUrl: string
}

/**
 * The reconciliation reads, and the button that asks for a run (§10). The api never computes a
 * reconciliation: the worker does, in one activity, and this controller only starts it and prints
 * what it wrote.
 */
@Controller('reconciliation')
export class ReconciliationController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(TEMPORAL_CLIENT) private readonly temporal: Client,
  ) {}

  @Get('runs')
  async list(): Promise<ReconciliationRuns> {
    return { runs: await listRuns(this.pool) }
  }

  @Get('runs/:id')
  async find(@Param('id') id: string): Promise<ReconciliationRunView> {
    const run = await findRun(this.pool, id)
    if (run === undefined) {
      throw new NotFoundException(`no reconciliation run has the id ${id}.`)
    }
    return run
  }

  /**
   * 202 rather than 200: the run takes as long as the chain takes, and the screen polls the list
   * for it, like every other screen here. Nothing is queued when Temporal cannot be reached, so
   * that case says so instead of answering with a run id nobody started.
   */
  @Post('run')
  @HttpCode(HttpStatus.ACCEPTED)
  async run(): Promise<ReconciliationRunStarted> {
    const start = reconciliationRunStart(new Date(), taskQueue)
    try {
      await this.temporal.withDeadline(Date.now() + START_DEADLINE_MS, () =>
        this.temporal.workflow.start(RECONCILIATION_WORKFLOW, start),
      )
    } catch {
      throw new ServiceUnavailableException(
        'Temporal could not be reached, so no run was started. The reconciler runs by itself every ten minutes; try again when it is back.',
      )
    }
    return { startedAs: start.workflowId, temporalUrl: workflowUrl(start.workflowId) }
  }
}
