import { BadRequestException, Body, Controller, Get, Inject, Post } from '@nestjs/common'
import { explorerAddressUrl } from '@payments/chain'
import type { Payables } from '@payments/domain'
import { formatMinor } from '@payments/ledger'
import { field, readAddress, readAmount, readDescription, readId, type AmountLimits } from '../body'
import { MAX_INVOICE_USDC, MIN_INVOICE_USDC } from '../config'
import { PAYABLES_SERVICE, UNKNOWN_PARTNER, type NewPayable, type PayablesService } from './payables.service'

/** The range an invoice falls in, with an amount somebody would actually type. */
const AMOUNT: AmountLimits = { minUsdc: MIN_INVOICE_USDC, maxUsdc: MAX_INVOICE_USDC, example: '0.50' }

const MALFORMED_DESTINATION = 'destination must be an EVM address: 0x and 40 hexadecimal characters.'

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
    // Checked by hand, one condition and one sentence per field (`src/body.ts` says why).
    await this.payables.create({
      owedTo: readWhoIsOwed(body),
      amountMinor: readAmount(body, AMOUNT),
      description: readDescription(body),
    })
    return this.list()
  }
}

/**
 * A partner, or an address somebody typed: exactly one, because an invoice's destination is
 * either copied from a partner's row or written by hand. Neither and both are the same mistake.
 */
function readWhoIsOwed(body: unknown): NewPayable['owedTo'] {
  const toPartner = field(body, 'partnerId') !== undefined
  if (toPartner === (field(body, 'destination') !== undefined)) {
    throw new BadRequestException(
      'send partnerId, for an invoice to a partner, or destination, for one to an address you type. Not both, and not neither.',
    )
  }
  return toPartner
    ? { partnerId: readId(body, 'partnerId', UNKNOWN_PARTNER) }
    : { destination: readAddress(body, 'destination', MALFORMED_DESTINATION) }
}
