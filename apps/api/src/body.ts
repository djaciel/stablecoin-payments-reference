/**
 * The checks the api's write routes run on a request body, in one place.
 *
 * They are hand-written functions and not DTO decorators because `ValidationPipe` reads metadata
 * that tsx does not emit, and would silently check nothing (spec assumption 18). Each refusal is
 * one condition and one 400, and every caller passes its own sentence: what a person typed is
 * refused in the words of the screen they typed it on.
 */

import { BadRequestException } from '@nestjs/common'
import { USDC_DECIMALS, toMinorFromDecimal, type MinorUnits } from '@payments/ledger'
import { getAddress, type Address } from 'viem'

/** The longest description a list shows without turning a row into a paragraph. */
export const MAX_DESCRIPTION_LENGTH = 200

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What an amount must fall between, and one value the message can show. */
export interface AmountLimits {
  readonly minUsdc: string
  readonly maxUsdc: string
  readonly example: string
}

export function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined
}

/**
 * Only the shape: whether that id names anything is the service's question, so missing,
 * malformed and nobody's all get the caller's one sentence.
 */
export function readId(body: unknown, name: string, refusal: string): string {
  const value = field(body, name)
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new BadRequestException(refusal)
  }
  return value
}

/**
 * An address, checksummed on the way in by viem: stored one way everywhere, so the allowlist and
 * an invoice's destination are comparable as plain text (`0005_partners.sql` says why).
 */
export function readAddress(body: unknown, name: string, refusal: string): Address {
  const value = field(body, name)
  try {
    return getAddress(typeof value === 'string' ? value.trim() : '')
  } catch {
    throw new BadRequestException(refusal)
  }
}

/** A decimal string in whole USDC, like every amount on the wire. A JSON number is refused: it is a float. */
export function readAmount(body: unknown, limits: AmountLimits): MinorUnits {
  const raw = field(body, 'amount')
  const amount = parseAmount(typeof raw === 'string' ? raw.trim() : '', limits.example)
  if (amount < toMinorFromDecimal(limits.minUsdc) || amount > toMinorFromDecimal(limits.maxUsdc)) {
    throw new BadRequestException(`amount must be between ${limits.minUsdc} and ${limits.maxUsdc} USDC.`)
  }
  return amount
}

function parseAmount(value: string, example: string): MinorUnits {
  try {
    return toMinorFromDecimal(value)
  } catch {
    throw new BadRequestException(
      `amount must be a positive decimal string in USDC, with at most ${String(USDC_DECIMALS)} decimals, like "${example}".`,
    )
  }
}

export function readDescription(body: unknown): string {
  const raw = field(body, 'description')
  const description = typeof raw === 'string' ? raw.trim() : ''
  if (description === '' || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new BadRequestException(
      `description must say what the invoice is for, in 1 to ${String(MAX_DESCRIPTION_LENGTH)} characters.`,
    )
  }
  return description
}
