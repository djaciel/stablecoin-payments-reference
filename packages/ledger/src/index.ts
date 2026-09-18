/**
 * The ledger's public surface.
 *
 * One way to write money: open a transaction, call `postTransaction`. The named postings
 * (reserve, settle, reversal, cancel, …) arrive with the phases that need them and all go
 * through this same door.
 */
export {
  ACCOUNTS,
  type AccountBalance,
  type AccountCode,
  type AccountKind,
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
