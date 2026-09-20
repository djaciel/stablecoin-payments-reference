import { type Address, type Log, decodeEventLog, getAddress, parseAbi } from 'viem'
import type { ChainClient } from './clients'

/**
 * Circle's official testnet USDC on Base Sepolia. Any other contract can emit a Transfer event
 * with the same shape, so this address is half the settlement check.
 *
 * Its decimal count lives in `@payments/ledger`, next to the functions that format amounts.
 */
export const USDC_ADDRESS: Address = getAddress('0x036CbD53842c5426634e7929541eC2318f3dCF7e')

export const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address owner) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
])

export interface ExpectedTransfer {
  readonly from: Address
  readonly to: Address
  readonly amount: bigint
}

/**
 * Finds the Transfer event that proves a payment landed, and refuses anything
 * close-but-not-equal.
 *
 * A receipt with status "success" is NOT proof of payment: a transaction can succeed while
 * transferring nothing, or to somebody else, or emitting a Transfer from a lookalike contract.
 * Three checks, all equality: the official contract, the exact destination, the exact amount.
 *
 * Throws with what it saw instead when there is no match — the caller is expected to treat that
 * as "not paid", never as "probably fine".
 */
export function findSettlementLog(logs: readonly Log[], expected: ExpectedTransfer): Log {
  // Check 1, which is also why an unrelated log in the same receipt is not a problem.
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
 * How much USDC an address holds, in minor units. `blockNumber` pins the read to one block: the
 * public RPC is load balanced and its nodes lag each other, so two reads without it can come
 * from two different heights and quietly disagree.
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
