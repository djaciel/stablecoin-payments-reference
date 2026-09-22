import { useState } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import type { Experiments } from '@payments/domain'
import { setExperiments } from '../api/client'

/**
 * What the admin shell hands this screen: the flags it polls for its banner, and a way to show a
 * change at once. A failing read is the shell's to say, on every admin screen.
 */
export interface ExperimentsContext {
  readonly experiments: Experiments | undefined
  readonly show: (experiments: Experiments) => void
}

/**
 * The failure-injection switches (§9). Each one makes a real failure happen to the next payment, on
 * the real network. The flags come from the shell's poll, so this card and the banner never disagree.
 */
export function BreakItScreen() {
  const { experiments, show } = useOutletContext<ExperimentsContext>()
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  if (experiments === undefined) {
    return <p className="card-note">reading…</p>
  }

  const turn = (revertNextPayment: boolean): void => {
    setBusy(true)
    setFailure(undefined)
    setExperiments({ ...experiments, revertNextPayment })
      .then(show)
      .catch((refused: unknown) => {
        setFailure(refused instanceof Error ? refused.message : String(refused))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  const armed = experiments.revertNextPayment

  return (
    <div className="cards">
      <section className="card">
        <h2 className="card-title">
          Revert the next payment <span className={armed ? 'badge is-armed' : 'badge'}>{armed ? 'armed' : 'off'}</span>
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
              turn(!armed)
            }}
          >
            {armed ? 'Disarm' : 'Arm'}
          </button>
        </p>
      </section>
    </div>
  )
}
