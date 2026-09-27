import { rpcHost } from '@payments/chain'
import type { Experiments, LedgerFigures, Payables, PaymentSummary, PaymentTimeline, Payments } from '@payments/domain'

/**
 * What every `pnpm experiment:*` command runs on: the api client it drives the demo with, and
 * the one shape it prints its evidence in.
 *
 * The scripts drive the same doors the Break it buttons press, so the evidence a reader pastes
 * into a review comes from the same code path the demo runs. Nothing here prints an RPC URL: a
 * provider endpoint carries its key in the path, so only the host is ever shown.
 */

/** Where the api is. The compose stack publishes it here; `API_URL` is for anything else. */
export function apiUrl(): string {
  return process.env['API_URL'] ?? 'http://localhost:3000'
}

export function get<T>(path: string): Promise<T> {
  return call<T>('GET', path)
}

export function post<T>(path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
  return call<T>('POST', path, body, headers)
}

export function put<T>(path: string, body: unknown): Promise<T> {
  return call<T>('PUT', path, body)
}

/** What a call answered when the code is part of the evidence: the double click's 201 and 200. */
export interface Answer<T> {
  readonly code: number
  readonly body: T
}

/**
 * A `POST` that hands the status code back with the body. A refusal at the door (422) is an answer
 * too, the way the browser's client reads it: the api recorded that payment as FAILED and its body
 * says why. Anything else still throws.
 */
export async function postAnswering<T>(path: string, body: unknown, headers: Record<string, string>): Promise<Answer<T>> {
  const answer = await ask<T>('POST', path, body, headers)
  if (answer.code >= 300 && answer.code !== 422) {
    throw refusal('POST', path, answer)
  }
  return answer
}

/** A refusal comes back as the api's own sentence, which is what the person running this needs. */
async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const answer = await ask<T>(method, path, body, headers)
  if (answer.code >= 300) {
    throw refusal(method, path, answer)
  }
  return answer.body
}

async function ask<T>(method: string, path: string, body: unknown, headers: Record<string, string>): Promise<Answer<T>> {
  const response = await fetch(`${apiUrl()}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const answer: unknown = await response.json().catch(() => undefined)
  return { code: response.status, body: answer as T }
}

function refusal(method: string, path: string, answer: Answer<unknown>): Error {
  const message = typeof answer.body === 'object' && answer.body !== null ? (answer.body as { message?: unknown }).message : undefined
  return new Error(`${method} ${path} answered ${String(answer.code)}: ${typeof message === 'string' ? message : 'no reason given'}`)
}

/** The three figures the books show above the invoices, from the screen's own read. */
export async function books(): Promise<LedgerFigures> {
  return (await get<Payables>('/payables')).ledger
}

/**
 * The invoice a run writes for itself, to the first partner on the screen: the same door the Break
 * it cards press, and the amount stays small because this is real testnet money.
 */
export async function writeOwnInvoice(amount: string, description: string): Promise<string> {
  const partner = (await get<Payables>('/payables')).partners[0]
  if (partner === undefined) {
    throw new Error('there is no partner to invoice. Add one on /admin/partners.')
  }
  const invoice = (await post<Payables>('/payables', { partnerId: partner.id, amount, description })).payables[0]
  if (invoice === undefined) {
    throw new Error('the api did not answer with the invoice it had just written')
  }
  step(`invoice for ${amount} USDC to ${partner.name}`)
  return invoice.id
}

/**
 * The double click's pre-flight: its evidence reads Available before and after, so another payment
 * moving at the same time would blur it. REVIEW and the ends are resting.
 */
export async function nothingElseInFlight(): Promise<void> {
  const moving = (await get<Payments>('/payments')).payments.find((payment) => !isResting(payment))
  if (moving !== undefined) {
    throw new Error(`${moving.reference} is still ${moving.status}: wait until nothing else is moving, then run this again`)
  }
}

/**
 * A command that arms a flag does not start while that flag is already armed: its disarm at the
 * end would switch off an arm somebody else made.
 */
export async function refuseIfArmed(flag: keyof Experiments): Promise<void> {
  if ((await get<Experiments>('/settings/experiments'))[flag].enabled) {
    throw new Error(`${flag} is already armed: disarm it first, then run this again`)
  }
}

/** How often the timeline is asked for, and how long before a script stops waiting for an end. */
const POLL_MS = 3000
const LIMIT_MS = 900_000

/**
 * Follows one payment until nothing else will happen to it on its own, printing each state as it
 * changes. Returns the whole story, which is where the evidence comes from.
 */
export async function waitUntilResting(reference: string): Promise<PaymentTimeline> {
  const until = Date.now() + LIMIT_MS
  let shown: string | undefined
  while (Date.now() < until) {
    const timeline = await get<PaymentTimeline>(`/payments/${encodeURIComponent(reference)}/timeline`)
    if (timeline.payment.status !== shown) {
      shown = timeline.payment.status
      step(`${reference} is ${shown}`)
    }
    if (isResting(timeline.payment)) {
      return timeline
    }
    await wait(POLL_MS)
  }
  throw new Error(`${reference} was still ${shown ?? 'in flight'} after ${String(LIMIT_MS / 60_000)} minutes`)
}

function isResting(payment: PaymentSummary): boolean {
  return payment.status === 'SETTLED' || payment.status === 'FAILED' || payment.status === 'REVIEW'
}

export function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

/**
 * The command's title, and under it where it is pointed: the api, and the chain by host only. The
 * race passes its own second line, because it is the one command that never reaches a chain.
 */
export function heading(name: string, title: string, chain: string = rpcHost()): void {
  console.log(`\n${name}  ${title}\n`)
  field('api', apiUrl())
  field('chain', chain)
  console.log('')
}

/** One aligned label/value pair. Everything a reader compares by eye lines up in one column. */
export function field(label: string, value: string | number): void {
  console.log(`  ${label.padEnd(22)} ${String(value)}`)
}

/** Something that just happened, as it happens: the running commentary above the evidence. */
export function step(line: string): void {
  console.log(`  · ${line}`)
}

export function section(title: string): void {
  console.log(`\n  ${title}`)
}

/** How a script ends when it cannot finish: one sentence, no stack. */
export function died(name: string, error: unknown): never {
  console.error(`\n${name}  ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
