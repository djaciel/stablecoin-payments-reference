import { useRef, useState, type ReactNode } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { failedAfterReserving, type AuditStep, type BlackholeStep, type Experiments, type PaymentSummary, type PaymentView, type RaceResult } from '@payments/domain'
import { createPayable, doubleClick, getPayables, getPayments, getPaymentTimeline, payPayable, resumePayment, runRace, setExperiments, type PaymentAnswer } from '../api/client'
import { AddressLine } from '../app/AddressLine'
import { formatUsdc } from '../app/usdc'
import { REASONS } from './PayablesScreen'

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

/** Every run writes its own invoice for this much: the author's amount, so a run costs as little as possible. */
const RUN_AMOUNT = '0.02'

/** How often a run asks for its payment's story. Its own loop: the screen's poll pauses in a hidden tab, a run must not. */
const RUN_POLL_MS = 2000

/**
 * How long a run follows its payment before it lets go. Waiting for a final block took about three
 * minutes in both live runs, so this leaves room; what it rules out is a payment that never reaches
 * an end (the worker down, a step still retrying) holding a global flag armed for good.
 */
const RUN_LIMIT_MS = 600_000

/** Failed reads in a row a run rides out: one bad poll should not end a run that lasts minutes. */
const RUN_READ_BLIPS = 2

/**
 * The Break it cards (§9). Each one makes a real failure happen, on the real network: Run it does
 * the whole experiment and leaves the evidence on the card, and the switch under it is the long way.
 * The flags come from the shell's poll, so these cards and the banner never disagree.
 */
export function BreakItScreen() {
  const { experiments, show } = useOutletContext<ExperimentsContext>()
  // One run at a time: "Node not responding" is global, so a second run would be caught by the first's flag.
  const [running, setRunning] = useState<string | undefined>(undefined)

  if (experiments === undefined) {
    return <p className="card-note">reading…</p>
  }

  // §9's four failures in the order the article lists them, then §6's revert.
  const card: CardProps = { show, running, setRunning }
  return (
    <div className="cards">
      <DoubleClickCard {...card} />
      <RaceCard {...card} />
      <CrashCard armed={experiments.crashAfterSigning} {...card} />
      <BlackholeCard blackhole={experiments.blackholeRpc} {...card} />
      <RevertCard armed={experiments.revertNextPayment} {...card} />
    </div>
  )
}

/** What the screen hands every card: the flags' writer and the latch that keeps runs one at a time. */
interface CardProps {
  readonly show: ExperimentsContext['show']
  readonly running: string | undefined
  readonly setRunning: (card: string | undefined) => void
}

function RevertCard({ armed, ...card }: { readonly armed: boolean } & CardProps) {
  const run = useRun('revert', card, {
    arm: { flag: (on) => ({ revertNextPayment: on }), says: 'Armed: the next payment is signed with a gas limit too low to finish.' },
    description: 'Revert run',
  })

  return (
    <section className="card">
      <h2 className="card-title">
        Revert the next payment · article §6 <Badge armed={armed} />
      </h2>
      <p className="card-value">The next payment reaches the chain and reverts: nothing moves, and it costs only gas.</p>
      <p className="card-note">
        It is signed with a gas limit too low for the transfer, so the network includes it and it runs out of gas. Its
        money stays reserved until the revert is final; then it goes back to Available and the invoice can be paid
        again. Waiting for that final block takes minutes.
      </p>
      <RunIt run={run} />
      <Switch armed={armed} run={run} show={card.show} flag={{ revertNextPayment: !armed }} />
    </section>
  )
}

function BlackholeCard({ blackhole, ...card }: { readonly blackhole: Experiments['blackholeRpc'] } & CardProps) {
  // The step to arm, picked here; while armed, the stored one.
  const [picked, setPicked] = useState<BlackholeStep>(blackhole.step)
  const step = blackhole.enabled ? blackhole.step : picked
  const run = useRun('blackhole', card, {
    arm: { flag: (on) => ({ blackholeRpc: { enabled: on, step } }), says: `Armed: the node stops answering ${BLACKHOLE_WHERE[step]} (${step}).` },
    description: 'Stuck run',
  })

  return (
    <section className="card">
      <h2 className="card-title">
        Node not responding · article §9 <Badge armed={blackhole.enabled} />
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
              disabled={blackhole.enabled || run.busy || run.blocked}
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
        workflow cannot see it, and Reserved still holds the money. While armed it affects every payment in flight, so a
        run switches it off the moment its own payment is in REVIEW.
      </p>
      <RunIt run={run} />
      <Switch armed={blackhole.enabled} run={run} show={card.show} flag={{ blackholeRpc: { enabled: !blackhole.enabled, step } }} />
    </section>
  )
}

function CrashCard({ armed, ...card }: { readonly armed: boolean } & CardProps) {
  const run = useRun('crash', card, {
    arm: { flag: (on) => ({ crashAfterSigning: on }), says: 'Armed: the next payment kills the worker the moment its hash is stored.' },
    description: 'Crash run',
    narrate: crashStages,
  })

  return (
    <section className="card">
      <h2 className="card-title">
        Crash after signing · article §9 <Badge armed={armed} />
      </h2>
      <p className="card-value">
        The worker dies between signing and broadcasting, and the payment finishes itself with the bytes it had
        already signed.
      </p>
      <p className="card-note">
        The signing step stores the hash, the signed bytes and the nonce, commits, and then kills its own process:
        nothing was sent, and the payment cannot know whether the transfer went out. Nobody restarts it by hand.
        Docker brings the worker back within seconds, and half a minute later that step runs again, on its second
        attempt, and finds the hash already stored. The next step is the one that asks the network about it, does not
        find it, and sends the same bytes. The process really dies, so it takes down every payment in flight with it:
        each of their steps loses one of its attempts. Run this one on its own.
      </p>
      <RunIt run={run} />
      <Switch armed={armed} run={run} show={card.show} flag={{ crashAfterSigning: !armed }} />
    </section>
  )
}

/**
 * §9's double click. Nothing is armed and nothing is broken: the failure is the reader's own
 * nervous second click, so the card has no badge and no switch, and its long way is the command.
 */
function DoubleClickCard(card: CardProps) {
  // What the two calls answered, kept for the verdict: it has to say whether they name one payment.
  const answers = useRef<readonly PaymentAnswer[]>([])
  const run = useRun('double-click', card, {
    description: 'Double-click run',
    fire: async (payableId, key) => {
      answers.current = await doubleClick(payableId, key)
      return { reference: answers.current[0]?.payment.reference ?? '', stages: answers.current.map(answerStage) }
    },
    narrate: (steps) => doubleClickVerdict(steps, answers.current),
  })

  return (
    <section className="card">
      <h2 className="card-title">Double click · article §9</h2>
      <p className="card-value">
        The same invoice is paid twice at the same instant, with the same key, and one payment comes out of it.
      </p>
      <p className="card-note">
        Both requests carry the key this run made once, and both leave before either one answers. One of them records
        the payment and is told so; the other arrives a moment late, finds that payment already written and gets it
        back. Two answers, one reference, one set of entries, and the money leaves Available once. The long way is the
        command <code>pnpm experiment:double-click</code>.
      </p>
      <RunIt run={run} />
    </section>
  )
}

/**
 * §9's race. The only card that spends nothing, and the only one that does not run on the demo's
 * own books: the two payments together have to be more than Available, and Available here is a few
 * dollars of real testnet money. Its runner is its own, next to `useRun` rather than inside it, but
 * it shares the same latch: there is no invoice, no flag and no payment to follow.
 */
function RaceCard({ running, setRunning }: CardProps) {
  const [result, setResult] = useState<RaceResult | undefined>(undefined)
  const [failure, setFailure] = useState<string | undefined>(undefined)
  const busy = running === 'race'
  const blocked = running !== undefined && !busy

  const start = (): void => {
    setRunning('race')
    setResult(undefined)
    setFailure(undefined)
    runRace()
      .then(setResult, (refused: unknown) => {
        setFailure(sentenceOf(refused))
      })
      .finally(() => {
        setRunning(undefined)
      })
  }

  return (
    <section className="card">
      <h2 className="card-title">The race · article §9</h2>
      <p className="card-value">
        There is 1,500 available and two payments of 1,000 arrive at the same instant, with different keys: one is
        reserved and the other is refused.
      </p>
      <p className="card-note">
        This is the failure the demo's own money cannot show, because the two payments together have to be more than
        Available and Available here is a few dollars of real testnet USDC. So this one runs the article's figures
        against a sandbox database of its own, through the same payment door the Pay button presses: the demo's books
        do not move, and nothing is signed or sent. The long way is the command <code>pnpm experiment:race</code>.
      </p>
      <p className="card-actions">
        <button type="button" className="button" disabled={busy || blocked} onClick={start}>
          {busy ? 'running…' : 'Run it'}
        </button>
        {blocked && <span className="card-note">The other run has to finish first.</span>}
      </p>
      {failure !== undefined && <p className="card-value is-bad">{failure}</p>}
      {result !== undefined && <RaceEvidence result={result} />}
    </section>
  )
}

/** What the race left in the sandbox: the two answers as the api would have sent them, and the books. */
function RaceEvidence({ result }: { readonly result: RaceResult }) {
  return (
    <div className="result">
      <p className="card-value">{raceVerdict(result)}</p>
      <ol className="steps">
        {result.attempts.map((attempt) => (
          <li key={attempt.reference}>
            <code>{attempt.code}</code> {attempt.reference} {attempt.status}{' '}
            {attempt.reason !== undefined && <code>{attempt.reason}</code>} {formatUsdc(attempt.amount)}
          </li>
        ))}
      </ol>
      <dl className="figures">
        <div className="figure">
          <dt>Available before</dt>
          <dd>{formatUsdc(result.availableBefore)}</dd>
        </div>
        <div className="figure">
          <dt>Payments reserved</dt>
          <dd>{result.reserves}</dd>
        </div>
        <div className="figure">
          <dt>Available after</dt>
          <dd>{formatUsdc(result.availableAfter)}</dd>
        </div>
        <div className="figure">
          <dt>Reserved after</dt>
          <dd>{formatUsdc(result.reservedAfter)}</dd>
        </div>
        <div className="figure">
          <dt>Ran against</dt>
          <dd>{result.database}</dd>
        </div>
      </dl>
    </div>
  )
}

/**
 * The three things this card claims, checked rather than announced: one of the two reserved, the
 * other was refused for insufficient funds, and one reserve reached the books. A negative Available
 * is read off the string, because these figures carry thousands separators.
 */
function raceVerdict(result: RaceResult): string {
  const reserved = result.attempts.find((attempt) => attempt.status === 'RESERVED')
  const refused = result.attempts.find((attempt) => attempt.reason === 'insufficient_funds')
  const negative = result.availableAfter.startsWith('-')
  if (reserved === undefined || refused === undefined || result.attempts.length !== 2 || result.reserves !== 1 || negative) {
    return (
      `Not what this card claims: ${count(result.attempts.length, 'payment')} with ` +
      `${count(result.reserves, 'reserve')} in the books, and Available at ${formatUsdc(result.availableAfter)}.`
    )
  }
  return (
    `${reserved.reference} reserved its ${formatUsdc(reserved.amount)} and ${refused.reference} was refused for insufficient ` +
    `funds. Available went from ${formatUsdc(result.availableBefore)} to ${formatUsdc(result.availableAfter)}, and never below zero.`
  )
}

/** One answer, in the order the two requests came back, with the code that says what it did. */
function answerStage({ code, payment }: PaymentAnswer): ReactNode {
  const what = code === 201 ? 'recorded it' : code === 200 ? 'found it already written and answered with it' : 'refused it'
  return (
    <>
      <code>{code}</code> <Link to={`/admin/transfers/${payment.reference}`}>{payment.reference}</Link> {payment.status}: the api {what}.
    </>
  )
}

/**
 * The three things this card claims, checked rather than announced: both answers name the same
 * payment, and that payment left ONE `created` row and ONE `reserved` row in its own story. If any
 * of them is not true, the line says what happened instead.
 */
function doubleClickVerdict(steps: readonly AuditStep[], answers: readonly PaymentAnswer[]): string[] {
  const rows = (event: string): number => steps.filter((step) => step.subjectType === 'payment' && step.event === event).length
  const created = rows('created')
  const reserved = rows('reserved')
  if (created === 0) {
    return []
  }
  const references = new Set(answers.map((answer) => answer.payment.reference))
  const oneReference = answers.length === 2 && references.size === 1
  if (created === 1 && reserved === 1 && oneReference) {
    return [`One payment, one reserve: both answers name ${[...references].join('')}, and ${formatUsdc(RUN_AMOUNT)} USDC left Available once.`]
  }
  return [
    `Not what this card claims: the answers named ${oneReference ? 'one payment' : `${String(references.size)} payments`}, ` +
      `with ${count(created, 'payment')} recorded and ${count(reserved, 'reserve')} in the books. Read the story on Transfers.`,
  ]
}

function count(rows: number, thing: string): string {
  return `${String(rows)} ${thing}${rows === 1 ? '' : 's'}`
}

/**
 * The two moments of §9's crash that a status cannot show, read from the story the run already
 * asks for: the `signed` row that took the flag, and the `sent` row that found the network had
 * never heard of the hash.
 */
function crashStages(steps: readonly AuditStep[]): string[] {
  const stages: string[] = []
  const signed = steps.find((step) => step.event === 'signed' && (step.context.failureInjection ?? '').includes('crash_after_signing'))
  if (signed !== undefined) {
    stages.push(`Signed ${shortened(signed.context.txHash)}, then the worker was killed with nothing sent.`)
  }
  const sent = steps.find((step) => step.event === 'sent' && step.context.networkAlreadyKnew === 'false')
  if (sent !== undefined) {
    stages.push('The worker came back, asked the network about that hash, did not find it, and sent the same bytes.')
  }
  return stages
}

function shortened(hash: string | undefined): string {
  return hash === undefined ? 'it' : `${hash.slice(0, 10)}…${hash.slice(-4)}`
}

/** Run it, the stages the run has reached as it reaches them, and the evidence it ends with. */
function RunIt({ run }: { readonly run: Run }) {
  const { done, doing, failure, payment } = run.state
  // Once a run has started, the stages under the button say all this better than a hint could.
  const hint = run.blocked ? 'The other run has to finish first.' : done.length > 0 ? undefined : `It writes its own ${formatUsdc(RUN_AMOUNT)} USDC invoice and pays it.`

  return (
    <>
      <p className="card-actions">
        <button type="button" className="button" disabled={run.busy || run.blocked} onClick={run.start}>
          {run.busy ? 'running…' : 'Run it'}
        </button>
        {hint !== undefined && <span className="card-note">{hint}</span>}
      </p>

      {(done.length > 0 || doing !== undefined) && (
        <ol className="steps">
          {done.map((line, index) => (
            <li key={String(index)}>{line}</li>
          ))}
          {doing !== undefined && <li className="is-doing">{doing}…</li>}
        </ol>
      )}
      {failure !== undefined && <p className="card-value is-bad">{failure}</p>}
      {payment !== undefined && <Evidence payment={payment} run={run} />}
    </>
  )
}

/** How the run ended: what happened to the money, which payment, and the transfer itself. */
function Evidence({ payment, run }: { readonly payment: PaymentSummary; readonly run: Run }) {
  return (
    <div className="result">
      <p className="card-value">{whatTheMoneyDid(payment)}</p>
      <dl className="figures">
        <div className="figure">
          <dt>Payment</dt>
          <dd>
            <Link to={`/admin/transfers/${payment.reference}`}>{payment.reference}</Link>
          </dd>
        </div>
        <div className="figure">
          <dt>Amount</dt>
          <dd>{formatUsdc(payment.amount)} USDC</dd>
        </div>
        <div className="figure">
          <dt>State</dt>
          <dd>
            {payment.status}
            {payment.reason !== undefined && <> · {payment.reason}</>}
          </dd>
        </div>
      </dl>
      {payment.transaction !== undefined && (
        <>
          <p className="address-sub">The transfer</p>
          <AddressLine address={payment.transaction.hash} explorerUrl={payment.transaction.explorerUrl} />
        </>
      )}
      {payment.status === 'REVIEW' && (
        <p className="card-actions">
          <button
            type="button"
            className="button"
            disabled={run.busy || run.blocked}
            onClick={() => {
              run.resume(payment.reference)
            }}
          >
            Resume
          </button>
        </p>
      )}
    </div>
  )
}

/** The long way: arm the switch by hand and pay your own invoice. */
function Switch({
  armed,
  run,
  show,
  flag,
}: {
  readonly armed: boolean
  readonly run: Run
  readonly show: ExperimentsContext['show']
  readonly flag: Partial<Experiments>
}) {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>(undefined)

  // Sends one flag and nothing else: the screen's copy of the others can be a poll old, and sending
  // it back could re-arm the revert a payment has just taken.
  const change = (): void => {
    setBusy(true)
    setFailure(undefined)
    setExperiments(flag)
      .then(show)
      .catch((refused: unknown) => {
        setFailure(sentenceOf(refused))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <>
      {failure !== undefined && <p className="card-value is-bad">{failure}</p>}
      <p className="card-actions">
        <button type="button" className="link-button" disabled={busy || run.busy || run.blocked} onClick={change}>
          {armed ? 'Disarm' : 'Arm'}
        </button>
        <span className="card-note">
          The long way: this switch, then Pay on your own invoice in <Link to="/admin/payables">Payables</Link>.
        </span>
      </p>
    </>
  )
}

/** What one card's Run it does: the invoice it writes, what it arms if it arms anything, and how it pays. */
interface RunPlan {
  /**
   * The flag this card arms for its own payment, and what to say once it is on. A card that breaks
   * nothing (the double click: two calls a user makes, not a failure injected) leaves it out, and
   * then the run never touches the flags endpoint at all.
   */
  readonly arm?: {
    readonly flag: (armed: boolean) => Partial<Experiments>
    readonly says: string
  }
  readonly description: string
  /**
   * How this card turns its invoice into a payment. The default is the one `POST /payments` every
   * Pay button makes; the double click's makes two at once. It answers the reference the run then
   * follows, and the lines to show for what it did.
   */
  readonly fire?: (payableId: string, key: string) => Promise<Fired>
  /**
   * What this card can tell from the payment's story that its status cannot say. Called with the
   * steps each poll already returns, it answers the stages so far; the run shows the new ones.
   */
  readonly narrate?: (steps: readonly AuditStep[]) => string[]
}

/** What a `fire` leaves the run: the one payment to follow, and what to say about the answers. */
interface Fired {
  readonly reference: string
  readonly stages: readonly ReactNode[]
}

interface RunState {
  readonly done: readonly ReactNode[]
  /** The stage it is on, while it is on it. */
  readonly doing?: string
  /** The payment once it is resting: the evidence block. */
  readonly payment?: PaymentSummary
  readonly failure?: string
}

/** What a card gets back: whether it can start, the stages so far, and the evidence. */
interface Run {
  readonly state: RunState
  readonly busy: boolean
  readonly blocked: boolean
  readonly start: () => void
  readonly resume: (reference: string) => void
}

/** Where the payment is while the run follows it, in the article's words (§7). */
const FOLLOWING: Partial<Record<PaymentView['status'], string>> = {
  CREATED: 'Recorded, reserving its money',
  RESERVED: 'Reserved, waiting to be signed and sent',
  SENT: 'Sent, waiting for the network (a final block takes minutes)',
}

/**
 * One click: write an invoice, arm this card's flag, pay it, follow the payment until nothing else
 * will happen on its own, and disarm again. The flag goes on last, right before the payment that is
 * meant to take it, so nothing else is exposed to it while the invoice is being written. The disarm
 * is in `finally`, and the following is bounded, because the node flag is global: a run that gives
 * up half way must never leave it catching everyone else's payments.
 */
function useRun(card: string, { show, running, setRunning }: CardProps, plan: RunPlan): Run {
  const [state, setState] = useState<RunState>({ done: [] })
  // The attempt's idempotency key (§4), made once per run: a second POST could only replay this payment.
  const key = useRef<string | undefined>(undefined)

  const doing = (stage: string): void => {
    setState((run) => ({ ...run, doing: stage }))
  }
  const did = (line: ReactNode): void => {
    setState((run) => ({ ...run, done: [...run.done, line], doing: undefined }))
  }
  const gaveUp = (error: unknown, what: string): void => {
    setState((run) => ({ ...run, doing: undefined, failure: `${run.failure ?? ''} ${what} ${sentenceOf(error)}`.trim() }))
  }

  /** Asks for the payment's story until it is resting, and keeps it as the evidence. It always
   *  returns, one way or another, so the disarm in `finally` always happens. */
  const follow = async (reference: string): Promise<void> => {
    const until = Date.now() + RUN_LIMIT_MS
    let blips = 0
    // How many of the card's own stages are already on screen, so each one is shown once.
    let narrated = 0
    while (Date.now() < until) {
      try {
        const { payment, steps } = await getPaymentTimeline(reference)
        blips = 0
        for (const stage of (plan.narrate?.(steps) ?? []).slice(narrated)) {
          did(stage)
          narrated += 1
        }
        if (isResting(payment.status)) {
          setState((run) => ({ ...run, doing: undefined, payment }))
          return
        }
        doing(FOLLOWING[payment.status] ?? 'Following the payment')
      } catch (error: unknown) {
        blips += 1
        if (blips > RUN_READ_BLIPS) {
          throw error
        }
      }
      await wait(RUN_POLL_MS)
    }
    // Out of time, not out of money: the payment carries on and its story is the record.
    did(
      <>
        No end either way after {String(Math.round(RUN_LIMIT_MS / 60_000))} minutes, so this card stops following it. It is still
        going: see <Link to={`/admin/transfers/${reference}`}>{reference}</Link> on Transfers.
      </>,
    )
  }

  const start = async (): Promise<void> => {
    setRunning(card)
    setState({ done: [], doing: `Writing an invoice for ${formatUsdc(RUN_AMOUNT)} USDC` })
    try {
      await nothingElseInFlight()
      const partner = (await getPayables()).partners[0]
      if (partner === undefined) {
        throw new Error('there is no active partner to invoice. Add one on Partners.')
      }
      // The api answers the whole screen, invoices newest first, so the new one is the first row.
      const invoice = (await createPayable({ partnerId: partner.id, amount: RUN_AMOUNT, description: plan.description })).payables[0]
      if (invoice === undefined) {
        throw new Error('the api did not answer with the invoice it had just written.')
      }
      did(`Invoice for ${formatUsdc(RUN_AMOUNT)} USDC to ${partner.name}.`)

      if (plan.arm !== undefined) {
        doing('Arming the switch')
        show(await setExperiments(plan.arm.flag(true)))
        did(plan.arm.says)
      }

      doing('Paying it')
      key.current ??= crypto.randomUUID()
      const fired = await (plan.fire ?? payOnce)(invoice.id, key.current)
      for (const stage of fired.stages) {
        did(stage)
      }

      await follow(fired.reference)
    } catch (error: unknown) {
      gaveUp(error, 'The run stopped:')
    } finally {
      key.current = undefined
      // A card that armed nothing never sends a flag, not even to switch one off: this screen is
      // the only thing that arms them, and a stray PUT could disarm a run somebody else started.
      if (plan.arm !== undefined) {
        await setExperiments(plan.arm.flag(false)).then(show, (refused: unknown) => {
          gaveUp(refused, 'The run could not switch this off, so press Disarm:')
        })
      }
      setRunning(undefined)
    }
  }

  const resume = async (reference: string): Promise<void> => {
    setRunning(card)
    // The evidence goes while the payment moves again; the run ends with what it found this time.
    setState((run) => ({ ...run, payment: undefined, doing: 'Resuming' }))
    try {
      await resumePayment(reference)
      did('Resumed: back where it was, and its workflow looks for the proof again with the same signed bytes.')
      await follow(reference)
    } catch (error: unknown) {
      gaveUp(error, 'The resume stopped:')
    } finally {
      setRunning(undefined)
    }
  }

  return {
    state,
    busy: running === card,
    blocked: running !== undefined && running !== card,
    start: () => {
      void start()
    },
    resume: (reference: string) => {
      void resume(reference)
    },
  }
}

/** What every card but the double click does with its invoice: the one call the Pay button makes. */
async function payOnce(payableId: string, key: string): Promise<Fired> {
  const payment = await payPayable(payableId, key)
  return { reference: payment.reference, stages: [payStage(payment)] }
}

/**
 * A run wants the demo to itself. A card that breaks something breaks it for every payment in
 * flight (a killed step costs each of them one of its five attempts), and a card that breaks
 * nothing still needs its evidence to be about its own payment. So a run does not start while one
 * is moving. REVIEW and the ends are fine; nothing moves them on its own.
 */
async function nothingElseInFlight(): Promise<void> {
  const moving = (await getPayments()).payments.find((payment) => !isResting(payment.status))
  if (moving !== undefined) {
    throw new Error(`${moving.reference} is still ${moving.status}. A run wants the demo to itself, so it waits until nothing else is moving.`)
  }
}

/** What the pay step did. The api answers a refusal at the door with the payment it recorded as
 *  FAILED, so the stage says that instead of claiming money moved. */
function payStage(payment: PaymentView): ReactNode {
  const reference = <Link to={`/admin/transfers/${payment.reference}`}>{payment.reference}</Link>
  if (payment.status !== 'FAILED') {
    return (
      <>
        Paid as {reference}: {formatUsdc(RUN_AMOUNT)} USDC moved from Available to Reserved.
      </>
    )
  }
  return (
    <>
      Refused as {reference}: {payment.reason === undefined ? '' : `${REASONS[payment.reason]} `}
      {failedAfterReserving(payment.reason) ? 'The money is back in Available.' : 'Nothing was reserved.'}
    </>
  )
}

/** What happened to the money, in one sentence, the way the payment's story tells it. The amount is
 *  next to it in the figures, so the sentence does not repeat it. */
function whatTheMoneyDid(payment: PaymentSummary): string {
  const why = payment.reason === undefined ? '' : `${REASONS[payment.reason]} `
  switch (payment.status) {
    case 'FAILED':
      return failedAfterReserving(payment.reason)
        ? `${why}No stablecoin moved: the money is back in Available and the invoice can be paid again.`
        : `${why}Nothing was reserved.`
    case 'REVIEW':
      return 'No proof either way, so the money stays in Reserved until it is resumed.'
    case 'SETTLED':
      return "Paid: Reserved went down by this amount and the invoice's debt was cleared."
    default:
      return `The payment is ${payment.status}.`
  }
}

/** Nothing moves a payment in one of these on its own: the run stops and shows what it found. */
function isResting(status: PaymentView['status']): boolean {
  return status === 'SETTLED' || status === 'FAILED' || status === 'REVIEW'
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function sentenceOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function Badge({ armed }: { readonly armed: boolean }) {
  return <span className={armed ? 'badge is-armed' : 'badge'}>{armed ? 'armed' : 'off'}</span>
}
