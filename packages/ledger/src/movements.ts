import type { PoolClient } from '@payments/db'
import { recordAudit } from './audit'
import { writeTransaction } from './engine'
import { ACCOUNTS, type LedgerTransactionId, type MinorUnits, type ReversalProof } from './types'

/**
 * The movements of the article's payment, one function per row of the spec's posting table
 * and nothing else. They add no SQL of their own: the lock, the zero-sum check and the typed
 * rejections all live in the engine, so there is exactly one place where money is written.
 *
 * Each takes a client because the caller owns the transaction. Phase 4 commits the reserve
 * together with the payment's CREATED → RESERVED status change, which is the whole reason the
 * money and the state cannot disagree.
 *
 * `reversal` and `cancel` are the two — and the only two — doors that send reserved money
 * back to available. They write the SAME entry pair and differ only in what justifies it, so
 * nothing here is what keeps a third door shut: the deferred trigger in
 * `migrations/0002_ledger.sql` refuses that movement under any other kind, whatever the
 * function it came from was called.
 */

export interface TransferInput {
  /** The payment this movement belongs to, e.g. `PAY-4821`. */
  readonly reference: string
  readonly amount: MinorUnits
  readonly currency: string
}

export interface ReversalInput extends TransferInput {
  /**
   * Why the hold may be released: the broadcast transaction reverted onchain, and this says
   * which one. Required rather than optional, so the rule cannot be broken by forgetting an
   * argument — a timeout produces no proof, and a payment with no proof goes to REVIEW with
   * the money still held.
   */
  readonly proof: ReversalProof
}

export interface CancelInput extends TransferInput {
  /** Why the admin cancelled it, in their own words. Goes to the audit log, not the books. */
  readonly reason: string
}

/**
 * CREATED → RESERVED. Dr `treasury:reserved` / Cr `treasury:available`.
 *
 * The money stops being spendable before anything is signed or broadcast. §5: two entries
 * that make a second payment for the same funds impossible, written before the chain is
 * involved at all. Rejects with `InsufficientFunds` when available is short — which is the
 * article's §9 race, from the loser's side.
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
 * SENT → SETTLED. Dr `partner:payable` / Cr `treasury:reserved`.
 *
 * §7: the debt is extinguished and the held money leaves the books, both at once. Available
 * does not move here — it was already reduced at reserve time.
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
 * §6: the transfer reverted onchain, so the hold is released and the money becomes spendable
 * again. This is the posting that must never happen on a timeout — a transaction that has not
 * landed yet can still land, and releasing the hold there is how a system pays twice. The
 * required `proof` argument is what keeps that mistake from being one forgotten branch away.
 *
 * Nobody checks here that the hash in the proof really reverted in the block it names; that
 * is reconciliation's job in Phase 9.
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

  // The evidence lands in the audit log in the same database transaction as the entries it
  // justifies. Either the release and its reason are both in the books, or neither is.
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
 * Second release door. RESERVED → FAILED, before anything was signed. The same entry pair as
 * a reversal, recorded as `cancel` and with no chain proof.
 *
 * The absence IS the proof: no signed bytes exist, so no node can ever include them, and the
 * transfer can no longer land. That is the one release the article allows without a reverted
 * transaction to point at.
 *
 * The ledger does NOT check the payment's status or its hash — it cannot, and it should not
 * pretend to. Those conditions (status RESERVED, `tx_hash IS NULL`, `signed_tx IS NULL`) are
 * enforced by the payment service inside one transaction holding
 * `SELECT … FROM payments WHERE reference = $1 FOR UPDATE`, which is what makes cancel and
 * sign unable to interleave. There is no payments table yet: T-25 (Phase 8) owns it, and it
 * also tightens the trigger to refuse a cancel whose payment already has a stored hash.
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

  // Same `released` event as a reversal, because the same thing happened to the money, and
  // the timeline in Phase 8 reads one line per release. What distinguishes the two doors is
  // `proof`: a reverted transaction there, or the sentence below.
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
