import { Controller, Get, Inject, Logger, ServiceUnavailableException } from '@nestjs/common'
import { explorerAddressUrl, readUsdcBalance, rpcHost, type ChainClient } from '@payments/chain'
import type { Pool } from '@payments/db'
import { ACCOUNTS, formatMinor, getBalances, type AccountCode } from '@payments/ledger'
import { formatEther, type Address } from 'viem'
import { CHAIN_CLIENT } from '../chain/chain.module'
import { DATABASE_POOL } from '../db/db.module'
import { SIGNER_CLIENT } from '../signer/signer-client.module'
import { SignerUnavailableError, type SignerClient } from '../signer/signer-client.service'

/**
 * What the Start screen needs, in one answer. Amounts are decimal strings in whole tokens: the
 * browser formats nothing and rounds nothing.
 */
interface TreasuryView {
  readonly address: Address
  readonly explorerUrl: string
  /** What the chain says, or null when the RPC could not be reached. */
  readonly onchain: { readonly usdc: string; readonly eth: string; readonly blockNumber: string } | null
  /** Set only when `onchain` is null: one sentence a screen can print. */
  readonly chainError?: string
  /** What the books say. The article's three accounts, by their published names. */
  readonly ledger: { readonly available: string; readonly reserved: string; readonly partnerDebt: string }
}

@Controller('treasury')
export class TreasuryController {
  private readonly logger = new Logger(TreasuryController.name)

  constructor(
    @Inject(SIGNER_CLIENT) private readonly signer: SignerClient,
    @Inject(CHAIN_CLIENT) private readonly chain: ChainClient,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  /**
   * The whole Start screen in one read. One request instead of three because the three figures
   * are only worth comparing when they were read at the same moment.
   *
   * The address is asked of the signer on every call rather than cached: a cache would be
   * correct, and it would also let the api answer from memory about a service that may have
   * died, or pin a wrong answer taken while the signer was still starting.
   */
  @Get()
  async read(): Promise<TreasuryView> {
    const address = await this.readAddress()

    // Independent halves: Postgres on the compose network, a public RPC across the internet.
    const [onchain, ledger] = await Promise.all([this.readOnchain(address), this.readLedger()])

    return { address, explorerUrl: explorerAddressUrl(address), ...onchain, ledger }
  }

  /** No address, no screen: this one failure is still a 503. */
  private async readAddress(): Promise<Address> {
    try {
      const { address } = await this.signer.treasuryAddress()
      return address
    } catch (error) {
      if (error instanceof SignerUnavailableError) {
        // The detail goes to the log; the response says what is wrong in one sentence.
        this.logger.error(error.message)
        throw new ServiceUnavailableException(
          'the signer is not answering, so the treasury address cannot be read. Check `docker compose logs signer`.',
        )
      }
      throw error
    }
  }

  /**
   * The chain half, and the one dependency whose failure is NOT a 503: an RPC hiccup must not
   * blank a screen whose other half comes from a database that is answering perfectly well.
   *
   * Both balances are pinned to one block. At `latest`, a load-balanced RPC could answer the
   * two calls from two nodes at different heights, and the screen would show two figures that
   * never existed together.
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

  /** The books half. `getBalances` takes a client, so one is borrowed and given back. */
  private async readLedger(): Promise<TreasuryView['ledger']> {
    const client = await this.pool.connect()
    try {
      const balances = await getBalances(client)
      const of = (code: AccountCode): string => formatMinor(balances.find((b) => b.code === code)?.balanceMinor ?? 0n)
      return {
        available: of(ACCOUNTS.treasuryAvailable),
        reserved: of(ACCOUNTS.treasuryReserved),
        partnerDebt: of(ACCOUNTS.partnerPayable),
      }
    } finally {
      client.release()
    }
  }
}
