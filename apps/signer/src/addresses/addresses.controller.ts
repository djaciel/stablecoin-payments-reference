import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common'
import { TREASURY_ADDRESS_INDEX } from '@payments/chain'
import type { Address } from 'viem'
import { KEYS_SERVICE } from '../keys/keys.module'
import type { KeysService } from '../keys/keys.service'

interface AddressResponse {
  readonly index: number
  readonly address: Address
}

/**
 * The addresses the company seed produces. Nothing here returns key material, and the
 * mnemonic is not reachable from this file: it asks `KeysService` for an account and
 * reads its address.
 */
@Controller('addresses')
export class AddressesController {
  constructor(@Inject(KEYS_SERVICE) private readonly keys: KeysService) {}

  /** Where the company's money lives. The one address a human has to fund by hand. */
  @Get('treasury')
  treasury(): AddressResponse {
    return { index: TREASURY_ADDRESS_INDEX, address: this.keys.treasury().address }
  }

  /**
   * The deposit address of the partner at `index` — where that partner pays what it owes.
   *
   * The body is validated by hand. Nest's `ValidationPipe` reads the DTO class from
   * decorator metadata that tsx does not emit, so a `@Body() dto: Dto` here would be
   * accepted without a single check running (spec assumption 18).
   */
  // POST because the index travels in a body, not because anything is created: the
  // address existed the moment the seed did. 200, therefore, not Nest's default 201.
  @Post('deposit')
  @HttpCode(HttpStatus.OK)
  deposit(@Body() body: unknown): AddressResponse {
    const index = readDepositIndex(body)
    return { index, address: this.keys.depositAccount(index).address }
  }
}

/**
 * One condition: a whole number of 1 or more. Missing, fractional, negative, string —
 * they are all the same mistake, and listing them separately would buy a longer file and
 * no extra safety. The treasury index gets its own sentence because asking for it is a
 * reasonable thing to try and the answer is a rule, not a typo.
 */
function readDepositIndex(body: unknown): number {
  const index: unknown = typeof body === 'object' && body !== null && 'index' in body ? body.index : undefined

  if (index === TREASURY_ADDRESS_INDEX) {
    throw new BadRequestException(
      `index ${TREASURY_ADDRESS_INDEX} is the treasury address and is never handed out as a deposit address: money sent there would be the company paying itself. Deposit indexes start at 1. The treasury address is at GET /addresses/treasury.`,
    )
  }

  if (typeof index !== 'number' || !Number.isInteger(index) || index < 1) {
    throw new BadRequestException('index must be a whole number of 1 or more.')
  }

  return index
}
