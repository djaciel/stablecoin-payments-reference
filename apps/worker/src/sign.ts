import { ApplicationFailure, activityInfo, log } from '@temporalio/activity'
import {
  ERC20_ABI,
  SignerClient,
  USDC_ADDRESS,
  chainErrorMessage,
  createChainClient,
  readSignerUrl,
  rpcHost,
  type SignedTransaction,
  type TransactionToSign,
} from '@payments/chain'
import { inTransaction, type PoolClient } from '@payments/db'
import { AUDIT_ACTORS, AUDIT_SUBJECTS, PAYMENT_EVENTS, recordAudit } from '@payments/ledger'
import { getAddress, keccak256 } from 'viem'
import { FEE_CAP_MULTIPLIER, GAS_HEADROOM_PERCENT, REVERT_GAS_LIMIT } from './config'
import { workerPool } from './db'
import { claimRevertNextPayment } from './experiments'

const chain = createChainClient()
const signer = new SignerClient(readSignerUrl())

/** The lock that stands for the treasury's nonce. Transaction-scoped: the COMMIT releases it. */
const TREASURY_NONCE_LOCK = 'treasury-nonce'

const COLUMNS = 'status, destination, amount_minor, tx_hash, nonce'

/** What `signPayment` is told: the numbers the chain gave step 2. */
export interface SigningInput {
  readonly reference: string
  /** The treasury's `pending` transaction count. */
  readonly pendingNonce: number
  readonly gas: bigint
  readonly maxFeePerGas: bigint
  readonly maxPriorityFeePerGas: bigint
}

export type SignOutcome =
  /** Signed now: hash, bytes and nonce are committed on the row. */
  | { readonly kind: 'signed'; readonly txHash: string; readonly nonce: number; readonly gasTooLowOnPurpose: boolean }
  /** Signed before: the signer was not asked, and this is the stored hash. */
  | { readonly kind: 'already-signed'; readonly txHash: string; readonly nonce: number }
  /** No longer RESERVED, so there is nothing to sign. */
  | { readonly kind: 'not-reserved'; readonly status: string }

/** The `sign` activity: steps 1 and 2 here, 3 to 5 in `signPayment`. */
export async function sign(reference: string): Promise<string> {
  const client = await workerPool().connect()
  try {
    // 1. The payment, without a lock. A re-run of a signed payment ends here.
    const payment = await readPayment(client, reference)
    if (payment === undefined) {
      // A workflow started by hand for nothing fails at once instead of retrying forever.
      throw ApplicationFailure.nonRetryable(`${reference}: no payment has this reference`)
    }
    const skip = nothingToSign(payment)
    if (skip !== undefined) {
      return report(reference, skip)
    }

    // 2. The chain reads, before any transaction is opened: a database transaction held across
    //    a call to a public endpoint holds its locks for as long as the internet feels like it.
    const input = { reference, ...(await readChain(payment)) }

    return report(reference, await signPayment(client, input, (transaction) => signer.signTransfer(transaction)))
  } catch (error) {
    log.error(`${reference} sign: attempt ${activityInfo().attempt} FAILED — ${chainErrorMessage(error)} [chain: ${rpcHost()}]`)
    throw error
  } finally {
    client.release()
  }
}

/**
 * Steps 3 to 5 in one database transaction, committed before this returns. No Temporal API in
 * here, so `tests/db/signing.db.test.ts` calls it directly; like every unit of work in this repo
 * it joins a transaction the caller already opened.
 */
export async function signPayment(
  client: PoolClient,
  input: SigningInput,
  signTransfer: (transaction: TransactionToSign) => Promise<SignedTransaction>,
): Promise<SignOutcome> {
  return inTransaction(client, async () => {
    // 3. The row lock, then the same checks again. A cancel takes this lock too: whoever
    //    commits first wins, and the other one sees what changed.
    const result = await client.query<PaymentRow>(`SELECT ${COLUMNS} FROM payments WHERE reference = $1 FOR UPDATE`, [
      input.reference,
    ])
    const locked = result.rows[0]
    if (locked === undefined) {
      throw new Error(`${input.reference} vanished between reading it and locking it`)
    }
    const skip = nothingToSign(locked)
    if (skip !== undefined) {
      return skip
    }

    // The treasury's nonce lock, then the nonce. The chain's pending count does not know about a
    // payment signed a second ago and not sent yet, so the highest nonce stored here counts too.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [TREASURY_NONCE_LOCK])
    const stored = await client.query<{ next: number | null }>('SELECT max(nonce) + 1 AS next FROM payments')
    const nonce = Math.max(input.pendingNonce, stored.rows[0]?.next ?? 0)

    // Break it's revert flag, claimed in this transaction: a rollback (the signer down) leaves it
    // armed, and two payments signing together cannot both take it.
    const gasTooLowOnPurpose = await claimRevertNextPayment(client)
    const gas = gasTooLowOnPurpose ? REVERT_GAS_LIMIT : input.gas

    // 4. The signer, inside the transaction. Not the "no network inside a transaction" case: a
    //    compose-internal call with a 5 s timeout, and holding the row lock across it is what
    //    keeps sign and cancel from interleaving (spec, Release rule).
    const signed = await signTransfer({
      to: getAddress(locked.destination),
      amount: BigInt(locked.amount_minor),
      nonce,
      gas,
      maxFeePerGas: input.maxFeePerGas,
      maxPriorityFeePerGas: input.maxPriorityFeePerGas,
    })

    // 5. Stored, and still RESERVED: signing is not a status change in the article. The hash must
    //    name these exact bytes, or every later lookup and retry would ask about the wrong ones.
    if (keccak256(signed.signedTransaction).toLowerCase() !== signed.hash.toLowerCase()) {
      throw ApplicationFailure.nonRetryable(`${input.reference}: the signer's hash does not name its bytes; nothing was stored`)
    }
    const updated = await client.query(
      `UPDATE payments SET tx_hash = $2, signed_tx = $3, nonce = $4
        WHERE reference = $1 AND status = 'RESERVED' AND tx_hash IS NULL`,
      [input.reference, signed.hash, signed.signedTransaction, nonce],
    )
    if (updated.rowCount !== 1) {
      throw new Error(`${input.reference} changed under its own row lock; nothing was stored`)
    }
    await recordAudit(client, {
      actor: AUDIT_ACTORS.worker,
      subjectType: AUDIT_SUBJECTS.payment,
      subjectId: input.reference,
      event: PAYMENT_EVENTS.signed,
      context: {
        txHash: signed.hash,
        nonce,
        gas,
        // What the payout would have been signed with, next to the gas it was signed with.
        ...(gasTooLowOnPurpose ? { failureInjection: 'revert_next_payment', estimatedGas: input.gas } : {}),
        maxFeePerGas: input.maxFeePerGas,
        maxPriorityFeePerGas: input.maxPriorityFeePerGas,
      },
    })
    return { kind: 'signed', txHash: signed.hash, nonce, gasTooLowOnPurpose }
  })
}

interface PaymentRow {
  readonly status: string
  readonly destination: string
  readonly amount_minor: string
  readonly tx_hash: string | null
  readonly nonce: number | null
}

async function readPayment(client: PoolClient, reference: string): Promise<PaymentRow | undefined> {
  const result = await client.query<PaymentRow>(`SELECT ${COLUMNS} FROM payments WHERE reference = $1`, [reference])
  return result.rows[0]
}

/** A hash already stored, or a payment no longer RESERVED: signing again is never the answer. */
function nothingToSign(payment: PaymentRow): SignOutcome | undefined {
  if (payment.tx_hash !== null && payment.nonce !== null) {
    return { kind: 'already-signed', txHash: payment.tx_hash, nonce: payment.nonce }
  }
  if (payment.status !== 'RESERVED') {
    return { kind: 'not-reserved', status: payment.status }
  }
  return undefined
}

/** Step 2: the numbers the signer cannot look up, because it never talks to a node. */
async function readChain(payment: PaymentRow): Promise<Omit<SigningInput, 'reference'>> {
  const { address: treasury } = await signer.treasuryAddress()
  const pendingNonce = await chain.getTransactionCount({ address: treasury, blockTag: 'pending' })
  const fees = await chain.estimateFeesPerGas()
  const estimate = await chain.estimateContractGas({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [getAddress(payment.destination), BigInt(payment.amount_minor)],
    account: treasury,
  })

  return {
    pendingNonce,
    gas: (estimate * (100n + GAS_HEADROOM_PERCENT)) / 100n,
    maxFeePerGas: fees.maxFeePerGas * FEE_CAP_MULTIPLIER,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
  }
}

/** The step's one line: logged for the operator, returned so the Temporal UI shows it too. */
function report(reference: string, outcome: SignOutcome): string {
  let line: string
  switch (outcome.kind) {
    case 'signed':
      line = `signed ${outcome.txHash} (nonce ${outcome.nonce})`
      if (outcome.gasTooLowOnPurpose) {
        line += `, with a gas limit of ${REVERT_GAS_LIMIT} set too low on purpose (Break it): it will be included and revert`
      }
      break
    case 'already-signed':
      line = `already signed ${outcome.txHash} (nonce ${outcome.nonce})`
      break
    case 'not-reserved':
      line = `nothing to sign: ${outcome.status}`
      break
  }
  log.info(`${reference} sign: ${line}`)
  return line
}
