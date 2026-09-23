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
  /** What this partner still owes: its OPEN and PAYING invoices. */
  readonly owes: string
  /** What the company still owes it: its OPEN and PAYING payables. */
  readonly owed: string
  /** What has arrived at its deposit address and been credited: the sum of its SETTLED deposits. */
  readonly arrived: string
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
  /**
   * The payment on this invoice: the one paying it, else its latest attempt (a FAILED one leaves
   * the invoice OPEN, to be paid again). Null until someone presses Pay.
   */
  readonly payment: Pick<PaymentView, 'reference' | 'status' | 'reason' | 'transaction'> | null
}

/**
 * What `GET /payables` and `POST /payables` answer: the invoices newest first, the partners an
 * invoice can be written to (the form's select), and the books, read in the same snapshot as the
 * invoices so a row never disagrees with the figures above it.
 */
export interface Payables {
  readonly payables: readonly PayableSummary[]
  readonly partners: readonly { readonly id: string; readonly name: string }[]
  readonly ledger: LedgerFigures
}

/** One invoice a partner owes the company, as both sides list it. */
export interface ReceivableSummary {
  readonly id: string
  readonly partnerName: string
  readonly amount: string
  readonly description: string
  readonly status: 'OPEN' | 'PAYING' | 'PAID'
  /** The hash the partner recorded before broadcasting its transfer. Null until it pays. */
  readonly transaction: { readonly hash: string; readonly explorerUrl: string } | null
  /** The deposit that settled it, once the watcher credited one. Null until then. */
  readonly deposit: { readonly hash: string; readonly explorerUrl: string } | null
}

/** The two figures a receivable and its deposit move. Neither is the treasury's money yet. */
export interface ReceivableFigures {
  /** `partner:receivable`: what partners owe, invoiced and not yet credited. */
  readonly receivable: string
  /** `deposits:onchain`: what has arrived at the deposit addresses and been credited. */
  readonly deposits: string
}

/**
 * What `GET /receivables` and `POST /receivables` answer: the invoices newest first, the partners one
 * can be written to (the form's select), and the figures, read in the same snapshot as the invoices.
 */
export interface Receivables {
  readonly receivables: readonly ReceivableSummary[]
  readonly partners: readonly { readonly id: string; readonly name: string }[]
  readonly ledger: ReceivableFigures
}

/**
 * One deposit as the Transfers screen lists it. DETECTED is what the chain showed; SETTLED is
 * what the books were told, and `matchedBy` says which rule decided the invoice it paid.
 */
export interface DepositSummary {
  readonly id: string
  readonly partnerName: string
  readonly amount: string
  readonly status: 'DETECTED' | 'SETTLED'
  /** The address it arrived at, which is the whole attribution. */
  readonly depositAddress: string
  readonly blockNumber: string
  readonly transaction: { readonly hash: string; readonly explorerUrl: string }
  /** Null while DETECTED: nothing has been matched because nothing has been credited. */
  readonly matchedBy: 'hash' | 'amount' | 'unmatched' | null
  /** The invoice it paid. Null when it matched none, and for a deposit not credited yet. */
  readonly receivable: { readonly id: string; readonly description: string } | null
  readonly detectedAt: string
}

/** What `GET /deposits` answers: the latest deposits, newest first. */
export interface Deposits {
  readonly deposits: readonly DepositSummary[]
}

/**
 * What `POST /demo/partner-payments` answers once the transfer has landed: the invoice as both
 * screens now list it, the transaction that paid it, and what the partner wallet holds after.
 *
 * Nothing about the company's books, because nothing there moved: the company credits the invoice
 * when its own watcher sees the money, not when the partner clicks.
 */
export interface PartnerPaymentReceipt {
  readonly receivable: ReceivableSummary
  readonly transaction: { readonly hash: string; readonly explorerUrl: string; readonly blockNumber: string }
  /** The shared partner wallet, and the deposit address of the partner that owed the invoice. */
  readonly from: string
  readonly to: string
  readonly amount: string
  /** What sending it cost, in the network's own currency: fees are never paid in stablecoin. */
  readonly gasEth: string
  /** Where that figure comes from, in a sentence a screen prints, like `GasSpent.basis`. */
  readonly gasBasis: string
  /** What the company has done about this money, which is nothing yet. Prose, and the point. */
  readonly credit: string
  /** Read at the block the transfer landed in, or null when that read failed. */
  readonly partnerWallet: { readonly usdc: string; readonly eth: string } | null
}

/**
 * What `GET /partners/view` answers: the whole `/partner` screen in one read. `partners` is the
 * selector's list; everything else is about the selected one.
 */
export interface PartnerView {
  readonly partners: readonly { readonly id: string; readonly name: string }[]
  /**
   * The partner the screen is showing, with the address it pays at. Null when there is no partner
   * yet. No balance on it: what sits there is the company's money, shown on the admin's side.
   */
  readonly partner: {
    readonly id: string
    readonly name: string
    readonly deposit: { readonly address: string; readonly explorerUrl: string }
  } | null
  readonly receivables: readonly ReceivableSummary[]
  /** The shared wallet the partners pay from: demo scaffolding, and labelled so on the screen. */
  readonly partnerWallet: {
    readonly address: string
    readonly explorerUrl: string
    readonly usdc: string | null
    readonly eth: string | null
  }
  readonly blockNumber: string | null
  /** Set only when `blockNumber` is null: one sentence a screen can print. */
  readonly chainError?: string
}

/** Why a payment failed: short codes a screen turns into a sentence and the article can quote. */
export type PaymentFailureReason =
  | 'payable_not_open'
  | 'partner_inactive'
  | 'destination_not_allowlisted'
  | 'amount_out_of_range'
  | 'compliance_rejected'
  | 'insufficient_funds'
  | 'reverted'

/** Each reason, decided once: did it fail after the money was reserved (true), or at the door (false)? */
const AFTER_RESERVING: Record<PaymentFailureReason, boolean> = {
  payable_not_open: false,
  partner_inactive: false,
  destination_not_allowlisted: false,
  amount_out_of_range: false,
  compliance_rejected: false,
  insufficient_funds: false,
  reverted: true,
}

/** The one rule behind the api's replay code and the screen's "Nothing was reserved." */
export function failedAfterReserving(reason: PaymentFailureReason | undefined): boolean {
  return reason !== undefined && AFTER_RESERVING[reason]
}

/**
 * One payment, as `POST /payments` and `GET /payments/:reference` answer it. `reason` is present
 * only when the payment FAILED. A replay answers with the code of the first attempt's outcome and
 * the payment as it is now (spec assumption 19).
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
  /** Present once the payment is signed: the hash exists, and is stored, before anything is sent. */
  readonly transaction?: { readonly hash: string; readonly explorerUrl: string }
  readonly createdAt: string
}

/**
 * One of the two payments in §9's race, as the api would have answered it: the body it would have
 * sent, and the code the payment door's own rule gives that outcome (201 recorded, 422 refused).
 */
export interface RaceAttempt {
  readonly reference: string
  readonly amount: string
  readonly status: PaymentView['status']
  readonly reason?: PaymentFailureReason
  readonly code: number
}

/**
 * What `POST /experiments/race` answers: §9's race with the article's own figures, run against a
 * sandbox database (spec assumption 10), which is why `database` is part of the evidence.
 */
export interface RaceResult {
  readonly database: string
  readonly availableBefore: string
  readonly attempts: readonly RaceAttempt[]
  /** `reserve` ledger transactions the two attempts left behind. The article's answer is one. */
  readonly reserves: number
  readonly availableAfter: string
  readonly reservedAfter: string
}

/** One payment as the Transfers list shows it: its view, who it pays, and when its log last moved. */
export interface PaymentSummary extends PaymentView {
  /** Null only for a payment to an address, which has no partner. */
  readonly partnerName: string | null
  /** The time of its newest audit row. */
  readonly lastChangeAt: string
  /** Present only in REVIEW: what the REVIEW queue shows, from the row and its latest `escalated` row. */
  readonly review?: PaymentReview
}

/** Why a payment is in REVIEW, and where resume sends it back to. */
export interface PaymentReview {
  readonly fromStatus: 'RESERVED' | 'SENT'
  /** The step that gave up: `sign`, `execute`, `watch`, `settle` or `reverse`. */
  readonly step: string
  /** Its last error, or the finality wait's last verdict. */
  readonly reason: string
  /** When it went to REVIEW. */
  readonly at: string
  /**
   * Only for a payment signed and never sent: it holds this treasury nonce, and every payout signed
   * after it waits until it goes out (spec assumption 24).
   */
  readonly nonce?: number
}

/** What `GET /payments` answers: the latest payments, newest first. */
export interface Payments {
  readonly payments: readonly PaymentSummary[]
}

/** One row of the audit log, as it was written. Every value in `context` arrives as a string. */
export interface AuditStep {
  readonly at: string
  readonly actor: string
  /** `payment`, or `invoice` for the invoice's rows that name this payment. */
  readonly subjectType: string
  readonly event: string
  readonly context: Readonly<Record<string, string>>
}

/**
 * What `GET /payments/:reference/timeline` answers: the payment, and its audit rows in the order
 * they were written, read in one snapshot so no step is ahead of the state above it.
 */
export interface PaymentTimeline {
  readonly payment: PaymentSummary
  readonly steps: readonly AuditStep[]
  /**
   * The payment's runs in the Temporal UI, found by workflow id: a payment can have more than one.
   * Absent when it was refused before its money was reserved, because no workflow ever ran for it.
   */
  readonly workflowUrl?: string
}
