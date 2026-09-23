import { explorerTransactionUrl } from '@payments/chain'
import type { Pool } from '@payments/db'
import type { ReconciliationItemView, ReconciliationRunSummary, ReconciliationRunView } from '@payments/domain'
import { formatMinor } from '@payments/ledger'

/**
 * The reconciliation reads. The api computes nothing here: a run is written by the worker, whole,
 * and these two queries only print it.
 */

/** The history the screen shows. Older runs stay in the database, like payments and deposits. */
const LIST_LIMIT = 20

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const RUN_COLUMNS = 'id, started_at, finished_at, block_number, outcome, checked, explained, mismatched, summary'

/** `GET /reconciliation/runs`: newest first. */
export async function listRuns(pool: Pool): Promise<ReconciliationRunSummary[]> {
  const result = await pool.query<RunRow>(
    `SELECT ${RUN_COLUMNS} FROM reconciliation_runs ORDER BY started_at DESC LIMIT ${String(LIST_LIMIT)}`,
  )
  return result.rows.map(toRunSummary)
}

/** `GET /reconciliation/runs/:id`. An id that is not a uuid names no run, so it is the same 404. */
export async function findRun(pool: Pool, id: string): Promise<ReconciliationRunView | undefined> {
  if (!UUID.test(id)) {
    return undefined
  }
  const run = await pool.query<RunRow>(`SELECT ${RUN_COLUMNS} FROM reconciliation_runs WHERE id = $1`, [id])
  const row = run.rows[0]
  if (row === undefined) {
    return undefined
  }
  const items = await pool.query<ItemRow>(
    'SELECT subject_type, subject_id, outcome, delta_minor, detail, evidence FROM reconciliation_items WHERE run_id = $1 ORDER BY id',
    [id],
  )
  return { run: toRunSummary(row), items: items.rows.map(toItemView) }
}

interface RunRow {
  readonly id: string
  readonly started_at: Date
  readonly finished_at: Date
  readonly block_number: string | null
  readonly outcome: ReconciliationRunSummary['outcome']
  readonly checked: number
  readonly explained: number
  readonly mismatched: number
  readonly summary: string
}

interface ItemRow {
  readonly subject_type: ReconciliationItemView['subject']
  readonly subject_id: string
  readonly outcome: ReconciliationItemView['outcome']
  readonly delta_minor: string | null
  readonly detail: string
  readonly evidence: { readonly txHash?: string } | null
}

function toRunSummary(row: RunRow): ReconciliationRunSummary {
  return {
    id: row.id,
    startedAt: row.started_at.toISOString(),
    finishedAt: row.finished_at.toISOString(),
    block: row.block_number,
    outcome: row.outcome,
    checked: row.checked,
    explained: row.explained,
    mismatched: row.mismatched,
    summary: row.summary,
  }
}

/** Decimal strings in whole USDC on the wire, like every other amount this api answers with. */
function toItemView(row: ItemRow): ReconciliationItemView {
  const hash = row.evidence?.txHash
  return {
    subject: row.subject_type,
    subjectId: row.subject_id,
    outcome: row.outcome,
    ...(row.delta_minor === null ? {} : { delta: formatMinor(BigInt(row.delta_minor)) }),
    detail: row.detail,
    ...(hash === undefined ? {} : { explorerUrl: explorerTransactionUrl(hash) }),
  }
}
