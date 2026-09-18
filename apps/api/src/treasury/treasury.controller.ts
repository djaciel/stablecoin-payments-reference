import { Controller, Get, Inject, Logger, ServiceUnavailableException } from '@nestjs/common'
import { explorerAddressUrl, readUsdcBalance, rpcHost, type ChainClient } from '@payments/chain'
import { formatMinor } from '@payments/ledger'
import { formatEther, type Address } from 'viem'
import { CHAIN_CLIENT } from '../chain/chain.module'
import { SignerUnavailableError } from '../signer/signer-client.service'
import { TREASURY_SERVICE, type LastFunding, type LedgerFigures, type TreasuryService } from './treasury.service'

/**
 * What the Start screen needs, in one answer. Amounts are decimal strings in whole tokens
 * (the spec's wire format): the browser formats nothing and rounds nothing.
 */
interface TreasuryView {
  readonly address: Address
  readonly explorerUrl: string
  /** What the chain says, or null when the RPC could not be reached. */
  readonly onchain: { readonly usdc: string; readonly eth: string; readonly blockNumber: string } | null
  /** Set only when `onchain` is null: one sentence a screen can print. */
  readonly chainError?: string
  /** What the books say. The article's three accounts, by their published names. */
  readonly ledger: LedgerFigures
  /** Which transaction the watcher turned into those books, or null before the first one. */
  readonly lastFunding: LastFunding | null
}

@Controller('treasury')
export class TreasuryController {
  private readonly logger = new Logger(TreasuryController.name)

  constructor(
    @Inject(TREASURY_SERVICE) private readonly treasury: TreasuryService,
    @Inject(CHAIN_CLIENT) private readonly chain: ChainClient,
  ) {}

  /**
   * The whole Start screen in one read: who the treasury is, what it holds on chain, what
   * the books say about it, and which transaction put it there.
   *
   * One request instead of four because a screen that polls four endpoints multiplies its
   * traffic by the number of cards, and because the figures are only worth comparing when
   * they were read at the same moment.
   *
   * The address is asked of the signer on every call rather than cached. It cannot change
   * while the seed file is stable, so a cache would be correct — and it would also mean
   * the api answers from memory about a service that may have died, and that the first
   * tester to hit this endpoint while the signer was still starting would get a wrong
   * answer for the life of the process.
   */
  @Get()
  async read(): Promise<TreasuryView> {
    const address = await this.readAddress()

    // Independent halves, neither waiting for the other: the books come from Postgres on
    // the compose network, the balances from a public RPC across the internet.
    const [onchain, ledger, lastFunding] = await Promise.all([
      this.readOnchain(address),
      this.treasury.ledgerFigures(),
      this.treasury.lastFunding(),
    ])

    return { address, explorerUrl: explorerAddressUrl(address), ...onchain, ledger, lastFunding }
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
   * The chain half, and the one dependency whose failure is NOT a 503: a public RPC
   * hiccup must not blank a screen whose other half comes from a database that is
   * answering perfectly well. The card says the chain is unreachable and everything else
   * stays on screen.
   *
   * Both balances are pinned to one block. Reading them at `latest` would let a
   * load-balanced RPC answer the two calls from two nodes at different heights, and the
   * screen would show two figures that never existed together.
   */
  private async readOnchain(address: Address): Promise<Pick<TreasuryView, 'onchain' | 'chainError'>> {
    try {
      const blockNumber = await this.chain.getBlockNumber()
      const [usdc, eth] = await Promise.all([
        readUsdcBalance(this.chain, address, blockNumber),
        this.chain.getBalance({ address, blockNumber }),
      ])
      return { onchain: { usdc: formatMinor(usdc), eth: formatEther(eth), blockNumber: blockNumber.toString() } }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      // The host, never the URL: a provider endpoint carries its API key in the path.
      this.logger.error(`the RPC at ${rpcHost()} did not answer: ${detail}`)
      return {
        onchain: null,
        chainError: `the chain is unreachable (RPC ${rpcHost()}), so the onchain balances cannot be read. The books are unaffected.`,
      }
    }
  }
}
