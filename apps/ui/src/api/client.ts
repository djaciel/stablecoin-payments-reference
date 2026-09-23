/**
 * The browser's view of the api: one typed function per endpoint it reads.
 *
 * The shapes come from `@payments/domain`, where the api writes them too, so the two sides
 * cannot drift. What is here is how the browser asks: the base path and the two rules for
 * reading an answer.
 *
 * There is no host and no port here on purpose: `/api` is served by the Vite dev server,
 * which forwards it to the api container (see vite.config.ts). The browser never learns that
 * the api is a different process, so the demo runs with no CORS setup and no environment
 * variable.
 */

import type { Allowlist, Deposits, Experiments, Health, PartnerPaymentReceipt, Partners, PartnerView, PartnerWalletFunding, Payables, PaymentTimeline, PaymentView, Payments, RaceResult, Receivables, Treasury } from '@payments/domain'

const API_BASE_PATH = '/api'

export function getHealth(): Promise<Health> {
  return read<Health>('/health')
}

export function getTreasury(): Promise<Treasury> {
  return read<Treasury>('/treasury')
}

export function getPartners(): Promise<Partners> {
  return read<Partners>('/partners')
}

/** Answers with the whole list, so the screen shows the new partner without waiting a poll. */
export function createPartner(name: string): Promise<Partners> {
  return send<Partners>('/partners', { name })
}

export function getPayables(): Promise<Payables> {
  return read<Payables>('/payables')
}

/**
 * Writes one invoice: for a partner, or to an address somebody typed. Answers with the whole
 * screen, so the new invoice and the higher Partner debt show at once.
 */
export function createPayable(
  invoice: { amount: string; description: string } & ({ partnerId: string } | { destination: string }),
): Promise<Payables> {
  return send<Payables>('/payables', invoice)
}

/** Every address the payment door will accept, the partners' first. */
export function getAllowlist(): Promise<Allowlist> {
  return read<Allowlist>('/allowlist')
}

/** Answers with the whole list, so the panel shows the address without a second read. A 409 throws with its sentence. */
export function addToAllowlist(address: { address: string; label: string }): Promise<Allowlist> {
  return send<Allowlist>('/allowlist', address)
}

export function getReceivables(): Promise<Receivables> {
  return read<Receivables>('/receivables')
}

/** Answers with the whole screen, so the new invoice and the higher Partner receivables show at once. */
export function createReceivable(invoice: { partnerId: string; amount: string; description: string }): Promise<Receivables> {
  return send<Receivables>('/receivables', invoice)
}

/** The whole partner screen in one read: the selector, what that partner owes, and its two addresses. */
export function getPartnerView(partnerId: string | null): Promise<PartnerView> {
  return read<PartnerView>(partnerId === null ? '/partners/view' : `/partners/view?partnerId=${encodeURIComponent(partnerId)}`)
}

/**
 * The partner pays one of its invoices from the shared wallet. It takes as long as one
 * transaction takes to land (a few seconds on Base Sepolia) because the answer is the evidence:
 * the hash, the block and what the wallet holds after. A 409 (another payment in flight) and a
 * 422 (refused, and the invoice open again) both throw with the api's own sentence.
 */
export function payReceivable(receivableId: string): Promise<PartnerPaymentReceipt> {
  return send<PartnerPaymentReceipt>('/demo/partner-payments', { receivableId })
}

/**
 * `POST /payments` for one invoice, with the key the screen made for this attempt and, when it is
 * not to run now, the ISO time it runs at. A 422 resolves instead of throwing: it is a payment the
 * api recorded as FAILED, and its body carries the reason the screen puts in a sentence. A 400, a
 * 409 or an api that is not there throw, with the api's own sentence when it sent one.
 */
export async function payPayable(payableId: string, idempotencyKey: string, executeAt?: string): Promise<PaymentView> {
  return (await postPayment(payableId, idempotencyKey, executeAt)).payment
}

/** One answer to `POST /payments`, code and all: which call recorded the payment is in the code. */
export interface PaymentAnswer {
  readonly code: number
  readonly payment: PaymentView
}

/**
 * §9's double click: the same invoice paid twice at the same instant, with ONE key. The two
 * requests are in flight before either answers (nothing is awaited between them), which is the
 * only thing that makes this a double click and not two payments in a row. Both answers come
 * back with their status code, because the codes are the evidence: one recorded the payment
 * (201), the other found it already there and answered with it (200).
 */
export function doubleClick(payableId: string, idempotencyKey: string): Promise<[PaymentAnswer, PaymentAnswer]> {
  return Promise.all([postPayment(payableId, idempotencyKey), postPayment(payableId, idempotencyKey)])
}

async function postPayment(payableId: string, idempotencyKey: string, executeAt?: string): Promise<PaymentAnswer> {
  // The field is left out for a payment that runs now, which is what its absence means to the api.
  const body = { payableId, ...(executeAt === undefined ? {} : { executeAt }) }
  const response = await write('POST', '/payments', body, { 'idempotency-key': idempotencyKey })
  if (!response.ok && response.status !== 422) {
    throw new Error(await refusalMessage(response))
  }
  return { code: response.status, payment: (await response.json()) as PaymentView }
}

export function getPayments(): Promise<Payments> {
  return read<Payments>('/payments')
}

/** The money that arrived at the deposit addresses, newest first. */
export function getDeposits(): Promise<Deposits> {
  return read<Deposits>('/deposits')
}

/**
 * What the Transfers screen shows: money going out and money coming in, asked for together so
 * the screen keeps one "reading…" and one "unavailable" instead of two of each.
 */
export async function readTransfers(): Promise<{ payments: Payments; deposits: Deposits }> {
  const [payments, deposits] = await Promise.all([getPayments(), getDeposits()])
  return { payments, deposits }
}

/** One payment's story, from the audit log. */
export function getPaymentTimeline(reference: string): Promise<PaymentTimeline> {
  return read<PaymentTimeline>(`/payments/${encodeURIComponent(reference)}/timeline`)
}

/** A payment in REVIEW back to where it was, and its workflow started again. A 409 throws with its sentence. */
export function resumePayment(reference: string): Promise<PaymentView> {
  return send<PaymentView>(`/payments/${encodeURIComponent(reference)}/resume`, undefined)
}

/**
 * A payment promised for later, cancelled before anything is signed: its money goes back to
 * Available and its invoice reopens. A 404, and a 409 for a payment already signed, throw with
 * the api's own sentence.
 */
export function cancelPayment(reference: string): Promise<PaymentView> {
  return send<PaymentView>(`/payments/${encodeURIComponent(reference)}/cancel`, undefined)
}

/**
 * Sends USDC and gas from the treasury to the partner wallet. It takes as long as two
 * transactions take to land (a few seconds on Base Sepolia) because the answer is the
 * evidence: both hashes, the gas that was spent, and the entry written to the books.
 */
export function fundPartnerWallet(): Promise<PartnerWalletFunding> {
  return send<PartnerWalletFunding>('/treasury/fund-partner-wallet', undefined)
}

/**
 * §9's race, in one call: the api seeds a sandbox database with the article's 1,500 and races two
 * payments of 1,000 through the same payment door. The two calls are made there and not here
 * because two requests from a browser cannot be made to arrive at the same instant.
 */
export function runRace(): Promise<RaceResult> {
  return send<RaceResult>('/experiments/race', undefined)
}

/** The failure-injection flags the Break it screen switches. */
export function getExperiments(): Promise<Experiments> {
  return read<Experiments>('/settings/experiments')
}

/** Changes only the flags it is given, and answers all of them as stored, so the screen shows what the api holds. */
export function setExperiments(flags: Partial<Experiments>): Promise<Experiments> {
  return send<Experiments>('/settings/experiments', flags, 'PUT')
}

/**
 * One rule for every endpoint: anything but a 2xx is a failure the screen shows as-is.
 * A degraded api (503 with a body) and an api that is not there at all (the proxy's own
 * error) both land here, and both mean the same thing to a card: this is not live data.
 */
async function read<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_PATH}${path}`)
  if (!response.ok) {
    throw new Error(`the api answered ${String(response.status)}`)
  }
  return (await response.json()) as T
}

/**
 * The same rule for writes, with one addition: a refused write has a reason the person who
 * typed it needs to read ("name must be text of 1 to 80 characters"), and Nest puts that
 * sentence in the body. A bare status code would send them to the logs for a typo.
 */
async function send<T>(path: string, body: unknown, method: 'POST' | 'PUT' = 'POST'): Promise<T> {
  const response = await write(method, path, body)
  if (!response.ok) {
    throw new Error(await refusalMessage(response))
  }
  return (await response.json()) as T
}

function write(method: 'POST' | 'PUT', path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${API_BASE_PATH}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    // Some of these endpoints are a verb with no arguments; they send no body at all.
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function refusalMessage(response: Response): Promise<string> {
  const body: unknown = await response.json().catch(() => undefined)
  const message = typeof body === 'object' && body !== null ? (body as { message?: unknown }).message : undefined
  return typeof message === 'string' ? message : `the api answered ${String(response.status)}`
}
