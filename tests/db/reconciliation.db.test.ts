import { ERC20_ABI, USDC_ADDRESS, type LandedTransaction } from '@payments/chain'
import { inTransaction } from '@payments/db'
import { formatMinor, seedArticle, toMinor, withLedgerTransaction, type MinorUnits } from '@payments/ledger'
import { encodeEventTopics, getAddress, pad, toHex, type Address, type Hex, type TransactionReceipt } from 'viem'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPayment } from '../../apps/api/src/payments/create-payment'
import { recordDetected, settleDeposit } from '../../apps/worker/src/deposits'
import { reconcile, type ChainFacts } from '../../apps/worker/src/reconcile'
import type { ReconciliationItem } from '../../apps/worker/src/reconcile-items'
import { reversePayment } from '../../apps/worker/src/reverse'
import { settlePayment } from '../../apps/worker/src/settle'
import { resetDatabase, seedInvoices, seedPartner, seedWatchedAddress, testPool, withClient } from './helpers/database'

/**
 * Article section 10 against real Postgres: every payment and every deposit, three versions each,
 * at one block. What was asked for, what was recorded, what happened — and the two disagreements
 * the section names, "a settled payment with no event" and a release whose proof is not true.
 *
 * The chain side is a stub, so the mismatch is manufactured where a real one would come from. The
 * ledger's side cannot be corrupted at all: it is append-only by trigger.
 */

/** The company's treasury and the partner's payout address, as `seedInvoices` writes it. */
const TREASURY = getAddress('0xf5B56DA7C4B64e43F1C44528123D2010CffDA873')
const PAYOUT = getAddress('0x1111111111111111111111111111111111111111')
/** Where a partner's money arrives, and the shared wallet of the demo it comes from. */
const NORTHWIND_DEPOSIT = getAddress('0x1460d0f96b5dcB7C417Bdf293835ed1cA0581992')
const PARTNER_WALLET = getAddress('0xb1353F69Df99053e8717Ed806b25589D2c28cc38')
/** An address nobody put on the allowlist, which is what the door refuses. */
const UNLISTED = getAddress('0x9999999999999999999999999999999999999999')

/** The watcher's cursor, the final block, and the two blocks below both: B = the cursor. */
const CURSOR = 47_210_722n
const FINAL_BLOCK = 47_210_800n
const PAYMENT_BLOCK = 47_131_497n
const DEPOSIT_BLOCK = 47_173_508n

const PAYMENT_HASH = '0x97a4d339d0f1f82f7bde40e64c71fc2ccd8305a7fdde8add2ef2dec407d55751' as const
const DEPOSIT_HASH = '0x4241c0af0c2828d6f118fd99b035f7b6840dea186c3e6b0ef591cbf1f9eee394' as const
const DEPOSIT_LOG_INDEX = 25

const pool = testPool()
let payableId: string
let northwind: string

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await resetDatabase(pool)
  await withLedgerTransaction(pool, (client) => seedArticle(client))
  payableId = (await seedInvoices(pool)).first
  northwind = await seedPartner(pool, 'Northwind Logistics', 3, NORTHWIND_DEPOSIT)
  // What a running system would have written: the addresses it watches, and how far it has looked.
  await seedWatchedAddress(pool, TREASURY, 'treasury')
  await seedWatchedAddress(pool, NORTHWIND_DEPOSIT, 'deposit', northwind)
  await pool.query('INSERT INTO watcher_state (name, last_block) VALUES ($1, $2)', ['usdc-transfers', CURSOR.toString()])
})

describe('a reconciliation run', () => {
  it('finds the three versions agree, payment by payment and deposit by deposit', async () => {
    const reference = await settledPayment()
    const depositId = await settledDeposit(toMinor(1))
    // The third kind of history this demo is made of: a payment the door refused, which never
    // reached the books and never reached the chain, so both sides agree by having nothing.
    const refused = await refusedAtTheDoor()

    const run = await reconcile(pool, stubChain({ [PAYMENT_HASH]: paidReceipt(), [DEPOSIT_HASH]: arrivedReceipt(toMinor(1)) }))

    expect(run.outcome).toBe('clean')
    expect(run.blockNumber).toBe(CURSOR)
    expect(outcomesOf(run.items)).toEqual({ [reference]: 'ok', [refused]: 'ok', [depositId]: 'ok' })
    expect(itemFor(run.items, refused).detail).toBe('refused at the door: no money moved and nothing was signed')
    // Null, not zero: a delta is the money in flight, and nothing here is.
    expect(run.items.map((item) => item.deltaMinor)).toEqual([null, null, null])

    // Written once, whole: one run row, and every item on it.
    const stored = await storedRun()
    expect(stored).toEqual({ runs: 1, items: 3, outcome: 'clean', block: CURSOR.toString(), checked: 3, explained: 0, mismatched: 0 })
  })

  it('will not say nothing was signed about a refused payment whose row carries a hash', async () => {
    const refused = await refusedAtTheDoor()
    // The row the sentence cannot be said about: refused before the books moved, and yet holding
    // bytes that could still land and a treasury nonce. Nothing in this repo writes one, and
    // `payments_signed_together` (0008) means it can only exist whole; the check must not assume
    // it cannot exist at all.
    await pool.query(`UPDATE payments SET tx_hash = $2, signed_tx = '0x02', nonce = 9 WHERE reference = $1`, [refused, PAYMENT_HASH])

    const run = await reconcile(pool, stubChain({}))

    const flagged = itemFor(run.items, refused)
    expect(flagged.outcome).toBe('mismatch')
    expect(flagged.detail).toContain('nothing was signed, and yet the row carries the transaction')
    expect(run.outcome).toBe('mismatch')
  })

  it('flags a settled payment the chain never carried, and leaves the rest alone', async () => {
    const reference = await settledPayment()
    const depositId = await settledDeposit(toMinor(1))

    // The receipt succeeded and carries a Transfer, for somebody else's amount: section 10's
    // "a settled payment with no event", which a status check alone would call fine.
    const wrongAmount = paidReceipt(toMinor(999))
    const run = await reconcile(pool, stubChain({ [PAYMENT_HASH]: wrongAmount, [DEPOSIT_HASH]: arrivedReceipt(toMinor(1)) }))

    expect(run.outcome).toBe('mismatch')
    expect(outcomesOf(run.items)).toEqual({ [reference]: 'mismatch', [depositId]: 'ok' })
    const flagged = itemFor(run.items, reference)
    expect(flagged.detail).toContain('settled in the books')
    // Both numbers, as money rather than as minor units.
    expect(flagged.detail).toContain(formatMinor(toMinor(1_000)))
    expect(flagged.detail).toContain(formatMinor(toMinor(999)))
    expect(flagged.detail).not.toContain(toMinor(1_000).toString())
    expect(await storedRun()).toMatchObject({ outcome: 'mismatch', checked: 2, mismatched: 1 })
  })

  it('flags a release whose proof names a transaction that did not revert', async () => {
    const reference = await reversedPayment()

    // The books released the money on the word of this hash. The chain says it succeeded.
    const run = await reconcile(pool, stubChain({ [PAYMENT_HASH]: paidReceipt() }))

    expect(run.outcome).toBe('mismatch')
    const flagged = itemFor(run.items, reference)
    expect(flagged.outcome).toBe('mismatch')
    expect(flagged.detail).toContain('did not revert')
    expect(flagged.detail).toContain(PAYMENT_HASH)
  })
})

/** A payment through the api's door, then what `sign`, `execute` and `settle` leave behind. */
async function settledPayment(): Promise<string> {
  const reference = await reserveAndSend()
  await withClient(pool, (client) =>
    settlePayment(client, reference, {
      txHash: PAYMENT_HASH,
      blockNumber: Number(PAYMENT_BLOCK),
      finalBlock: Number(FINAL_BLOCK),
      logIndex: 0,
    }),
  )
  return reference
}

/** The same payment, ended the other way: FAILED `reverted`, with its proof on the books (§6). */
async function reversedPayment(): Promise<string> {
  const reference = await reserveAndSend()
  await withClient(pool, (client) =>
    reversePayment(client, reference, { txHash: PAYMENT_HASH, blockNumber: Number(PAYMENT_BLOCK), finalBlock: Number(FINAL_BLOCK) }),
  )
  return reference
}

async function reserveAndSend(): Promise<string> {
  const outcome = await withClient(pool, (client) =>
    inTransaction(client, () => createPayment(client, { idempotencyKey: 'key-1', payableId })),
  )
  if (outcome.kind !== 'recorded' || outcome.payment.status !== 'RESERVED') {
    throw new Error(`expected a RESERVED payment, got ${outcome.kind}`)
  }
  await pool.query(`UPDATE payments SET status = 'SENT', tx_hash = $2, signed_tx = '0x02', nonce = 4 WHERE reference = $1`, [
    outcome.payment.reference,
    PAYMENT_HASH,
  ])
  return outcome.payment.reference
}

/** A payment the door refused before anything moved: not on the books, not on the chain. */
async function refusedAtTheDoor(): Promise<string> {
  const payable = await pool.query<{ id: string }>(
    `INSERT INTO payables (partner_id, destination, amount_minor, description)
     SELECT id, $1, $2, 'Not on the allowlist' FROM partners WHERE derivation_index = 1 RETURNING id`,
    [UNLISTED, toMinor(1).toString()],
  )
  const outcome = await withClient(pool, (client) =>
    inTransaction(client, () => createPayment(client, { idempotencyKey: 'key-refused', payableId: payable.rows[0]?.id ?? '' })),
  )
  if (outcome.kind !== 'recorded' || outcome.payment.status !== 'FAILED') {
    throw new Error(`expected a refusal, got ${outcome.kind}`)
  }
  return outcome.payment.reference
}

/** Money that arrived at a deposit address, detected and then credited, the watcher's two steps. */
async function settledDeposit(amount: MinorUnits): Promise<string> {
  await withClient(pool, (client) =>
    inTransaction(client, () =>
      recordDetected(
        client,
        { from: PARTNER_WALLET, to: NORTHWIND_DEPOSIT, amount, blockNumber: DEPOSIT_BLOCK, txHash: DEPOSIT_HASH, logIndex: DEPOSIT_LOG_INDEX },
        northwind,
        DEPOSIT_BLOCK,
      ),
    ),
  )
  const found = await pool.query<{ id: string }>('SELECT id FROM deposits WHERE tx_hash = $1', [DEPOSIT_HASH])
  const id = found.rows[0]?.id
  if (id === undefined) {
    throw new Error('the deposit was not recorded')
  }
  await withClient(pool, (client) =>
    settleDeposit(client, id, {
      txHash: DEPOSIT_HASH,
      blockNumber: Number(DEPOSIT_BLOCK),
      finalBlock: Number(FINAL_BLOCK),
      logIndex: DEPOSIT_LOG_INDEX,
    }),
  )
  return id
}

/** The chain port with no network behind it: the run asks it exactly two questions. */
function stubChain(receipts: Readonly<Record<string, LandedTransaction>>): ChainFacts {
  return {
    finalBlock: () => Promise.resolve(FINAL_BLOCK),
    receiptOf: (hash) => Promise.resolve(receipts[hash]),
  }
}

/** The payout as the chain recorded it: the official contract's Transfer, treasury to partner. */
function paidReceipt(amount: MinorUnits = toMinor(1_000)): LandedTransaction {
  return {
    status: 'success',
    blockNumber: PAYMENT_BLOCK,
    logs: [transferLog({ from: TREASURY, to: PAYOUT, amount, blockNumber: PAYMENT_BLOCK, txHash: PAYMENT_HASH, logIndex: 0 })],
  }
}

/** The partner's transfer, at the exact log index the deposit row recorded. */
function arrivedReceipt(amount: MinorUnits): LandedTransaction {
  return {
    status: 'success',
    blockNumber: DEPOSIT_BLOCK,
    logs: [
      transferLog({
        from: PARTNER_WALLET,
        to: NORTHWIND_DEPOSIT,
        amount,
        blockNumber: DEPOSIT_BLOCK,
        txHash: DEPOSIT_HASH,
        logIndex: DEPOSIT_LOG_INDEX,
      }),
    ],
  }
}

/** A real ERC20 Transfer log, encoded with the same ABI the chain package decodes it with. */
function transferLog(transfer: {
  from: Address
  to: Address
  amount: MinorUnits
  blockNumber: bigint
  txHash: Hex
  logIndex: number
}): TransactionReceipt['logs'][number] {
  return {
    address: USDC_ADDRESS,
    topics: encodeEventTopics({ abi: ERC20_ABI, eventName: 'Transfer', args: { from: transfer.from, to: transfer.to } }) as [Hex, Hex, Hex],
    data: pad(toHex(transfer.amount)),
    blockHash: pad('0xbb'),
    blockNumber: transfer.blockNumber,
    logIndex: transfer.logIndex,
    transactionHash: transfer.txHash,
    transactionIndex: 0,
    removed: false,
  }
}

function outcomesOf(items: readonly ReconciliationItem[]): Record<string, string> {
  return Object.fromEntries(items.map((item) => [item.subjectId, item.outcome]))
}

function itemFor(items: readonly ReconciliationItem[], subjectId: string): ReconciliationItem {
  const item = items.find((candidate) => candidate.subjectId === subjectId)
  if (item === undefined) {
    throw new Error(`the run wrote no item for ${subjectId}`)
  }
  return item
}

/** What the two tables hold afterwards, read straight from them rather than from the return value. */
async function storedRun(): Promise<Record<string, unknown>> {
  const result = await pool.query<{
    runs: string
    items: string
    outcome: string
    block: string | null
    checked: number
    explained: number
    mismatched: number
  }>(
    `SELECT (SELECT count(*) FROM reconciliation_runs) AS runs,
            (SELECT count(*) FROM reconciliation_items) AS items,
            r.outcome, r.block_number AS block, r.checked, r.explained, r.mismatched
       FROM reconciliation_runs r`,
  )
  const row = result.rows[0]
  if (row === undefined) {
    throw new Error('the run was not written')
  }
  return { ...row, runs: Number(row.runs), items: Number(row.items) }
}
