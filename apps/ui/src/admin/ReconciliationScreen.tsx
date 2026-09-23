import { useCallback, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { ReconciliationItemView, ReconciliationRunSummary, ReconciliationRunView } from '@payments/domain'
import { getReconciliationRun, getReconciliationRuns, runReconciliation } from '../api/client'
import { usePolling } from '../api/usePolling'
import { MOMENT } from './TransfersScreen'

/**
 * Article section 10 on one screen: the books against the stablecoin the company holds on chain
 * at one fixed block, then every movement that explains the difference, then the runs before
 * this one. Everything here is what the run recorded when it ran, never a fresh read.
 */

/** The outcome in the words a person would use, rather than the one stored. */
const OUTCOME: Record<ReconciliationRunSummary['outcome'], string> = {
  clean: 'Books and chain agree',
  mismatch: 'Something is not explained',
  incomplete: 'The chain could not be read at that block',
}

/** Unexplained first, then what the chain could not answer for, then the differences, then the rest. */
const ORDER: Record<ReconciliationItemView['outcome'], number> = { mismatch: 0, unchecked: 1, explained: 2, ok: 3 }

export function ReconciliationScreen() {
  // The run on show: the latest one, until somebody picks another out of the history.
  const [chosen, setChosen] = useState<string | undefined>(undefined)
  const read = useCallback(async () => {
    const { runs } = await getReconciliationRuns()
    const id = chosen ?? runs[0]?.id
    return { runs, run: id === undefined ? undefined : await getReconciliationRun(id) }
  }, [chosen])
  const { data, error } = usePolling(read)

  if (data === undefined) {
    return <p className="card-note">{error === undefined ? 'reading…' : `unavailable — ${error}`}</p>
  }

  return (
    <>
      <LatestRun view={data.run} latestId={data.runs[0]?.id} onLatest={() => setChosen(undefined)} />
      {data.run !== undefined && <Movements items={data.run.items} />}
      <History runs={data.runs} showing={data.run?.run.id} onChoose={setChosen} />
    </>
  )
}

/** The run at the top: what it found, the identity in three lines, and the button that asks for another. */
function LatestRun({ view, latestId, onLatest }: { readonly view?: ReconciliationRunView; readonly latestId?: string; readonly onLatest: () => void }) {
  return (
    <section className="panel">
      <h2 className="card-title">{view === undefined ? 'No run yet' : OUTCOME[view.run.outcome]}</h2>
      <p className="panel-lead">
        What is compared is the stablecoin the company holds: Available and Reserved in the books, plus what has arrived
        at the partners' deposit addresses, against the same money on chain. Invoices nobody has paid yet are not on the
        chain at all, and gas is never posted to the books, so neither can show up here as a difference.
      </p>
      <p className="card-note">
        The block is fixed, never the latest one: at a moving target the payments in flight look like differences that
        fix themselves in seconds, and in two weeks nobody reads the alert.
      </p>

      {view === undefined ? (
        <p className="card-note">Press Run now, or wait: the check runs by itself every ten minutes.</p>
      ) : (
        <>
          <Identity view={view} />
          <p className="card-note">
            Ran {MOMENT.format(new Date(view.run.startedAt))}, {view.run.checked} checks
            {view.run.mismatched === 0 ? '' : `, ${view.run.mismatched} unexplained`}.
          </p>
        </>
      )}

      <p className="card-actions">
        <RunNowButton latestId={latestId} onStarted={onLatest} />
      </p>
    </section>
  )
}

/** The three lines this whole phase exists to print. Every figure comes out of the run's own record. */
function Identity({ view }: { readonly view: ReconciliationRunView }) {
  const global = view.items.find((item) => item.subject === 'global')
  if (view.identity === undefined) {
    // A run older than this check has no identity to show, and it was not wrong when it ran: the
    // figures are missing, which is a plain fact rather than something in red.
    return <p className="card-note">{global?.detail ?? 'This run was recorded before the books were compared with the chain, so it has no figures.'}</p>
  }
  const { books, chain, explained, remainder } = view.identity
  const settled = global?.outcome === 'ok'

  return (
    <>
      <dl className="figures is-identity">
        <Line label="Books">
          Available {books.available} + Reserved {books.reserved} + Deposits {books.deposits} = <strong>{books.total}</strong>
        </Line>
        <Line label={`Chain at block ${view.run.block ?? '—'}`}>
          {chain.addresses.map((held) => `${held.label} ${held.amount}`).join(' + ')} = <strong>{chain.total}</strong>
        </Line>
        <Line label="Explained by what was in flight">
          {explained} → {settled ? 'nothing left over' : `${remainder} left over, which nothing explains`}
        </Line>
      </dl>
      <p className="card-note">
        {chain.addresses.map((held) => `${held.label}: ${held.address}`).join(' · ')}
      </p>
    </>
  )
}

function Line({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="figure">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

/**
 * `POST /reconciliation/run`, which answers 202 the moment the workflow is started. The button
 * stays busy until a newer run appears, because that is the only thing that means it finished.
 */
function RunNowButton({ latestId, onStarted }: { readonly latestId?: string; readonly onStarted: () => void }) {
  const [asked, setAsked] = useState<string | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const [starting, setStarting] = useState(false)
  const waiting = starting || (asked !== undefined && asked === (latestId ?? ''))

  const run = (): void => {
    setStarting(true)
    setFailure(undefined)
    runReconciliation()
      .then(() => {
        setAsked(latestId ?? '')
        onStarted()
      })
      .catch((refused: unknown) => {
        setFailure(refused instanceof Error ? refused.message : String(refused))
      })
      .finally(() => {
        setStarting(false)
      })
  }

  return (
    <>
      <button type="button" className="button" disabled={waiting} onClick={run}>
        {waiting ? 'running…' : 'Run now'}
      </button>
      {failure !== undefined && <span className="cell-note">{failure}</span>}
    </>
  )
}

/** Every movement the run checked, unexplained ones first. One sentence each, with its evidence. */
function Movements({ items }: { readonly items: readonly ReconciliationItemView[] }) {
  const sorted = [...items].sort((one, other) => ORDER[one.outcome] - ORDER[other.outcome])

  return (
    <section className="panel">
      <h2 className="card-title">Every movement, and what explains it</h2>
      <p className="panel-lead">
        One line per payment and per deposit, plus the identity above. A difference carries a number: what the books
        hold and the chain has already moved, or the other way round.
      </p>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>What</th>
              <th>Found</th>
              <th className="is-number">Difference</th>
              <th>What it is</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => (
              <tr key={`${item.subject}-${item.subjectId}`}>
                <td>
                  {item.subject === 'payment' ? <Link to={`/admin/transfers/${item.subjectId}`}>{item.subjectId}</Link> : item.subjectId}
                  <span className="cell-note">{item.subject}</span>
                </td>
                <td>{FOUND[item.outcome]}</td>
                <td className="is-number">{item.delta === undefined ? '—' : `${item.delta} USDC`}</td>
                <td>{item.detail}</td>
                <td>
                  {item.explorerUrl === undefined ? null : (
                    <a href={item.explorerUrl} target="_blank" rel="noreferrer">
                      onchain
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** The four outcomes, said plainly: the stored word is for the database, not for a reader. */
const FOUND: Record<ReconciliationItemView['outcome'], string> = {
  ok: 'agrees',
  explained: 'explained',
  mismatch: 'unexplained',
  unchecked: 'not checked',
}

/** The runs before this one. Clicking one shows it above, figures and all. */
function History({
  runs,
  showing,
  onChoose,
}: {
  readonly runs: readonly ReconciliationRunSummary[]
  readonly showing?: string
  readonly onChoose: (id: string) => void
}) {
  if (runs.length === 0) {
    return null
  }

  return (
    <section className="panel">
      <h2 className="card-title">The runs before this one</h2>
      <p className="panel-lead">
        A run happens by itself every ten minutes here, so a reader can watch one appear; the article's rhythm is daily.
        Nothing a run writes is ever changed afterwards: a check that came out wrong stays on the record.
      </p>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Ran</th>
              <th className="is-number">Block</th>
              <th>Outcome</th>
              <th className="is-number">Checked</th>
              <th className="is-number">Explained</th>
              <th className="is-number">Unexplained</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => (
              <tr key={run.id}>
                <td>
                  {run.id === showing ? (
                    MOMENT.format(new Date(run.startedAt))
                  ) : (
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => {
                        onChoose(run.id)
                      }}
                    >
                      {MOMENT.format(new Date(run.startedAt))}
                    </button>
                  )}
                </td>
                <td className="is-number">{run.block ?? '—'}</td>
                <td>{OUTCOME[run.outcome]}</td>
                <td className="is-number">{run.checked}</td>
                <td className="is-number">{run.explained}</td>
                <td className="is-number">{run.mismatched}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}
