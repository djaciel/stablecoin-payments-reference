import { Module } from '@nestjs/common'
import type { Pool } from '@payments/db'
import { DATABASE_POOL, DbModule } from '../db/db.module'
import { PayablesController } from './payables.controller'
import { PAYABLES_SERVICE, PayablesService } from './payables.service'

/** Invoices and the debt they put on the books: Postgres only, no chain and no signer. */
@Module({
  imports: [DbModule],
  controllers: [PayablesController],
  providers: [
    {
      provide: PAYABLES_SERVICE,
      // Injected by explicit token: tsx emits no decorator metadata (see `src/db/db.module.ts`).
      useFactory: (pool: Pool): PayablesService => new PayablesService(pool),
      inject: [DATABASE_POOL],
    },
  ],
})
export class PayablesModule {}
