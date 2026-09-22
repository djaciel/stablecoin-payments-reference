import { BadRequestException, Body, ConflictException, Controller, Get, Headers, Inject, NotFoundException, Param, Post, Res } from '@nestjs/common'
import { inTransaction, type Pool } from '@payments/db'
import type { PaymentTimeline, PaymentView, Payments } from '@payments/domain'
import type { Client } from '@temporalio/client'
import { DATABASE_POOL } from '../db/db.module'
import { TEMPORAL_CLIENT } from '../temporal/temporal.module'
import { createPayment, type PaymentOutcome, type PaymentRequest } from './create-payment'
import { dispatchPayment } from './dispatch'
import { findPayment, listPayments, paymentTimeline } from './read-payments'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_KEY_LENGTH = 200
const UNKNOWN_PAYABLE = 'payableId must be the id of an invoice, as GET /payables lists them.'

/** The one thing this controller needs from Express's response: a status code that depends on the outcome. */
interface StatusCodeSetter {
  status(code: number): unknown
}

@Controller('payments')
export class PaymentsController {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(TEMPORAL_CLIENT) private readonly temporal: Client,
  ) {}

  @Post()
  async create(
    @Headers('idempotency-key') header: unknown,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: StatusCodeSetter,
  ): Promise<PaymentView> {
    // Validated by hand, one condition and one 400 each: tsx emits no decorator metadata, so
    // `ValidationPipe` would check nothing here (spec assumption 18).
    const request = { idempotencyKey: readIdempotencyKey(header), payableId: readPayableId(body) }

    const outcome = await this.inOneTransaction(request)
    if (outcome.kind === 'key-conflict') {
      throw new ConflictException(
        `idempotency-key "${request.idempotencyKey}" was already used for a different request: one key cannot be two payments.`,
      )
    }
    if (outcome.kind === 'unknown-payable') {
      throw new BadRequestException(UNKNOWN_PAYABLE)
    }

    // Committed first, dispatched after: the money is reserved before any workflow exists. A replay
    // of a payment still RESERVED dispatches again, since its first start may have failed.
    if (outcome.payment.status === 'RESERVED') {
      await dispatchPayment(this.temporal, outcome.payment.reference)
    }

    response.status(statusCodeOf(outcome))
    return outcome.payment
  }

  /** The Transfers list. */
  @Get()
  async list(): Promise<Payments> {
    return { payments: await listPayments(this.pool) }
  }

  @Get(':reference')
  async find(@Param('reference') reference: string): Promise<PaymentView> {
    return (await findPayment(this.pool, reference)) ?? notFound(reference)
  }

  /** One payment's story, read from the audit log: the step-by-step view polls this. */
  @Get(':reference/timeline')
  async timeline(@Param('reference') reference: string): Promise<PaymentTimeline> {
    return (await paymentTimeline(this.pool, reference)) ?? notFound(reference)
  }

  /** The transaction is opened and committed here; `createPayment` runs inside it and never ends it. */
  private async inOneTransaction(request: PaymentRequest): Promise<PaymentOutcome> {
    const client = await this.pool.connect()
    try {
      return await inTransaction(client, () => createPayment(client, request))
    } finally {
      client.release()
    }
  }
}

/**
 * 201 for a new reservation, 200 for a replay of one, 422 for a refusal whether new or replayed: a
 * replay answers with the code its first attempt had (spec assumption 19), so a client that reads
 * only status codes can never take a rejected payment for an accepted one.
 */
function statusCodeOf(outcome: { readonly kind: 'recorded' | 'replayed'; readonly payment: PaymentView }): number {
  if (outcome.payment.status === 'FAILED') {
    return 422
  }
  return outcome.kind === 'recorded' ? 201 : 200
}

function notFound(reference: string): never {
  throw new NotFoundException(`no payment has the reference ${reference}.`)
}

function readIdempotencyKey(header: unknown): string {
  if (typeof header !== 'string' || header.trim() === '' || header.length > MAX_KEY_LENGTH) {
    throw new BadRequestException(
      `the idempotency-key header is required, 1 to ${String(MAX_KEY_LENGTH)} characters: one key per payment, reused only to retry it.`,
    )
  }
  return header
}

function readPayableId(body: unknown): string {
  const payableId: unknown = typeof body === 'object' && body !== null && 'payableId' in body ? body.payableId : undefined
  if (typeof payableId !== 'string' || !UUID.test(payableId)) {
    throw new BadRequestException(UNKNOWN_PAYABLE)
  }
  return payableId
}
