/**
 * The vocabulary the schema and the engine share. These names are the article's names:
 * changing one here means changing what the published text claims.
 */

/**
 * The chart of accounts, the same nine rows `migrations/0002_ledger.sql` inserts. Codes are
 * plain text in the database rather than an enum column, so adding an account is an INSERT
 * and not a migration that rewrites a type.
 */
export const ACCOUNTS = {
  treasuryAvailable: 'treasury:available',
  treasuryReserved: 'treasury:reserved',
  partnerPayable: 'partner:payable',
  partnerReceivable: 'partner:receivable',
  depositsOnchain: 'deposits:onchain',
  equityOpening: 'equity:opening',
  expenseServices: 'expense:services',
  revenueServices: 'revenue:services',
  demoPartnerFunding: 'demo:partner-funding',
} as const

export type AccountCode = (typeof ACCOUNTS)[keyof typeof ACCOUNTS]

/**
 * The side a balance grows on. A debit adds to a debit-normal account and subtracts from a
 * credit-normal one, which is why `partner:payable` reads positive when money is owed.
 */
export type NormalSide = 'debit' | 'credit'

/** Which way a single entry moves money. */
export type Direction = 'debit' | 'credit'

/** What a ledger transaction was for. Mirrors the `kind` CHECK in the migration. */
export type LedgerTransactionKind =
  | 'seed'
  | 'funding'
  | 'payable'
  | 'receivable'
  | 'reserve'
  | 'settle'
  | 'reversal'
  | 'cancel'
  | 'deposit'
  | 'scaffolding'

/**
 * Money is minor units, always. USDC has 6 decimals, so 1,000 USDC is 1_000_000_000n.
 * `bigint` rather than `number` because a JavaScript number stops being exact at 2^53, and
 * rather than a decimal string because arithmetic on money must be arithmetic.
 */
export type MinorUnits = bigint

/**
 * One line of a ledger transaction, shaped exactly like the row it becomes: a positive
 * amount plus the direction it moves in. Signing the amount instead would let a caller
 * write a "negative debit", which is a thing no ledger has ever meant.
 */
export interface Entry {
  readonly account: AccountCode
  readonly direction: Direction
  readonly amount: MinorUnits
}

/**
 * Evidence that a transfer can no longer land, which is what lets reserved money go back to
 * available. Invariant 5.
 *
 * `blockNumber` is a number rather than a bigint because it is not money and is nowhere near
 * the limit of an exact integer. Money stays bigint, always.
 */
export interface ReversalProof {
  readonly txHash: string
  readonly blockNumber: number
  readonly reason: string
}

/** What one ledger transaction is made of. */
export interface PostingInput {
  readonly kind: LedgerTransactionKind
  /** What this movement belongs to, e.g. `PAY-4821`. Fixtures have none. */
  readonly reference?: string
  readonly currency: string
  readonly entries: readonly Entry[]
  /** Required for a reversal, meaningless for anything else. Stored with the transaction. */
  readonly proof?: ReversalProof
}

export type LedgerTransactionId = string

/** How an account stands right now, as the ledger keeps it. */
export interface AccountBalance {
  readonly code: AccountCode
  readonly currency: string
  readonly balanceMinor: MinorUnits
}
