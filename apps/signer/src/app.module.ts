import { Module } from '@nestjs/common'
import { AddressesController } from './addresses/addresses.controller'
import { HealthController } from './health/health.controller'
import { KeysModule } from './keys/keys.module'
import { SignController } from './sign/sign.controller'

/**
 * The root module, with the same shape as the api's: controller folders are registered
 * here, and only a folder that provides something — `keys/`, which provides the loaded
 * seed — keeps a module of its own.
 */
@Module({
  imports: [KeysModule],
  controllers: [HealthController, AddressesController, SignController],
})
export class AppModule {}
