import { Module } from '@nestjs/common'
import { DbModule } from '../db/db.module'
import { HealthController } from './health.controller'

/**
 * One directory per module, one module per thing the API does: this is the shape every
 * later module copies. A module with logic gets a `<name>.service.ts` as well, and that
 * service calls into `packages/*` — the business rules live there, not in a controller.
 */
@Module({
  imports: [DbModule],
  controllers: [HealthController],
})
export class HealthModule {}
