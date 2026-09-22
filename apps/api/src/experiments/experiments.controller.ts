import { BadRequestException, Body, Controller, Get, Inject, Put } from '@nestjs/common'
import type { Pool } from '@payments/db'
import { EXPERIMENT_KEYS, type Experiments } from '@payments/domain'
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

  @Put()
  async write(@Body() body: unknown): Promise<Experiments> {
    const revertNextPayment: unknown =
      typeof body === 'object' && body !== null && 'revertNextPayment' in body ? body.revertNextPayment : undefined
    if (typeof revertNextPayment !== 'boolean') {
      throw new BadRequestException('revertNextPayment must be true or false.')
    }
    await writeFlag(this.pool, EXPERIMENT_KEYS.revertNextPayment, revertNextPayment)
    return readExperiments(this.pool)
  }
}

/** An absent row is off. */
async function readExperiments(pool: Pool): Promise<Experiments> {
  const result = await pool.query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [EXPERIMENT_KEYS.revertNextPayment])
  return { revertNextPayment: result.rows[0]?.value === true }
}

async function writeFlag(pool: Pool, key: string, value: boolean): Promise<void> {
  await pool.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  )
}
