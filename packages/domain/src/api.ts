// shapes the api answers with and the ui reads; anything only one side needs stays on that side.
//
// Every amount is a decimal string in whole tokens, formatted by the api, and every address
// and hash is a plain string: the browser does no arithmetic on money, and this package
// depends on nothing — not viem, not Nest.

/** What `GET /health` answers: the api and its database. */
export interface Health {
  readonly status: string
  readonly database: string
}

/** What the books say, in the article's three published account names. */
export interface LedgerFigures {
  readonly available: string
  readonly reserved: string
  readonly partnerDebt: string
}

/**
 * What one click of "Fund partner wallet" sends, and under `requires` the minimum the api
 * refuses below — the button reads those, so it is never enabled on a treasury the api
 * would turn away.
 */
export interface FundingAmounts {
  readonly usdc: string
  readonly eth: string
  readonly requires: { readonly usdc: string; readonly eth: string }
}

/**
 * What `GET /treasury` answers: everything the Start screen shows, read in one go.
 *
 * `onchain` is null when the api could not reach the RPC — a public endpoint having a bad
 * minute is not a reason to blank the rest of the page, so that one failure arrives as data
 * rather than as an error.
 */
export interface Treasury {
  readonly address: string
  readonly explorerUrl: string
  readonly onchain: { readonly usdc: string; readonly eth: string; readonly blockNumber: string } | null
  /** Set only when `onchain` is null: one sentence a screen can print. */
  readonly chainError?: string
  readonly ledger: LedgerFigures
  /**
   * The shared wallet the partners pay from — demo scaffolding, funded from the treasury by
   * the button on the same screen, and read at the same block as the treasury's own balances.
   */
  readonly partnerWallet: {
    readonly address: string
    readonly explorerUrl: string
    readonly usdc: string | null
    readonly eth: string | null
    readonly funding: FundingAmounts
  }
}

/** One of the two transactions "Fund partner wallet" sends: USDC for one, ETH for the other. */
export interface FundingTransfer {
  readonly hash: string
  readonly explorerUrl: string
  readonly amount: string
  readonly blockNumber: string
}

/**
 * What the two transactions cost to run. In halves because they are not equally final: the
 * Base fee is settled the moment the receipt exists, the fee for posting the bytes to
 * Ethereum is the node's figure at inclusion. `basis` says so in a sentence a screen prints.
 */
export interface GasSpent {
  readonly totalEth: string
  readonly l2Eth: string
  readonly l1Eth: string
  readonly basis: string
}

/**
 * What `POST /treasury/fund-partner-wallet` answers once both transactions have landed and
 * the entry is in the books. It all arrives at once because the endpoint is synchronous:
 * there is nothing to poll for.
 */
export interface PartnerWalletFunding {
  readonly usdc: FundingTransfer
  readonly gas: FundingTransfer
  readonly gasSpent: GasSpent
  /** `posted` is false when this transaction hash had already been posted. */
  readonly ledger: { readonly reference: string; readonly posted: boolean }
  /** Read at the block the transactions landed in, or null when that read failed. */
  readonly balances: {
    readonly treasury: { readonly usdc: string; readonly eth: string }
    readonly partnerWallet: { readonly usdc: string; readonly eth: string }
    readonly blockNumber: string
  } | null
}

/** One address on a screen: the text, the link, and what it holds at the read block. */
export interface AddressBalance {
  readonly address: string
  readonly explorerUrl: string
  /** Decimal USDC in whole tokens, or null when the api could not reach the chain. */
  readonly usdc: string | null
}

/** One partner as a screen lists it: company seed for `deposit`, partner seed for `payout`. */
export interface PartnerSummary {
  readonly id: string
  readonly name: string
  readonly derivationIndex: number
  readonly deposit: AddressBalance
  readonly payout: AddressBalance
}

/**
 * What `GET /partners` and `POST /partners` answer: every partner with its two addresses, and
 * the one block all the balances were read at — figures read at different heights would not
 * be comparable.
 */
export interface Partners {
  readonly partners: readonly PartnerSummary[]
  readonly blockNumber: string | null
  /** Set only when `blockNumber` is null: one sentence a screen can print. */
  readonly chainError?: string
}

/** One invoice the company owes, as the Payables screen lists it. */
export interface PayableSummary {
  readonly id: string
  /** Null only for an ad-hoc payable to an address, which has no partner. */
  readonly partnerName: string | null
  readonly amount: string
  readonly description: string
  readonly status: 'OPEN' | 'PAYING' | 'PAID'
  /** Where it will be paid: the partner's payout address, as it was when the invoice was created. */
  readonly destination: { readonly address: string; readonly explorerUrl: string }
}

/**
 * What `GET /payables` and `POST /payables` answer: the invoices newest first, the partners an
 * invoice can be written to (the form's select), and the Partner debt figure the books hold.
 */
export interface Payables {
  readonly payables: readonly PayableSummary[]
  readonly partners: readonly { readonly id: string; readonly name: string }[]
  readonly partnerDebt: string
}

/** Why a payment was refused: short codes a screen turns into a sentence and the article can quote. */
export type PaymentFailureReason =
  | 'payable_not_open'
  | 'partner_inactive'
  | 'destination_not_allowlisted'
  | 'amount_out_of_range'
  | 'compliance_rejected'
  | 'insufficient_funds'

/**
 * One payment, as `POST /payments` and `GET /payments/:reference` answer it. `reason` is present
 * only when the payment FAILED, and a replay answers exactly what the first attempt answered.
 */
export interface PaymentView {
  /** `PAY-XXXX`, the article's format. */
  readonly reference: string
  readonly status: 'CREATED' | 'RESERVED' | 'SENT' | 'SETTLED' | 'FAILED' | 'REVIEW'
  readonly amount: string
  readonly destination: string
  /** The invoice it pays. Null only for a payment to an address, which has no invoice. */
  readonly payableId: string | null
  readonly reason?: PaymentFailureReason
  readonly createdAt: string
}
