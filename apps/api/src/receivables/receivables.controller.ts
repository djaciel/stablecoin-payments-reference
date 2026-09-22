import { Body, Controller, Get, Inject, Post } from '@nestjs/common'
import type { Receivables } from '@payments/domain'
import { formatMinor } from '@payments/ledger'
import { readAmount, readDescription, readId, type AmountLimits } from '../body'
import { MAX_INVOICE_USDC, MIN_INVOICE_USDC } from '../config'
import { RECEIVABLES_SERVICE, UNKNOWN_PARTNER, receivableView, type ReceivablesService } from './receivables.service'

/** The same range as a payable, with the smaller amount this side of the demo uses. */
const AMOUNT: AmountLimits = { minUsdc: MIN_INVOICE_USDC, maxUsdc: MAX_INVOICE_USDC, example: '0.05' }

@Controller('receivables')
export class ReceivablesController {
  constructor(@Inject(RECEIVABLES_SERVICE) private readonly receivables: ReceivablesService) {}

  /** The whole Receivables screen in one read: the invoices, the form's partners, the two figures. */
  @Get()
  async list(): Promise<Receivables> {
    const overview = await this.receivables.list()
    return {
      receivables: overview.receivables.map(receivableView),
      partners: overview.partners,
      ledger: {
        receivable: formatMinor(overview.partnerReceivable),
        deposits: formatMinor(overview.deposits),
      },
    }
  }

  /** Answers with the whole screen, so the new invoice and the higher figure show before the next poll. */
  @Post()
  async create(@Body() body: unknown): Promise<Receivables> {
    // Checked by hand, one condition and one sentence per field (`src/body.ts` says why).
    await this.receivables.create({
      partnerId: readId(body, 'partnerId', UNKNOWN_PARTNER),
      amountMinor: readAmount(body, AMOUNT),
      description: readDescription(body),
    })
    return this.list()
  }
}
