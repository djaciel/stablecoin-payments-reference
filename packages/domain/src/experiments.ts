// Every failure-injection flag: its key in the `settings` table and what it does. The api writes
// them (`PUT /settings/experiments`) and only the worker's payment steps read them. An absent row is off.

/** The two payment steps that ask a node: before the broadcast (`execute`) and after it (`watch`). */
export type BlackholeStep = 'execute' | 'watch'

export const BLACKHOLE_STEPS: readonly BlackholeStep[] = ['execute', 'watch']

/** What `GET /settings/experiments` answers. `PUT` takes any of these fields and changes only those. */
export interface Experiments {
  readonly revertNextPayment: boolean
  readonly crashAfterSigning: boolean
  readonly blackholeRpc: { readonly enabled: boolean; readonly step: BlackholeStep }
}

/** Each flag's `settings` key, under its name in `Experiments`. */
export const EXPERIMENT_KEYS = {
  /**
   * One-shot: the next payment `sign` signs gets a gas limit too low for the transfer. The network
   * includes it, it runs out of gas and reverts: nothing moves, it costs only gas.
   */
  revertNextPayment: 'experiment.revert_next_payment',
  /**
   * One-shot: the next payment stores its hash, its signed bytes and its nonce, commits, and then
   * the worker kills its own process with nothing sent. It comes back and finishes the payment (§9).
   */
  crashAfterSigning: 'experiment.crash_after_signing',
  /**
   * While enabled, that step of every payment in flight fails like a node that does not answer, so
   * its attempts run out and the payment goes to REVIEW with its money still reserved (§9's stuck one).
   */
  blackholeRpc: 'experiment.blackhole_rpc',
} as const satisfies Record<keyof Experiments, string>
