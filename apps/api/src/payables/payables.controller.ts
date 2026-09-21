import { BadRequestException, Body, Controller, Get, Inject, Post } from '@nestjs/common'
import { explorerAddressUrl } from '@payments/chain'
import type { Payables } from '@payments/domain'
import { USDC_DECIMALS, formatMinor, toMinorFromDecimal, type MinorUnits } from '@payments/ledger'
import { MAX_INVOICE_USDC, MIN_INVOICE_USDC } from '../config'
import { PAYABLES_SERVICE, UNKNOWN_PARTNER, type PayablesService } from './payables.service'

const MIN_INVOICE_MINOR = toMinorFromDecimal(MIN_INVOICE_USDC)
const MAX_INVOICE_MINOR = toMinorFromDecimal(MAX_INVOICE_USDC)

/** The longest description the list shows without turning a card into a paragraph. */
const MAX_DESCRIPTION_LENGTH = 200

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

@Controller('payables')
export class PayablesController {
  constructor(@Inject(PAYABLES_SERVICE) private readonly payables: PayablesService) {}

  /** The whole Payables screen in one read: the invoices with their payments, the form's partners, the books. */
  @Get()
  async list(): Promise<Payables> {
    const overview = await this.payables.list()
    return {
      payables: overview.payables.map((invoice) => ({
        id: invoice.id,
        partnerName: invoice.partnerName,
        amount: formatMinor(invoice.amountMinor),
        description: invoice.description,
        status: invoice.status,
        destination: { address: invoice.destination, explorerUrl: explorerAddressUrl(invoice.destination) },
        payment: invoice.payment,
      })),
      partners: overview.partners,
      ledger: {
        available: formatMinor(overview.available),
        reserved: formatMinor(overview.reserved),
        partnerDebt: formatMinor(overview.partnerDebt),
      },
    }
  }

  /** Answers with the whole screen, so the new invoice and the higher debt show before the next poll. */
  @Post()
  async create(@Body() body: unknown): Promise<Payables> {
    // Validated by hand, one condition and one sentence per field: `ValidationPipe` would
    // check nothing here, because tsx emits no decorator metadata (spec assumption 18).
    await this.payables.create({
      partnerId: readPartnerId(body),
      amountMinor: readAmount(body),
      description: readDescription(body),
    })
    return this.list()
  }
}

function field(body: unknown, name: string): unknown {
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>)[name] : undefined
}

/** Only the shape here; whether that partner exists, and is active, is the service's question. */
function readPartnerId(body: unknown): string {
  const partnerId = field(body, 'partnerId')
  if (typeof partnerId !== 'string' || !UUID.test(partnerId)) {
    throw new BadRequestException(UNKNOWN_PARTNER)
  }
  return partnerId
}

/** A decimal string in whole USDC, like every amount on the wire. A JSON number is refused: it is a float. */
function readAmount(body: unknown): MinorUnits {
  const raw = field(body, 'amount')
  const amount = parseAmount(typeof raw === 'string' ? raw.trim() : '')
  if (amount < MIN_INVOICE_MINOR || amount > MAX_INVOICE_MINOR) {
    throw new BadRequestException(`amount must be between ${MIN_INVOICE_USDC} and ${MAX_INVOICE_USDC} USDC.`)
  }
  return amount
}

function parseAmount(value: string): MinorUnits {
  try {
    return toMinorFromDecimal(value)
  } catch {
    throw new BadRequestException(
      `amount must be a positive decimal string in USDC, with at most ${String(USDC_DECIMALS)} decimals, like "0.50".`,
    )
  }
}

function readDescription(body: unknown): string {
  const raw = field(body, 'description')
  const description = typeof raw === 'string' ? raw.trim() : ''
  if (description === '' || description.length > MAX_DESCRIPTION_LENGTH) {
    throw new BadRequestException(
      `description must say what the invoice is for, in 1 to ${String(MAX_DESCRIPTION_LENGTH)} characters.`,
    )
  }
  return description
}
