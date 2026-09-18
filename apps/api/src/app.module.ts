import { Module } from '@nestjs/common'
import { DbModule } from './db/db.module'
import { HealthController } from './health/health.controller'
import { SignerClientModule } from './signer/signer-client.module'
import { TreasuryController } from './treasury/treasury.controller'

/**
 * The root module: the controllers the API exposes, and the modules that provide what
 * those controllers inject.
 *
 * The repo's rule for Nest: a folder gets its own `<name>.module.ts` only when it
 * provides something (`db/` provides the pool, `signer/` provides the HTTP client). A
 * folder that is just a controller is registered here, because a module whose whole body
 * is `controllers: [OneController]` is a file to open, read and close again for nothing.
 * A controller that grows a service gets its module then, not before.
 */
@Module({
  imports: [DbModule, SignerClientModule],
  controllers: [HealthController, TreasuryController],
})
export class AppModule {}
