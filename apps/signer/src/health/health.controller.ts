import { Controller, Get, Inject } from '@nestjs/common'
import { KEYS_SERVICE } from '../keys/keys.module'
import type { KeysService } from '../keys/keys.service'

@Controller('health')
export class HealthController {
  constructor(@Inject(KEYS_SERVICE) private readonly keys: KeysService) {}

  /**
   * For the api's `/health` the question is "can I reach my database". Here it is "is the
   * seed loaded and usable", and the honest way to answer is to derive from it. The
   * address is not in the response: the signer answers what it is asked, and this was a
   * health check, not an address lookup.
   */
  @Get()
  check(): { status: string; seed: string } {
    this.keys.treasury()
    return { status: 'ok', seed: 'loaded' }
  }
}
