import { Module } from '@nestjs/common'
import type { Pool } from '@payments/db'
import { ChainModule } from '../chain/chain.module'
import { DATABASE_POOL, DbModule } from '../db/db.module'
import { SIGNER_CLIENT, SignerClientModule } from '../signer/signer-client.module'
import type { SignerClient } from '../signer/signer-client.service'
import { TreasuryController } from './treasury.controller'
import { TREASURY_SERVICE, TreasuryService } from './treasury.service'

/**
 * The treasury feature finally provides something — it registers the address the watcher
 * looks at, and reads the books — so by this repo's rule it gets a module of its own. Until
 * T-09 it was one controller registered in `app.module.ts`.
 */
@Module({
  imports: [ChainModule, DbModule, SignerClientModule],
  controllers: [TreasuryController],
  providers: [
    {
      provide: TREASURY_SERVICE,
      // Injected by explicit token, like everything else here: tsx emits no decorator
      // metadata for Nest to read (see `src/db/db.module.ts`).
      useFactory: (signer: SignerClient, pool: Pool): TreasuryService => new TreasuryService(signer, pool),
      inject: [SIGNER_CLIENT, DATABASE_POOL],
    },
  ],
})
export class TreasuryModule {}
