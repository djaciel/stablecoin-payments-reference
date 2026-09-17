import type { PoolClient } from 'pg'

/** Where a client stands: outside a transaction, inside a healthy one, or inside a dead one. */
export type TransactionState = 'none' | 'open' | 'aborted'

const NOT_IN_TRANSACTION = '25P01'
const IN_FAILED_TRANSACTION = '25P02'

/**
 * Asks Postgres what state the client's transaction is in.
 *
 * `SAVEPOINT` is the probe, and it answers all three cases in one round trip: it succeeds
 * inside a healthy transaction, fails with `25P01` outside one, and fails with `25P02` when
 * the transaction is still open but already aborted. Releasing it immediately leaves nothing
 * behind. There is no cheaper question — `pg_current_xact_id_if_assigned()` answers a
 * different one, since a transaction that has not written yet has no id.
 */
export async function transactionState(client: PoolClient): Promise<TransactionState> {
  try {
    await client.query('SAVEPOINT transaction_probe; RELEASE SAVEPOINT transaction_probe')
    return 'open'
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === NOT_IN_TRANSACTION) {
      return 'none'
    }
    if (code === IN_FAILED_TRANSACTION) {
      return 'aborted'
    }
    throw error
  }
}

/** Is this client inside a transaction the caller opened, and is that transaction usable? */
export async function isInTransaction(client: PoolClient): Promise<boolean> {
  return (await transactionState(client)) === 'open'
}

/**
 * Runs `body` inside a transaction, opening one only if the caller has not already.
 *
 * This is what lets a unit of work be called either way: on its own, where it has to be
 * atomic by itself, or inside a bigger one that will commit it along with everything else.
 * Whoever opened the transaction is the one who closes it, so this never commits work the
 * caller is not finished with.
 */
export async function inTransaction<T>(client: PoolClient, body: () => Promise<T>): Promise<T> {
  const state = await transactionState(client)

  if (state === 'aborted') {
    // Opening a transaction here would fail anyway, and running the body would fail on every
    // statement. Say what is actually wrong instead: the caller has an error to deal with.
    throw new Error('this client is inside an aborted transaction; roll it back before using it')
  }

  if (state === 'open') {
    return body()
  }

  try {
    await client.query('BEGIN')
    const result = await body()
    await client.query('COMMIT')
    return result
  } catch (error) {
    // Inside the try on purpose: if BEGIN itself fails, or the body does, the client must not
    // go back to the pool still holding a transaction for whoever borrows it next.
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  }
}
