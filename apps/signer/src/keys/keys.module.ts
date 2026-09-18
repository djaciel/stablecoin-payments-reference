import { Module } from '@nestjs/common'
import { KeysService } from './keys.service'

/**
 * The injection token for the keys service.
 *
 * Injected by token rather than by class type for the same reason as the api's database
 * pool: this repo runs TypeScript through tsx, whose esbuild core does not emit decorator
 * metadata, so Nest cannot infer a constructor parameter's class. `@Inject(KEYS_SERVICE)`
 * makes the dependency visible in the code instead of in a compiler setting.
 */
export const KEYS_SERVICE = Symbol('KEYS_SERVICE')

const DEFAULT_KEYS_DIR = '/keys'

/**
 * The seed is loaded once, at startup, by an async factory. Two consequences worth
 * having: a broken or missing keys directory stops the process before it listens, and
 * every request afterwards derives from memory instead of re-reading a file.
 */
@Module({
  providers: [
    {
      provide: KEYS_SERVICE,
      useFactory: (): Promise<KeysService> => KeysService.load(readKeysDir()),
    },
  ],
  exports: [KEYS_SERVICE],
})
export class KeysModule {}

/**
 * The only place that reads KEYS_DIR. The default is the path compose bind-mounts; set
 * the variable to run the signer straight on your machine.
 */
function readKeysDir(): string {
  const value = process.env['KEYS_DIR']
  // An empty variable is a mistake, not a request for the empty string.
  return value === undefined || value === '' ? DEFAULT_KEYS_DIR : value
}
