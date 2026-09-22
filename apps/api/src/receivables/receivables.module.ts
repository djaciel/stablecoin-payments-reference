import { Module } from '@nestjs/common'
import type { Pool } from '@payments/db'
import { DATABASE_POOL, DbModule } from '../db/db.module'
import { ReceivablesController } from './receivables.controller'
import { RECEIVABLES_SERVICE, ReceivablesService } from './receivables.service'

/** Invoices a partner owes and the accrual they put on the books: Postgres only, no chain. */
@Module({
  imports: [DbModule],
  controllers: [ReceivablesController],
  providers: [
    {
      provide: RECEIVABLES_SERVICE,
      // Injected by explicit token: tsx emits no decorator metadata (see `src/db/db.module.ts`).
      useFactory: (pool: Pool): ReceivablesService => new ReceivablesService(pool),
      inject: [DATABASE_POOL],
    },
  ],
})
export class ReceivablesModule {}
