import { useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import type { BlackholeStep, Experiments } from '@payments/domain'
import { setExperiments } from '../api/client'

/**
 * What the admin shell hands this screen: the flags it polls for its banner, and a way to show a
 * change at once. A failing read is the shell's to say, on every admin screen.
 */
export interface ExperimentsContext {
  readonly experiments: Experiments | undefined
  readonly show: (experiments: Experiments) => void
}

/** Where "Node not responding" bites, in the article's words; the step's own name stays under it. */
export const BLACKHOLE_WHERE: Record<BlackholeStep, string> = {
  execute: 'before the broadcast',
  watch: 'after the broadcast',
}

/**
 * The Break it switches (§9). Each one makes a real failure happen, on the real network.
 * The flags come from the shell's poll, so these cards and the banner never disagree.
 */
export function BreakItScreen() {
  const { experiments, show } = useOutletContext<ExperimentsContext>()

  if (experiments === undefined) {
    return <p className="card-note">reading…</p>
  }

  return (
    <div className="cards">
      <RevertCard armed={experiments.revertNextPayment} show={show} />
      <BlackholeCard blackhole={experiments.blackholeRpc} show={show} />
    </div>
  )
}

function RevertCard({ armed, show }: { readonly armed: boolean; readonly show: ExperimentsContext['show'] }) {
  const { busy, failure, change } = useSwitch(show)

  return (
    <section className="card">
      <h2 className="card-title">
        Revert the next payment <Badge armed={armed} />
      </h2>
      <p className="card-value">The next payment reaches the chain and reverts: nothing moves, and it costs only gas.</p>
      <p className="card-note">
        It is signed with a gas limit too low for the transfer, so the network includes it and it runs out of gas. Its
        money stays reserved until the revert is final; then it goes back to Available and the invoice can be paid
        again. The switch turns itself off once a payment has taken it. Arm it, then press Pay on a small invoice in{' '}
        <Link to="/admin/payables">Payables</Link>.
      </p>
      {failure !== undefined && <p className="card-value is-bad">{failure}</p>}
      <p className="card-actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => {
            change({ revertNextPayment: !armed })
          }}
        >
          {armed ? 'Disarm' : 'Arm'}
        </button>
      </p>
    </section>
  )
}

function BlackholeCard({ blackhole, show }: { readonly blackhole: Experiments['blackholeRpc']; readonly show: ExperimentsContext['show'] }) {
  const { busy, failure, change } = useSwitch(show)
  // The step to arm, picked here; while armed, the stored one.
  const [picked, setPicked] = useState<BlackholeStep>(blackhole.step)
  const step = blackhole.enabled ? blackhole.step : picked

  return (
    <section className="card">
      <h2 className="card-title">
        Node not responding <Badge armed={blackhole.enabled} />
      </h2>
      <p className="card-value">
        The node stops answering the payment's workflow: the step runs out of its attempts and the payment goes to REVIEW,
        with its money still reserved.
      </p>
      <p className="form-row">
        {(Object.keys(BLACKHOLE_WHERE) as BlackholeStep[]).map((option) => (
          <label key={option} className="field-unit">
            <input
              type="radio"
              name="blackhole-step"
              checked={step === option}
              disabled={blackhole.enabled || busy}
              onChange={() => {
                setPicked(option)
              }}
            />
            {BLACKHOLE_WHERE[option]} <code>{option}</code>
          </label>
        ))}
      </p>
      <p className="card-note">
        Before the broadcast, the payment is signed and never sent, and it holds its nonce: every payout signed after it
        waits until it is resumed, and Fund partner wallet is refused until then. After it, the transfer lands while the
        workflow cannot see it, and Reserved still holds the money. While armed it affects every payment in flight; the
        api and the watcher are not affected. Disarm it and the next attempt asks the node again; a payment already in
        REVIEW waits for Resume on <Link to="/admin/transfers">Transfers</Link>. Arm it, then press Pay on a small invoice
        in <Link to="/admin/payables">Payables</Link>.
      </p>
      {failure !== undefined && <p className="card-value is-bad">{failure}</p>}
      <p className="card-actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={() => {
            change({ blackholeRpc: { enabled: !blackhole.enabled, step } })
          }}
        >
          {blackhole.enabled ? 'Disarm' : 'Arm'}
        </button>
      </p>
    </section>
  )
}

/**
 * Sends one flag and nothing else: the screen's copy of the others can be a poll old, and sending
 * it back could re-arm the revert a payment has just taken.
 */
function useSwitch(show: ExperimentsContext['show']) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  const change = (flag: Partial<Experiments>): void => {
    setBusy(true)
    setFailure(undefined)
    setExperiments(flag)
      .then(show)
      .catch((refused: unknown) => {
        setFailure(refused instanceof Error ? refused.message : String(refused))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return { busy, failure, change }
}

function Badge({ armed }: { readonly armed: boolean }) {
  return <span className={armed ? 'badge is-armed' : 'badge'}>{armed ? 'armed' : 'off'}</span>
}
