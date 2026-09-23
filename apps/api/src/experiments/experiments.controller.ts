import { BadRequestException, Body, Controller, Get, Inject, Put } from '@nestjs/common'
import type { Pool } from '@payments/db'
import { BLACKHOLE_STEPS, EXPERIMENT_KEYS, type BlackholeStep, type Experiments } from '@payments/domain'
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
        'Send revertNextPayment (true or false), crashAfterSigning (true or false), blackholeRpc ({ "enabled": true or false, "step": "execute" or "watch" }), any of them, and nothing else.',
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
  if (revertNextPayment !== undefined && typeof revertNextPayment !== 'boolean') {
    return undefined
  }
  if (crashAfterSigning !== undefined && typeof crashAfterSigning !== 'boolean') {
    return undefined
  }
  if (blackholeRpc !== undefined && !isBlackhole(blackholeRpc)) {
    return undefined
  }
  return { revertNextPayment, crashAfterSigning, blackholeRpc }
}

function isBlackhole(value: unknown): value is Experiments['blackholeRpc'] {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  const { enabled, step, ...unknownFields } = value as Record<string, unknown>
  return typeof enabled === 'boolean' && BLACKHOLE_STEPS.includes(step as BlackholeStep) && Object.keys(unknownFields).length === 0
}

/** An absent row is off; "Node not responding" defaults to after the broadcast. */
async function readExperiments(pool: Pool): Promise<Experiments> {
  const result = await pool.query<{ key: string; value: unknown }>('SELECT key, value FROM settings WHERE key = ANY($1)', [
    Object.values(EXPERIMENT_KEYS),
  ])
  const stored = new Map(result.rows.map((row) => [row.key, row.value]))
  return {
    revertNextPayment: stored.get(EXPERIMENT_KEYS.revertNextPayment) === true,
    crashAfterSigning: stored.get(EXPERIMENT_KEYS.crashAfterSigning) === true,
    blackholeRpc: (stored.get(EXPERIMENT_KEYS.blackholeRpc) as Experiments['blackholeRpc'] | undefined) ?? { enabled: false, step: 'watch' },
  }
}

async function writeFlag(pool: Pool, key: string, value: unknown): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  )
}
