import {
  ACCOUNTS,
  EXAMPLE_TREASURY,
  LedgerRejected,
  cancel,
  writeTransaction,
  reserve,
  reversal,
  seedExample,
  settle,
  toMinor,
  withLedgerTransaction,
} from '@payments/ledger'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { balanceOf, resetDatabase, testPool } from './helpers/database'

/**
 * Invariant 5, the whole rule: reserved money goes back to available through exactly two doors,
 * and the database refuses every other way whatever it is labelled.
 *
 *   reversal: the broadcast transaction reverted onchain, and the proof says which one.
 *   cancel:   nothing was ever signed, so no node can include anything. That absence IS the
 *             proof, and it is the one release allowed without a chain proof.
 *
 * This is the invariant that costs real money when it is wrong: releasing a hold on a transfer
 * that has not landed yet is how a system pays the same partner twice. The third test is the
 * hole a schema gets when it constrains the `kind` column instead of the movement.
 */

const USDC = 'USDC'
const PAYMENT = toMinor(1_000)
const REFERENCE = 'PAY-4821'
const PROOF = { txHash: '0xrevert', blockNumber: 45_155_022, reason: 'execution reverted' }

const pool = testPool()

afterAll(async () => {
  await pool.end()
})

// Every test starts right after the reserve: Available 9,000 with 1,000 held for PAY-4821.
beforeEach(async () => {
  await resetDatabase(pool)
  await withLedgerTransaction(pool, async (client) => {
    await seedExample(client)
    await reserve(client, { reference: REFERENCE, amount: PAYMENT, currency: USDC })
  })
})

describe('releasing a hold', () => {
  it('through a reversal: the entries, the proof and the audit row land together or not at all', async () => {
    // First the failure, while the hold is still there to be lost: a caller that dies after
    // releasing must leave the money held AND a log that does not claim it was released.
    await expect(
      withLedgerTransaction(pool, async (client) => {
        await reversal(client, { reference: REFERENCE, amount: PAYMENT, currency: USDC, proof: PROOF })
        throw new Error('the workflow died after releasing')
      }),
    ).rejects.toThrow('the workflow died after releasing')

    expect(await balanceOf(pool, ACCOUNTS.treasuryReserved)).toBe(PAYMENT)
    expect(await auditRowsFor(REFERENCE)).toEqual([])
    expect(await countTransactions('reversal')).toBe(0)

    // Then the same release, committed. The failure figures: the hold is gone and the money is
    // spendable again.
    await withLedgerTransaction(pool, (client) =>
      reversal(client, { reference: REFERENCE, amount: PAYMENT, currency: USDC, proof: PROOF }),
    )

    expect(await balanceOf(pool, ACCOUNTS.treasuryReserved)).toBe(0n)
    expect(await balanceOf(pool, ACCOUNTS.treasuryAvailable)).toBe(EXAMPLE_TREASURY)

    // The proof is stored next to the entries it justifies, and once more in the audit log.
    expect(await proofOnTransaction('reversal')).toEqual(PROOF)

    const audit = await auditRowsFor(REFERENCE)
    expect(audit).toHaveLength(1)
    expect(audit[0]?.event).toBe('released')
    expect(audit[0]?.context['proof']).toEqual(PROOF)
    // Written as a decimal string: money is bigint here and JSON has no bigint, so the
    // conversion happens in `recordAudit` instead of crashing somebody's transaction.
    expect(audit[0]?.context['amountMinor']).toBe(PAYMENT.toString())
  })

  it('is refused by the database when a reversal carries no proof, even posted through the engine', async () => {
    // Straight through `writeTransaction`, bypassing the `reversal` function whose required
    // argument makes this unwritable: the guarantee has to hold for the engine underneath too.
    const refusal = await withLedgerTransaction(pool, (client) =>
      writeTransaction(client, {
        kind: 'reversal',
        reference: 'PAY-0002',
        currency: USDC,
        entries: [
          { account: ACCOUNTS.treasuryAvailable, direction: 'debit', amount: PAYMENT },
          { account: ACCOUNTS.treasuryReserved, direction: 'credit', amount: PAYMENT },
        ],
      }),
    ).catch((error: unknown) => error)

    expect(refusal).toBeInstanceOf(LedgerRejected)
    expect((refusal as LedgerRejected).constraint).toBe('ledger_reversal_needs_proof')

    // The hold is untouched, which is the point: no proof means the payment goes to REVIEW
    // with the money still held, not to FAILED with the money back.
    expect(await balanceOf(pool, ACCOUNTS.treasuryReserved)).toBe(PAYMENT)
    expect(await auditRowsFor('PAY-0002')).toEqual([])
  })

  it('is refused when the reversal entry pair is recorded as a settle, while a real settle passes', async () => {
    // The exact movement of a reversal, under a label the schema likes. The rule is about what
    // the money did, so the trigger refuses it at COMMIT and names what it was recorded as.
    const refusal = await withLedgerTransaction(pool, (client) =>
      writeTransaction(client, {
        kind: 'settle',
        reference: 'PAY-0003',
        currency: USDC,
        entries: [
          { account: ACCOUNTS.treasuryAvailable, direction: 'debit', amount: PAYMENT },
          { account: ACCOUNTS.treasuryReserved, direction: 'credit', amount: PAYMENT },
        ],
      }),
    ).catch((error: unknown) => error)

    expect((refusal as Error).message).toMatch(/releases a hold .* but is recorded as settle/)
    expect(await balanceOf(pool, ACCOUNTS.treasuryReserved)).toBe(PAYMENT)

    // And a real settle still posts: it consumes the hold to pay a debt and
    // never touches available. That is a settlement, not a release.
    await withLedgerTransaction(pool, (client) =>
      settle(client, { reference: REFERENCE, amount: PAYMENT, currency: USDC }),
    )

    expect(await balanceOf(pool, ACCOUNTS.treasuryReserved)).toBe(0n)
    expect(await balanceOf(pool, ACCOUNTS.treasuryAvailable)).toBe(toMinor(9_000))
    expect(await balanceOf(pool, ACCOUNTS.partnerPayable)).toBe(0n)
  })

  it('through a cancel: no chain proof, the same figures, and the audit log says why', async () => {
    await withLedgerTransaction(pool, (client) =>
      cancel(client, { reference: REFERENCE, amount: PAYMENT, currency: USDC, reason: 'paid by another route' }),
    )

    // The same place the reversal ends, reached without anything onchain to point at.
    expect(await balanceOf(pool, ACCOUNTS.treasuryReserved)).toBe(0n)
    expect(await balanceOf(pool, ACCOUNTS.treasuryAvailable)).toBe(EXAMPLE_TREASURY)
    expect(await proofOnTransaction('cancel')).toBeNull()

    const audit = await auditRowsFor(REFERENCE)
    expect(audit).toHaveLength(1)
    expect(audit[0]?.event).toBe('released')
    expect(audit[0]?.context['reason']).toBe('paid by another route')
    // What stands in for a chain proof, in words, because a screen has to show something.
    expect(audit[0]?.context['proof']).toMatch(/no signed transaction exists/)
  })

  it('is refused by the database when the cancelled payment carries a hash, and allowed when it carries none', async () => {
    // Straight through `cancel`, bypassing the payment service whose row lock is the primary
    // guard (`0015`): signed bytes can still land, whoever writes the movement.
    await recordSignedPayment()

    const refusal = await withLedgerTransaction(pool, (client) =>
      cancel(client, { reference: REFERENCE, amount: PAYMENT, currency: USDC, reason: 'signed a second ago' }),
    ).catch((error: unknown) => error)

    expect((refusal as Error).message).toMatch(/already carries a signed transaction/)
    expect(await balanceOf(pool, ACCOUNTS.treasuryReserved)).toBe(PAYMENT)
    expect(await auditRowsFor(REFERENCE)).toEqual([])

    // The same movement once nothing is signed. The trigger refuses only what it can see: it
    // never asks that a payment exist, or the example ledger fixture would break.
    await pool.query('UPDATE payments SET tx_hash = NULL, signed_tx = NULL, nonce = NULL WHERE reference = $1', [REFERENCE])
    await withLedgerTransaction(pool, (client) =>
      cancel(client, { reference: REFERENCE, amount: PAYMENT, currency: USDC, reason: 'nothing was signed' }),
    )

    expect(await balanceOf(pool, ACCOUNTS.treasuryReserved)).toBe(0n)
    expect(await balanceOf(pool, ACCOUNTS.treasuryAvailable)).toBe(EXAMPLE_TREASURY)
  })
})

/** PAY-4821 as the `sign` step leaves it: RESERVED, with hash, bytes and nonce on the row. */
async function recordSignedPayment(): Promise<void> {
  await pool.query(
    `INSERT INTO payments (reference, status, destination, amount_minor, currency, idempotency_key, request_fingerprint, tx_hash, signed_tx, nonce)
     VALUES ($1, 'RESERVED', '0x1111111111111111111111111111111111111111', $2, $3, 'key-4821', 'fingerprint', '0xsigned', '0x02', 7)`,
    [REFERENCE, PAYMENT.toString(), USDC],
  )
}

async function auditRowsFor(reference: string): Promise<Array<{ event: string; context: Record<string, unknown> }>> {
  const result = await pool.query<{ event: string; context: Record<string, unknown> }>(
    'SELECT event, context FROM audit_log WHERE subject_type = $1 AND subject_id = $2 ORDER BY id',
    ['payment', reference],
  )
  return result.rows
}

/** The `proof` column of the one transaction of that kind, straight from the database. */
async function proofOnTransaction(kind: string): Promise<unknown> {
  const result = await pool.query<{ proof: unknown }>('SELECT proof FROM ledger_transactions WHERE kind = $1', [kind])
  expect(result.rows).toHaveLength(1)
  return result.rows[0]?.proof
}

async function countTransactions(kind: string): Promise<number> {
  const result = await pool.query<{ count: string }>(
    'SELECT count(*) AS count FROM ledger_transactions WHERE kind = $1',
    [kind],
  )
  return Number(result.rows[0]?.count)
}
