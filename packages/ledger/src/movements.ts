import type { PoolClient } from '@payments/db'
import { recordAudit } from './audit'
import { writeTransaction } from './engine'
import { ACCOUNTS, type LedgerTransactionId, type MinorUnits, type ReversalProof } from './types'

/**
 * One function per row of the spec's posting table. They add no SQL of their own: the lock,
 * the zero-sum check and the typed rejections all live in the engine, and each takes a client
 * because the caller owns the transaction.
 *
 * `reversal` and `cancel` write the SAME entry pair and differ only in what justifies it, so
 * nothing here is what keeps a third door shut: the deferred trigger in
 * `migrations/0002_ledger.sql` refuses that movement under any other kind.
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
 * This is the posting that must never happen on a timeout — a transaction that has not landed
 * yet can still land, and releasing the hold there is how a system pays twice. The required
 * `proof` argument is what keeps that mistake from being one forgotten branch away. Whether
 * the hash really reverted in the block it names is reconciliation's job, not this one's.
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

  // Same database transaction as the entries it justifies: either the release and its reason
  // are both in the books, or neither is.
  await recordAudit(client, {
    actor: 'worker',
    subjectType: 'payment',
    subjectId: input.reference,
    event: 'released',
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
 * reversal, recorded as `cancel` and with no chain proof. No signed bytes exist, so no node
 * can ever include them, and that absence IS the proof.
 *
 * The ledger does NOT check the payment's status or its hash — it cannot. Those conditions
 * (status RESERVED, `tx_hash IS NULL`, `signed_tx IS NULL`) belong to the payment service,
 * inside one transaction holding `SELECT … FROM payments WHERE reference = $1 FOR UPDATE`,
 * which is what makes cancel and sign unable to interleave.
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

  // The same `released` event as a reversal, because the same thing happened to the money.
  // What distinguishes the two doors is `proof`.
  await recordAudit(client, {
    actor: 'admin',
    subjectType: 'payment',
    subjectId: input.reference,
    event: 'released',
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
