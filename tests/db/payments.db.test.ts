import { inTransaction } from '@payments/db'
import type { PaymentView } from '@payments/domain'
import { seedExample, withLedgerTransaction } from '@payments/ledger'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPayment, type PaymentOutcome, type PaymentRequest } from '../../apps/api/src/payments/create-payment'
import { barrier, resetDatabase, seedInvoices, testPool, withClient } from './helpers/database'

/**
 * The idempotency key against real Postgres: one key is one payment, whatever the
 * client does with it. Retry it, reuse it for another request, or fire it twice at the same
 * instant (the double click).
 */

const KEY = 'abc-123'

const pool = testPool()
let invoices: { readonly first: string; readonly second: string }

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await resetDatabase(pool)
  await withLedgerTransaction(pool, (client) => seedExample(client))
  invoices = await seedInvoices(pool)
})

describe('one idempotency key, one payment', () => {
  it('answers the same request twice with the same payment, and writes nothing the second time', async () => {
    const first = paymentOf(await pay({ idempotencyKey: KEY, payableId: invoices.first }))
    const before = await rowCounts()

    const again = await pay({ idempotencyKey: KEY, payableId: invoices.first })

    expect(first.reference).toMatch(/^PAY-\d{4}$/)
    expect(first.status).toBe('RESERVED')
    expect(again.kind).toBe('replayed')
    expect(paymentOf(again).reference).toBe(first.reference)
    expect(await rowCounts()).toEqual(before)
  })

  it('refuses the same key with a different body, and writes nothing', async () => {
    await pay({ idempotencyKey: KEY, payableId: invoices.first })
    const before = await rowCounts()

    const reused = await pay({ idempotencyKey: KEY, payableId: invoices.second })

    expect(reused.kind).toBe('key-conflict')
    expect(await rowCounts()).toEqual(before)
  })

  it('makes one payment out of two parallel calls with the same key: one row, one reserve, one reference', async () => {
    // The latch makes it a double click rather than two calls in a row: both transactions are
    // open before either inserts, so one of them has to wait on the unique index for the other.
    const startTogether = barrier(2)
    const click = (): Promise<PaymentOutcome> =>
      withClient(pool, (client) =>
        inTransaction(client, async () => {
          await startTogether()
          return createPayment(client, { idempotencyKey: KEY, payableId: invoices.first })
        }),
      )

    const [one, other] = await Promise.all([click(), click()])

    expect([one.kind, other.kind].sort()).toEqual(['recorded', 'replayed'])
    expect(paymentOf(one).reference).toBe(paymentOf(other).reference)
    expect((await rowCounts()).payments).toBe(1)
    const reserves = await pool.query(`SELECT 1 FROM ledger_transactions WHERE kind = 'reserve'`)
    expect(reserves.rowCount).toBe(1)
  })
})

/** The way the api calls it: one connection, one transaction the caller opens and commits. */
function pay(request: PaymentRequest): Promise<PaymentOutcome> {
  return withClient(pool, (client) => inTransaction(client, () => createPayment(client, request)))
}

function paymentOf(outcome: PaymentOutcome): PaymentView {
  if (outcome.kind !== 'recorded' && outcome.kind !== 'replayed') {
    throw new Error(`expected a payment, got ${outcome.kind}`)
  }
  return outcome.payment
}

/** Everything a payment can write. "Nothing new" means none of these moved. */
async function rowCounts(): Promise<Record<string, number>> {
  const result = await pool.query<Record<string, string>>(
    `SELECT (SELECT count(*) FROM payments) AS payments,
            (SELECT count(*) FROM ledger_transactions) AS ledger_transactions,
            (SELECT count(*) FROM ledger_entries) AS ledger_entries,
            (SELECT count(*) FROM audit_log) AS audit_log`,
  )
  return Object.fromEntries(Object.entries(result.rows[0] ?? {}).map(([table, count]) => [table, Number(count)]))
}
