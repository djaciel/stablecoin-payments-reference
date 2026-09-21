import { inTransaction } from '@payments/db'
import type { PaymentView } from '@payments/domain'
import { ARTICLE_PARTNER_DEBT, seedArticle, withLedgerTransaction } from '@payments/ledger'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPayment, type PaymentOutcome, type PaymentRequest } from '../../apps/api/src/payments/create-payment'
import { barrier, resetDatabase, testPool, withClient } from './helpers/database'

/**
 * The article's idempotency key (§4) against real Postgres: one key is one payment, whatever the
 * client does with it. Retry it, reuse it for another request, or fire it twice at the same
 * instant (§9's double click).
 */

const PAYOUT_ADDRESS = '0x1111111111111111111111111111111111111111'
const KEY = 'abc-123'

const pool = testPool()
let invoices: { readonly first: string; readonly second: string }

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await resetDatabase(pool)
  await withLedgerTransaction(pool, (client) => seedArticle(client))
  invoices = await seedInvoices()
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

/**
 * The first invoice is the Partner debt `seedArticle` put on the books (§7's 1,000); the second is
 * only there to be "a different body". Written straight to the table: these tests are about the
 * payment, not about how invoices are created.
 */
async function seedInvoices(): Promise<{ first: string; second: string }> {
  const partner = await pool.query<{ id: string }>(
    `INSERT INTO partners (name, derivation_index, deposit_address, payout_address)
     VALUES ('Bluefin Studio', 1, '0x2222222222222222222222222222222222222222', $1) RETURNING id`,
    [PAYOUT_ADDRESS],
  )
  const payables = await pool.query<{ id: string }>(
    `INSERT INTO payables (partner_id, destination, amount_minor, description)
     VALUES ($1, $2, $3, 'March logistics'), ($1, $2, $3, 'April logistics') RETURNING id`,
    [partner.rows[0]?.id, PAYOUT_ADDRESS, ARTICLE_PARTNER_DEBT.toString()],
  )
  const [first, second] = payables.rows
  if (first === undefined || second === undefined) {
    throw new Error('the two invoices were not written')
  }
  return { first: first.id, second: second.id }
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
