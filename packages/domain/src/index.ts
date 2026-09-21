// What every service shares and nothing owns: the one rule about reading the environment, and
// the shapes the api answers with. The payment states and the ledger accounts are NOT here —
// they belong with the schema that stores them.
//
// This package has no dependencies and gains none: anything that needs Postgres, the chain
// or NestJS belongs in the package named after it.
export type {
  AddressBalance,
  FundingAmounts,
  FundingTransfer,
  GasSpent,
  Health,
  LedgerFigures,
  PartnerSummary,
  Partners,
  PartnerWalletFunding,
  Treasury,
} from './api'
export { optionalEnv, readEnv, requireEnv } from './env'
