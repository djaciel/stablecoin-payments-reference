import { type Address, type Hex, type Log, decodeEventLog, getAbiItem, getAddress, parseAbi } from 'viem'
import type { ChainClient } from './clients'

/**
 * Circle's official testnet USDC on Base Sepolia. Any other contract can emit a Transfer with
 * the same shape, so this address is half the settlement check.
 */
export const USDC_ADDRESS: Address = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e')

export const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

/** The event every inbound query filters on, pulled out of the ABI so it is written once. */
const TRANSFER_EVENT = getAbiItem({ abi: ERC20_ABI, name: 'Transfer' })

export interface ExpectedTransfer {
  readonly from: Address
  readonly to: Address
  readonly amount: bigint
}

/** A USDC Transfer as the chain recorded it: who, how much, and where to find it again. */
export interface ObservedTransfer {
  readonly from: Address
  readonly to: Address
  readonly amount: bigint
  readonly blockNumber: bigint
  readonly txHash: Hex
  /** Position inside the transaction. With the hash it is the event's unique name. */
  readonly logIndex: number
}

export interface TransferQuery {
  /** Every address being watched. One request covers all of them, not one request each. */
  readonly addresses: readonly Address[]
  readonly fromBlock: bigint
  readonly toBlock: bigint
}

/**
 * Every USDC transfer that arrived at one of these addresses in this block range.
 *
 * ONE `eth_getLogs` whatever the number of addresses: the `to` topic takes a list and the
 * node does the filtering, which is the difference between one request per tick and one per
 * partner. `address` pins the query to the official contract — the first of the article's
 * three settlement checks.
 *
 * The caller must bound the range: `https://sepolia.base.org` refuses more than 10,000 blocks
 * in one request (`-32614 eth_getLogs is limited to a 10,000 range`).
 */
export async function findTransfersTo(client: ChainClient, query: TransferQuery): Promise<ObservedTransfer[]> {
  const logs = await client.getLogs({
    address: USDC_ADDRESS,
    event: TRANSFER_EVENT,
    args: { to: [...query.addresses] },
    fromBlock: query.fromBlock,
    toBlock: query.toBlock,
    // Drops anything whose arguments did not decode, so `args` below is complete.
    strict: true,
  })

  return logs.map((log) => ({
    from: log.args.from,
    to: log.args.to,
    amount: log.args.value,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    logIndex: log.logIndex,
  }))
}

/**
 * Finds the Transfer event that proves a payment landed. A receipt with status "success" is
 * NOT proof: a transaction can succeed while transferring nothing, or to somebody else, or
 * emitting a Transfer from a lookalike contract. Three checks, all equality — official
 * contract, exact destination, exact amount — and it throws with what it saw instead, which
 * the caller must treat as "not paid" rather than "probably fine".
 */
export function findSettlementLog(logs: readonly Log[], expected: ExpectedTransfer): Log {
  // Check 1, which is also why an unrelated log in the same receipt is harmless.
  const fromOfficialContract = logs.filter((log) => getAddress(log.address) === USDC_ADDRESS)

  if (fromOfficialContract.length === 0) {
    throw new Error(
      `no log came from the official USDC contract (${USDC_ADDRESS}). The transaction did something, but not this transfer.`,
    )
  }

  const transfers = fromOfficialContract.flatMap((log) => {
    const decoded = decodeTransfer(log)
    return decoded === undefined ? [] : [{ log, ...decoded }]
  })

  // Checks 2 and 3: no tolerance, no "at least", no address compare beyond the checksum.
  const match = transfers.find(
    (transfer) =>
      transfer.from === getAddress(expected.from) &&
      transfer.to === getAddress(expected.to) &&
      transfer.value === expected.amount,
  )

  if (match === undefined) {
    const seen = transfers.map((t) => `${t.from} → ${t.to}: ${t.value}`).join('; ')
    throw new Error(
      `the official contract emitted no Transfer of ${expected.amount} from ${expected.from} to ${expected.to}. Seen instead: ${seen === '' ? 'no Transfer events at all' : seen}`,
    )
  }

  return match.log
}

/** Logs from other events share the same shape and simply fail to decode; those are not errors. */
function decodeTransfer(log: Log): { from: Address; to: Address; value: bigint } | undefined {
  try {
    const decoded = decodeEventLog({ abi: ERC20_ABI, data: log.data, topics: log.topics })
    if (decoded.eventName !== 'Transfer') {
      return undefined
    }
    return { from: decoded.args.from, to: decoded.args.to, value: decoded.args.value }
  } catch {
    return undefined
  }
}

/**
 * `blockNumber` pins the read to one block: the public RPC is load balanced and its nodes lag
 * each other, so two reads without it can come from two heights and quietly disagree.
 */
export function readUsdcBalance(client: ChainClient, address: Address, blockNumber?: bigint): Promise<bigint> {
  return client.readContract({
    address: USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address],
    ...(blockNumber === undefined ? {} : { blockNumber }),
  })
}
