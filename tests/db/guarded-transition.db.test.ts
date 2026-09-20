import { TransitionRejected, applyGuardedTransition, inTransaction } from '@payments/db'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { barrier, testPool, withClient } from './helpers/database'

/**
 * Invariant 4: every state change is `UPDATE … WHERE status = expected`, and exactly one row has
 * to have changed. Proved against a fixture table, so payments, deposits and invoices inherit
 * the guarantee from one place.
 *
 * The case worth testing is the one that looks like success: an UPDATE that matched nothing is a
 * perfectly good statement, so a caller that does not read `rowCount` carries on as if the
 * transition happened.
 */

const pool = testPool()

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await pool.query('DROP TABLE IF EXISTS transition_fixture')
  await pool.query(`
    CREATE TABLE transition_fixture (
      reference text PRIMARY KEY,
      status    text NOT NULL
    )
  `)
  await pool.query(`INSERT INTO transition_fixture (reference, status) VALUES ('PAY-0001', 'RESERVED')`)
})

const transition = {
  table: 'transition_fixture',
  idColumn: 'reference',
  id: 'PAY-0001',
  statusColumn: 'status',
}

describe('a guarded transition', () => {
  it('lets exactly one of two parallel attempts win and tells the loser which state it found', async () => {
    // Two workers both believe the payment is RESERVED. The second UPDATE waits for the first
    // one's row lock, re-checks its WHERE clause and matches zero rows — the row count is what
    // turns that silence into a rejection.
    const startTogether = barrier(2)
    const attempt = (to: string): Promise<string> =>
      withClient(pool, (client) =>
        inTransaction(client, async () => {
          await startTogether()
          await applyGuardedTransition(client, { ...transition, from: 'RESERVED', to })
          return to
        }),
      )

    const outcomes = await Promise.allSettled([attempt('SENT'), attempt('FAILED')])

    const winner = outcomes.find((outcome) => outcome.status === 'fulfilled')
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1)
    expect(await statusOf('PAY-0001')).toBe((winner as PromiseFulfilledResult<string>).value)

    // The loser's error names both states, so a log line is enough to tell "somebody beat me to
    // it" apart from "this payment was never in that state".
    const refusal: unknown = outcomes.find((outcome) => outcome.status === 'rejected')?.reason
    expect(refusal).toBeInstanceOf(TransitionRejected)
    expect((refusal as TransitionRejected).expected).toBe('RESERVED')
    expect((refusal as TransitionRejected).actual).toBe((winner as PromiseFulfilledResult<string>).value)
  })
})

async function statusOf(reference: string): Promise<string | undefined> {
  const result = await pool.query<{ status: string }>('SELECT status FROM transition_fixture WHERE reference = $1', [
    reference,
  ])
  return result.rows[0]?.status
}
