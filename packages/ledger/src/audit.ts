import type { PoolClient } from '@payments/db'

/**
 * Takes a client, never a pool, so the record commits with the thing it describes: an audit
 * row that survived a rolled-back release would be a story about money that never moved.
 */

/** Who acted: a synchronous request path, a Temporal activity, the chain watcher, an operator, fixtures. */
export type AuditActor = 'api' | 'worker' | 'watcher' | 'admin' | 'seed'

export interface AuditEvent {
  readonly actor: AuditActor
  /** What kind of thing this is about: `payment`, `deposit`, `invoice`, `ledger`. */
  readonly subjectType: string
  /** Which one: a payment reference, a deposit id. */
  readonly subjectId: string
  /** What happened, past tense: `reserved`, `sent`, `settled`, `released`, `escalated`. */
  readonly event: string
  /** Everything a human would ask next. Nothing secret — no private keys, no connection strings. */
  readonly context?: Readonly<Record<string, unknown>>
}

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
