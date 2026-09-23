import { chainErrorMessage, findSettlementLog, type ExpectedTransfer, type LandedTransaction } from '@payments/chain'
import { formatMinor } from '@payments/ledger'
import { getAddress, type Address } from 'viem'

/**
 * Step 4 of a run (`reconcile.ts`): one payment or one deposit, three versions, one sentence.
 *
 * This is where this demo's own history stops being a list of alerts. A revert whose proof has to
 * be true, a cancel with nothing on the chain to ask about, a refusal that never touched the books,
 * money in flight and money nobody invoiced are all EXPLAINED here, each with a sentence written
 * for a human rather than a code for a machine.
 */

export type ItemOutcome = 'ok' | 'explained' | 'mismatch' | 'unchecked'

/** One line of a run: what was checked, what it costs the comparison, and why, in words. */
export interface ReconciliationItem {
  readonly subjectType: 'payment' | 'deposit'
  readonly subjectId: string
  readonly outcome: ItemOutcome
  /** Books minus chain at B. Null when this item contributes nothing. */
  readonly deltaMinor: bigint | null
  readonly detail: string
  readonly evidence?: Readonly<Record<string, unknown>>
}

/** One payment as the snapshot read it. */
export interface PaymentFacts {
  readonly reference: string
  readonly status: string
  /** Read to tell the three kinds of failure apart. It is never printed: see the GUIDE. */
  readonly failureReason: string | null
  readonly destination: string
  readonly amountMinor: bigint
  readonly txHash: string | null
  readonly nonce: number | null
}

/** One deposit as the snapshot read it. */
export interface DepositFacts {
  readonly id: string
  readonly txHash: string
  readonly logIndex: number
  readonly fromAddress: string
  readonly depositAddress: string
  readonly amountMinor: bigint
  readonly blockNumber: bigint
  readonly status: string
  readonly matchedBy: string | null
}

/** One ledger transaction as the check reads it: its kind, its amount and its evidence. */
export interface LedgerFacts {
  readonly kind: string
  readonly amountMinor: bigint
  readonly proof: { readonly txHash?: string; readonly blockNumber?: number } | null
}

/** What the chain said about one transaction, or why it could not say. */
export type ChainAnswer =
  | { readonly kind: 'receipt'; readonly receipt: LandedTransaction }
  | { readonly kind: 'not-landed' }
  /** The read failed, or there was no block to read at. Never a mismatch. */
  | { readonly kind: 'unreadable'; readonly why: string }

export type Receipts = ReadonlyMap<string, ChainAnswer>

/**
 * One payment, three versions, in the order the cases are told apart: cancelled, refused at the
 * door, reverted, settled, then still in flight.
 *
 * A payment refused at the door reads "refused at the door" and nothing else. Its stored reason is
 * a short code meant for the door, and one of them in this demo is misleading.
 */
export function checkPayment(
  payment: PaymentFacts,
  ledger: readonly LedgerFacts[],
  receipts: Receipts,
  block: bigint | undefined,
  treasury: Address | undefined,
): ReconciliationItem {
  // Null unless this item really is one of the four differences that carry a number: a screen
  // showing 0.000000 on thirty rows says "checked" in a column that means "in flight".
  const item = (outcome: ItemOutcome, detail: string, deltaMinor: bigint | null = null): ReconciliationItem => ({
    subjectType: 'payment',
    subjectId: payment.reference,
    outcome,
    deltaMinor,
    detail,
    ...(payment.txHash === null ? {} : { evidence: { txHash: payment.txHash } }),
  })
  const disagreement = (expected: readonly string[]): string | undefined => ledgerDisagreement(ledger, expected, payment.amountMinor)

  if (payment.status === 'FAILED' && payment.failureReason === 'cancelled') {
    const wrong = disagreement(['reserve', 'cancel']) ?? signedAnyway(payment, 'it was released as a cancel, which means nothing was signed')
    return wrong === undefined
      ? item('ok', 'cancelled before anything was signed, so there is nothing on the chain to check: the money went straight back to Available')
      : item('mismatch', wrong)
  }

  if (payment.status === 'FAILED' && payment.failureReason !== 'reverted') {
    // Refused before the reserve: the books were never touched, and the row must carry no bytes
    // and no nonce either, because that is the other half of what the sentence below promises.
    const wrong =
      ledger.length === 0
        ? signedAnyway(payment, 'it was refused at the door, which means nothing was signed')
        : `refused at the door, and yet the books hold ${kindsOf(ledger)} for it: a refusal must leave no ledger transaction at all`
    return wrong === undefined ? item('ok', 'refused at the door: no money moved and nothing was signed') : item('mismatch', wrong)
  }

  // Both remaining checks compare against the destination, so a string the chain could never hold
  // is this row's own problem — and one bad row must not end a run that is evidence for the rest.
  const destination = checksummed(payment.destination)
  if (destination === undefined) {
    return item('mismatch', `its destination is not an address the chain could hold: ${payment.destination}`)
  }

  if (payment.status === 'FAILED') {
    return checkReversal(payment, ledger, receipts, destination, treasury, item, disagreement)
  }

  if (payment.status === 'SETTLED') {
    return checkSettled(payment, receipts, block, destination, treasury, item, disagreement)
  }

  // RESERVED, SENT or REVIEW: reserved and nothing else, whatever the chain is doing.
  const wrong = disagreement(['reserve'])
  if (wrong !== undefined) {
    return item('mismatch', wrong)
  }
  if (payment.txHash === null) {
    return payment.status === 'RESERVED'
      ? item('ok', `waiting for its time: the money is held and nothing is signed (${formatMinor(payment.amountMinor)} reserved)`)
      : item('mismatch', `it is ${payment.status} with no transaction hash on the row: nothing was ever signed for it`)
  }
  return inFlight(payment, receipts, block, item)
}

/** The one the article's section 6 leaves behind: the proof is READ against the chain, not trusted. */
function checkReversal(
  payment: PaymentFacts,
  ledger: readonly LedgerFacts[],
  receipts: Receipts,
  destination: Address,
  treasury: Address | undefined,
  item: (outcome: ItemOutcome, detail: string, delta?: bigint | null) => ReconciliationItem,
  disagreement: (expected: readonly string[]) => string | undefined,
): ReconciliationItem {
  const wrong = disagreement(['reserve', 'reversal'])
  if (wrong !== undefined) {
    return item('mismatch', wrong)
  }
  const proof = ledger.find((fact) => fact.kind === 'reversal')?.proof
  if (proof?.txHash === undefined || proof.blockNumber === undefined) {
    return item('mismatch', 'the money was released as a reversal, and its proof names no transaction and no block')
  }
  if (proof.txHash !== payment.txHash) {
    return item('mismatch', `its proof names ${proof.txHash}, and the transaction stored on the payment is ${payment.txHash ?? 'none'}`)
  }

  const answer = receipts.get(proof.txHash)
  if (answer === undefined || answer.kind === 'unreadable') {
    return item('unchecked', `its proof could not be checked against the chain: ${answer?.why ?? 'the receipt was not read'}`, null)
  }
  if (answer.kind === 'not-landed') {
    return item('mismatch', `its proof says ${proof.txHash} reverted in block ${String(proof.blockNumber)}, and the chain has no such transaction`)
  }
  const { receipt } = answer
  if (receipt.status !== 'reverted') {
    return item('mismatch', `the transaction its proof names did not revert: ${proof.txHash} succeeded in block ${receipt.blockNumber.toString()}`)
  }
  if (receipt.blockNumber !== BigInt(proof.blockNumber)) {
    return item('mismatch', `its proof names block ${String(proof.blockNumber)}, and the chain has that transaction in block ${receipt.blockNumber.toString()}`)
  }
  if (treasury === undefined) {
    return item('unchecked', 'no treasury address this run could use is being watched, so its logs cannot be checked for a transfer that should not be there', null)
  }
  // The third condition, and the one a status alone would miss: a reverted transaction moves nothing.
  if (transferMissing(receipt.logs, { from: treasury, to: destination, amount: payment.amountMinor }) === undefined) {
    return item('mismatch', `${proof.txHash} reverted, and yet its logs carry the transfer of ${formatMinor(payment.amountMinor)} it was supposed to have failed to make`)
  }
  return item(
    'ok',
    `the transaction its proof names really reverted in block ${receipt.blockNumber.toString()}: no stablecoin moved, and the money went back to Available`,
  )
}

/** The happy path, and the one honest difference it can carry: the watcher's cursor trailing it. */
function checkSettled(
  payment: PaymentFacts,
  receipts: Receipts,
  block: bigint | undefined,
  destination: Address,
  treasury: Address | undefined,
  item: (outcome: ItemOutcome, detail: string, delta?: bigint | null) => ReconciliationItem,
  disagreement: (expected: readonly string[]) => string | undefined,
): ReconciliationItem {
  const wrong = disagreement(['reserve', 'settle'])
  if (wrong !== undefined) {
    return item('mismatch', wrong)
  }
  if (payment.txHash === null) {
    return item('mismatch', 'it is settled in the books with no transaction hash on the row: there is nothing to check it against')
  }
  const answer = receipts.get(payment.txHash)
  if (answer === undefined || answer.kind === 'unreadable') {
    return item('unchecked', `its receipt could not be read: ${answer?.why ?? 'the receipt was not read'}`, null)
  }
  if (answer.kind === 'not-landed') {
    return item('mismatch', `it is settled in the books, and the chain has no transaction ${payment.txHash}`)
  }
  const { receipt } = answer
  if (receipt.status !== 'success') {
    return item('mismatch', `it is settled in the books, and ${payment.txHash} reverted in block ${receipt.blockNumber.toString()}`)
  }
  if (treasury === undefined) {
    return item('unchecked', 'no treasury address this run could use is being watched, so the transfer cannot be checked against the official contract', null)
  }
  const missing = transferMissing(receipt.logs, { from: treasury, to: destination, amount: payment.amountMinor })
  if (missing !== undefined) {
    return item('mismatch', `it is settled in the books, and the chain never carried that transfer: ${missing}`)
  }
  if (block !== undefined && receipt.blockNumber > block) {
    return item(
      'explained',
      `settled in the books; its transfer landed in block ${receipt.blockNumber.toString()}, after the block this run pinned, so the chain still shows the money at the treasury`,
      -payment.amountMinor,
    )
  }
  return item('ok', `paid in block ${receipt.blockNumber.toString()}, with the official contract's Transfer of ${formatMinor(payment.amountMinor)} to ${payment.destination}`)
}

/** Signed and broadcast, not settled yet: the difference section 10 calls a payment in flight. */
function inFlight(
  payment: PaymentFacts,
  receipts: Receipts,
  block: bigint | undefined,
  item: (outcome: ItemOutcome, detail: string, delta?: bigint | null) => ReconciliationItem,
): ReconciliationItem {
  const answer = receipts.get(payment.txHash ?? '')
  if (answer === undefined || answer.kind === 'unreadable') {
    return item('unchecked', `its receipt could not be read: ${answer?.why ?? 'the receipt was not read'}`, null)
  }
  if (answer.kind === 'not-landed') {
    return item('explained', 'signed and broadcast, and not in a block yet: the books hold the money and the chain has not moved it')
  }
  const { blockNumber, status } = answer.receipt
  if (status === 'reverted') {
    return item('explained', `its transaction reverted in block ${blockNumber.toString()}: the books release the money when the reversal is posted, with that receipt as its proof`)
  }
  if (block !== undefined && blockNumber <= block) {
    return item(
      'explained',
      `the transfer landed in block ${blockNumber.toString()}; the books still hold the money until it settles`,
      payment.amountMinor,
    )
  }
  return item('explained', `its transfer landed in block ${blockNumber.toString()}, after the block this run pinned: neither side has moved yet`)
}

/**
 * One deposit, two versions plus the event at the exact position the row recorded. A DETECTED row
 * is what the chain showed, not money, so the chain is not asked about it again.
 */
export function checkDeposit(money: DepositFacts, ledger: readonly LedgerFacts[], receipts: Receipts, block: bigint | undefined): ReconciliationItem {
  // Null unless this item really is one of the four differences that carry a number (`checkPayment`).
  const item = (outcome: ItemOutcome, detail: string, deltaMinor: bigint | null = null): ReconciliationItem => ({
    subjectType: 'deposit',
    subjectId: money.id,
    outcome,
    deltaMinor,
    detail,
    evidence: { txHash: money.txHash, logIndex: money.logIndex, blockNumber: money.blockNumber.toString() },
  })
  // The address is the attribution (article section 8), so money nobody invoiced is still money.
  const attribution = money.matchedBy === 'unmatched' ? ', with no invoice to match: money that arrived before anybody invoiced it' : ''
  const seen = `seen at block ${money.blockNumber.toString()}`

  if (money.status !== 'SETTLED') {
    if (ledger.length > 0) {
      return item('mismatch', `it is not credited, and yet the books hold ${kindsOf(ledger)} for it`)
    }
    // Whether this is a difference depends entirely on which side of the run's block it falls,
    // so with no block pinned the question cannot be put at all.
    if (block === undefined) {
      return item('unchecked', `${seen} and not credited, and this run pinned no block to compare it against`)
    }
    return money.blockNumber <= block
      ? item('explained', `${seen} and not credited: nothing is credited until its block is final and the event still says so`, -money.amountMinor)
      : item('explained', `${seen}, which this run's block has not reached: not money yet on either side`)
  }

  const wrong = ledgerDisagreement(ledger, ['deposit'], money.amountMinor)
  if (wrong !== undefined) {
    return item('mismatch', wrong)
  }
  const answer = receipts.get(money.txHash)
  if (answer === undefined || answer.kind === 'unreadable') {
    return item('unchecked', `its receipt could not be read: ${answer?.why ?? 'the receipt was not read'}`, null)
  }
  if (answer.kind === 'not-landed') {
    return item('mismatch', `it is credited on the books, and the chain has no transaction ${money.txHash}`)
  }
  const { receipt } = answer
  if (receipt.blockNumber !== money.blockNumber) {
    return item('mismatch', `it was credited from block ${money.blockNumber.toString()}, and the chain now has that transaction in block ${receipt.blockNumber.toString()}`)
  }
  const from = checksummed(money.fromAddress)
  const to = checksummed(money.depositAddress)
  if (from === undefined || to === undefined) {
    return item('mismatch', `the addresses on the row are not both addresses the chain could hold: ${money.fromAddress} to ${money.depositAddress}`)
  }
  // The one log the row recorded: the official contract, that exact address, that exact amount.
  const missing = transferMissing(receipt.logs.filter((entry) => entry.logIndex === money.logIndex), { from, to, amount: money.amountMinor })
  if (missing !== undefined) {
    return item('mismatch', `it is credited on the books, and the event it names is not there: ${missing}`)
  }
  if (block !== undefined && money.blockNumber > block) {
    return item(
      'explained',
      `credited from block ${money.blockNumber.toString()}, after the block this run pinned, so the chain at that block does not show it yet${attribution}`,
      money.amountMinor,
    )
  }
  return item('ok', `${formatMinor(money.amountMinor)} arrived at ${money.depositAddress} in block ${money.blockNumber.toString()} and is credited${attribution}`)
}

/**
 * What the books must say, checked as a set: those kinds, each exactly once, each for the amount.
 * Returns the sentence naming what was expected and what was found, or nothing when they agree.
 */
function ledgerDisagreement(facts: readonly LedgerFacts[], expected: readonly string[], amount: bigint): string | undefined {
  const found = facts.map((fact) => fact.kind).sort()
  if (found.join(',') !== [...expected].sort().join(',')) {
    return `the books should hold ${expected.join(' and ')} for it, and they hold ${found.length === 0 ? 'no ledger transaction at all' : kindsOf(facts)}`
  }
  const wrongAmount = facts.find((fact) => fact.amountMinor !== amount)
  if (wrongAmount !== undefined) {
    return `it is for ${formatMinor(amount)}, and its ${wrongAmount.kind} moved ${formatMinor(wrongAmount.amountMinor)}`
  }
  return undefined
}

/**
 * Both sentences that say nothing was ever signed, held to it: a hash means bytes that could still
 * land, and a nonce means one of the treasury's was spent on a payment that went nowhere.
 */
function signedAnyway(payment: PaymentFacts, claim: string): string | undefined {
  if (payment.txHash !== null) {
    return `${claim}, and yet the row carries the transaction ${payment.txHash}`
  }
  return payment.nonce === null ? undefined : `${claim}, and yet the row holds treasury nonce ${String(payment.nonce)}`
}

/** A malformed address is one item's mismatch, never the end of a run the other items are evidence for. */
export function checksummed(address: string): Address | undefined {
  try {
    return getAddress(address)
  } catch {
    return undefined
  }
}

/**
 * The official contract's Transfer, asked of a receipt's logs: nothing when it is there, and the
 * sentence saying what was found instead when it is not. A settled payment must have it, a
 * reverted one must not, and a deposit must have it at the exact position its row recorded.
 *
 * The chain package writes its amounts in minor units, and every standalone run of digits in that
 * message is one; the lookarounds keep the substitution off the digits inside an address or a hash.
 */
function transferMissing(logs: LandedTransaction['logs'], expected: ExpectedTransfer): string | undefined {
  try {
    findSettlementLog(logs, expected)
    return undefined
  } catch (mismatch) {
    return chainErrorMessage(mismatch).replace(/(?<![\w.])\d+(?![\w.])/g, (amount) => formatMinor(BigInt(amount)))
  }
}

function kindsOf(facts: readonly LedgerFacts[]): string {
  return facts
    .map((fact) => fact.kind)
    .sort()
    .join(' and ')
}
