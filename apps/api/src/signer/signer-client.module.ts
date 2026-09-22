import { Module } from '@nestjs/common'
import { SignerClient, readSignerUrl } from '@payments/chain'

/**
 * The injection token for the signer client, following the repo's rule: dependencies are
 * injected by explicit token, never by class type, because tsx emits no decorator
 * metadata for Nest to read (see `src/db/db.module.ts`).
 */
export const SIGNER_CLIENT = Symbol('SIGNER_CLIENT')

/** One client for the process. The client itself lives in `@payments/chain`: the worker asks the signer too. */
@Module({
  providers: [
    {
      provide: SIGNER_CLIENT,
      useFactory: (): SignerClient => new SignerClient(readSignerUrl()),
    },
  ],
  exports: [SIGNER_CLIENT],
})
export class SignerClientModule {}
