/**
 * How this repo reads its environment, in one place.
 *
 * The rule every service repeated until this file existed: **an empty variable is a
 * mistake, not a request for the empty string**. `RPC_URL=` in a compose file, a shell
 * that exports a variable it failed to fill, a `.env` line with nothing after the `=` —
 * all of them mean "I did not set this", and every one of them used to be one forgotten
 * `=== ''` away from a service connecting to the empty string and failing somewhere far
 * from the cause.
 *
 * Nothing here knows what a variable is for. Validation (a port must be a number, a URL
 * must parse) stays next to the thing being configured, because that is where the error
 * message can say something useful.
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
 * The value, or a refusal to continue. For the handful of variables that have no sensible
 * default — a database connection string is the whole example — where starting without
 * one would only move the failure somewhere less informative.
 *
 * `hint` is the sentence that tells the reader what to do about it.
 */
export function requireEnv(name: string, hint?: string): string {
  const value = optionalEnv(name)
  if (value === undefined) {
    throw new Error(`${name} is not set.${hint === undefined ? '' : ` ${hint}`}`)
  }
  return value
}
