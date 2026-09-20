import { type Pool, type PoolClient, transactionState } from '@payments/db'
import { InsufficientFunds, NotZeroSum, toLedgerError } from './errors'
import type { Entry, LedgerTransactionId, NormalSide, TransactionInput } from './types'

/** An account as the engine reads it while holding its lock. */
interface LockedAccount {
  readonly code: string
  readonly normal_side: NormalSide
  readonly allows_negative: boolean
  readonly balance_minor: string
}

/**
 * Writes one ledger transaction: the transaction row, then its entries.
 *
 * Runs inside the caller's database transaction and never opens or commits one of its own,
 * because a payment row and its reserve have to land together or not at all. Use
 * `withLedgerTransaction` when a posting really is the whole unit of work.
 *
 * The database would refuse an illegal posting anyway (`migrations/0002_ledger.sql`). The
 * checks here exist so the caller hears it from the engine, where the numbers are still
 * known, instead of from a constraint that only knows which row gave way.
 */
export async function writeTransaction(client: PoolClient, input: TransactionInput): Promise<LedgerTransactionId> {
  assertWellFormed(input)
  assertZeroSum(input)
  await assertInTransaction(client)

  try {
    const accounts = await lockAccounts(client, input.entries)
    assertBalancesSurvive(input, accounts)

    const transaction = await client.query<{ id: string }>(
      `INSERT INTO ledger_transactions (kind, reference, currency, proof)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.kind, input.reference ?? null, input.currency, input.proof ?? null],
    )
    const id = transaction.rows[0]?.id
    if (id === undefined) {
      throw new Error('the ledger transaction was not written')
    }

    for (const entry of input.entries) {
      await client.query(
        `INSERT INTO ledger_entries (transaction_id, account_code, direction, amount_minor, currency)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, entry.account, entry.direction, entry.amount.toString(), input.currency],
      )
    }

    return id
  } catch (error) {
    throw toLedgerError(error)
  }
}

/** Shape checks that do not need the database. */
function assertWellFormed(input: TransactionInput): void {
  if (input.entries.length === 0) {
    // The deferred zero-sum trigger fires per inserted entry, so a transaction with no
    // entries at all would never be asked whether it balances.
    throw new Error('a ledger transaction needs at least one entry')
  }
  for (const entry of input.entries) {
    if (entry.amount <= 0n) {
      throw new Error(`entry amounts are positive; ${entry.account} was posted ${entry.amount}`)
    }
  }
}

/**
 * Invariant 1, checked before anything is written. The database enforces this too, at
 * COMMIT, but a caller deserves to hear it here — where the imbalance can still be named.
 */
function assertZeroSum(input: TransactionInput): void {
  let imbalance = 0n
  for (const entry of input.entries) {
    imbalance += entry.direction === 'debit' ? entry.amount : -entry.amount
  }
  if (imbalance !== 0n) {
    throw new NotZeroSum(input.currency, imbalance)
  }
}

/**
 * Refuses to run outside a transaction the caller opened.
 *
 * Without this, autocommit turns each statement into its own transaction: the
 * `ledger_transactions` row commits on its own, the first entry then trips the deferred
 * zero-sum trigger, and what is left behind is a phantom transaction with no entries that
 * the append-only trigger makes impossible to delete. The row lock would also be released
 * the moment its statement ended, so every guarantee in this file would quietly evaporate.
 */
async function assertInTransaction(client: PoolClient): Promise<void> {
  const state = await transactionState(client)
  if (state === 'open') {
    return
  }
  throw new Error(
    state === 'aborted'
      ? 'this client is inside an aborted transaction; roll it back before posting to the ledger'
      : 'writeTransaction must run inside a transaction the caller opened, so the posting and whatever else the caller is writing commit together or not at all. Use withLedgerTransaction if the posting is the whole unit of work.',
  )
}

/**
 * Takes the row locks this posting needs, all of them, in one statement.
 *
 * `ORDER BY code` is the whole point and is not a stylistic choice. Two transactions that
 * touch the same two accounts in opposite orders will each hold what the other is waiting
 * for, and Postgres resolves that by killing one of them. Sorting the codes means every
 * writer in this system queues for the same accounts in the same sequence, so they wait
 * instead of deadlocking.
 *
 * This is the lock the article's §5 is about: from here until the caller commits, nobody
 * else can read these balances to decide whether they can afford something.
 */
async function lockAccounts(client: PoolClient, entries: readonly Entry[]): Promise<Map<string, LockedAccount>> {
  const codes = [...new Set(entries.map((entry) => entry.account))].sort()

  const locked = await client.query<LockedAccount>(
    `SELECT code, normal_side, allows_negative, balance_minor
       FROM ledger_accounts
      WHERE code = ANY($1)
      ORDER BY code
        FOR UPDATE`,
    [codes],
  )

  return new Map(locked.rows.map((row) => [row.code, row]))
}

/**
 * Invariant 3, evaluated while the rows are locked: replay this posting's entries against
 * the balances we just read and refuse if a guarded account dips below zero.
 *
 * Entry by entry, in order, because that is what the database will do: the balance trigger
 * fires per row, so an account that ends the posting whole can still be overdrawn halfway
 * through it, and the CHECK fires there. Netting the deltas instead would let such a posting
 * past this function and have the database reject it — with an error that no longer knows
 * the amounts, which is precisely what this check exists to provide.
 *
 * An account the query did not return is not in the chart of accounts. Nothing is invented
 * for it here; the foreign key refuses the entry a few lines later.
 */
function assertBalancesSurvive(input: TransactionInput, accounts: Map<string, LockedAccount>): void {
  const running = new Map<string, bigint>()

  for (const entry of input.entries) {
    const account = accounts.get(entry.account)
    if (account === undefined) {
      continue
    }
    const balance = running.get(entry.account) ?? BigInt(account.balance_minor)
    const delta = entry.direction === account.normal_side ? entry.amount : -entry.amount
    const next = balance + delta

    if (!account.allows_negative && next < 0n) {
      throw new InsufficientFunds(entry.account, entry.amount, balance)
    }
    running.set(entry.account, next)
  }
}

/**
 * For callers whose whole unit of work is one posting. Anything that also writes a payment
 * row should open its own transaction and call `writeTransaction` inside it instead.
 *
 * COMMIT is where the deferred guards answer, so this is also the only place a zero-sum or
 * release violation can surface: it maps that failure like any other.
 */
export async function withLedgerTransaction<T>(pool: Pool, body: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  // A client whose ROLLBACK failed may still be inside a transaction. Releasing it plainly
  // would hand that transaction to whoever borrows it next, so the pool is told to destroy
  // it instead: `release(error)` discards the connection rather than reusing it.
  let poisoned: Error | undefined

  try {
    await client.query('BEGIN')
    const result = await body(client)
    await client.query('COMMIT')
    return result
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackFailure: unknown) => {
      poisoned = rollbackFailure instanceof Error ? rollbackFailure : new Error(String(rollbackFailure))
    })
    throw toLedgerError(error)
  } finally {
    client.release(poisoned)
  }
}
