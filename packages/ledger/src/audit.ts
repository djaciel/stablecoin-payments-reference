import type { PoolClient } from '@payments/db'

// Everything the log can say, in one place. The values are stored in `audit_log` and old rows
// keep them forever: add a value, never rename one.

/** Who acted: a synchronous request path, a Temporal activity, the chain watcher, an operator, fixtures. */
export const AUDIT_ACTORS = { api: 'api', worker: 'worker', watcher: 'watcher', admin: 'admin', seed: 'seed' } as const

/** What a row is about. `invoice` is an invoice the company owes (receivables will need their own word). */
export const AUDIT_SUBJECTS = { payment: 'payment', invoice: 'invoice', treasury: 'treasury', demo: 'demo' } as const

/** A payment's events, in the order its life can produce them. `released` is money back to Available. */
export const PAYMENT_EVENTS = {
  created: 'created',
  reserved: 'reserved',
  signed: 'signed',
  sent: 'sent',
  settled: 'settled',
  failed: 'failed',
  released: 'released',
} as const

/** An invoice's events. The last two name their payment in `context.reference`. */
export const INVOICE_EVENTS = { created: 'created', paymentLinked: 'payment-linked', paid: 'paid' } as const

/** The watcher's one event, and the demo scaffolding's. */
export const TREASURY_EVENTS = { funded: 'funded' } as const
export const DEMO_EVENTS = { partnerWalletFunded: 'partner-wallet-funded' } as const

type ValueOf<T> = T[keyof T]
export type AuditActor = ValueOf<typeof AUDIT_ACTORS>
export type AuditSubject = ValueOf<typeof AUDIT_SUBJECTS>
export type AuditEventName =
  | ValueOf<typeof PAYMENT_EVENTS>
  | ValueOf<typeof INVOICE_EVENTS>
  | ValueOf<typeof TREASURY_EVENTS>
  | ValueOf<typeof DEMO_EVENTS>

export interface AuditEvent {
  readonly actor: AuditActor
  readonly subjectType: AuditSubject
  /** Which one: a payment reference, an invoice id. */
  readonly subjectId: string
  /** What happened, past tense. */
  readonly event: AuditEventName
  /** Everything a human would ask next. Nothing secret — no private keys, no connection strings. */
  readonly context?: Readonly<Record<string, unknown>>
}

/**
 * Takes a client, never a pool, so the record commits with the thing it describes: an audit
 * row that survived a rolled-back release would be a story about money that never moved.
 */
export async function recordAudit(client: PoolClient, event: AuditEvent): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (actor, subject_type, subject_id, event, context)
     VALUES ($1, $2, $3, $4, $5)`,
    [event.actor, event.subjectType, event.subjectId, event.event, jsonSafe(event.context ?? {})],
  )
}

/**
 * Money is bigint everywhere and JSON has none, so an amount in `context` would otherwise take
 * the caller's whole transaction down with `Do not know how to serialize a BigInt`.
 */
function jsonSafe(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString()
  }
  if (Array.isArray(value)) {
    return value.map(jsonSafe)
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, jsonSafe(nested)]))
  }
  return value
}
