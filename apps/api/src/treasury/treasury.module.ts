import { Module } from '@nestjs/common'
import type { ChainClient } from '@payments/chain'
import type { Pool } from '@payments/db'
import { CHAIN_CLIENT, ChainModule } from '../chain/chain.module'
import { DATABASE_POOL, DbModule } from '../db/db.module'
import { DemoScaffoldingModule, PARTNER_KEYS } from '../demo-scaffolding/demo-scaffolding.module'
import type { PartnerKeysService } from '../demo-scaffolding/partner-keys.service'
import { SIGNER_CLIENT, SignerClientModule } from '../signer/signer-client.module'
import type { SignerClient } from '../signer/signer-client.service'
import { FUND_PARTNER_WALLET_SERVICE, FundPartnerWalletService } from './fund-partner-wallet.service'
import { TreasuryController } from './treasury.controller'
import { TREASURY_SERVICE, TreasuryService } from './treasury.service'

/** It provides services now, so by this repo's rule the feature gets a module of its own. */
@Module({
  // The partner seed is here because "Fund partner wallet" needs the address it pays: the
  // treasury sends, the partner wallet receives, and only the api knows both.
  imports: [ChainModule, DbModule, DemoScaffoldingModule, SignerClientModule],
  controllers: [TreasuryController],
  providers: [
    {
      provide: TREASURY_SERVICE,
      // Injected by explicit token, like everything else here: tsx emits no decorator
      // metadata for Nest to read (see `src/db/db.module.ts`).
      useFactory: (signer: SignerClient, partnerKeys: PartnerKeysService, pool: Pool): TreasuryService =>
        new TreasuryService(signer, partnerKeys, pool),
      inject: [SIGNER_CLIENT, PARTNER_KEYS, DATABASE_POOL],
    },
    {
      provide: FUND_PARTNER_WALLET_SERVICE,
      // It asks the treasury who is sending and who receives, rather than holding a second
      // copy of the signer and the partner seed.
      useFactory: (
        treasury: TreasuryService,
        signer: SignerClient,
        chain: ChainClient,
        pool: Pool,
      ): FundPartnerWalletService => new FundPartnerWalletService(treasury, signer, chain, pool),
      inject: [TREASURY_SERVICE, SIGNER_CLIENT, CHAIN_CLIENT, DATABASE_POOL],
    },
  ],
})
export class TreasuryModule {}
