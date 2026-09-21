import { Module } from '@nestjs/common'
import { readEnv } from '@payments/domain'
import { PartnerKeysService } from './partner-keys.service'

/**
 * The injection token for the partner keys, by explicit token like everything else here:
 * tsx emits no decorator metadata for Nest to read (see `src/db/db.module.ts`).
 */
export const PARTNER_KEYS = Symbol('PARTNER_KEYS')

const DEFAULT_PARTNER_KEYS_DIR = '/partner-keys'

/**
 * The seed is loaded once, at startup, by an async factory: a missing keys directory stops
 * the api before it listens, and every request afterwards derives from memory.
 */
@Module({
  providers: [
    {
      provide: PARTNER_KEYS,
      useFactory: (): Promise<PartnerKeysService> => PartnerKeysService.load(readPartnerKeysDir()),
    },
  ],
  exports: [PARTNER_KEYS],
})
export class DemoScaffoldingModule {}

/**
 * The only place that reads PARTNER_KEYS_DIR. The default is the path compose bind-mounts;
 * set the variable to run the api straight on your machine.
 */
function readPartnerKeysDir(): string {
  return readEnv('PARTNER_KEYS_DIR', DEFAULT_PARTNER_KEYS_DIR)
}
