import type { PoolClient } from 'pg'
import { transactionState } from './transaction'

/**
 * Invariant 4, written once.
 *
 * Every state change in this system is `UPDATE … SET status = $to WHERE id = $id AND status =
 * $from`, followed by a check that exactly one row changed. The guard is what makes a
 * transition safe under concurrency: two workers both trying to move the same payment out of
 * RESERVED run the same statement, and only one of them matches a row.
 *
 * The row count is the part that gets forgotten. An UPDATE that matched nothing is a
 * successful statement — Postgres has no complaint — so a caller who does not look at
 * `rowCount` carries on as if the transition happened. Writing it here means none of the
 * dozens of transitions in Phases 4 to 9 can forget.
 *
 * Lives in `packages/db` rather than `packages/ledger` because payments, deposits and
 * invoices all transition, and none of them is a ledger concern.
 */

/**
 * A transition that did not happen, with both states named so the message can go straight
 * into a log: expecting RESERVED and finding SETTLED is a very different bug from finding
 * nothing at all.
 */
export class TransitionRejected extends Error {
  constructor(
    readonly subject: string,
    readonly expected: string,
    readonly actual: string | undefined,
  ) {
    super(
      actual === undefined
        ? `${subject} was expected in state ${expected}, but no such row exists`
        : `${subject} was expected in state ${expected}, but it is in state ${actual}`,
    )
    this.name = 'TransitionRejected'
  }
}

export interface GuardedTransition {
  readonly table: string
  readonly idColumn: string
  readonly id: string
  readonly statusColumn: string
  /** The state the caller believes the row is in. The guard, and the whole point. */
  readonly from: string
  readonly to: string
  /** Columns to set along with the status, in the same statement: a hash, a timestamp. */
  readonly extraSet?: Readonly<Record<string, unknown>>
}

/**
 * Identifiers cannot be parameters in SQL, so they are checked and then quoted.
 *
 * Both, not either. The pattern rejects anything that is not a plain lowercase identifier,
 * and the quoting means that even if the pattern were ever loosened, the value still could
 * not end the identifier and start a new clause. This function takes table and column names
 * from its caller, and a helper that takes identifiers is exactly where injection gets in.
 */
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/

function quoteIdentifier(identifier: string, what: string): string {
  // Converted once and then used twice. Testing one string and interpolating another would
  // let a value that stringifies differently each time pass the check and land in the SQL.
  const value = String(identifier)
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`${what} must be a plain lowercase identifier; refusing to build SQL with "${value}"`)
  }
  return `"${value}"`
}

/**
 * Moves one row from one state to another, or explains why it could not.
 *
 * Takes a client, never a pool: the transition has to commit with whatever else the caller is
 * writing. A payment that moved to SETTLED in a transaction that later rolled back would be a
 * payment whose books and status disagree.
 */
export async function applyGuardedTransition(client: PoolClient, transition: GuardedTransition): Promise<void> {
  // Identifiers first. A bad one is a programming error and does not depend on the state of
  // the connection, so it should say so whatever else is wrong.
  const table = quoteIdentifier(transition.table, 'table')
  const idColumn = quoteIdentifier(transition.idColumn, 'id column')
  const statusColumn = quoteIdentifier(transition.statusColumn, 'status column')

  const extra = Object.entries(transition.extraSet ?? {})
  const assignments = [
    `${statusColumn} = $1`,
    ...extra.map(([column], index) => `${quoteIdentifier(column, 'extra column')} = $${index + 4}`),
  ]

  // The doc above promises this runs inside the caller's transaction. Check it rather than
  // trusting it: in autocommit the UPDATE commits on its own, and a transition that committed
  // while the work it belongs to rolled back is a status that disagrees with the books.
  if ((await transactionState(client)) !== 'open') {
    throw new Error(
      'applyGuardedTransition must run inside a transaction the caller opened, so the transition commits with the work it belongs to',
    )
  }

  const result = await client.query(
    `UPDATE ${table}
        SET ${assignments.join(', ')}
      WHERE ${idColumn} = $2
        AND ${statusColumn} = $3`,
    [transition.to, transition.id, transition.from, ...extra.map(([, value]) => value)],
  )

  if (result.rowCount === 1) {
    return
  }

  // Read the row back for the message. Under READ COMMITTED this is a fresh snapshot, so it
  // reports whatever is there now — usually the state that beat us to it, occasionally
  // something a third transaction wrote in between. A diagnostic, not a claim about the
  // instant the UPDATE ran.
  const current = await client.query<Record<string, string>>(
    `SELECT ${statusColumn} AS status FROM ${table} WHERE ${idColumn} = $1`,
    [transition.id],
  )

  throw new TransitionRejected(transition.id, transition.from, current.rows[0]?.['status'])
}
