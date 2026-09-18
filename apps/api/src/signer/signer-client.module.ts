import { Module } from '@nestjs/common'
import { readEnv } from '@payments/domain'
import { SignerClient } from './signer-client.service'

/**
 * The injection token for the signer client, following the repo's rule: dependencies are
 * injected by explicit token, never by class type, because tsx emits no decorator
 * metadata for Nest to read (see `src/db/db.module.ts`).
 */
export const SIGNER_CLIENT = Symbol('SIGNER_CLIENT')

const DEFAULT_SIGNER_URL = 'http://signer:3001'

/**
 * One client for the process, built from the environment in one place. The signer has no
 * published port, so this URL is a compose-network address: `signer` is the service name.
 */
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

/**
 * The only place that reads SIGNER_URL. The default is the address inside compose, which
 * is where this api normally runs; set the variable to point an api started on your
 * machine at a signer started the same way.
 */
function readSignerUrl(): string {
  return readEnv('SIGNER_URL', DEFAULT_SIGNER_URL).replace(/\/+$/, '')
}
