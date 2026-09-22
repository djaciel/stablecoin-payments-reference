import { Body, Controller, Get, Inject, Post } from '@nestjs/common'
import { explorerAddressUrl } from '@payments/chain'
import type { Payables } from '@payments/domain'
import { formatMinor } from '@payments/ledger'
import { readAmount, readDescription, readId, type AmountLimits } from '../body'
import { MAX_INVOICE_USDC, MIN_INVOICE_USDC } from '../config'
import { PAYABLES_SERVICE, UNKNOWN_PARTNER, type PayablesService } from './payables.service'

/** The range an invoice falls in, with an amount somebody would actually type. */
const AMOUNT: AmountLimits = { minUsdc: MIN_INVOICE_USDC, maxUsdc: MAX_INVOICE_USDC, example: '0.50' }

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
      partnerId: readId(body, 'partnerId', UNKNOWN_PARTNER),
      amountMinor: readAmount(body, AMOUNT),
      description: readDescription(body),
    })
    return this.list()
  }
}
