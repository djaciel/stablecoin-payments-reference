import { Module } from '@nestjs/common'
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
  const value = process.env['SIGNER_URL']
  // An empty variable is a mistake, not a request for the empty string.
  return value === undefined || value === '' ? DEFAULT_SIGNER_URL : value.replace(/\/+$/, '')
}
