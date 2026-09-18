import type { PoolClient } from '@payments/db'

/**
 * The audit log's writer.
 *
 * Takes a client, never a pool, so the record commits with the thing it describes. An audit
 * row that survived a rolled-back release would be a story about money that never moved,
 * which is worse than no record at all.
 */

/**
 * Who acted. A small known set rather than free text: a reader filtering the log needs these
 * to mean the same thing every time.
 *
 * `api` — a synchronous request path decision. `worker` — a Temporal activity.
 * `watcher` — the chain watcher. `admin` — an operator action. `seed` — fixtures.
 */
export type AuditActor = 'api' | 'worker' | 'watcher' | 'admin' | 'seed'

export interface AuditEvent {
  readonly actor: AuditActor
  /** What kind of thing this is about: `payment`, `deposit`, `invoice`, `ledger`. */
  readonly subjectType: string
  /** Which one: a payment reference, a deposit id. Text, because they are all short strings. */
  readonly subjectId: string
  /** What happened, past tense: `reserved`, `sent`, `settled`, `released`, `escalated`. */
  readonly event: string
  /**
   * Everything a human would ask next: amounts in minor units, transaction hashes, block
   * numbers, the attempt count, the error that caused an escalation. Nothing secret — no
   * private keys, no connection strings.
   */
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
 * Turns bigints into decimal strings, at any depth.
 *
 * Money is bigint everywhere in this repo and JSON has no bigint, so an amount in `context`
 * would otherwise take the caller's whole transaction down with `TypeError: Do not know how
 * to serialize a BigInt` — in the middle of a release, which is the worst possible moment.
 * Version 1 shipped a `recordAudit` whose own comment told callers to put amounts here.
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
