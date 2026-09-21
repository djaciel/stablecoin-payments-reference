import { Module } from '@nestjs/common'
import { DbModule } from './db/db.module'
import { HealthController } from './health/health.controller'
import { PartnersModule } from './partners/partners.module'
import { PayablesModule } from './payables/payables.module'
import { PaymentsController } from './payments/payments.controller'
import { TreasuryModule } from './treasury/treasury.module'

/**
 * The root module: the controllers the API exposes, and the modules that provide what
 * those controllers inject.
 *
 * The repo's rule for Nest: a folder gets its own `<name>.module.ts` only when it
 * provides something (`db/` provides the pool, `signer/` provides the HTTP client). A
 * folder that is just a controller is registered here, because a module whose whole body
 * is `controllers: [OneController]` is a file to open, read and close again for nothing.
 * A controller that grows a service gets its module then, not before — which is exactly
 * what happened to `treasury/` in T-09: it now registers the watched address and reads the
 * last funding, so it owns its controller and brings its own dependencies with it.
 */
@Module({
  imports: [DbModule, PartnersModule, PayablesModule, TreasuryModule],
  controllers: [HealthController, PaymentsController],
})
export class AppModule {}
