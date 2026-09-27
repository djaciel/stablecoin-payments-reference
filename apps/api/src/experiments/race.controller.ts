import { Controller, HttpCode, HttpStatus, Inject, InternalServerErrorException, Post } from '@nestjs/common'
import type { Pool } from '@payments/db'
import type { RaceResult } from '@payments/domain'
import { DATABASE_POOL } from '../db/db.module'
import { runRace } from './race'

/**
 * The race, from one call and with no body: the two racing calls happen inside the api, on two
 * connections, because two requests from a browser could not be made to arrive at the same instant.
 */
@Controller('experiments')
export class RaceController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Post('race')
  @HttpCode(HttpStatus.OK)
  async race(): Promise<RaceResult> {
    try {
      return await runRace(this.pool)
    } catch (error: unknown) {
      // A sandbox it may not touch, or a migration that fails there: whichever it was, the sentence
      // it refused with is the only useful thing to show.
      throw new InternalServerErrorException(`the race did not run: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
