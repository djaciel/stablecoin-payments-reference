import { ApplicationFailure, activityInfo, log } from '@temporalio/activity'
import {
  SignerClient,
  chainErrorMessage,
  createChainClient,
  finalBlockNumber,
  paidVerdict,
  readSignerUrl,
  rpcHost,
  type PaidVerdict,
} from '@payments/chain'
import type { PoolClient } from '@payments/db'
import { TransactionReceiptNotFoundError, getAddress, type Hex, type TransactionReceipt } from 'viem'
import { workerPool } from './db'
import { failIfNodeBlackholed } from './experiments'

const chain = createChainClient()
const signer = new SignerClient(readSignerUrl())

/**
 * What `settle` needs to know about the transfer, and what its audit row keeps. Plain JSON on
 * purpose: activity results cross Temporal as JSON, and JSON has no bigint.
 */
export interface SettlementEvidence {
  readonly txHash: string
  readonly blockNumber: number
  readonly finalBlock: number
  readonly logIndex: number
}

/** What `reverse` needs: the transaction that reverted, its block, and the final block that makes it proof. */
export interface RevertEvidence {
  readonly txHash: string
  readonly blockNumber: number
  readonly finalBlock: number
}

export type WatchResult =
  | { readonly outcome: 'not-landed' }
  | { readonly outcome: 'not-final'; readonly blockNumber: number; readonly finalBlock: number }
  | { readonly outcome: 'paid'; readonly evidence: SettlementEvidence }
  | { readonly outcome: 'reverted'; readonly evidence: RevertEvidence }

/** The `watch` activity: one short check, no writes. The workflow repeats it on a durable timer. */
export async function watch(reference: string): Promise<WatchResult> {
  const client = await workerPool().connect()
  try {
    // 1. The row. A settled payment is answered from its own audit row, and the chain is not asked.
    const payment = await readPayment(client, reference)
    if (payment === undefined) {
      throw ApplicationFailure.nonRetryable(`${reference}: no payment has this reference`)
    }
    if (payment.status === 'SETTLED') {
      return report(reference, { outcome: 'paid', evidence: await storedEvidence(client, reference) })
    }
    if (payment.status !== 'SENT' || payment.tx_hash === null) {
      throw ApplicationFailure.nonRetryable(`${reference}: nothing to watch, the payment is ${payment.status}`)
    }
    const hash = payment.tx_hash as Hex

    // 2. The receipt by the stored hash, the final block, and who must have sent it.
    await failIfNodeBlackholed(client, 'watch')
    const receipt = await readReceipt(hash)
    const finalBlock = await finalBlockNumber(chain)
    const { address: treasury } = await signer.treasuryAddress()

    // 3. The verdict. A final transaction without the expected event will never be paid, and it is
    //    no proof of a failure either: not worth retrying, so the payment goes to REVIEW, money held.
    let verdict: PaidVerdict
    try {
      verdict = paidVerdict(receipt, finalBlock, { from: treasury, to: getAddress(payment.destination), amount: BigInt(payment.amount_minor) })
    } catch (mismatch) {
      throw ApplicationFailure.nonRetryable(`${hash} is final, but ${chainErrorMessage(mismatch)}: it will never be paid`)
    }

    switch (verdict.outcome) {
      case 'not-landed':
        return report(reference, verdict)
      case 'not-final':
        return report(reference, { outcome: 'not-final', blockNumber: Number(verdict.blockNumber), finalBlock: Number(finalBlock) })
      case 'reverted':
        return report(reference, {
          outcome: 'reverted',
          evidence: { txHash: hash, blockNumber: Number(verdict.blockNumber), finalBlock: Number(finalBlock) },
        })
      case 'paid':
        return report(reference, {
          outcome: 'paid',
          evidence: {
            txHash: hash,
            blockNumber: Number(verdict.blockNumber),
            finalBlock: Number(finalBlock),
            logIndex: verdict.log.logIndex,
          },
        })
    }
  } catch (error) {
    log.error(`${reference} watch: attempt ${activityInfo().attempt} FAILED — ${chainErrorMessage(error)} [chain: ${rpcHost()}]`)
    throw error
  } finally {
    client.release()
  }
}

/** A node that has not seen the transaction in a block answers null, which viem raises. */
export async function readReceipt(hash: Hex): Promise<TransactionReceipt | undefined> {
  try {
    return await chain.getTransactionReceipt({ hash })
  } catch (error) {
    if (error instanceof TransactionReceiptNotFoundError) {
      return undefined
    }
    throw error
  }
}

interface PaymentRow {
  readonly status: string
  readonly destination: string
  readonly amount_minor: string
  readonly tx_hash: string | null
}

async function readPayment(client: PoolClient, reference: string): Promise<PaymentRow | undefined> {
  const result = await client.query<PaymentRow>('SELECT status, destination, amount_minor, tx_hash FROM payments WHERE reference = $1', [
    reference,
  ])
  return result.rows[0]
}

/** The evidence `settle` recorded, read back for a workflow that runs again on a settled payment. */
async function storedEvidence(client: PoolClient, reference: string): Promise<SettlementEvidence> {
  const result = await client.query<{ context: SettlementEvidence }>(
    `SELECT context FROM audit_log WHERE subject_type = 'payment' AND subject_id = $1 AND event = 'settled'`,
    [reference],
  )
  const context = result.rows[0]?.context
  if (context === undefined) {
    throw new Error(`${reference} is SETTLED but has no settled audit row`)
  }
  const { txHash, blockNumber, finalBlock, logIndex } = context
  return { txHash, blockNumber, finalBlock, logIndex }
}

/** The check's one line, for the operator; the result itself shows in the Temporal UI. */
function report(reference: string, result: WatchResult): WatchResult {
  let line: string
  switch (result.outcome) {
    case 'not-landed':
      line = 'not landed yet'
      break
    case 'not-final':
      line = `not final: in block ${result.blockNumber}, the final block is ${result.finalBlock}`
      break
    case 'paid': {
      const { blockNumber, finalBlock, logIndex } = result.evidence
      line = `paid: final (block ${blockNumber}, final ${finalBlock}) and the official Transfer is log ${logIndex}`
      break
    }
    case 'reverted':
      line = `reverted in block ${result.evidence.blockNumber} (final ${result.evidence.finalBlock}): the transfer did not happen`
      break
  }
  log.info(`${reference} watch: ${line}`)
  return result
}
