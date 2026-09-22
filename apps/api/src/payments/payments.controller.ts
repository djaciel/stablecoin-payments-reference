import { BadRequestException, Body, ConflictException, Controller, Get, Headers, HttpCode, HttpStatus, Inject, NotFoundException, Param, Post, Res } from '@nestjs/common'
import { inTransaction, type Pool, type PoolClient } from '@payments/db'
import { failedAfterReserving, type PaymentTimeline, type PaymentView, type Payments } from '@payments/domain'
import type { Client } from '@temporalio/client'
import { DATABASE_POOL } from '../db/db.module'
import { TEMPORAL_CLIENT } from '../temporal/temporal.module'
import { createPayment } from './create-payment'
import { dispatchPayment } from './dispatch'
import { findPayment, listPayments, paymentTimeline } from './read-payments'
import { resumePayment } from './resume-payment'

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

    const outcome = await this.inOneTransaction((client) => createPayment(client, request))
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

  /**
   * Back from REVIEW to where it was, with its money untouched (§9), then dispatched exactly as Pay
   * does: committed first, so the run that looks for the proof again reads the resumed state.
   */
  @Post(':reference/resume')
  @HttpCode(HttpStatus.OK)
  async resume(@Param('reference') reference: string): Promise<PaymentView> {
    const outcome = await this.inOneTransaction((client) => resumePayment(client, reference))
    if (outcome.kind === 'unknown') {
      notFound(reference)
    }
    if (outcome.kind === 'not-in-review') {
      throw new ConflictException(`${reference} is ${outcome.status}: only a payment in REVIEW can be resumed.`)
    }
    await dispatchPayment(this.temporal, reference)
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

  /** The transaction is opened and committed here; `createPayment` and `resumePayment` run inside it and never end it. */
  private async inOneTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      return await inTransaction(client, () => work(client))
    } finally {
      client.release()
    }
  }
}

/**
 * 422 only for a payment the door refused, new or replayed; otherwise 201 recorded, 200 replayed,
 * whatever its state now. Spec assumption 19, decided: the code answers the request's first outcome
 * and the body the payment's current state, so a replay of a payment that later reverted is 200 with
 * FAILED `reverted`, and a client that reads only codes never takes a refusal for an acceptance.
 */
function statusCodeOf(outcome: { readonly kind: 'recorded' | 'replayed'; readonly payment: PaymentView }): number {
  const { status, reason } = outcome.payment
  if (status === 'FAILED' && !failedAfterReserving(reason)) {
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
