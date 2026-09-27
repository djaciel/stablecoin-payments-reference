import { useCallback, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { ReconciliationIdentity, ReconciliationItemView, ReconciliationRunSummary, ReconciliationRunView } from '@payments/domain'
import { getReconciliationRun, getReconciliationRuns, runReconciliation } from '../api/client'
import { usePolling } from '../api/usePolling'
import { formatUsdc } from '../app/usdc'
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

/** The four outcomes, said plainly: the stored word is for the database, not for a reader. */
const FOUND: Record<ReconciliationItemView['outcome'], string> = {
  ok: 'agrees',
  explained: 'explained',
  mismatch: 'unexplained',
  unchecked: 'not checked',
}

/** The run's time on the meta line: to the minute, because the block is the precise part. */
const RAN = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

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
    return <p className="card-note">{error === undefined ? 'reading…' : `unavailable: ${error}`}</p>
  }

  return (
    <>
      <LatestRun view={data.run} latestId={data.runs[0]?.id} onLatest={() => setChosen(undefined)} />
      {data.run !== undefined && <Movements items={data.run.items} />}
      <History runs={data.runs} showing={data.run?.run.id} onChoose={setChosen} />
    </>
  )
}

/** The run at the top: its outcome, one line saying which block and when, and the three figures. */
function LatestRun({ view, latestId, onLatest }: { readonly view?: ReconciliationRunView; readonly latestId?: string; readonly onLatest: () => void }) {
  const outcome = view?.run.outcome
  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <h2 className={`recon-title${outcome === undefined || outcome === 'clean' ? '' : ' is-warning'}`}>
            {outcome !== undefined && <span className="recon-mark">{outcome === 'clean' ? '✓' : '!'}</span>}
            {outcome === undefined ? 'No run yet' : OUTCOME[outcome]}
          </h2>
          <div className="panel-head-actions">
            <RunNowButton latestId={latestId} onStarted={onLatest} />
          </div>
        </div>
        <p className="card-note">
          {view === undefined
            ? 'Press Run now, or wait: it runs every ten minutes.'
            : `${view.run.block === null ? 'No block' : `Block ${view.run.block}`} · ${RAN.format(new Date(view.run.startedAt))} · ${String(view.run.checked)} checks`}
        </p>
      </section>
      {view !== undefined && <Figures view={view} />}
    </>
  )
}

/** Books, chain and what was in flight, one card each. Every figure comes out of the run's own record. */
function Figures({ view }: { readonly view: ReconciliationRunView }) {
  if (view.identity === undefined) {
    const global = view.items.find((item) => item.subject === 'global')
    // A run older than this check has no figures, and it was not wrong when it ran: a plain fact,
    // not something in red. A chain that did not answer keeps its full sentence in the tooltip.
    return (
      <p className="card-note" title={global?.detail}>
        {view.run.outcome === 'incomplete'
          ? 'The chain did not answer at this block, so there are no figures.'
          : 'This run was recorded before the books were compared with the chain, so it has no figures.'}
      </p>
    )
  }
  const { books, chain, explained, remainder } = view.identity

  return (
    <div className="figure-cards">
      <FigureCard label="Books" total={books.total}>
        <Line label="Available" amount={books.available} />
        <Line label="Reserved" amount={books.reserved} />
        <Line label="Deposits" amount={books.deposits} />
      </FigureCard>
      <FigureCard label="Chain" total={chain.total}>
        {chain.addresses
          .filter((held) => held.label === TREASURY)
          .map((held) => (
            <Line key={held.address} label="Treasury" amount={held.amount} />
          ))}
        <Line label="Partner addresses" amount={partnerTotal(chain)} />
      </FigureCard>
      <FigureCard label="In flight" total={explained}>
        {/[1-9]/.test(remainder) && <Line label="Unexplained" amount={remainder} bad />}
      </FigureCard>
    </div>
  )
}

/** The label the worker gives the treasury; every other address it watches is a partner's deposit address. */
const TREASURY = 'treasury'

function FigureCard({ label, total, children }: { readonly label: string; readonly total: string; readonly children: ReactNode }) {
  return (
    <section className="card">
      <h2 className="card-title">{label}</h2>
      <p className="card-value">{formatUsdc(total)} USDC</p>
      <dl className="figures">{children}</dl>
    </section>
  )
}

function Line({ label, amount, bad = false }: { readonly label: string; readonly amount: string; readonly bad?: boolean }) {
  return (
    <div className={`figure${bad ? ' is-bad' : ''}`}>
      <dt>{label}</dt>
      <dd>{formatUsdc(amount)}</dd>
    </div>
  )
}

/**
 * Every partner deposit address added up, in whole USDC with six decimals like the api sends.
 * Summed in micro units as a bigint, so no amount goes through a float.
 */
function partnerTotal(chain: ReconciliationIdentity['chain']): string {
  const micro = chain.addresses
    .filter((held) => held.label !== TREASURY)
    .reduce((total, held) => {
      const [whole = '0', fraction = ''] = held.amount.replaceAll(',', '').split('.')
      return total + BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0').slice(0, 6))
    }, 0n)
  const fraction = (micro % 1_000_000n).toString().padStart(6, '0')
  return `${(micro / 1_000_000n).toString()}.${fraction}`
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

/** Every movement the run checked, unexplained ones first. Only what needs a look, unless asked for all. */
function Movements({ items }: { readonly items: readonly ReconciliationItemView[] }) {
  const [showAll, setShowAll] = useState(false)
  const sorted = [...items].sort((one, other) => ORDER[one.outcome] - ORDER[other.outcome])
  const needLook = sorted.filter((item) => item.outcome !== 'ok')
  const shown = showAll ? sorted : needLook

  return (
    <section className="panel">
      <div className="panel-head">
        <h2 className="card-title">Every payment and deposit</h2>
        <button
          type="button"
          className="link-button"
          onClick={() => {
            setShowAll(!showAll)
          }}
        >
          {showAll ? 'Show only what needs a look' : `Show all ${String(sorted.length)}`}
        </button>
      </div>
      {shown.length === 0 ? (
        <p className="card-note">Everything agrees.</p>
      ) : (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Reference</th>
                <th>Result</th>
                <th className="is-number">Difference</th>
                <th>Detail</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((item) => (
                <tr key={`${item.subject}-${item.subjectId}`}>
                  <td>
                    <Reference item={item} />
                  </td>
                  <td className={`result is-${item.outcome}`}>{FOUND[item.outcome]}</td>
                  <td className="is-number">{item.delta === undefined ? '' : `${formatUsdc(item.delta)} USDC`}</td>
                  <td>
                    <span className="cell-detail" title={item.detail}>
                      {shortDetail(item.detail)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}

/** A payment links to its story; a deposit id is a uuid, so it shows its first part and the rest on hover. */
function Reference({ item }: { readonly item: ReconciliationItemView }) {
  if (item.subject === 'payment') {
    return (
      <>
        <Link to={`/admin/transfers/${item.subjectId}`}>{item.subjectId}</Link>
        <span className="kind-tag">payment</span>
      </>
    )
  }
  if (item.subject === 'deposit') {
    return (
      <>
        <span className="is-mono" title={item.subjectId}>
          {item.subjectId.slice(0, 8)}
        </span>
        <span className="kind-tag">deposit</span>
      </>
    )
  }
  return <>{item.subjectId}</>
}

/**
 * The worker's sentence cut to a few words for the table; the full one stays in the tooltip. Each
 * pattern is the start of a sentence `apps/worker/src/reconcile-items.ts` writes. Anything else is
 * cut at its first colon or comma, which is where those sentences turn from what into why.
 */
const SHORT: readonly (readonly [RegExp, (block: string) => string])[] = [
  [/^paid in block (\d+)/, (block) => `Paid in block ${block}`],
  [/^refused at the door: no money moved/, () => 'Refused, nothing moved'],
  [/^cancelled before anything was signed/, () => 'Cancelled before signing'],
  [/^the transaction its proof names really reverted in block (\d+)/, (block) => `Reverted in block ${block}, nothing moved`],
  [/^waiting for its time/, () => 'Waiting for its time'],
  [/^[\d,.]+ arrived at \S+ in block (\d+) and is credited, with no invoice/, (block) => `Credited in block ${block}, no invoice`],
  [/^[\d,.]+ arrived at \S+ in block (\d+) and is credited/, (block) => `Credited in block ${block}`],
  [/^signed and broadcast, and not in a block yet/, () => 'In flight'],
  [/^the transfer landed in block \d+; the books still hold/, () => 'In flight'],
  [/^its transfer landed in block \d+, after the block this run pinned/, () => 'In flight'],
  [/^settled in the books; its transfer landed in block (\d+), after the block/, (block) => `Paid in block ${block}, after this run's block`],
  [/^its transaction reverted in block (\d+): the books release/, (block) => `Reverted in block ${block}, not released yet`],
  [/^seen at block (\d+) and not credited:/, (block) => `Seen in block ${block}, not credited yet`],
  [/^seen at block (\d+), which this run's block has not reached/, (block) => `Seen in block ${block}, after this run's block`],
  [/^credited from block (\d+), after the block this run pinned/, (block) => `Credited in block ${block}, after this run's block`],
  [/^the books hold [\d,.]+, the chain held [\d,.]+ at block \d+, and what was in flight explains [\d,.]+: nothing is left over/, () => 'Nothing left over'],
  [/^the books hold [\d,.]+, the chain held [\d,.]+ at block \d+, and what was in flight explains [\d,.]+, and/, () => 'Left over, nothing explains it'],
  [/^what the company holds on chain could not be read at block (\d+)/, (block) => `Chain not read at block ${block}`],
  [/^what is left over cannot be told/, () => 'Left over unknown, the chain did not answer'],
  [/^this run pinned no block/, () => 'No block to compare at'],
]

function shortDetail(detail: string): string {
  for (const [pattern, phrase] of SHORT) {
    const match = pattern.exec(detail)
    if (match !== null) {
      return phrase(match[1] ?? '')
    }
  }
  const cut = detail.split(/[:,]/, 1)[0] ?? detail
  return cut.charAt(0).toUpperCase() + cut.slice(1)
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
                <td className="is-number">{run.block ?? 'none'}</td>
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
