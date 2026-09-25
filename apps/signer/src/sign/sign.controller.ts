import { BadRequestException, Body, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common'
import { CHAIN, ERC20_ABI, USDC_ADDRESS } from '@payments/chain'
import { encodeFunctionData, getAddress, isAddress, keccak256, type Address, type Hex } from 'viem'
import { KEYS_SERVICE } from '../keys/keys.module'
import type { KeysService } from '../keys/keys.service'

/**
 * Signing, and nothing else. The treasury's key is in this process and the network is not:
 * every number a transaction needs — the nonce, the gas, the fees — is given to the signer by
 * the caller, because a service that can be asked to sign must not also be able to look up
 * what to sign.
 *
 * The answer is the raw bytes plus their hash, and the hash is the point: it is computed from
 * the signature, so the transaction has its name before any node has heard of it. Whoever
 * broadcasts stores that hash first, and a retry re-sends these exact bytes instead of signing
 * a second transaction that could also land.
 */

/** What every endpoint here answers. Never a key, never the phrase behind it. */
interface SignedTransaction {
  readonly hash: Hex
  readonly signedTransaction: Hex
}

/** The fields shared by both endpoints; `amount` is USDC minor units or wei by endpoint. */
interface SigningRequest {
  readonly to: Address
  readonly amount: bigint
  readonly nonce: number
  readonly gas: bigint
  readonly maxFeePerGas: bigint
  readonly maxPriorityFeePerGas: bigint
}

/** The part of the transaction each endpoint decides: where it goes and what it carries. */
interface Call {
  readonly to: Address
  readonly value: bigint
  readonly data?: Hex
}

@Controller('sign')
export class SignController {
  constructor(@Inject(KEYS_SERVICE) private readonly keys: KeysService) {}

  /** A USDC transfer from the treasury. */
  // 200 rather than Nest's default 201: signing creates nothing on this server, and nothing
  // on the chain either — the bytes it returns are inert until somebody broadcasts them.
  @Post('transfer')
  @HttpCode(HttpStatus.OK)
  transfer(@Body() body: unknown): Promise<SignedTransaction> {
    const request = readSigningRequest(body, 'amountMinor')

    // The contract is this file's, not the caller's: a request that could name the token
    // could have the treasury sign a transfer of something else entirely.
    return this.sign(request, {
      to: USDC_ADDRESS,
      value: 0n,
      data: encodeFunctionData({ abi: ERC20_ABI, functionName: 'transfer', args: [request.to, request.amount] }),
    })
  }

  /** Base Sepolia ETH from the treasury: gas for an address that has to sign something later. */
  @Post('native-transfer')
  @HttpCode(HttpStatus.OK)
  nativeTransfer(@Body() body: unknown): Promise<SignedTransaction> {
    const request = readSigningRequest(body, 'valueWei')
    return this.sign(request, { to: request.to, value: request.amount })
  }

  private async sign(request: SigningRequest, call: Call): Promise<SignedTransaction> {
    // The account never leaves this method and is never logged: it can sign, so it is
    // spending power over the treasury even though it does not carry the seed phrase.
    const account = this.keys.treasury()

    const signedTransaction = await account.signTransaction({
      ...call,
      type: 'eip1559',
      chainId: CHAIN.id,
      nonce: request.nonce,
      gas: request.gas,
      maxFeePerGas: request.maxFeePerGas,
      maxPriorityFeePerGas: request.maxPriorityFeePerGas,
    })

    return { hash: keccak256(signedTransaction), signedTransaction }
  }
}

/**
 * One condition, one 400 (the repo's rule, set by `addresses.controller.ts`). Missing,
 * mistyped or negative are the same mistake: the caller did not send a signable transaction.
 *
 * Validated by hand because Nest's `ValidationPipe` reads the DTO class from decorator
 * metadata that tsx does not emit, so a `@Body() dto: Dto` here would be accepted without a
 * single check running.
 */
function readSigningRequest(body: unknown, amountField: 'amountMinor' | 'valueWei'): SigningRequest {
  const fields: Record<string, unknown> = typeof body === 'object' && body !== null ? { ...body } : {}

  const to = fields['to']
  const nonce = fields['nonce']
  const amount = wholeNumber(fields[amountField])
  const gas = wholeNumber(fields['gas'])
  const maxFeePerGas = wholeNumber(fields['maxFeePerGas'])
  const maxPriorityFeePerGas = wholeNumber(fields['maxPriorityFeePerGas'])

  const usable =
    typeof to === 'string' &&
    isAddress(to, { strict: false }) &&
    typeof nonce === 'number' &&
    Number.isInteger(nonce) &&
    nonce >= 0 &&
    amount !== undefined &&
    amount > 0n &&
    gas !== undefined &&
    gas > 0n &&
    maxFeePerGas !== undefined &&
    maxPriorityFeePerGas !== undefined

  if (!usable) {
    throw new BadRequestException(
      `a signing request is { to: "0x…", ${amountField}: "<whole number>", nonce, gas, maxFeePerGas, maxPriorityFeePerGas }: an address, a nonce of 0 or more, and positive amounts as decimal strings (JSON has no bigint, and money in a float is money rounded). The signer reads no chain, so it cannot fill any of them in for you.`,
    )
  }

  return {
    to: getAddress(to),
    amount,
    nonce,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
  }
}

/** `undefined` for anything that is not a non-negative whole number written as a string. */
function wholeNumber(value: unknown): bigint | undefined {
  return typeof value === 'string' && /^[0-9]+$/.test(value) ? BigInt(value) : undefined
}
