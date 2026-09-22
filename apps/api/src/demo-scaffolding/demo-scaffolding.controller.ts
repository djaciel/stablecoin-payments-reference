import { Body, ConflictException, Controller, HttpCode, HttpStatus, Inject, Post } from '@nestjs/common'
import { TransitionRejected } from '@payments/db'
import type { PartnerPaymentReceipt } from '@payments/domain'
import { readId } from '../body'
import { PARTNER_PAYMENTS_SERVICE, type PartnerPaymentsService } from './partner-payments.service'

/** Missing, malformed or nobody's: the same mistake, so the same sentence (`src/body.ts`). */
const UNKNOWN_RECEIVABLE = 'receivableId must be the id of an invoice, as GET /receivables lists them.'

/**
 * The endpoints that exist only because one machine plays both sides of the demo. Everything
 * under `/demo` is scaffolding, and every screen that uses it says so.
 */
@Controller('demo')
export class DemoScaffoldingController {
  constructor(@Inject(PARTNER_PAYMENTS_SERVICE) private readonly payments: PartnerPaymentsService) {}

  /**
   * The partner pays one of its invoices, while this request is open: the answer IS the receipt,
   * which is what lets the modal on `/partner` show the hash and the block without polling.
   *
   * 409 while another payment is in flight (one wallet, one nonce) or when the invoice changed
   * underneath, 422 when the wallet is short or the chain disagrees with what was asked for.
   * None of them is a surprise; they are all answers.
   */
  @Post('partner-payments')
  @HttpCode(HttpStatus.OK)
  async pay(@Body() body: unknown): Promise<PartnerPaymentReceipt> {
    try {
      return await this.payments.pay(readId(body, 'receivableId', UNKNOWN_RECEIVABLE))
    } catch (error) {
      // The guard did its job: somebody else moved this invoice between the read and the
      // update. That is a conflict to retry, not a server fault.
      if (error instanceof TransitionRejected) {
        throw new ConflictException(
          `the invoice changed while this payment was being made (${error.message}), so nothing was sent. Read it again on /partner and try once more.`,
        )
      }
      throw error
    }
  }
}
