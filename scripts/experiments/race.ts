import type { RaceAttempt, RaceResult } from '@payments/domain'
import { died, field, heading, post, section } from './harness'

/**
 * §9's race: Available 1,500 and two payments of 1,000 arriving at the same instant, with
 * different keys. One is reserved, the other is refused for insufficient funds, and Available
 * never crosses into negative.
 *
 *   pnpm experiment:race
 *
 * It presses the same door the Break it card presses, and it is the one command here that spends
 * nothing and takes seconds: the article's figures need more money than the demo's treasury holds,
 * so the api runs the race against a sandbox database of its own. The name of that database is
 * printed below, and the demo's books do not move.
 */

const NAME = 'experiment:race'

async function main(): Promise<void> {
  heading(NAME, 'two payments of 1,000 against an available 1,500', 'none: this one never leaves the database')

  const race = await post<RaceResult>('/experiments/race')

  section('Where it ran')
  field('database', race.database)
  field('available before', race.availableBefore)

  section('The two answers')
  for (const [index, attempt] of race.attempts.entries()) {
    field(`attempt ${String(index + 1)}`, answerLine(attempt))
  }

  section('What it moved')
  field('payments reserved', race.reserves)
  field('available after', race.availableAfter)
  field('reserved after', race.reservedAfter)

  section('What it proves')
  console.log(verdict(race))
  console.log('')
}

function answerLine({ code, reference, status, reason, amount }: RaceAttempt): string {
  return `${String(code)}  ${reference}  ${status}${reason === undefined ? '' : `  ${reason}`}  ${amount}`
}

/**
 * Three claims, checked rather than printed: one reserve, one refusal, and Available never negative.
 * The last is read off the string, because these figures carry thousands separators.
 */
function verdict(race: RaceResult): string {
  const reserved = race.attempts.find((attempt) => attempt.status === 'RESERVED')
  const refused = race.attempts.find((attempt) => attempt.reason === 'insufficient_funds')
  const negative = race.availableAfter.startsWith('-')
  if (reserved === undefined || refused === undefined || race.attempts.length !== 2 || race.reserves !== 1 || negative) {
    return (
      `  Not proven: ${String(race.attempts.length)} payment(s) with ${String(race.reserves)} reserve(s) in the\n` +
      `  books, and Available at ${race.availableAfter}. Read ${race.database} before running anything else.`
    )
  }
  return (
    `  Both read the same 1,500 and only one of them fit: ${reserved.reference} reserved its\n` +
    `  ${reserved.amount} and ${refused.reference} was refused for insufficient funds. One reserve in the\n` +
    `  books, Available ${race.availableBefore} → ${race.availableAfter}, and it never crossed into negative.\n` +
    `  None of it touched the demo's own books: it all happened in ${race.database}.`
  )
}

main().catch((error: unknown) => died(NAME, error))
