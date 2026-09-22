// Every failure-injection flag: its key in the `settings` table and what it does. The api writes
// them (`PUT /settings/experiments`) and only the worker's payment steps read them. An absent row is off.

/** What `GET /settings/experiments` answers and `PUT` takes. */
export interface Experiments {
  readonly revertNextPayment: boolean
}

/** Each flag's `settings` key, under its name in `Experiments`. */
export const EXPERIMENT_KEYS = {
  /**
   * One-shot: the next payment `sign` signs gets a gas limit too low for the transfer. The network
   * includes it, it runs out of gas and reverts: nothing moves, it costs only gas.
   */
  revertNextPayment: 'experiment.revert_next_payment',
} as const satisfies Record<keyof Experiments, string>
