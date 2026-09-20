/**
 * One rule, in one place: **an empty variable is a mistake, not a request for the empty
 * string**. `RPC_URL=` in a compose file means "I did not set this", and without this every
 * service is one forgotten `=== ''` away from connecting to the empty string.
 *
 * Validation (a port must be a number, a URL must parse) stays next to the thing being
 * configured, where the error message can say something useful.
 */

/** The raw value, or `undefined` when it is unset — which includes set-but-empty. */
export function optionalEnv(name: string): string | undefined {
  const value = process.env[name]
  return value === undefined || value === '' ? undefined : value
}

/** The value, or the default. The default is what makes "no env var to run" true. */
export function readEnv(name: string, fallback: string): string {
  return optionalEnv(name) ?? fallback
}

/**
 * For the handful of variables with no sensible default — a database connection string is the
 * whole example — where starting without one only moves the failure somewhere less
 * informative. `hint` is the sentence that tells the reader what to do about it.
 */
export function requireEnv(name: string, hint?: string): string {
  const value = optionalEnv(name)
  if (value === undefined) {
    throw new Error(`${name} is not set.${hint === undefined ? '' : ` ${hint}`}`)
  }
  return value
}
