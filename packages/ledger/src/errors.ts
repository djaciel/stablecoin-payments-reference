/**
 * The ledger refuses work by throwing, never by returning a falsy value: a caller that ignores
 * the result of a reserve must not carry on as if money moved.
 *
 * The split is about who found the problem. The engine names the two money failures because it
 * checked before writing, while it still knew the numbers; everything the DATABASE refused
 * arrives as `LedgerRejected` carrying the database's own message, so nothing parses prose.
 */

/**
 * An account that may not go negative was asked to. The numbers are always here because the
 * engine throws this under the row lock, having just read the balance.
 */
export class InsufficientFunds extends Error {
  constructor(
    readonly account: string,
    readonly requested: bigint,
    readonly available: bigint,
  ) {
    super(`${account} has ${available} available and ${requested} was requested`)
    this.name = 'InsufficientFunds'
  }
}

/** A ledger transaction whose entries do not cancel out, per currency. Invariant 1. */
export class NotZeroSum extends Error {
  constructor(
    readonly currency: string,
    readonly imbalance: bigint,
  ) {
    super(`entries in ${currency} are off by ${imbalance}; a ledger transaction must sum to zero`)
    this.name = 'NotZeroSum'
  }
}

/**
 * The database said no. Callers that need to branch match on `code` or `constraint`, which
 * Postgres guarantees, rather than on the message.
 */
export class LedgerRejected extends Error {
  constructor(
    readonly code: string,
    readonly constraint: string | undefined,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'LedgerRejected'
  }
}

/** The Postgres error shape this module reads. */
interface PostgresError {
  readonly code?: unknown
  readonly constraint?: unknown
  readonly message?: unknown
}

/**
 * Turns a database rejection into `LedgerRejected` and leaves everything else alone — a
 * `TypeError` dressed up as a ledger failure is a lie the API would repeat. A Postgres error is
 * recognised by its string `code`, the one stable thing about it.
 */
export function toLedgerError(error: unknown): unknown {
  // Already translated: the posting engine maps what it catches, and the transaction wrapper
  // around it maps again when COMMIT is what the database refused.
  if (error instanceof LedgerRejected || typeof error !== 'object' || error === null) {
    return error
  }
  const { code, constraint, message } = error as PostgresError
  if (typeof code !== 'string') {
    return error
  }
  return new LedgerRejected(code, typeof constraint === 'string' ? constraint : undefined, String(message), {
    cause: error,
  })
}
