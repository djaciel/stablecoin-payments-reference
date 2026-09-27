import { CHAIN, ERC20_ABI, USDC_ADDRESS, deriveAccount, type SignedTransaction, type TransactionToSign } from '@payments/chain'
import { inTransaction } from '@payments/db'
import { seedExample, withLedgerTransaction } from '@payments/ledger'
import { encodeFunctionData, keccak256, type Hex } from 'viem'
import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import { createPayment } from '../../apps/api/src/payments/create-payment'
import { signPayment, type SignOutcome, type SigningInput } from '../../apps/worker/src/sign'
import { barrier, resetDatabase, seedInvoices, testPool, withClient } from './helpers/database'

/**
 * The Signed moment against real Postgres, with a signer that really signs: the published test
 * mnemonic that `derive.test.ts` pins, so the bytes are real and nothing reaches a network.
 */

/** NEVER a real seed: the Hardhat/anvil test mnemonic, known to everyone. */
const TEST_MNEMONIC = 'test test test test test test test test test test test junk'

/** What step 2 would have read from the chain. Plausible numbers; nothing is broadcast. */
const CHAIN_READS = { gas: 72_000n, maxFeePerGas: 12_000_000n, maxPriorityFeePerGas: 1_000_000n }

const pool = testPool()
let payments: { readonly first: string; readonly second: string }

afterAll(async () => {
  await pool.end()
})

beforeEach(async () => {
  await resetDatabase(pool)
  await withLedgerTransaction(pool, (client) => seedExample(client))
  const invoices = await seedInvoices(pool)
  payments = { first: await reserve(invoices.first, 'key-1'), second: await reserve(invoices.second, 'key-2') }
})

describe('signing a payment', () => {
  it('signs a payment once: two calls at the same instant and one more after ask the signer once', async () => {
    const signer = testSigner()
    // Both transactions are open before either locks the row, so one of them waits on the other.
    const startTogether = barrier(2)
    const signAtOnce = (): Promise<SignOutcome> =>
      withClient(pool, (client) =>
        inTransaction(client, async () => {
          await startTogether()
          return signPayment(client, input(payments.first, 0), signer.sign)
        }),
      )

    const [one, other] = await Promise.all([signAtOnce(), signAtOnce()])
    const again = await withClient(pool, (client) => signPayment(client, input(payments.first, 0), signer.sign))

    const stored = await storedSigning(payments.first)
    expect(signer.calls).toBe(1)
    expect([one.kind, other.kind].sort()).toEqual(['already-signed', 'signed'])
    expect(again).toEqual({ kind: 'already-signed', txHash: stored.tx_hash, nonce: stored.nonce })
    expect(stored.tx_hash).toBe(keccak256(stored.signed_tx))
    // Signed, and still RESERVED: nothing has been sent.
    expect(stored.status).toBe('RESERVED')
    const audit = await pool.query("SELECT 1 FROM audit_log WHERE subject_id = $1 AND event = 'signed'", [payments.first])
    expect(audit.rowCount).toBe(1)
  })

  it('gives two payments signed at the same instant two nonces, though the chain told both 7', async () => {
    // The chain's pending count cannot see a payment signed a second ago and not yet sent.
    const signer = testSigner()
    const startTogether = barrier(2)
    const signAtOnce = (reference: string): Promise<SignOutcome> =>
      withClient(pool, (client) =>
        inTransaction(client, async () => {
          await startTogether()
          return signPayment(client, input(reference, 7), signer.sign)
        }),
      )

    await Promise.all([signAtOnce(payments.first), signAtOnce(payments.second)])

    const nonces = await pool.query<{ nonce: number }>('SELECT nonce FROM payments WHERE nonce IS NOT NULL ORDER BY nonce')
    expect(nonces.rows.map((row) => row.nonce)).toEqual([7, 8])
    expect(signer.calls).toBe(2)
  })
})

/** RESERVED through the api's own door, the way every payment the worker signs gets there. */
async function reserve(payableId: string, idempotencyKey: string): Promise<string> {
  const outcome = await withClient(pool, (client) => inTransaction(client, () => createPayment(client, { idempotencyKey, payableId })))
  if (outcome.kind !== 'recorded' || outcome.payment.status !== 'RESERVED') {
    throw new Error(`expected a RESERVED payment, got ${outcome.kind}`)
  }
  return outcome.payment.reference
}

function input(reference: string, pendingNonce: number): SigningInput {
  return { reference, pendingNonce, ...CHAIN_READS }
}

/** Signs what `apps/signer`'s `POST /sign/transfer` signs, and counts how often it was asked. */
function testSigner(): { calls: number; sign: (transaction: TransactionToSign) => Promise<SignedTransaction> } {
  const account = deriveAccount(TEST_MNEMONIC, 0)
  const signer = {
    calls: 0,
    sign: async (transaction: TransactionToSign): Promise<SignedTransaction> => {
      signer.calls += 1
      const signedTransaction = await account.signTransaction({
        to: USDC_ADDRESS,
        value: 0n,
        data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [transaction.to, transaction.amount] }),
        type: 'eip1559',
        chainId: CHAIN.id,
        nonce: transaction.nonce,
        gas: transaction.gas,
        maxFeePerGas: transaction.maxFeePerGas,
        maxPriorityFeePerGas: transaction.maxPriorityFeePerGas,
      })
      return { hash: keccak256(signedTransaction), signedTransaction }
    },
  }
  return signer
}

async function storedSigning(reference: string): Promise<{ status: string; tx_hash: Hex; signed_tx: Hex; nonce: number }> {
  const result = await pool.query<{ status: string; tx_hash: Hex; signed_tx: Hex; nonce: number }>(
    'SELECT status, tx_hash, signed_tx, nonce FROM payments WHERE reference = $1',
    [reference],
  )
  const row = result.rows[0]
  if (row === undefined) {
    throw new Error(`${reference} is not in the table`)
  }
  return row
}
