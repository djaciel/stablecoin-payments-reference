import { log } from '@temporalio/activity'
import { createChainClient, finalBlockNumber, findTransfersTo, type ObservedTransfer } from '@payments/chain'
import { inTransaction, type PoolClient } from '@payments/db'
import { formatMinor, funding, fundingReference } from '@payments/ledger'
import { getAddress, type Address } from 'viem'
import { workerPool } from './db'

/**
 * The watcher tick: what the chain did while we were not looking, turned into ledger entries.
 *
 * It runs every 10 seconds, started by the `watcher` Temporal schedule (see schedules.ts).
 * One tick is:
 *
 *   1. read the cursor and the addresses to watch  (Postgres)
 *   2. decide whether to ask the chain at all      (adaptive skip)
 *   3. find the last block that cannot be reorganised away  (1 RPC request)
 *   4. ask for every USDC transfer to those addresses in one bounded range  (1 RPC request)
 *   5. post what arrived AND move the cursor, in ONE database transaction
 *
 * Step 5 is the one that matters. The cursor advances only when the entries it justifies
 * commit, so a worker killed at any moment re-scans the range instead of skipping it — and
 * re-scanning cannot double-post, because the ledger's `(kind, reference)` unique index says
 * one transaction per `tx:<hash>:<logIndex>`.
 *
 * What it does NOT do: outgoing payments (the payment workflow confirms its own), and
 * deposit addresses (Phase 6 — the table already holds them, this tick only posts treasury
 * funding).
 */

/** The one scan there is today. `watcher_state` is keyed by it so a second one is a row. */
const SCAN_NAME = 'usdc-transfers'

/** The books are USDC-only (spec assumption 2). Gas is never posted. */
const CURRENCY = 'USDC'

/**
 * The largest block range one tick will ask for.
 *
 * Measured against `https://sepolia.base.org` on 2026-09-17: it accepts ranges up to 10,000
 * blocks and refuses anything larger with `-32614 eth_getLogs is limited to a 10,000 range`.
 * 2,000 keeps a wide margin under that ceiling and is never reached in normal running — at
 * 2-second blocks a tick every 10 seconds is about five blocks behind. It only matters while
 * catching up, which is exactly when a cap is worth having.
 */
const MAX_RANGE_BLOCKS = 2_000n

/**
 * How far back the very first tick looks when there is no cursor yet.
 *
 * 10,000 blocks is ~5.5 hours of Base Sepolia, and it is the largest window the public RPC
 * serves at all. Generous on purpose: a treasury is usually funded from a faucet BEFORE the
 * stack that watches it exists, so a lookback that only covers the last few minutes would
 * make the demo's first lesson "your money is invisible".
 *
 * Money older than this window needs the cursor moved back by hand, once:
 *   UPDATE watcher_state SET last_block = <block before the transfer> WHERE name = 'usdc-transfers';
 * The next tick picks it up from there, and posts nothing twice on the way.
 */
const INITIAL_LOOKBACK_BLOCKS = 10_000n

/**
 * How long the watcher waits between scans once the treasury has money in the books.
 *
 * Spec assumption 6, reduced to what exists today: "something is in flight" currently means
 * "nothing has ever been funded", because there are no payments or deposits yet. Before the
 * first funding it scans on every tick, so the thing the reviewer is waiting for lands
 * within ten seconds; afterwards it idles at 30 s and the schedule's other ticks cost one
 * short query each instead of two RPC requests. Phases 5 and 6 widen "in flight" to payments
 * and deposits.
 */
const IDLE_INTERVAL_MS = 30_000

const chain = createChainClient()

/** One tick. Returns the same sentence it logs, so the Temporal UI shows it as the result. */
export async function watchChain(): Promise<string> {
  const client = await workerPool().connect()
  try {
    const watched = await readWatchedAddresses(client)
    if (watched.size === 0) {
      return report('no addresses are being watched yet — the api registers the treasury at startup')
    }

    const cursor = await readCursor(client)
    if (cursor !== undefined && !(await shouldScan(client, cursor.lastScanAt))) {
      return report(`idle: nothing in flight and the last scan was under ${IDLE_INTERVAL_MS / 1000}s ago`)
    }

    // Two RPC requests per tick, and no more: the final block, then the logs. Both are read
    // before any transaction is opened — a database transaction held open across a call to a
    // public endpoint would hold the ledger's locks for as long as the internet felt like it.
    const finalBlock = await finalBlockNumber(chain)
    const fromBlock = cursor === undefined ? firstBlock(finalBlock) : cursor.lastBlock + 1n
    // The range, in one line: from where we stopped, up to the last final block, but never
    // more than one request's worth. Whatever is left over is the next tick's.
    const rangeCeiling = fromBlock + MAX_RANGE_BLOCKS - 1n
    const toBlock = rangeCeiling < finalBlock ? rangeCeiling : finalBlock

    if (toBlock < fromBlock) {
      // The chain has produced nothing final since the last tick. Still record that we
      // looked, or the idle timer never moves.
      await inTransaction(client, () => touchCursor(client, fromBlock - 1n))
      return report(`nothing new: final block ${finalBlock} is already scanned`)
    }

    const transfers = await findTransfersTo(chain, { addresses: [...watched.keys()], fromBlock, toBlock })

    const posted = await inTransaction(client, async () => {
      const lines: string[] = []
      for (const transfer of transfers) {
        lines.push(await postTransfer(client, watched, transfer))
      }
      await touchCursor(client, toBlock)
      return lines
    })

    for (const line of posted) {
      log.info(`watcher: ${line}`)
    }
    return report(
      `scanned ${fromBlock}..${toBlock} (final ${finalBlock}), ${transfers.length} transfer(s) to watched addresses`,
    )
  } finally {
    client.release()
  }
}

/**
 * One observed transfer, decided by what the address is for.
 *
 * Runs inside the tick's transaction, so anything it writes commits with the cursor.
 */
async function postTransfer(
  client: PoolClient,
  watched: Map<Address, string>,
  transfer: ObservedTransfer,
): Promise<string> {
  const reference = fundingReference(transfer.txHash, transfer.logIndex)
  // Checksummed on both sides before they are compared: the same address written two
  // different ways is the classic way a watcher misses money.
  const role = watched.get(getAddress(transfer.to))

  if (role !== 'treasury') {
    // A deposit address. Phase 6 owns the DETECTED row and the credit at finality; until it
    // ships, a transfer here is noted and nothing else. Worth knowing: the cursor moves past
    // it, so the deposits that arrive before Phase 6 need the same one-line cursor rewind as
    // money older than the initial lookback.
    return `${reference}: ${formatMinor(transfer.amount)} ${CURRENCY} to a ${role ?? 'unknown'} address — deposits arrive in Phase 6, not posted`
  }

  if (await alreadyPosted(client, reference)) {
    // The normal outcome of re-scanning a range: a crash, a restart or a hand-rewound cursor
    // brought us past this transfer again. The unique index would refuse the INSERT anyway;
    // asking first is what lets the rest of this tick carry on in the same transaction.
    return `${reference}: already posted, nothing to do`
  }

  await funding(client, {
    txHash: transfer.txHash,
    logIndex: transfer.logIndex,
    blockNumber: transfer.blockNumber,
    amount: transfer.amount,
    currency: CURRENCY,
  })
  return `${reference}: posted funding of ${formatMinor(transfer.amount)} ${CURRENCY} at block ${transfer.blockNumber}`
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
 * The adaptive skip. Before the first funding, every tick scans; after it, only when the
 * last scan is older than the idle interval.
 */
async function shouldScan(client: PoolClient, lastScanAt: Date): Promise<boolean> {
  if (Date.now() - lastScanAt.getTime() >= IDLE_INTERVAL_MS) {
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
async function touchCursor(client: PoolClient, lastBlock: bigint): Promise<void> {
  await client.query(
    `INSERT INTO watcher_state (name, last_block) VALUES ($1, $2)
     ON CONFLICT (name) DO UPDATE SET last_block = EXCLUDED.last_block, last_scan_at = now()`,
    [SCAN_NAME, lastBlock.toString()],
  )
}

/** One line per tick, the one an operator reads at 2 a.m.: range, findings, or why not. */
function report(line: string): string {
  log.info(`watcher: ${line}`)
  return line
}
