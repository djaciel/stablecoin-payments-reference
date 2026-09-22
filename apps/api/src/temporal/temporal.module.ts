import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common'
import { readTemporalConfig } from '@payments/domain'
import { Client, Connection } from '@temporalio/client'

/** The injection token for the Temporal client, for the same reason as `DATABASE_POOL`. */
export const TEMPORAL_CLIENT = Symbol('TEMPORAL_CLIENT')

/**
 * One client for the process, over a connection opened lazily: the api boots and takes payments
 * even while Temporal is slow or down, because a start it cannot make is the dispatcher's to make.
 */
@Module({
  providers: [
    {
      provide: TEMPORAL_CLIENT,
      useFactory: (): Client => {
        const { address, namespace } = readTemporalConfig()
        return new Client({ connection: Connection.lazy({ address }), namespace })
      },
    },
  ],
  exports: [TEMPORAL_CLIENT],
})
export class TemporalModule implements OnApplicationShutdown {
  constructor(@Inject(TEMPORAL_CLIENT) private readonly client: Client) {}

  async onApplicationShutdown(): Promise<void> {
    await this.client.connection.close()
  }
}
