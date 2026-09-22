import { type Log, getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { type LandedTransaction, USDC_ADDRESS, findSettlementLog, paidVerdict } from './usdc'

/**
 * The log below is real: it was emitted by the official USDC contract on Base Sepolia in
 * transaction 0xe0b0c35048c114598545cdbe302dadf666c609364a2b486134a72a98b8bb2e99, a
 * transfer of 0.1 USDC (100000 units, 6 decimals). Copied verbatim from the receipt so
 * these tests exercise the shape the network actually produces.
 *
 * One test per thing the settlement rule claims to do. After the first `findSettlementLog`
 * test, each one is a transaction that SUCCEEDED on chain, and none of them is a payment.
 * `paidVerdict` adds the other half, finality: the right event alone is not paid yet.
 */
const PROBE_ADDRESS = getAddress('0x1Ac9Fe52f99fcb60C80EfB97f022a8BcA8a30423')
const AMOUNT = 100_000n
/** The block that transaction landed in. */
const BLOCK = 45154876n

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

function transferLog(overrides: { address?: string; from?: string; to?: string; value?: bigint } = {}): Log {
  const from = overrides.from ?? PROBE_ADDRESS
  const to = overrides.to ?? PROBE_ADDRESS
  const value = overrides.value ?? AMOUNT
  return {
    address: overrides.address ?? USDC_ADDRESS,
    topics: [TRANSFER_TOPIC, asTopic(from), asTopic(to)],
    data: `0x${value.toString(16).padStart(64, '0')}`,
    blockNumber: BLOCK,
    blockHash: '0x00',
    logIndex: 89,
    transactionHash: '0x00',
    transactionIndex: 0,
    removed: false,
  } as Log
}

function asTopic(address: string): `0x${string}` {
  return `0x${address.toLowerCase().replace('0x', '').padStart(64, '0')}`
}

const EXPECTED = { from: PROBE_ADDRESS, to: PROBE_ADDRESS, amount: AMOUNT }

describe('findSettlementLog', () => {
  it('accepts the Transfer the payment was waiting for, among the other logs of the receipt', () => {
    // A receipt carries every log of the transaction, not just the one being looked for.
    const unrelated = { ...transferLog({ address: '0x1111111111111111111111111111111111111111' }), logIndex: 1 } as Log

    const found = findSettlementLog([unrelated, transferLog()], EXPECTED)

    expect(found.logIndex).toBe(89)
  })

  it('rejects the same transfer emitted by a lookalike contract', () => {
    const impostor = [transferLog({ address: '0x2222222222222222222222222222222222222222' })]

    expect(() => findSettlementLog(impostor, EXPECTED)).toThrow(/official USDC contract/)
  })

  it('rejects a transfer to a different destination', () => {
    const elsewhere = [transferLog({ to: '0x3333333333333333333333333333333333333333' })]

    // The message carries what it saw instead, because a mismatch nobody can read is a
    // mismatch nobody can fix.
    expect(() => findSettlementLog(elsewhere, EXPECTED)).toThrow(/emitted no Transfer.*Seen instead:.*0x3333/s)
  })

  it('rejects an amount that is short by one unit', () => {
    const short = [transferLog({ value: AMOUNT - 1n })]

    expect(() => findSettlementLog(short, EXPECTED)).toThrow(/emitted no Transfer.*Seen instead:.*: 99999$/s)
  })
})

describe('paidVerdict', () => {
  // The same real log inside its receipt: the right event, from the right contract, for the right amount.
  const receipt = { status: 'success', blockNumber: BLOCK, logs: [transferLog()] } as LandedTransaction

  it('does not call it paid while its block is above the final block, even with the right event', () => {
    expect(paidVerdict(receipt, BLOCK - 1n, EXPECTED)).toEqual({ outcome: 'not-final', blockNumber: BLOCK, finalBlock: BLOCK - 1n })
  })

  it('calls it paid once its block is at the final block and the right event is in its logs', () => {
    const verdict = paidVerdict(receipt, BLOCK, EXPECTED)

    expect(verdict.outcome).toBe('paid')
    expect(verdict.outcome === 'paid' ? verdict.log.logIndex : undefined).toBe(89)
  })
})
