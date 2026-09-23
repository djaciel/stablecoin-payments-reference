import { rpcHost } from '@payments/chain'
import type { PaymentSummary, PaymentTimeline } from '@payments/domain'

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

/** A refusal comes back as the api's own sentence, which is what the person running this needs. */
async function call<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<T> {
  const response = await fetch(`${apiUrl()}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const answer: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = typeof answer === 'object' && answer !== null ? (answer as { message?: unknown }).message : undefined
    throw new Error(`${method} ${path} answered ${String(response.status)}: ${typeof message === 'string' ? message : 'no reason given'}`)
  }
  return answer as T
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

/** The command's title, and under it where it is pointed: the api, and the chain by host only. */
export function heading(name: string, title: string): void {
  console.log(`\n${name}  ${title}\n`)
  field('api', apiUrl())
  field('chain', rpcHost())
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
