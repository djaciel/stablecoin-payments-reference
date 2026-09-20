import { activityInfo, log } from '@temporalio/activity'
import { createChainClient, finalBlockNumber, findTransfersTo, rpcHost, type ObservedTransfer } from '@payments/chain'
import { inTransaction, type PoolClient } from '@payments/db'
import { formatMinor, funding, fundingReference } from '@payments/ledger'
import { getAddress, type Address } from 'viem'
import { workerPool } from './db'

/** The one scan there is today. `watcher_state` is keyed by it so a second one is a row. */
const SCAN_NAME = 'usdc-transfers'

/** The books are USDC-only (spec assumption 2). Gas is never posted. */
const CURRENCY = 'USDC'

/** `https://sepolia.base.org` refuses an `eth_getLogs` range wider than 10,000 blocks. */
const MAX_RANGE_BLOCKS = 2_000n

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

    // Both RPC reads happen before any transaction is opened: a database transaction held
    // open across a call to a public endpoint holds the ledger's locks for as long as the
    // internet feels like it.
    const finalBlock = await finalBlockNumber(chain)
    const fromBlock = cursor === undefined ? firstBlock(finalBlock) : cursor.lastBlock + 1n
    const rangeCeiling = fromBlock + MAX_RANGE_BLOCKS - 1n
    const toBlock = rangeCeiling < finalBlock ? rangeCeiling : finalBlock
    behindFinalBlock = toBlock < finalBlock

    if (toBlock < fromBlock) {
      // The chain has produced nothing final since the last tick. Still record that we
      // looked, or the idle timer never moves.
      await inTransaction(client, () => advanceCursor(client, fromBlock - 1n))
      return logAndReturn(`nothing new: final block ${finalBlock} is already scanned`)
    }

    const transfers = await findTransfersTo(chain, { addresses: [...watched.keys()], fromBlock, toBlock })

    // The entries and the cursor commit together, which is the whole safety argument: a
    // worker killed mid-tick re-scans the range instead of skipping it, and re-scanning
    // cannot double-post because `(kind, reference)` names one transaction per Transfer.
    const outcomes = await inTransaction(client, async () => {
      const results: TransferOutcome[] = []
      for (const transfer of transfers) {
        results.push(await postTransfer(client, watched, transfer))
      }
      await advanceCursor(client, toBlock)
      return results
    })

    for (const outcome of outcomes) {
      log.info(`watcher: ${outcome.line}`)
    }

    const posted = outcomes.filter((outcome) => outcome.posted).length
    const lag = behindFinalBlock ? `${finalBlock - toBlock} behind` : 'caught up'
    return logAndReturn(
      `scanned ${fromBlock}..${toBlock} (final ${finalBlock}, ${lag}): ${transfers.length} transfer(s) found, ${posted} posted, ${transfers.length - posted} skipped`,
    )
  } finally {
    client.release()
  }
}

interface TransferOutcome {
  /** Whether it became a ledger entry, which is what the tick's line counts. */
  readonly posted: boolean
  readonly line: string
}

/** Runs inside the tick's transaction, so anything it writes commits with the cursor. */
async function postTransfer(
  client: PoolClient,
  watched: Map<Address, string>,
  transfer: ObservedTransfer,
): Promise<TransferOutcome> {
  const reference = fundingReference(transfer.txHash, transfer.logIndex)
  // Checksummed on both sides before they are compared: the same address written two
  // different ways is the classic way a watcher misses money.
  const role = watched.get(getAddress(transfer.to))

  if (role !== 'treasury') {
    // Phase 6 owns the DETECTED row and the credit at finality. The cursor moves past this
    // transfer either way, so a deposit seen before Phase 6 needs a manual cursor rewind.
    const line = `${reference}: ${formatMinor(transfer.amount)} ${CURRENCY} to a ${role ?? 'unknown'} address — deposits arrive in Phase 6, not posted`
    return { posted: false, line }
  }

  if (await alreadyPosted(client, reference)) {
    // The normal outcome of re-scanning a range. The unique index would refuse the INSERT
    // anyway; asking first is what lets the rest of this tick carry on in the same transaction.
    return { posted: false, line: `${reference}: already posted, nothing to do` }
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
    line: `${reference}: posted funding of ${formatMinor(transfer.amount)} ${CURRENCY} at block ${transfer.blockNumber}`,
  }
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

/** Address → role, which is how a transfer's destination decides what the transfer means. */
async function readWatchedAddresses(client: PoolClient): Promise<Map<Address, string>> {
  const result = await client.query<{ address: string; role: string }>(
    'SELECT address, role FROM watched_addresses ORDER BY created_at',
  )
  return new Map(result.rows.map((row) => [getAddress(row.address), row.role]))
}

/** Where a database with no cursor starts. See INITIAL_LOOKBACK_BLOCKS. */
function firstBlock(finalBlock: bigint): bigint {
  return finalBlock > INITIAL_LOOKBACK_BLOCKS ? finalBlock - INITIAL_LOOKBACK_BLOCKS : 0n
}

/**
 * The adaptive skip: before the first funding every tick scans, afterwards only stale ones
 * do — and a catch-up in progress overrides both, because idling through it is the slow way.
 */
async function shouldScan(client: PoolClient, lastScanAt: Date): Promise<boolean> {
  if (behindFinalBlock || Date.now() - lastScanAt.getTime() >= IDLE_INTERVAL_MS) {
    return true
  }
  const funded = await client.query("SELECT 1 FROM ledger_transactions WHERE kind = 'funding' LIMIT 1")
  return funded.rows.length === 0
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
