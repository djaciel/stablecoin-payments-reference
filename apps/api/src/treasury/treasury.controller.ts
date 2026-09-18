import { Controller, Get, Inject, Logger, ServiceUnavailableException } from '@nestjs/common'
import { SIGNER_CLIENT } from '../signer/signer-client.module'
import { SignerUnavailableError, type SignerClient } from '../signer/signer-client.service'

@Controller('treasury')
export class TreasuryController {
  private readonly logger = new Logger(TreasuryController.name)

  constructor(@Inject(SIGNER_CLIENT) private readonly signer: SignerClient) {}

  /**
   * The treasury address, asked of the signer on every call rather than cached.
   *
   * It cannot change while the seed file is stable, so a cache would be correct — and it
   * would also mean the api answers from memory about a service that may have died, and
   * that the first tester to hit this endpoint while the signer was still starting would
   * get a wrong answer for the life of the process. One HTTP call on the compose network
   * is not worth that.
   */
  @Get()
  async read(): Promise<{ address: string }> {
    try {
      const { address } = await this.signer.treasuryAddress()
      return { address }
    } catch (error) {
      if (error instanceof SignerUnavailableError) {
        // The detail (which URL, which status) goes to the log, where an operator reads
        // it. The response says what is wrong in one sentence.
        this.logger.error(error.message)
        throw new ServiceUnavailableException(
          'the signer is not answering, so the treasury address cannot be read. Check `docker compose logs signer`.',
        )
      }
      throw error
    }
  }
}
