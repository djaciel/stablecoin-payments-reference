import { Controller, Get, Inject, Logger, ServiceUnavailableException } from '@nestjs/common'
import type { Pool } from '@payments/db'
import type { Health } from '@payments/domain'
import { DATABASE_POOL } from '../db/db.module'

@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name)

  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  /**
   * Health means "this service can reach its database", not "the process is alive".
   * A process that answers 200 while Postgres is gone is worse than one that answers 503:
   * compose, a load balancer and a reader all believe it.
   */
  @Get()
  async check(): Promise<Health> {
    try {
      await this.pool.query('SELECT 1')
      return { status: 'ok', database: 'up' }
    } catch (error) {
      this.logger.error('health check could not reach the database', error)
      // The object is the response body, verbatim, with status 503.
      throw new ServiceUnavailableException({ status: 'degraded', database: 'unreachable' })
    }
  }
}
