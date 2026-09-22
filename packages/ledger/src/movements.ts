import type { PoolClient } from '@payments/db'
import { AUDIT_ACTORS, AUDIT_SUBJECTS, PAYMENT_EVENTS, TREASURY_EVENTS, recordAudit } from './audit'
import { writeTransaction } from './engine'
import { ACCOUNTS, type LedgerTransactionId, type MinorUnits, type ReversalProof } from './types'

/**
 * One function per row of the spec's posting table. No SQL of their own — the lock, the
 * zero-sum check and the typed rejections live in the engine — and each takes a client
 * because the caller owns the transaction.
 *
 * `reversal` and `cancel` write the SAME entry pair and differ only in what justifies it.
 * What keeps a third door shut is not this file: it is the deferred trigger in
 * `migrations/0002_ledger.sql`, which refuses that movement under any other kind.
 */

export interface TransferInput {
  /** The payment this movement belongs to, e.g. `PAY-4821`. */
  readonly reference: string
  readonly amount: MinorUnits
  readonly currency: string
}

export interface ReversalInput extends TransferInput {
  /**
   * Why the hold may be released: the broadcast transaction reverted onchain. Required rather
   * than optional, so the rule cannot be broken by forgetting an argument.
   */
  readonly proof: ReversalProof
}

export interface CancelInput extends TransferInput {
  /** Why the admin cancelled it, in their own words. Goes to the audit log, not the books. */
  readonly reason: string
}

export interface ScaffoldingInput {
  /** The USDC transfer that moved the money. Its hash names the ledger transaction. */
  readonly txHash: string
  readonly amount: MinorUnits
  readonly currency: string
}

export interface PayableInput {
  /** The invoice this debt belongs to. Its id names the ledger transaction. */
  readonly payableId: string
  readonly amount: MinorUnits
  readonly currency: string
}

export interface FundingInput {
  readonly txHash: string
  /** Position of the Transfer event inside that transaction. */
  readonly logIndex: number
  readonly blockNumber: bigint
  /** What actually arrived, read off the event. Never a number somebody typed. */
  readonly amount: MinorUnits
  readonly currency: string
}

/**
 * One Transfer event, named by the transaction that carried it and its position inside it.
 * The `(kind, reference)` unique index turns that name into the guarantee: re-scanning a
 * range cannot post the same money twice, and what stops it is a constraint, not a caller.
 */
export function fundingReference(txHash: string, logIndex: number): string {
  return `tx:${txHash}:${logIndex}`
}

/**
 * Money arriving at the treasury, seen onchain. Dr `treasury:available` / Cr `equity:opening`
 * at the amount the event carried, which is what makes the books chain-true.
 *
 * It never touches `treasury:reserved`, so the release trigger has nothing to say about it
 * and no new guard is needed.
 */
export async function funding(client: PoolClient, input: FundingInput): Promise<LedgerTransactionId> {
  const reference = fundingReference(input.txHash, input.logIndex)

  const id = await writeTransaction(client, {
    kind: 'funding',
    reference,
    currency: input.currency,
    entries: [
      { account: ACCOUNTS.treasuryAvailable, direction: 'debit', amount: input.amount },
      { account: ACCOUNTS.equityOpening, direction: 'credit', amount: input.amount },
    ],
  })

  // Same database transaction as the entries: the books say the balance went up, this says
  // which transaction on which chain put it there.
  await recordAudit(client, {
    actor: AUDIT_ACTORS.watcher,
    subjectType: AUDIT_SUBJECTS.treasury,
    subjectId: reference,
    event: TREASURY_EVENTS.funded,
    context: {
      txHash: input.txHash,
      logIndex: input.logIndex,
      blockNumber: input.blockNumber,
      amountMinor: input.amount,
      currency: input.currency,
      ledgerTransactionId: id,
    },
  })

  return id
}

/** One transaction, one entry pair. The hash is the whole name: a transfer carries one of these. */
export function scaffoldingReference(txHash: string): string {
  return `tx:${txHash}`
}

/**
 * "Fund partner wallet": the one movement that takes money out of the treasury without being a
 * payment. Dr `demo:partner-funding` / Cr `treasury:available`, at the USDC amount the chain
 * carried — the gas that moved it is never posted (spec assumption 2), it goes to the audit log.
 *
 * It never touches `treasury:reserved`, so the release trigger has nothing to say about it.
 * Unlike `funding`, the audit row is the caller's to write: what makes this entry readable is
 * the gas transaction next to it, and only the caller has seen that receipt.
 */
export function scaffolding(client: PoolClient, input: ScaffoldingInput): Promise<LedgerTransactionId> {
  return writeTransaction(client, {
    kind: 'scaffolding',
    reference: scaffoldingReference(input.txHash),
    currency: input.currency,
    entries: [
      { account: ACCOUNTS.demoPartnerFunding, direction: 'debit', amount: input.amount },
      { account: ACCOUNTS.treasuryAvailable, direction: 'credit', amount: input.amount },
    ],
  })
}

/**
 * An invoice the company owes: Dr `expense:services` / Cr `partner:payable`, the article's
 * Partner debt. No money moves yet. The `(kind, reference)` unique index is why one invoice
 * can put its debt on the books only once. The audit row is the caller's, like `scaffolding`.
 */
export function payable(client: PoolClient, input: PayableInput): Promise<LedgerTransactionId> {
  return writeTransaction(client, {
    kind: 'payable',
    reference: input.payableId,
    currency: input.currency,
    entries: [
      { account: ACCOUNTS.expenseServices, direction: 'debit', amount: input.amount },
      { account: ACCOUNTS.partnerPayable, direction: 'credit', amount: input.amount },
    ],
  })
}

/**
 * CREATED → RESERVED. Dr `treasury:reserved` / Cr `treasury:available`: the money stops being
 * spendable before anything is signed or broadcast. Rejects with `InsufficientFunds` when
 * available is short.
 */
export function reserve(client: PoolClient, input: TransferInput): Promise<LedgerTransactionId> {
  return writeTransaction(client, {
    kind: 'reserve',
    reference: input.reference,
    currency: input.currency,
    entries: [
      { account: ACCOUNTS.treasuryReserved, direction: 'debit', amount: input.amount },
      { account: ACCOUNTS.treasuryAvailable, direction: 'credit', amount: input.amount },
    ],
  })
}

/**
 * SENT → SETTLED. Dr `partner:payable` / Cr `treasury:reserved`. Available does not move here
 * — it was already reduced at reserve time.
 */
export function settle(client: PoolClient, input: TransferInput): Promise<LedgerTransactionId> {
  return writeTransaction(client, {
    kind: 'settle',
    reference: input.reference,
    currency: input.currency,
    entries: [
      { account: ACCOUNTS.partnerPayable, direction: 'debit', amount: input.amount },
      { account: ACCOUNTS.treasuryReserved, direction: 'credit', amount: input.amount },
    ],
  })
}

/**
 * First release door. SENT → FAILED, with proof. Dr `treasury:available` / Cr
 * `treasury:reserved`.
 *
 * It must never happen on a timeout: a transaction that has not landed yet can still land,
 * and releasing the hold there is how a system pays twice. The required `proof` argument is
 * what keeps that mistake from being one forgotten branch away.
 */
export async function reversal(client: PoolClient, input: ReversalInput): Promise<LedgerTransactionId> {
  const id = await writeTransaction(client, {
    kind: 'reversal',
    reference: input.reference,
    currency: input.currency,
    proof: input.proof,
    entries: [
      { account: ACCOUNTS.treasuryAvailable, direction: 'debit', amount: input.amount },
      { account: ACCOUNTS.treasuryReserved, direction: 'credit', amount: input.amount },
    ],
  })

  // Same transaction as the entries it justifies: the release and its reason land together.
  await recordAudit(client, {
    actor: AUDIT_ACTORS.worker,
    subjectType: AUDIT_SUBJECTS.payment,
    subjectId: input.reference,
    event: PAYMENT_EVENTS.released,
    context: {
      amountMinor: input.amount,
      currency: input.currency,
      ledgerTransactionId: id,
      proof: input.proof,
    },
  })

  return id
}

/**
 * Second release door. RESERVED → FAILED, before anything was signed: the same entry pair as a
 * reversal, with no chain proof, because no signed bytes exist and that absence IS the proof.
 *
 * The ledger does NOT check the payment's status or its hash — it cannot. Those conditions
 * belong to the payment service, inside one transaction holding `SELECT … FROM payments
 * WHERE reference = $1 FOR UPDATE`, which is what makes cancel and sign unable to interleave.
 */
export async function cancel(client: PoolClient, input: CancelInput): Promise<LedgerTransactionId> {
  const id = await writeTransaction(client, {
    kind: 'cancel',
    reference: input.reference,
    currency: input.currency,
    entries: [
      { account: ACCOUNTS.treasuryAvailable, direction: 'debit', amount: input.amount },
      { account: ACCOUNTS.treasuryReserved, direction: 'credit', amount: input.amount },
    ],
  })

  // The same `released` event as a reversal — the same thing happened to the money. What
  // distinguishes the two doors is `proof`.
  await recordAudit(client, {
    actor: AUDIT_ACTORS.admin,
    subjectType: AUDIT_SUBJECTS.payment,
    subjectId: input.reference,
    event: PAYMENT_EVENTS.released,
    context: {
      amountMinor: input.amount,
      currency: input.currency,
      ledgerTransactionId: id,
      reason: input.reason,
      proof: 'cancelled before signing: no signed transaction exists, so no node can ever include one',
    },
  })

  return id
}
