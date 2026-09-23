import { log } from '@temporalio/activity'
import { chainErrorMessage, createChainClient, finalBlockNumber, readUsdcBalance, rpcHost, type ChainClient, type LandedTransaction } from '@payments/chain'
import { inTransaction, type Pool, type PoolClient } from '@payments/db'
import { ACCOUNTS, AUDIT_SUBJECTS, DEPOSIT_EVENTS } from '@payments/ledger'
import type { Address, Hex } from 'viem'
import { workerPool } from './db'
import {
  checkDeposit,
  checkGlobal,
  checkPayment,
  checksummed,
  type AddressBalance,
  type BookFigures,
  type ChainAnswer,
  type DepositFacts,
  type LedgerFacts,
  type PaymentFacts,
  type ReconciliationItem,
  type Receipts,
} from './reconcile-items'
import { readReceipt } from './watch'
import { SCAN_NAME } from './watcher'

/**
 * Article section 10's first check: every payment and every deposit, three versions each, at one
 * block. What was asked for (the intent row), what was recorded (the ledger transactions with that
 * reference) and what happened (the receipt and the official contract's Transfer).
 *
 * The run is written once, whole, at the end. Half a reconciliation is not evidence.
 */

/** The ledger kinds a payment or a deposit can name. Nothing else is read. */
const CHECKED_KINDS = ['reserve', 'settle', 'reversal', 'cancel', 'deposit']

/** How many unexplained subjects the summary names before it becomes a count. */
const MISMATCHES_NAMED = 5

/**
 * What the run needs from the chain, as a port rather than a viem client: the db suite passes a
 * stub, so a mismatch can be manufactured on the chain's side without a network. Three methods
 * wide on purpose.
 */
export interface ChainFacts {
  finalBlock(): Promise<bigint>
  receiptOf(hash: Hex): Promise<LandedTransaction | undefined>
  /** The stablecoin at one address at ONE block. There is no call that reads it at `latest`. */
  usdcBalanceAt(address: Address, blockNumber: bigint): Promise<bigint>
}

/** How many times a balance is asked for at a block the answering node may not have yet. */
const BALANCE_READ_ATTEMPTS = 3
const BALANCE_READ_WAIT_MS = 1_500

/**
 * The real one. The receipt read is `watch`'s, so both steps ask the chain the same question.
 *
 * The retries behind the spec's "could not be read after retries" are viem's own three per call,
 * its default, which is why nothing below loops: a read that still fails is reported as
 * `unchecked` or `incomplete`, never guessed at and never re-asked at `latest`. The balance read
 * is the exception `fund-partner-wallet.service.ts` already makes, and for its reason: the
 * endpoint is load balanced, so the node answering may still be behind the block B was pinned to.
 */
export function chainFacts(): ChainFacts {
  const chain = createChainClient()
  return {
    finalBlock: () => finalBlockNumber(chain),
    receiptOf: (hash) => readReceipt(hash),
    usdcBalanceAt: (address, blockNumber) => balanceAt(chain, address, blockNumber),
  }
}

async function balanceAt(chain: ChainClient, address: Address, blockNumber: bigint): Promise<bigint> {
  let why = 'the balance was not read'
  for (let attempt = 1; attempt <= BALANCE_READ_ATTEMPTS; attempt += 1) {
    try {
      return await readUsdcBalance(chain, address, blockNumber)
    } catch (error) {
      why = chainErrorMessage(error)
      if (attempt < BALANCE_READ_ATTEMPTS) {
        await wait(BALANCE_READ_WAIT_MS)
      }
    }
  }
  // Thrown, not swallowed: the node's own words are what the unchecked item shows a reader, and
  // `rpcHost()` because a provider URL carries its API key.
  throw new Error(`${why} (RPC ${rpcHost()}, ${String(BALANCE_READ_ATTEMPTS)} attempts)`)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export interface ReconciliationRun {
  readonly id: string
  readonly blockNumber: bigint | undefined
  readonly outcome: 'clean' | 'mismatch' | 'incomplete'
  readonly summary: string
  readonly items: readonly ReconciliationItem[]
}

/**
 * The whole run, in the order it happens: one snapshot of the database, one block, the chain
 * reads, one item per payment and per deposit, one insert.
 */
export async function reconcile(pool: Pool, chain: ChainFacts): Promise<ReconciliationRun> {
  const startedAt = new Date()
  const client = await pool.connect()
  try {
    // 1. One snapshot. Everything compared comes from the same instant, and the transaction is
    //    closed before the first chain read: an RPC call inside it would hold the ledger's locks
    //    for as long as the internet felt like it.
    const books = await snapshot(client)

    // 2. The block B. The books' knowledge of the chain ends at the watcher's cursor, so B does
    //    too: a later block would read every funding in between as a mismatch that fixes itself
    //    in ten seconds.
    const block = await pinBlock(books.cursor, chain)

    // 3. The chain reads, one receipt per payment that has a hash and per settled deposit, and
    //    one balance per watched address — all of them at B, none of them at `latest`.
    const receipts = await readReceipts(books, block, chain)
    const balances = await readBalances(books, block, chain)

    // 4. The items, then the one identity they explain: books against the chain at B.
    const movements = [
      ...books.payments.map((payment) => checkPayment(payment, books.ledgerFor(payment.reference), receipts, block.number, books.treasury)),
      ...books.deposits.map((money) => checkDeposit(money, books.ledgerFor(money.id), receipts, block.number)),
    ]
    const identity = checkGlobal(books.figures, balances, movements, block.number)

    // 5. One insert, at the end.
    return await write(client, { startedAt, block, items: [...movements, identity], identity })
  } finally {
    client.release()
  }
}

/** The activity. Returns the run's one line, so the Temporal UI shows it as the result. */
export async function reconcileNow(): Promise<string> {
  const run = await reconcile(workerPool(), chainFacts())
  log.info(`reconciler: ${run.summary}`)
  return run.summary
}

// ---------------------------------------------------------------------------------------
// 1. The snapshot
// ---------------------------------------------------------------------------------------

interface Snapshot {
  readonly cursor: bigint | undefined
  readonly treasury: Address | undefined
  /** The treasury and every deposit address, which is the whole right-hand side of the identity. */
  readonly watched: readonly WatchedAddress[]
  /** The three accounts with a counterpart on the chain, read in the same instant as the rows. */
  readonly figures: BookFigures
  readonly payments: readonly PaymentFacts[]
  readonly deposits: readonly DepositFacts[]
  ledgerFor(reference: string): readonly LedgerFacts[]
}

interface WatchedAddress {
  readonly address: Address
  readonly label: string
}

/** The accounts in the identity, in the order the screen reads them out loud. */
const IDENTITY_ACCOUNTS = [ACCOUNTS.treasuryAvailable, ACCOUNTS.treasuryReserved, ACCOUNTS.depositsOnchain]

async function snapshot(client: PoolClient): Promise<Snapshot> {
  return inTransaction(client, async () => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')

    const cursor = await client.query<{ last_block: string }>('SELECT last_block FROM watcher_state WHERE name = $1', [SCAN_NAME])
    // The same table the watcher watches; the signer is never asked for anything here. The
    // treasury first, then a deposit address per partner, which is the order the screen prints.
    const watched = await client.query<{ address: string; role: string; name: string | null }>(
      `SELECT w.address, w.role, p.name FROM watched_addresses w
         LEFT JOIN partners p ON p.id = w.partner_id
        ORDER BY w.role DESC, p.name`,
    )
    const figures = await client.query<{ code: string; balance_minor: string }>(
      'SELECT code, balance_minor FROM ledger_accounts WHERE code = ANY($1::text[])',
      [IDENTITY_ACCOUNTS],
    )
    // The one thing the system already knows is wrong that no row of its own records: a deposit
    // the watcher refused to credit because its second look at the chain disagreed.
    const refused = await client.query<{ subject_id: string; reason: string | null }>(
      `SELECT DISTINCT ON (subject_id) subject_id, context->>'reason' AS reason
         FROM audit_log WHERE subject_type = $1 AND event = $2
        ORDER BY subject_id, id DESC`,
      [AUDIT_SUBJECTS.deposit, DEPOSIT_EVENTS.mismatched],
    )
    const payments = await client.query<PaymentRow>(
      'SELECT reference, status, failure_reason, destination, amount_minor, tx_hash, nonce FROM payments ORDER BY created_at',
    )
    const deposits = await client.query<DepositRow>(
      'SELECT id, tx_hash, log_index, from_address, deposit_address, amount_minor, block_number, status, matched_by FROM deposits ORDER BY detected_at',
    )
    // A transaction's entries all carry its amount, so one of them is the amount.
    const ledger = await client.query<{ reference: string; kind: string; amount_minor: string; proof: LedgerFacts['proof'] }>(
      `SELECT t.reference, t.kind, t.proof, max(e.amount_minor) AS amount_minor
         FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id
        WHERE t.reference IS NOT NULL AND t.kind = ANY($1::text[])
        GROUP BY t.id`,
      [CHECKED_KINDS],
    )

    const byReference = new Map<string, LedgerFacts[]>()
    for (const row of ledger.rows) {
      const facts = byReference.get(row.reference) ?? []
      facts.push({ kind: row.kind, amountMinor: BigInt(row.amount_minor), proof: row.proof })
      byReference.set(row.reference, facts)
    }

    const balanceOf = (code: string): bigint => BigInt(figures.rows.find((row) => row.code === code)?.balance_minor ?? '0')
    const reasons = new Map(refused.rows.map((row) => [row.subject_id, row.reason]))
    const treasury = watched.rows.find((row) => row.role === 'treasury')?.address

    return {
      cursor: cursor.rows[0] === undefined ? undefined : BigInt(cursor.rows[0].last_block),
      // Undefined rather than a throw if it is somehow not an address: the items that need it say
      // so one by one, and the rest of the run is still evidence.
      treasury: treasury === undefined ? undefined : checksummed(treasury),
      watched: watched.rows.flatMap(toWatchedAddress),
      figures: {
        available: balanceOf(ACCOUNTS.treasuryAvailable),
        reserved: balanceOf(ACCOUNTS.treasuryReserved),
        deposits: balanceOf(ACCOUNTS.depositsOnchain),
      },
      payments: payments.rows.map(toPaymentFacts),
      deposits: deposits.rows.map((row) => toDepositFacts(row, reasons.get(row.id) ?? null)),
      ledgerFor: (reference) => byReference.get(reference) ?? [],
    }
  })
}

// ---------------------------------------------------------------------------------------
// 2. The block B
// ---------------------------------------------------------------------------------------

/** The block the chain side is pinned to, or why there is none. */
interface PinnedBlock {
  readonly number: bigint | undefined
  readonly why: string | undefined
}

const NO_CURSOR = 'the watcher has not scanned anything yet, so there is no block at which the books and the chain can be compared'

async function pinBlock(cursor: bigint | undefined, chain: ChainFacts): Promise<PinnedBlock> {
  if (cursor === undefined) {
    return { number: undefined, why: NO_CURSOR }
  }
  try {
    // The `min` costs one read and protects the run from a cursor somebody rewound by hand.
    const final = await chain.finalBlock()
    return { number: cursor < final ? cursor : final, why: undefined }
  } catch (error) {
    // After viem's three attempts. Never a fallback to `latest`: a moving target is the thing
    // section 10 warns about.
    return { number: undefined, why: `the chain could not be read: ${chainErrorMessage(error)}` }
  }
}

// ---------------------------------------------------------------------------------------
// 3. The chain reads — all of them outside any transaction
// ---------------------------------------------------------------------------------------

async function readReceipts(books: Snapshot, block: PinnedBlock, chain: ChainFacts): Promise<Receipts> {
  const hashes = new Set([
    ...books.payments.flatMap((payment) => (payment.txHash === null ? [] : [payment.txHash])),
    ...books.deposits.flatMap((money) => (money.status === 'SETTLED' ? [money.txHash] : [])),
  ])

  const answers = new Map<string, ChainAnswer>()
  for (const hash of hashes) {
    if (block.number === undefined) {
      answers.set(hash, { kind: 'unreadable', why: block.why ?? NO_CURSOR })
      continue
    }
    try {
      const receipt = await chain.receiptOf(hash as Hex)
      answers.set(hash, receipt === undefined ? { kind: 'not-landed' } : { kind: 'receipt', receipt })
    } catch (error) {
      answers.set(hash, { kind: 'unreadable', why: chainErrorMessage(error) })
    }
  }
  return answers
}

/**
 * What the company holds on chain at B, address by address: the treasury plus every partner's
 * deposit address. A read that fails after its retries is carried as the node's sentence, which
 * makes the run `incomplete`; it is never guessed at and never re-asked at a later block.
 */
async function readBalances(books: Snapshot, block: PinnedBlock, chain: ChainFacts): Promise<AddressBalance[]> {
  const balances: AddressBalance[] = []
  for (const watched of books.watched) {
    if (block.number === undefined) {
      balances.push({ ...watched, why: block.why ?? NO_CURSOR })
      continue
    }
    try {
      balances.push({ ...watched, amountMinor: await chain.usdcBalanceAt(watched.address, block.number) })
    } catch (error) {
      balances.push({ ...watched, why: chainErrorMessage(error) })
    }
  }
  return balances
}

// (4. The items is `reconcile-items.ts`: one payment or one deposit, three versions, one sentence.)

// ---------------------------------------------------------------------------------------
// 5. The write — one transaction, once, at the end
// ---------------------------------------------------------------------------------------

async function write(
  client: PoolClient,
  run: { startedAt: Date; block: PinnedBlock; items: readonly ReconciliationItem[]; identity: ReconciliationItem },
): Promise<ReconciliationRun> {
  const explained = run.items.filter((item) => item.outcome === 'explained')
  const mismatched = run.items.filter((item) => item.outcome === 'mismatch')
  const unchecked = run.items.filter((item) => item.outcome === 'unchecked')
  const outcome = mismatched.length > 0 ? 'mismatch' : unchecked.length > 0 || run.block.number === undefined ? 'incomplete' : 'clean'
  const summary = summarise(outcome, run.items.length, explained.length, mismatched, unchecked.length, run.identity)

  const id = await inTransaction(client, async () => {
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO reconciliation_runs (started_at, finished_at, block_number, outcome, checked, explained, mismatched, summary)
       VALUES ($1, now(), $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        run.startedAt,
        run.block.number?.toString() ?? null,
        outcome,
        run.items.length,
        explained.length,
        mismatched.length,
        summary,
      ],
    )
    const runId = inserted.rows[0]?.id
    if (runId === undefined) {
      throw new Error('the reconciliation run was not written')
    }
    for (const item of run.items) {
      await client.query(
        `INSERT INTO reconciliation_items (run_id, subject_type, subject_id, outcome, delta_minor, detail, evidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [runId, item.subjectType, item.subjectId, item.outcome, item.deltaMinor?.toString() ?? null, item.detail, item.evidence ?? null],
      )
    }
    return runId
  })

  return { id, blockNumber: run.block.number, outcome, summary, items: run.items }
}

/**
 * The line the Temporal UI shows, and the one a person reads in psql: the counts, then the
 * identity's own sentence, which carries the block and all four figures.
 *
 * It names the unexplained subjects when there are few: a bare count sends a reader looking.
 */
function summarise(
  outcome: string,
  checked: number,
  explained: number,
  mismatched: readonly ReconciliationItem[],
  unchecked: number,
  identity: ReconciliationItem,
): string {
  const names = mismatched.length > 0 && mismatched.length <= MISMATCHES_NAMED ? ` (${mismatched.map((item) => item.subjectId).join(', ')})` : ''
  const tail = unchecked === 0 ? '' : `, ${String(unchecked)} the chain could not answer for`
  return `${outcome}: ${String(checked)} checked, ${String(explained)} explained, ${String(mismatched.length)} unexplained${names}${tail}. ${identity.detail}`
}

interface PaymentRow {
  readonly reference: string
  readonly status: string
  readonly failure_reason: string | null
  readonly destination: string
  readonly amount_minor: string
  readonly tx_hash: string | null
  readonly nonce: number | null
}

interface DepositRow {
  readonly id: string
  readonly tx_hash: string
  readonly log_index: number
  readonly from_address: string
  readonly deposit_address: string
  readonly amount_minor: string
  readonly block_number: string
  readonly status: string
  readonly matched_by: string | null
}

function toPaymentFacts(row: PaymentRow): PaymentFacts {
  return {
    reference: row.reference,
    status: row.status,
    failureReason: row.failure_reason,
    destination: row.destination,
    amountMinor: BigInt(row.amount_minor),
    txHash: row.tx_hash,
    nonce: row.nonce,
  }
}

/** A row whose address the chain could not hold is dropped: it is watching nothing. */
function toWatchedAddress(row: { address: string; role: string; name: string | null }): WatchedAddress[] {
  const address = checksummed(row.address)
  if (address === undefined) {
    return []
  }
  return [{ address, label: row.role === 'treasury' ? 'treasury' : `${row.name ?? 'a partner'}'s deposit address` }]
}

function toDepositFacts(row: DepositRow, mismatchedReason: string | null): DepositFacts {
  return {
    id: row.id,
    mismatchedReason,
    txHash: row.tx_hash,
    logIndex: row.log_index,
    fromAddress: row.from_address,
    depositAddress: row.deposit_address,
    amountMinor: BigInt(row.amount_minor),
    blockNumber: BigInt(row.block_number),
    status: row.status,
    matchedBy: row.matched_by,
  }
}
