import { Controller, Get, HttpCode, HttpStatus, Inject, Logger, Post, ServiceUnavailableException } from '@nestjs/common'
import { SignerUnavailableError, chainErrorMessage, explorerAddressUrl, readUsdcBalance, rpcHost, type ChainClient } from '@payments/chain'
import type { PartnerWalletFunding, Treasury } from '@payments/domain'
import { formatMinor } from '@payments/ledger'
import { formatEther, type Address } from 'viem'
import { CHAIN_CLIENT } from '../chain/chain.module'
import { FUND_PARTNER_WALLET_SERVICE, type FundPartnerWalletService } from './fund-partner-wallet.service'
import { TREASURY_SERVICE, type TreasuryService } from './treasury.service'

/** Balances of one address, or nulls when the chain could not be read. Unknown is not zero. */
interface Balances {
  readonly usdc: string | null
  readonly eth: string | null
}

@Controller('treasury')
export class TreasuryController {
  private readonly logger = new Logger(TreasuryController.name)

  constructor(
    @Inject(TREASURY_SERVICE) private readonly treasury: TreasuryService,
    @Inject(FUND_PARTNER_WALLET_SERVICE) private readonly funding: FundPartnerWalletService,
    @Inject(CHAIN_CLIENT) private readonly chain: ChainClient,
  ) {}

  /**
   * The whole Start screen in one read, because the figures are only worth comparing when
   * they were read at the same moment.
   *
   * The address is asked of the signer every call rather than cached: a cache would be
   * correct while the seed file is stable, and would also mean the api answers from memory
   * about a service that may have died.
   */
  @Get()
  async read(): Promise<Treasury> {
    const address = await this.readAddress()
    const partnerWallet = this.treasury.partnerWalletAddress()

    // Independent halves, neither waiting for the other: the books come from Postgres on
    // the compose network, the balances from a public RPC across the internet.
    const [onchain, ledger] = await Promise.all([
      this.readOnchain(address, partnerWallet),
      this.treasury.ledgerFigures(),
    ])

    return {
      address,
      explorerUrl: explorerAddressUrl(address),
      onchain: onchain.treasury,
      ...(onchain.chainError === undefined ? {} : { chainError: onchain.chainError }),
      ledger,
      partnerWallet: {
        address: partnerWallet,
        explorerUrl: explorerAddressUrl(partnerWallet),
        ...onchain.partnerWallet,
        funding: this.funding.fundingAmounts(),
      },
    }
  }

  /**
   * Two transactions out of the treasury and one entry in the books, all of it while this
   * request is open (spec assumption 15): the answer IS the receipt, which is what makes the
   * modal on the Start screen able to show both hashes without polling for them.
   *
   * The service refuses with a 422 when the treasury is short or the chain disagrees with
   * what was asked for; both of those are answers, not surprises.
   */
  @Post('fund-partner-wallet')
  @HttpCode(HttpStatus.OK)
  async fundPartnerWallet(): Promise<PartnerWalletFunding> {
    try {
      return await this.funding.fundPartnerWallet()
    } catch (error) {
      if (error instanceof SignerUnavailableError) {
        this.logger.error(error.message)
        throw new ServiceUnavailableException(
          'the signer is not answering, so nothing could be signed and nothing was sent. Check `docker compose logs signer`.',
        )
      }
      throw error
    }
  }

  /** No address, no screen: this one failure is still a 503. */
  private async readAddress(): Promise<Address> {
    try {
      return await this.treasury.address()
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

  /**
   * The one dependency whose failure is NOT a 503: an RPC hiccup must not blank a screen
   * whose other half comes from a database that is answering perfectly well.
   *
   * Both balances are pinned to one block. At `latest` a load-balanced RPC can answer the two
   * calls from nodes at different heights, and the screen shows figures that never coexisted.
   */
  private async readOnchain(
    treasury: Address,
    partnerWallet: Address,
  ): Promise<{
    treasury: Treasury['onchain']
    partnerWallet: Balances
    chainError?: string
  }> {
    try {
      const blockNumber = await this.chain.getBlockNumber()
      const [usdc, eth, partnerUsdc, partnerEth] = await Promise.all([
        readUsdcBalance(this.chain, treasury, blockNumber),
        this.chain.getBalance({ address: treasury, blockNumber }),
        readUsdcBalance(this.chain, partnerWallet, blockNumber),
        this.chain.getBalance({ address: partnerWallet, blockNumber }),
      ])
      return {
        treasury: { usdc: formatMinor(usdc), eth: formatEther(eth), blockNumber: blockNumber.toString() },
        partnerWallet: { usdc: formatMinor(partnerUsdc), eth: formatEther(partnerEth) },
      }
    } catch (error) {
      // The host, never the URL: a provider endpoint carries its API key in the path.
      this.logger.error(`the RPC at ${rpcHost()} did not answer: ${chainErrorMessage(error)}`)
      return {
        treasury: null,
        partnerWallet: { usdc: null, eth: null },
        chainError: `the chain is unreachable (RPC ${rpcHost()}), so the onchain balances cannot be read. The books are unaffected.`,
      }
    }
  }
}
