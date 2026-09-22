import { useEffect, useState } from 'react'

/**
 * The refresh interval of every live value in the UI. It is defined once, here: a screen
 * that wants fresher data changes this number, not its own timer.
 */
const POLL_INTERVAL_MS = 5000

export interface Polled<T> {
  /** The last successful answer, or undefined before the first one arrives. */
  readonly data: T | undefined
  /** Set when the last attempt failed; the screen shows this instead of stale data. */
  readonly error: string | undefined
}

/**
 * Reads something from the api now and every few seconds after that, and pauses the repeat
 * while the tab is hidden — a demo left open in a background tab should not keep asking,
 * and coming back to it refreshes immediately instead of waiting out the interval.
 *
 * The first read is not skipped when the tab starts hidden (a screen opened in a
 * background tab, a restored session): the repeat is what costs something, and a page
 * stuck on "checking…" until someone looks at it is a bug, not a saving.
 *
 * `read` must be a stable reference (a module-level function such as `getHealth`, or one
 * wrapped in `useCallback`): it is the effect's dependency, so a new function on every
 * render would restart the timer on every render. `isDone` too, when given: once an answer
 * satisfies it, that answer stays on screen and the repeats stop.
 */
export function usePolling<T>(read: () => Promise<T>, isDone?: (data: T) => boolean): Polled<T> {
  const [state, setState] = useState<Polled<T>>({ data: undefined, error: undefined })

  useEffect(() => {
    // Guards against a late answer from a poll started before this effect was torn down
    // writing over the state of the effect that replaced it.
    let active = true

    const readNow = (): void => {
      void read()
        .then((data) => {
          if (active) {
            setState({ data, error: undefined })
            if (isDone?.(data) === true) {
              stop()
            }
          }
        })
        .catch((error: unknown) => {
          if (active) {
            setState({ data: undefined, error: error instanceof Error ? error.message : String(error) })
          }
        })
    }

    const readIfVisible = (): void => {
      if (!document.hidden) {
        readNow()
      }
    }

    const timer = setInterval(readIfVisible, POLL_INTERVAL_MS)
    document.addEventListener('visibilitychange', readIfVisible)
    const stop = (): void => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', readIfVisible)
    }
    readNow()

    return () => {
      active = false
      stop()
    }
  }, [read, isDone])

  return state
}
