import type { Hex } from 'viem'
import { chainErrorMessage, rpcHost, type ChainClient } from './clients'
import type { SignedTransaction } from './signer-client'

/**
 * Broadcasting signed bytes and waiting for what the chain did with them: the two steps every
 * sender in this repo takes, whichever key signed.
 *
 * The messages here stop where the caller's knowledge begins — a node refused the transfer, and
 * what that means for the books or for an invoice is the caller's sentence to add.
 */

/** How long to wait for a receipt before giving up. Base Sepolia produces a block every ~2 s. */
const RECEIPT_TIMEOUT_MS = 60_000

/**
 * How the gas figure is qualified wherever it is published. Base serves `l1Fee` as soon as the
 * transaction is included, and that first answer can be an over-estimate the node later
 * revises — still the only honest source without re-reading the chain, so it is labelled.
 */
export const GAS_AT_INCLUSION = 'as reported at inclusion; the explorer is the source'

/**
 * The receipt as this chain formats it: Base is an L2, so a viem receipt from it carries the
 * cost of posting the transaction's data to Ethereum (`l1Fee`) next to the usual gas fields.
 */
export type Receipt = Awaited<ReturnType<ChainClient['waitForTransactionReceipt']>>

/** The node would not take the bytes, so nothing happened at all: the caller says what that means. */
export class BroadcastRefused extends Error {
  constructor(what: string, error: unknown) {
    super(`the chain (RPC ${rpcHost()}) refused ${what}: ${chainErrorMessage(error)}`)
    this.name = 'BroadcastRefused'
  }
}

/** Broadcast, but no receipt in time. The transaction may still land, which is the caller's problem. */
export class ReceiptMissing extends Error {
  constructor(what: string, hash: Hex, error: unknown) {
    super(`${what} was broadcast as ${hash} but no receipt arrived (RPC ${rpcHost()}): ${chainErrorMessage(error)}`)
    this.name = 'ReceiptMissing'
  }
}

/**
 * Sends the raw bytes and checks the network agreed about their name. Not ceremony: the
 * explorer link, the stored hash and the retry that must re-send these exact bytes all use that
 * hash, so a node answering with another one would make all of them point at a transaction
 * nobody has. That mismatch is a bug, not a refusal, and it is thrown as one.
 */
export async function sendSigned(chain: ChainClient, signed: SignedTransaction, what: string): Promise<Hex> {
  let accepted: Hex
  try {
    accepted = await chain.sendRawTransaction({ serializedTransaction: signed.signedTransaction })
  } catch (error) {
    throw new BroadcastRefused(what, error)
  }

  if (accepted !== signed.hash) {
    throw new Error(
      `the network accepted a different transaction than the one signed for ${what}: ${accepted} instead of ${signed.hash}. The stored hash would be worthless.`,
    )
  }
  return accepted
}

export async function waitForReceipt(chain: ChainClient, hash: Hex, what: string): Promise<Receipt> {
  try {
    return await chain.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })
  } catch (error) {
    throw new ReceiptMissing(what, hash, error)
  }
}

/** The two halves of what running one transaction cost, in wei. Never added up silently. */
export interface TransactionCost {
  /** Executing it on Base: settled as soon as the receipt exists. */
  readonly l2FeeWei: bigint
  /** Posting its bytes to Ethereum: the node's figure at inclusion — see `GAS_AT_INCLUSION`. */
  readonly l1FeeWei: bigint
}

/**
 * What running one transaction cost, from the receipt and never from the difference between two
 * balance reads (a lagging node makes that subtraction report zero). Both halves,
 * because an L2 charges for execution and for storing the bytes on Ethereum separately, and
 * which of the two is larger changes with traffic on either chain.
 */
export function transactionCost(receipt: Receipt): TransactionCost {
  return { l2FeeWei: receipt.gasUsed * receipt.effectiveGasPrice, l1FeeWei: receipt.l1Fee ?? 0n }
}
