/**
 * The ledger's public surface.
 *
 * One way to write money: open a transaction, call a named posting (or `postTransaction`
 * directly, which is what they all do). `reversal` and `cancel` — the two release doors —
 * arrive in T-07 with the rule that admits them; the postings for the other kinds arrive
 * with the phases that need them and go through this same door.
 */
export {
  ACCOUNTS,
  type AccountBalance,
  type AccountCode,
  type Direction,
  type Entry,
  type LedgerTransactionId,
  type LedgerTransactionKind,
  type MinorUnits,
  type NormalSide,
  type PostingInput,
  type ReversalProof,
} from './types'
export { postTransaction, withLedgerTransaction } from './post'
export { InsufficientFunds, LedgerRejected, NotZeroSum, toLedgerError } from './errors'
export { reserve, settle, type TransferInput } from './postings'
export { CANONICAL_PARTNER_DEBT, CANONICAL_TREASURY, RACE_TREASURY, seedCanonical, seedRaceScenario } from './seed'
export { getBalances } from './balances'
export { USDC_DECIMALS, formatMinor, toMinor } from './money'
