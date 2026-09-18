import { Module } from '@nestjs/common'
import { createChainClient, type ChainClient } from '@payments/chain'

/**
 * The injection token for the read-only chain client, following the repo's rule:
 * dependencies are injected by explicit token, never by class type, because tsx emits no
 * decorator metadata for Nest to read (see `src/db/db.module.ts`).
 */
export const CHAIN_CLIENT = Symbol('CHAIN_CLIENT')

/**
 * One client for the process, built in one place — the same reasoning as the pool: a
 * second client means a second set of connections to the RPC and two places to fix when
 * the endpoint changes. It reads only; it cannot sign, because the api holds no key.
 */
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
