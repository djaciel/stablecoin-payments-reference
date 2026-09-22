import { Module } from '@nestjs/common'
import type { Pool } from '@payments/db'
import { ChainModule } from '../chain/chain.module'
import { DATABASE_POOL, DbModule } from '../db/db.module'
import { DemoScaffoldingModule, PARTNER_KEYS } from '../demo-scaffolding/demo-scaffolding.module'
import type { PartnerKeysService } from '../demo-scaffolding/partner-keys.service'
import { SIGNER_CLIENT, SignerClientModule } from '../signer/signer-client.module'
import type { SignerClient } from '@payments/chain'
import { PartnersController } from './partners.controller'
import { PARTNERS_SERVICE, PartnersService } from './partners.service'

/** Both seeds meet here, one address each, and neither ever leaves its own holder. */
@Module({
  imports: [ChainModule, DbModule, DemoScaffoldingModule, SignerClientModule],
  controllers: [PartnersController],
  providers: [
    {
      provide: PARTNERS_SERVICE,
      // Injected by explicit token, like everything else here: tsx emits no decorator
      // metadata for Nest to read (see `src/db/db.module.ts`).
      useFactory: (signer: SignerClient, partnerKeys: PartnerKeysService, pool: Pool): PartnersService =>
        new PartnersService(signer, partnerKeys, pool),
      inject: [SIGNER_CLIENT, PARTNER_KEYS, DATABASE_POOL],
    },
  ],
})
export class PartnersModule {}
