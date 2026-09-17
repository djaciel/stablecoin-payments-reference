import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common'
import { createPool, type Pool } from '@payments/db'

/**
 * The injection token for the Postgres pool.
 *
 * Nest can inject a class by its type, but only when the compiler writes that type into
 * the metadata (`emitDecoratorMetadata`). This repo runs TypeScript through tsx, whose
 * esbuild core does not emit that metadata, so everything here is injected by an explicit
 * token: `@Inject(DATABASE_POOL)`. It costs one line at each constructor and it is what
 * makes the dependency visible in the code rather than in a compiler setting.
 */
export const DATABASE_POOL = Symbol('DATABASE_POOL')

/**
 * The pool is a provider, not a module-level constant, for one reason: a pool is a live
 * resource with a lifetime, and Nest owns lifetimes here. One pool is created for the
 * whole process, handed to whoever asks for it, and closed when the process shuts down.
 *
 * Services never call `createPool()` themselves. A second pool means a second set of
 * connections competing for the same `max` on the server, and two places to fix when
 * connection handling changes.
 */
@Module({
  providers: [
    {
      provide: DATABASE_POOL,
      useFactory: (): Pool => createPool(),
    },
  ],
  exports: [DATABASE_POOL],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  /**
   * Without this, `docker compose stop` waits for the pool's idle connections to time out
   * on their own (ten seconds by default) before Node has nothing left to do and exits.
   * Whoever opens a resource closes it.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.pool.end()
  }
}
