import { BadRequestException, Body, Controller, Get, Inject, Put } from '@nestjs/common'
import type { Pool } from '@payments/db'
import { BLACKHOLE_STEPS, EXPERIMENT_KEYS, type ArmedFlag, type BlackholeStep, type Experiments } from '@payments/domain'
import { DATABASE_POOL } from '../db/db.module'

/**
 * The failure-injection switches of the Break it screen. The api only stores them: nothing on its
 * own path reads a flag, so Pay and the Start screen behave the same while one is armed.
 */
@Controller('settings/experiments')
export class ExperimentsController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Get()
  async read(): Promise<Experiments> {
    return readExperiments(this.pool)
  }

  /**
   * Changes only the flags it is sent. A screen's copy of the flags can be a poll old, so sending
   * them all back could re-arm the one-shot revert right after a payment took it.
   */
  @Put()
  async write(@Body() body: unknown): Promise<Experiments> {
    const changes = changesIn(body)
    if (changes === undefined) {
      throw new BadRequestException(
        'Send revertNextPayment and crashAfterSigning as { "enabled": true or false, "payableId": an invoice id or left out }, blackholeRpc as the same plus "step": "execute" or "watch", any of them, and nothing else.',
      )
    }
    if (changes.revertNextPayment !== undefined) {
      await writeFlag(this.pool, EXPERIMENT_KEYS.revertNextPayment, changes.revertNextPayment)
    }
    if (changes.crashAfterSigning !== undefined) {
      await writeFlag(this.pool, EXPERIMENT_KEYS.crashAfterSigning, changes.crashAfterSigning)
    }
    if (changes.blackholeRpc !== undefined) {
      await writeFlag(this.pool, EXPERIMENT_KEYS.blackholeRpc, changes.blackholeRpc)
    }
    return readExperiments(this.pool)
  }
}

/** The fields sent, each one known and well-formed; undefined otherwise. */
function changesIn(body: unknown): Partial<Experiments> | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return undefined
  }
  const { revertNextPayment, crashAfterSigning, blackholeRpc, ...unknownFields } = body as Record<string, unknown>
  if (Object.keys(unknownFields).length > 0) {
    return undefined
  }
  if (revertNextPayment !== undefined && !isFlag(revertNextPayment)) {
    return undefined
  }
  if (crashAfterSigning !== undefined && !isFlag(crashAfterSigning)) {
    return undefined
  }
  if (blackholeRpc !== undefined && !isBlackhole(blackholeRpc)) {
    return undefined
  }
  return { revertNextPayment, crashAfterSigning, blackholeRpc }
}

/** `{ enabled, payableId? }`: the invoice whose payment it breaks, or none for the next payment. */
function isFlag(value: unknown): value is ArmedFlag {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const { enabled, payableId, ...unknownFields } = value as Record<string, unknown>
  return typeof enabled === 'boolean' && (payableId === undefined || typeof payableId === 'string') && Object.keys(unknownFields).length === 0
}

function isBlackhole(value: unknown): value is Experiments['blackholeRpc'] {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const { step, ...flag } = value as Record<string, unknown>
  return BLACKHOLE_STEPS.includes(step as BlackholeStep) && isFlag(flag)
}

/** An absent row, or a `true` stored before flags named an invoice, is off; "Node not responding" defaults to after the broadcast. */
async function readExperiments(pool: Pool): Promise<Experiments> {
  const result = await pool.query<{ key: string; value: unknown }>('SELECT key, value FROM settings WHERE key = ANY($1)', [
    Object.values(EXPERIMENT_KEYS),
  ])
  const stored = new Map(result.rows.map((row) => [row.key, row.value]))
  const blackhole = stored.get(EXPERIMENT_KEYS.blackholeRpc) as { step?: BlackholeStep } | undefined
  return {
    revertNextPayment: flagIn(stored.get(EXPERIMENT_KEYS.revertNextPayment)),
    crashAfterSigning: flagIn(stored.get(EXPERIMENT_KEYS.crashAfterSigning)),
    blackholeRpc: { ...flagIn(blackhole), step: blackhole?.step ?? 'watch' },
  }
}

function flagIn(value: unknown): ArmedFlag {
  const { enabled, payableId } = (typeof value === 'object' && value !== null ? value : {}) as Partial<ArmedFlag>
  return enabled === true ? { enabled, ...(payableId === undefined ? {} : { payableId }) } : { enabled: false }
}

async function writeFlag(pool: Pool, key: string, value: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  )
}
