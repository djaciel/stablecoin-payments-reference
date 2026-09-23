import { inTransaction } from '@payments/db'
import { ACCOUNTS, receivable, toMinor, withLedgerTransaction, type MinorUnits } from '@payments/ledger'
import { getAddress, type Address, type Hex } from 'viem'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { promotableDeposits, recordDetected, settleDeposit } from '../../apps/worker/src/deposits'
import { balanceOf, resetDatabase, seedPartner, seedReceivable, testPool, withClient } from './helpers/database'

/**
 * Article section 8 against real Postgres: money coming in is credited only when the chain can no
 * longer take it back, it belongs to whoever owns the address it arrived at, and scanning the same
 * block twice cannot pay an invoice twice.
 */

/** Two partners, two deposit addresses. Everything in these tests turns on which one was used. */
const NORTHWIND_DEPOSIT = getAddress('0x1460d0f96b5dcB7C417Bdf293835ed1cA0581992')
const BLUEFIN_DEPOSIT = getAddress('0x094bB7c1E830D54852Ead50a18821E81c6E45114')
/** The shared partner wallet of the demo: where a partner's transfer comes from. */
const PARTNER_WALLET = getAddress('0xb1353F69Df99053e8717Ed806b25589D2c28cc38')

const pool = testPool()
let northwind: string
let bluefin: string

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await resetDatabase(pool)
  northwind = await seedPartner(pool, 'Northwind Logistics', 1, NORTHWIND_DEPOSIT)
  bluefin = await seedPartner(pool, 'Bluefin Studio', 2, BLUEFIN_DEPOSIT)
})

describe('money arriving at a deposit address', () => {
  it('is credited only once its block can no longer be replaced', async () => {
    const finalBlock = 47_100_400n
    const settled = await detect({ at: NORTHWIND_DEPOSIT, partnerId: northwind, amount: toMinor(1), block: finalBlock - 28n, logIndex: 12 })
    const tip = await detect({ at: NORTHWIND_DEPOSIT, partnerId: northwind, amount: toMinor(2), block: finalBlock + 5n, logIndex: 7 })

    // The tail pass saw both; only one of them is money.
    const promotable = await withClient(pool, (client) => promotableDeposits(client, finalBlock))
    expect(promotable.map((money) => money.id)).toEqual([settled])

    await withClient(pool, (client) =>
      settleDeposit(client, settled, { txHash: hashOf(12), blockNumber: Number(finalBlock - 28n), finalBlock: Number(finalBlock), logIndex: 12 }),
    )

    expect(await balanceOf(pool, ACCOUNTS.depositsOnchain)).toBe(toMinor(1))
    expect(await postedFor(tip)).toBe(0)
    expect(await statusOf(tip)).toBe('DETECTED')
  })

  it('belongs to whoever owns the address it arrived at, invoice or no invoice', async () => {
    const owed = toMinor(1)
    const northwindInvoice = await invoice(northwind, owed, 'March haulage')
    const bluefinInvoice = await invoice(bluefin, owed, 'March design')

    // Same amount, two partners: the address is what decides, and nothing else is consulted.
    const toBluefin = await detect({ at: BLUEFIN_DEPOSIT, partnerId: bluefin, amount: owed, block: 100n, logIndex: 3 })
    await withClient(pool, (client) => settleDeposit(client, toBluefin, evidenceAt(100n, 3)))

    expect(await statusOf(bluefinInvoice, 'receivables')).toBe('PAID')
    expect(await statusOf(northwindInvoice, 'receivables')).toBe('OPEN')
    expect(await matchOf(toBluefin)).toEqual({ matched_by: 'amount', receivable_id: bluefinInvoice })

    // Nobody invoiced this, and it is credited anyway: money that arrived is money that arrived.
    const unexpected = await detect({ at: NORTHWIND_DEPOSIT, partnerId: northwind, amount: toMinor(5), block: 101n, logIndex: 4 })
    await withClient(pool, (client) => settleDeposit(client, unexpected, evidenceAt(101n, 4)))

    expect(await matchOf(unexpected)).toEqual({ matched_by: 'unmatched', receivable_id: null })
    expect(await statusOf(northwindInvoice, 'receivables')).toBe('OPEN')
    expect(await balanceOf(pool, ACCOUNTS.depositsOnchain)).toBe(toMinor(6))
    // Two invoices of 1 raised it to 2, one was paid, and 5 arrived against nothing: the company
    // owes this partner money, which is exactly what a partner paying before being invoiced means.
    expect(await balanceOf(pool, ACCOUNTS.partnerReceivable)).toBe(-toMinor(4))
  })

  it('cannot be recorded or credited twice, however often the range is scanned', async () => {
    const amount = toMinor(1)
    const paying = await invoice(northwind, amount, 'Deposit check', { status: 'PAYING', paymentTxHash: hashOf(9) })

    const first = await detect({ at: NORTHWIND_DEPOSIT, partnerId: northwind, amount, block: 100n, logIndex: 9 })
    const again = await detect({ at: NORTHWIND_DEPOSIT, partnerId: northwind, amount, block: 100n, logIndex: 9 })
    expect(again).toBe(first)
    expect(await countOf('deposits')).toBe(1)

    const credited = await withClient(pool, (client) => settleDeposit(client, first, evidenceAt(100n, 9)))
    const replay = await withClient(pool, (client) => settleDeposit(client, first, evidenceAt(100n, 9)))

    expect(credited).toMatchObject({ kind: 'settled', matchedBy: 'hash', receivableId: paying })
    expect(replay.kind).toBe('already-settled')
    expect(await postedFor(first)).toBe(1)
    expect(await balanceOf(pool, ACCOUNTS.depositsOnchain)).toBe(amount)
    expect(await statusOf(paying, 'receivables')).toBe('PAID')
    expect(await paidRowsFor(paying)).toBe(1)
  })
})

/** The `ObservedTransfer` a tick hands `recordDetected`, and the row id it left behind. */
async function detect(transfer: {
  at: Address
  partnerId: string
  amount: MinorUnits
  block: bigint
  logIndex: number
}): Promise<string> {
  await withClient(pool, (client) =>
    inTransaction(client, () =>
      recordDetected(
        client,
        { from: PARTNER_WALLET, to: transfer.at, amount: transfer.amount, blockNumber: transfer.block, txHash: hashOf(transfer.logIndex), logIndex: transfer.logIndex },
        transfer.partnerId,
        transfer.block,
      ),
    ),
  )
  const found = await pool.query<{ id: string }>('SELECT id FROM deposits WHERE tx_hash = $1 AND log_index = $2', [
    hashOf(transfer.logIndex),
    transfer.logIndex,
  ])
  const id = found.rows[0]?.id
  if (id === undefined) {
    throw new Error('the deposit was not recorded')
  }
  return id
}

/** The invoice and the accrual it put on the books, the way `POST /receivables` writes them. */
async function invoice(
  partnerId: string,
  amountMinor: MinorUnits,
  description: string,
  extra: { status?: string; paymentTxHash?: string } = {},
): Promise<string> {
  const id = await seedReceivable(pool, { partnerId, amountMinor, description, ...extra })
  await withLedgerTransaction(pool, (client) => receivable(client, { receivableId: id, amount: amountMinor, currency: 'USDC' }))
  return id
}

/** A distinct, well-formed hash per log index, so two fixtures are never the same transaction. */
function hashOf(logIndex: number): Hex {
  return `0x${String(logIndex).padStart(2, '0').repeat(32)}`
}

function evidenceAt(block: bigint, logIndex: number) {
  return { txHash: hashOf(logIndex), blockNumber: Number(block), finalBlock: Number(block + 50n), logIndex }
}

async function postedFor(depositId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*) FROM ledger_transactions WHERE kind = 'deposit' AND reference = $1`,
    [depositId],
  )
  return Number(result.rows[0]?.count)
}

async function statusOf(id: string, table: 'deposits' | 'receivables' = 'deposits'): Promise<string | undefined> {
  const result = await pool.query<{ status: string }>(`SELECT status FROM ${table} WHERE id = $1`, [id])
  return result.rows[0]?.status
}

async function matchOf(depositId: string): Promise<{ matched_by: string | null; receivable_id: string | null } | undefined> {
  const result = await pool.query<{ matched_by: string | null; receivable_id: string | null }>(
    'SELECT matched_by, receivable_id FROM deposits WHERE id = $1',
    [depositId],
  )
  return result.rows[0]
}

async function countOf(table: 'deposits'): Promise<number> {
  const result = await pool.query<{ count: string }>(`SELECT count(*) FROM ${table}`)
  return Number(result.rows[0]?.count)
}

async function paidRowsFor(receivableId: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    `SELECT count(*) FROM audit_log WHERE subject_type = 'receivable' AND subject_id = $1 AND event = 'paid'`,
    [receivableId],
  )
  return Number(result.rows[0]?.count)
}
