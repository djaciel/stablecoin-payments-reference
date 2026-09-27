import type { SignedTransaction, TransactionToSign } from '@payments/chain'
import { inTransaction } from '@payments/db'
import { EXPERIMENT_KEYS, type Experiments } from '@payments/domain'
import { seedArticle, withLedgerTransaction } from '@payments/ledger'
import { keccak256, toHex } from 'viem'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPayment } from '../../apps/api/src/payments/create-payment'
import { RpcBlackholed, failIfNodeBlackholed } from '../../apps/worker/src/experiments'
import { signPayment, type SignOutcome } from '../../apps/worker/src/sign'
import { barrier, resetDatabase, seedInvoices, testPool, withClient } from './helpers/database'

/**
 * A Break it flag breaks the payment of the invoice it names, and only that one, so every card can
 * run at once. Without an invoice it still breaks exactly one payment: whichever signs first.
 */

/** What step 2 would have read from the chain. Nothing is broadcast. */
const CHAIN_READS = { gas: 72_000n, maxFeePerGas: 12_000_000n, maxPriorityFeePerGas: 1_000_000n }

const pool = testPool()
let invoices: { readonly first: string; readonly second: string }
let payments: { readonly first: string; readonly second: string }

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await resetDatabase(pool)
  await withLedgerTransaction(pool, (client) => seedArticle(client))
  invoices = await seedInvoices(pool)
  payments = { first: await reserve(invoices.first, 'key-1'), second: await reserve(invoices.second, 'key-2') }
})

describe('a Break it flag', () => {
  it('breaks only the payment of the invoice it names: another payment signed first leaves it armed', async () => {
    const flag = { enabled: true, payableId: invoices.first }
    await arm(EXPERIMENT_KEYS.revertNextPayment, flag)

    const other = await signAlone(payments.second)
    expect(tookRevert(other)).toBe(false)
    expect(await stored(EXPERIMENT_KEYS.revertNextPayment)).toEqual(flag)

    const named = await signAlone(payments.first)
    expect(tookRevert(named)).toBe(true)
    expect(await stored(EXPERIMENT_KEYS.revertNextPayment)).toEqual({ enabled: false })
  })

  it('breaks exactly one of two payments signing at the same instant when it names no invoice', async () => {
    await arm(EXPERIMENT_KEYS.revertNextPayment, { enabled: true })

    const outcomes = await signTogether()

    expect(outcomes.filter(tookRevert)).toHaveLength(1)
    expect(await stored(EXPERIMENT_KEYS.revertNextPayment)).toEqual({ enabled: false })
  })

  it('makes the node silent for the payment of the invoice it names, and for no other', async () => {
    await arm(EXPERIMENT_KEYS.blackholeRpc, { enabled: true, step: 'watch', payableId: invoices.first })

    await withClient(pool, async (client) => {
      await expect(failIfNodeBlackholed(client, 'watch', payments.first)).rejects.toBeInstanceOf(RpcBlackholed)
      await expect(failIfNodeBlackholed(client, 'watch', payments.second)).resolves.toBeUndefined()
    })
  })
})

/** Writes a flag the way `PUT /settings/experiments` stores it. */
async function arm(key: string, value: Experiments[keyof Experiments]): Promise<void> {
  await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2)', [key, JSON.stringify(value)])
}

async function stored(key: string): Promise<unknown> {
  return (await pool.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [key])).rows[0]?.value
}

function signAlone(reference: string): Promise<SignOutcome> {
  return withClient(pool, (client) => signPayment(client, { reference, pendingNonce: 0, ...CHAIN_READS }, sign))
}

/** Both payments signed at once: each transaction is open before either takes a lock. */
async function signTogether(): Promise<[SignOutcome, SignOutcome]> {
  const startTogether = barrier(2)
  const signAtOnce = (reference: string): Promise<SignOutcome> =>
    withClient(pool, (client) =>
      inTransaction(client, async () => {
        await startTogether()
        return signPayment(client, { reference, pendingNonce: 0, ...CHAIN_READS }, sign)
      }),
    )
  return Promise.all([signAtOnce(payments.first), signAtOnce(payments.second)])
}

function tookRevert(outcome: SignOutcome): boolean {
  return outcome.kind === 'signed' && outcome.gasTooLowOnPurpose
}

/** Stands in for the signer: these tests are about the flag, so the bytes only need to match their hash. */
function sign(transaction: TransactionToSign): Promise<SignedTransaction> {
  const signedTransaction = toHex(`nonce ${String(transaction.nonce)}, gas ${String(transaction.gas)}`)
  return Promise.resolve({ hash: keccak256(signedTransaction), signedTransaction })
}

/** RESERVED through the api's own door, the way every payment the worker signs gets there. */
async function reserve(payableId: string, idempotencyKey: string): Promise<string> {
  const outcome = await withClient(pool, (client) => inTransaction(client, () => createPayment(client, { idempotencyKey, payableId })))
  if (outcome.kind !== 'recorded' || outcome.payment.status !== 'RESERVED') {
    throw new Error(`expected a RESERVED payment, got ${outcome.kind}`)
  }
  return outcome.payment.reference
}
