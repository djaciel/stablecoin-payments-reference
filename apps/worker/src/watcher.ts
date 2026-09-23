import { activityInfo, log } from '@temporalio/activity'
import {
  createChainClient,
  chainErrorMessage,
  finalBlockNumber,
  findSettlementLog,
  findTransfersTo,
  rpcHost,
  type ObservedTransfer,
} from '@payments/chain'
import { inTransaction, type PoolClient } from '@payments/db'
import { formatMinor, funding, fundingReference } from '@payments/ledger'
import { getAddress, type Address, type Hex } from 'viem'
import { workerPool } from './db'
import { correctBlock, markMismatched, promotableDeposits, recordDetected, settleDeposit, type PromotableDeposit } from './deposits'
import { readReceipt } from './watch'

/** The one scan there is today. `watcher_state` is keyed by it so a second one is a row. */
export const SCAN_NAME = 'usdc-transfers'

/** The books are USDC-only (spec assumption 2). Gas is never posted. */
const CURRENCY = 'USDC'

/**
 * `https://sepolia.base.org` refuses an `eth_getLogs` range wider than 1,001 blocks
 * (`-32614 eth_getLogs is limited to a 1,000 range`, measured again 2026-09-22; it took 10,000
 * when T-09 measured it). A caught-up watcher never comes near it — this is the ceiling that
 * decides how fast one catches up after being rewound or restarted.
 */
const MAX_RANGE_BLOCKS = 1_000n

/**
 * How far back the first tick looks when there is no cursor: ~5.5 hours of Base Sepolia,
 * because a treasury is usually funded before the stack that watches it exists. Older money
 * needs the cursor moved by hand once: `UPDATE watcher_state SET last_block = <block - 1>`.
 */
const INITIAL_LOOKBACK_BLOCKS = 10_000n

/** How long a caught-up watcher waits between scans once something has been funded. */
const IDLE_INTERVAL_MS = 30_000

const chain = createChainClient()

/**
 * Set by a tick that stopped short of the final block, and read by the idle check: catching
 * up must never idle, or 100,000 blocks at 2,000 a scan take half an hour instead of minutes.
 * It starts true because a worker that has just started does not know how far behind it is,
 * so its first tick asks the chain instead of trusting a cursor somebody may have rewound.
 */
let behindFinalBlock = true

/** One tick. Returns the same sentence it logs, so the Temporal UI shows it as the result. */
export async function watchChain(): Promise<string> {
  try {
    return await runTick()
  } catch (error) {
    // The loud line. Retries are bounded (workflows.ts), so a tick that keeps failing ends
    // its run FAILED instead of running forever — and this is what says why, in one line.
    log.error(`watcher: TICK FAILED (attempt ${activityInfo().attempt}) — ${reason(error)} [chain: ${rpcHost()}]`)
    throw error
  }
}

/**
 * One tick, in four parts: read the chain (twice, over two ranges), write what arrived in one
 * transaction with the cursor, then credit the deposits whose block can no longer change.
 */
async function runTick(): Promise<string> {
  const client = await workerPool().connect()
  try {
    const watched = await readWatchedAddresses(client)
    if (watched.size === 0) {
      return logAndReturn('no addresses are being watched yet — the api registers the treasury at startup')
    }

    const cursor = await readCursor(client)
    if (cursor !== undefined && !(await shouldScan(client, cursor.lastScanAt))) {
      return logAndReturn(`idle: caught up, nothing in flight, last scan under ${IDLE_INTERVAL_MS / 1000}s ago`)
    }

    // Every RPC read happens before any transaction is opened: a database transaction held
    // open across a call to a public endpoint holds the ledger's locks for as long as the
    // internet feels like it.
    const finalBlock = await finalBlockNumber(chain)
    const latest = await chain.getBlockNumber()
    const fromBlock = cursor === undefined ? firstBlock(finalBlock) : cursor.lastBlock + 1n
    const rangeCeiling = fromBlock + MAX_RANGE_BLOCKS - 1n
    const toBlock = rangeCeiling < finalBlock ? rangeCeiling : finalBlock
    behindFinalBlock = toBlock < finalBlock

    // Final blocks: money that cannot un-happen. Fundings are posted from here and nowhere else,
    // and deposits are recorded here too — one that became final while the worker was down would
    // otherwise never be seen at all.
    const finalRange = toBlock < fromBlock ? [] : await findTransfersTo(chain, { addresses: [...watched.keys()], fromBlock, toBlock })

    // The unfinalized tail, deposit addresses only, so the money shows on screen while everyone
    // waits for finality. It keeps no cursor: `(tx_hash, log_index)` makes re-reading it free.
    const depositAddresses = [...watched].filter(([, watch]) => watch.role === 'deposit').map(([address]) => address)
    const tailFrom = max(finalBlock + 1n, latest - MAX_RANGE_BLOCKS + 1n)
    const tail =
      depositAddresses.length === 0 || tailFrom > latest
        ? []
        : await findTransfersTo(chain, { addresses: depositAddresses, fromBlock: tailFrom, toBlock: latest })

    // The entries and the cursor commit together, which is the whole safety argument: a
    // worker killed mid-tick re-scans the range instead of skipping it, and re-scanning
    // cannot double-post because `(kind, reference)` names one transaction per Transfer.
    const outcomes = await inTransaction(client, async () => {
      const results: TransferOutcome[] = []
      for (const transfer of [...finalRange, ...tail]) {
        results.push(await postTransfer(client, watched, transfer, finalBlock))
      }
      // A tick that found nothing final still records that it looked, or the idle timer never moves.
      await advanceCursor(client, toBlock < fromBlock ? fromBlock - 1n : toBlock)
      return results
    })

    // Outside that transaction, because every deposit checked here costs one more RPC read.
    const promoted = await promote(client, finalBlock)

    for (const line of [...outcomes.map((outcome) => outcome.line), ...promoted.lines]) {
      log.info(`watcher: ${line}`)
    }

    const posted = outcomes.filter((outcome) => outcome.posted).length
    const detected = outcomes.filter((outcome) => outcome.detected).length
    const skipped = outcomes.filter((outcome) => !outcome.posted && !outcome.detected).length + promoted.skipped
    const lag = behindFinalBlock ? `${finalBlock - toBlock} behind` : 'caught up'
    const range = toBlock < fromBlock ? `nothing new up to ${finalBlock}` : `scanned ${fromBlock}..${toBlock} (final ${finalBlock}, ${lag})`
    return logAndReturn(
      `${range} + tail ${tailFrom}..${latest}: ${posted} funding(s) posted, ${detected} detected, ${promoted.settled} credited, ${skipped} skipped`,
    )
  } finally {
    client.release()
  }
}

interface TransferOutcome {
  /** Whether it became a ledger entry, which is what the tick's line counts. */
  readonly posted: boolean
  /** Whether it became a new DETECTED deposit row. Counted apart: a row is not a credit. */
  readonly detected: boolean
  readonly line: string
}

/** What is being watched at one address, and for whom. A treasury has no partner. */
interface WatchedAddress {
  readonly role: string
  readonly partnerId: string | null
}

/** Runs inside the tick's transaction, so anything it writes commits with the cursor. */
async function postTransfer(
  client: PoolClient,
  watched: Map<Address, WatchedAddress>,
  transfer: ObservedTransfer,
  finalBlock: bigint,
): Promise<TransferOutcome> {
  const reference = fundingReference(transfer.txHash, transfer.logIndex)
  // Checksummed on both sides before they are compared: the same address written two
  // different ways is the classic way a watcher misses money.
  const destination = watched.get(getAddress(transfer.to))

  if (destination?.role === 'deposit' && destination.partnerId !== null) {
    // The address IS the attribution (article section 8): whose money this is was decided when
    // the partner was created, not by what the amount happens to match.
    const outcome = await recordDetected(client, transfer, destination.partnerId, finalBlock)
    return { posted: false, detected: outcome.recorded, line: outcome.line }
  }

  if (destination?.role !== 'treasury') {
    return { posted: false, detected: false, line: `${reference}: to a ${destination?.role ?? 'unknown'} address nobody claims — not posted` }
  }

  if (await alreadyPosted(client, reference)) {
    // The normal outcome of re-scanning a range. The unique index would refuse the INSERT
    // anyway; asking first is what lets the rest of this tick carry on in the same transaction.
    return { posted: false, detected: false, line: `${reference}: already posted, nothing to do` }
  }

  await funding(client, {
    txHash: transfer.txHash,
    logIndex: transfer.logIndex,
    blockNumber: transfer.blockNumber,
    amount: transfer.amount,
    currency: CURRENCY,
  })
  return {
    posted: true,
    detected: false,
    line: `${reference}: posted funding of ${formatMinor(transfer.amount)} ${CURRENCY} at block ${transfer.blockNumber}`,
  }
}

/**
 * The promotion pass: for every DETECTED deposit whose block is final, ask the chain again.
 * The Transfer we saw in a log is not enough on its own — a block near the tip can be replaced —
 * so the receipt is re-read by hash and the event re-checked at the exact log index before a
 * single entry is written (article section 7's rule, applied to money coming in).
 */
async function promote(client: PoolClient, finalBlock: bigint): Promise<{ settled: number; skipped: number; lines: string[] }> {
  const lines: string[] = []
  let settled = 0
  let skipped = 0

  for (const money of await promotableDeposits(client, finalBlock)) {
    const receipt = await readReceipt(money.txHash as Hex)

    if (receipt === undefined) {
      await markMismatched(client, money, 'not in a block any more')
      lines.push(`deposit ${money.id}: the chain no longer has ${money.txHash} — still DETECTED, nothing credited`)
      skipped += 1
      continue
    }

    if (receipt.blockNumber !== money.blockNumber) {
      await correctBlock(client, money.id, receipt.blockNumber)
      if (receipt.blockNumber > finalBlock) {
        lines.push(`deposit ${money.id}: moved to block ${receipt.blockNumber}, waiting for that one to be final`)
        skipped += 1
        continue
      }
    }

    const evidence = { txHash: money.txHash, blockNumber: Number(receipt.blockNumber), finalBlock: Number(finalBlock), logIndex: money.logIndex }
    try {
      // One log, the one we recorded: the official contract, that exact address, that exact
      // amount. Anything else and this is not the transfer we detected.
      findSettlementLog(receipt.logs.filter((entry) => entry.logIndex === money.logIndex), expectedTransfer(money))
    } catch (mismatch) {
      await markMismatched(client, money, chainErrorMessage(mismatch))
      lines.push(`deposit ${money.id}: the event no longer matches — still DETECTED, nothing credited (${chainErrorMessage(mismatch)})`)
      skipped += 1
      continue
    }

    const outcome = await settleDeposit(client, money.id, evidence)
    if (outcome.kind === 'already-settled') {
      lines.push(`deposit ${money.id}: already credited, nothing to do`)
      skipped += 1
      continue
    }
    settled += 1
    lines.push(
      `deposit ${money.id}: credited ${formatMinor(money.amountMinor)} ${money.currency} (block ${receipt.blockNumber}, final ${finalBlock}), matched by ${outcome.matchedBy}${outcome.receivableId === null ? '' : ` → invoice ${outcome.receivableId} PAID`}`,
    )
  }

  return { settled, skipped, lines }
}

function expectedTransfer(money: PromotableDeposit): { from: Address; to: Address; amount: bigint } {
  return { from: getAddress(money.fromAddress), to: getAddress(money.depositAddress), amount: money.amountMinor }
}

interface Cursor {
  readonly lastBlock: bigint
  readonly lastScanAt: Date
}

async function readCursor(client: PoolClient): Promise<Cursor | undefined> {
  const result = await client.query<{ last_block: string; last_scan_at: Date }>(
    'SELECT last_block, last_scan_at FROM watcher_state WHERE name = $1',
    [SCAN_NAME],
  )
  const row = result.rows[0]
  return row === undefined ? undefined : { lastBlock: BigInt(row.last_block), lastScanAt: row.last_scan_at }
}

/** Address → what is watched there, which is how a transfer's destination decides what it means. */
async function readWatchedAddresses(client: PoolClient): Promise<Map<Address, WatchedAddress>> {
  const result = await client.query<{ address: string; role: string; partner_id: string | null }>(
    'SELECT address, role, partner_id FROM watched_addresses ORDER BY created_at',
  )
  return new Map(result.rows.map((row) => [getAddress(row.address), { role: row.role, partnerId: row.partner_id }]))
}

/** Where a database with no cursor starts. See INITIAL_LOOKBACK_BLOCKS. */
function firstBlock(finalBlock: bigint): bigint {
  return finalBlock > INITIAL_LOOKBACK_BLOCKS ? finalBlock - INITIAL_LOOKBACK_BLOCKS : 0n
}

function max(left: bigint, right: bigint): bigint {
  return left > right ? left : right
}

/**
 * The adaptive skip (spec assumption 6): before the first funding every tick scans, afterwards
 * only stale ones do — unless something is in flight. A partner's transfer waiting to be seen,
 * or a deposit waiting for finality, is exactly when a demo must not be asleep; and a catch-up
 * in progress overrides everything, because idling through it is the slow way.
 */
async function shouldScan(client: PoolClient, lastScanAt: Date): Promise<boolean> {
  if (behindFinalBlock || Date.now() - lastScanAt.getTime() >= IDLE_INTERVAL_MS) {
    return true
  }
  const inFlight = await client.query(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM receivables WHERE status = 'PAYING')
              OR EXISTS (SELECT 1 FROM deposits WHERE status = 'DETECTED')
              OR NOT EXISTS (SELECT 1 FROM ledger_transactions WHERE kind = 'funding')`,
  )
  return inFlight.rows.length > 0
}

async function alreadyPosted(client: PoolClient, reference: string): Promise<boolean> {
  const existing = await client.query(
    "SELECT 1 FROM ledger_transactions WHERE kind = 'funding' AND reference = $1",
    [reference],
  )
  return existing.rows.length > 0
}

/** The cursor and the entries commit together, or neither does. */
async function advanceCursor(client: PoolClient, lastBlock: bigint): Promise<void> {
  await client.query(
    `INSERT INTO watcher_state (name, last_block) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET last_block = EXCLUDED.last_block, last_scan_at = now()`,
    [SCAN_NAME, lastBlock.toString()],
  )
}

/** The tick's one line: logged for the operator, returned so the Temporal UI shows it too. */
function logAndReturn(line: string): string {
  log.info(`watcher: ${line}`)
  return line
}

/**
 * The first line only, never viem's whole message: that one runs to five lines and prints the
 * full RPC URL, which for a provider endpoint carries the API key. The host is added by the
 * caller because "HTTP request failed." does not say which endpoint refused.
 */
function reason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.split('\n')[0] ?? message
}
