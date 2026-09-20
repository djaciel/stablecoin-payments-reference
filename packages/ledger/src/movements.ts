import type { PoolClient } from '@payments/db'
import { writeTransaction } from './engine'
import { ACCOUNTS, type LedgerTransactionId, type MinorUnits } from './types'

/**
 * The two movements of the article's happy path, one function per row of the spec's posting
 * table and nothing else. They add no SQL of their own: the lock, the zero-sum check and the
 * typed rejections all live in the engine, so there is exactly one place where money is
 * written.
 *
 * Each takes a client because the caller owns the transaction. Phase 4 commits the reserve
 * together with the payment's CREATED → RESERVED status change, which is the whole reason the
 * money and the state cannot disagree.
 *
 * `reversal` and `cancel` are the two doors that release reserved money, so they arrive in
 * T-07 with the rule that admits them.
 */

export interface TransferInput {
  /** The payment this movement belongs to, e.g. `PAY-4821`. */
  readonly reference: string
  readonly amount: MinorUnits
  readonly currency: string
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
