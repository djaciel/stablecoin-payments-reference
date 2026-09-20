import { Module } from '@nestjs/common'
import { createChainClient, type ChainClient } from '@payments/chain'

/**
 * Injected by explicit token, never by class type: tsx emits no decorator metadata for Nest to
 * read (see `src/db/db.module.ts`).
 */
export const CHAIN_CLIENT = Symbol('CHAIN_CLIENT')

/** One client for the process. It reads only; it cannot sign, because the api holds no key. */
@Module({
  providers: [
    {
      provide: CHAIN_CLIENT,
      useFactory: (): ChainClient => createChainClient(),
    },
  ],
  exports: [CHAIN_CLIENT],
})
export class ChainModule {}
