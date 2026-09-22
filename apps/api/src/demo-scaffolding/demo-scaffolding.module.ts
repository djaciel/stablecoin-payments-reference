import { Module } from '@nestjs/common'
import type { ChainClient } from '@payments/chain'
import type { Pool } from '@payments/db'
import { readEnv } from '@payments/domain'
import { CHAIN_CLIENT, ChainModule } from '../chain/chain.module'
import { DATABASE_POOL, DbModule } from '../db/db.module'
import { DemoScaffoldingController } from './demo-scaffolding.controller'
import { PARTNER_PAYMENTS_SERVICE, PartnerPaymentsService } from './partner-payments.service'
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
 *
 * The signer is not among the dependencies here, and must not become one: this module holds
 * the partner seed, that service holds the company's, and neither ever sees the other's.
 */
@Module({
  imports: [ChainModule, DbModule],
  controllers: [DemoScaffoldingController],
  providers: [
    {
      provide: PARTNER_KEYS,
      useFactory: (): Promise<PartnerKeysService> => PartnerKeysService.load(readPartnerKeysDir()),
    },
    {
      provide: PARTNER_PAYMENTS_SERVICE,
      useFactory: (pool: Pool, chain: ChainClient, partnerKeys: PartnerKeysService): PartnerPaymentsService =>
        new PartnerPaymentsService(pool, chain, partnerKeys),
      inject: [DATABASE_POOL, CHAIN_CLIENT, PARTNER_KEYS],
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
