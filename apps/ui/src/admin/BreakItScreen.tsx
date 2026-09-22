import { useRef, useState, type ReactNode } from 'react'
import { Link, useOutletContext } from 'react-router-dom'
import { failedAfterReserving, type BlackholeStep, type Experiments, type PaymentSummary, type PaymentView } from '@payments/domain'
import { createPayable, getPayables, getPaymentTimeline, payPayable, resumePayment, setExperiments } from '../api/client'
import { AddressLine } from '../app/AddressLine'
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

  const card: CardProps = { show, running, setRunning }
  return (
    <div className="cards">
      <RevertCard armed={experiments.revertNextPayment} {...card} />
      <BlackholeCard blackhole={experiments.blackholeRpc} {...card} />
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
    flag: (on) => ({ revertNextPayment: on }),
    armed: 'Armed: the next payment is signed with a gas limit too low to finish.',
    description: 'Revert run',
  })

  return (
    <section className="card">
      <h2 className="card-title">
        Revert the next payment <Badge armed={armed} />
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
    flag: (on) => ({ blackholeRpc: { enabled: on, step } }),
    armed: `Armed: the node stops answering ${BLACKHOLE_WHERE[step]} (${step}).`,
    description: 'Stuck run',
  })

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

/** Run it, the stages the run has reached as it reaches them, and the evidence it ends with. */
function RunIt({ run }: { readonly run: Run }) {
  const { done, doing, failure, payment } = run.state
  // Once a run has started, the stages under the button say all this better than a hint could.
  const hint = run.blocked ? 'The other run has to finish first.' : done.length > 0 ? undefined : `It writes its own ${RUN_AMOUNT} USDC invoice and pays it.`

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
          <dd>{payment.amount} USDC</dd>
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

/** What one card's Run it arms and disarms, what it says once armed, and the invoice it writes. */
interface RunPlan {
  readonly flag: (armed: boolean) => Partial<Experiments>
  readonly armed: string
  readonly description: string
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
    while (Date.now() < until) {
      try {
        const { payment } = await getPaymentTimeline(reference)
        blips = 0
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
    setState({ done: [], doing: `Writing an invoice for ${RUN_AMOUNT} USDC` })
    try {
      const partner = (await getPayables()).partners[0]
      if (partner === undefined) {
        throw new Error('there is no active partner to invoice. Add one on Partners.')
      }
      // The api answers the whole screen, invoices newest first, so the new one is the first row.
      const invoice = (await createPayable({ partnerId: partner.id, amount: RUN_AMOUNT, description: plan.description })).payables[0]
      if (invoice === undefined) {
        throw new Error('the api did not answer with the invoice it had just written.')
      }
      did(`Invoice for ${RUN_AMOUNT} USDC to ${partner.name}.`)

      doing('Arming the switch')
      show(await setExperiments(plan.flag(true)))
      did(plan.armed)

      doing('Paying it')
      key.current ??= crypto.randomUUID()
      const payment = await payPayable(invoice.id, key.current)
      did(payStage(payment))

      await follow(payment.reference)
    } catch (error: unknown) {
      gaveUp(error, 'The run stopped:')
    } finally {
      key.current = undefined
      await setExperiments(plan.flag(false)).then(show, (refused: unknown) => {
        gaveUp(refused, 'The run could not switch this off, so press Disarm:')
      })
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

/** What the pay step did. The api answers a refusal at the door with the payment it recorded as
 *  FAILED, so the stage says that instead of claiming money moved. */
function payStage(payment: PaymentView): ReactNode {
  const reference = <Link to={`/admin/transfers/${payment.reference}`}>{payment.reference}</Link>
  if (payment.status !== 'FAILED') {
    return (
      <>
        Paid as {reference}: {RUN_AMOUNT} USDC moved from Available to Reserved.
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
