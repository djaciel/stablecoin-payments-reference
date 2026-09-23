import { explorerTransactionUrl } from '@payments/chain'
import type { Pool } from '@payments/db'
import type { ReconciliationIdentity, ReconciliationItemView, ReconciliationRunSummary, ReconciliationRunView } from '@payments/domain'
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
  const identity = toIdentity(items.rows.find((item) => item.subject_type === 'global'))
  return { run: toRunSummary(row), items: items.rows.map(toItemView), ...(identity === undefined ? {} : { identity }) }
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
  readonly evidence: (ItemEvidence & Partial<IdentityEvidence>) | null
}

interface ItemEvidence {
  readonly txHash?: string
}

/** The global item's evidence, as the worker wrote it: minor units, like everything stored. */
interface IdentityEvidence {
  readonly books: { readonly available: string; readonly reserved: string; readonly deposits: string; readonly total: string }
  readonly chain: { readonly total: string; readonly addresses: readonly { address: string; label: string; amountMinor: string }[] }
  readonly explained: string
  readonly remainder: string
}

/**
 * The three lines the screen reads out loud, taken from the run's own record and never from a
 * fresh read of the books: the figures have to be the ones that block was compared against.
 *
 * Absent when the run has no figures to show — no block pinned, or the chain unreadable at it.
 */
function toIdentity(item: ItemRow | undefined): ReconciliationIdentity | undefined {
  const evidence = item?.evidence
  if (evidence?.books === undefined || evidence.chain === undefined || evidence.explained === undefined || evidence.remainder === undefined) {
    return undefined
  }
  return {
    books: {
      available: money(evidence.books.available),
      reserved: money(evidence.books.reserved),
      deposits: money(evidence.books.deposits),
      total: money(evidence.books.total),
    },
    chain: {
      total: money(evidence.chain.total),
      addresses: evidence.chain.addresses.map((held) => ({ address: held.address, label: held.label, amount: money(held.amountMinor) })),
    },
    explained: money(evidence.explained),
    remainder: money(evidence.remainder),
  }
}

function money(minorUnits: string): string {
  return formatMinor(BigInt(minorUnits))
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
