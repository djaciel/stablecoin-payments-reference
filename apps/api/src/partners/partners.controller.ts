import { BadRequestException, Body, Controller, Get, Inject, Logger, Post, ServiceUnavailableException } from '@nestjs/common'
import { chainErrorMessage, explorerAddressUrl, readUsdcBalance, rpcHost, type ChainClient } from '@payments/chain'
import { formatMinor } from '@payments/ledger'
import type { Address } from 'viem'
import { CHAIN_CLIENT } from '../chain/chain.module'
import { SignerUnavailableError } from '../signer/signer-client.service'
import { PARTNERS_SERVICE, type Partner, type PartnersService } from './partners.service'

/** The longest name the screen shows without wrapping into nonsense. */
const MAX_NAME_LENGTH = 80

/** One address as the screen draws it: the text, the link, and what it holds. */
interface AddressView {
  readonly address: Address
  readonly explorerUrl: string
  /** Decimal USDC in whole tokens, or null when the chain could not be read. */
  readonly usdc: string | null
}

interface PartnerView {
  readonly id: string
  readonly name: string
  readonly derivationIndex: number
  /** Company seed: where this partner pays. */
  readonly deposit: AddressView
  /** Partner seed, demo scaffolding: where the company pays this partner. */
  readonly payout: AddressView
}

interface PartnersList {
  readonly partners: readonly PartnerView[]
  /** The block every balance above was read at, or null when the RPC could not be reached. */
  readonly blockNumber: string | null
  /** Set only when `blockNumber` is null: one sentence a screen can print. */
  readonly chainError?: string
}

@Controller('partners')
export class PartnersController {
  private readonly logger = new Logger(PartnersController.name)

  constructor(
    @Inject(PARTNERS_SERVICE) private readonly partners: PartnersService,
    @Inject(CHAIN_CLIENT) private readonly chain: ChainClient,
  ) {}

  /**
   * The whole Partners screen in one read (the screen polls one endpoint), with every
   * balance pinned to the same block: at `latest` a load-balanced RPC answers from nodes at
   * different heights and the list shows figures that never coexisted.
   */
  @Get()
  async list(): Promise<PartnersList> {
    const partners = await this.partners.list()
    return this.withBalances(partners)
  }

  /**
   * Creating a partner derives the next pair of addresses and starts watching the deposit
   * one. The answer carries balances too, so the screen can draw the new row before its
   * next poll.
   */
  @Post()
  async create(@Body() body: unknown): Promise<PartnersList> {
    const name = readPartnerName(body)

    try {
      await this.partners.create(name)
    } catch (error) {
      if (error instanceof SignerUnavailableError) {
        // The detail (which URL, which status) goes to the log. The response says what is
        // wrong in one sentence, and nothing was written: the partner row, its deposit
        // address and the index all live in the transaction that just rolled back.
        this.logger.error(error.message)
        throw new ServiceUnavailableException(
          'the signer is not answering, so the deposit address cannot be derived and the partner was not created. Check `docker compose logs signer`.',
        )
      }
      throw error
    }

    return this.list()
  }

  /**
   * The one dependency whose failure is NOT an error: an RPC hiccup must not blank a list
   * that Postgres answered perfectly well. The addresses are the point; the balances are
   * the extra.
   */
  private async withBalances(partners: readonly Partner[]): Promise<PartnersList> {
    try {
      const blockNumber = await this.chain.getBlockNumber()
      const views = await Promise.all(
        partners.map(async (partner) => {
          const [deposit, payout] = await Promise.all([
            readUsdcBalance(this.chain, partner.depositAddress, blockNumber),
            readUsdcBalance(this.chain, partner.payoutAddress, blockNumber),
          ])
          return toView(partner, formatMinor(deposit), formatMinor(payout))
        }),
      )
      return { partners: views, blockNumber: blockNumber.toString() }
    } catch (error) {
      // The host, never the URL: a provider endpoint carries its API key in the path.
      this.logger.error(`the RPC at ${rpcHost()} did not answer: ${chainErrorMessage(error)}`)
      return {
        partners: partners.map((partner) => toView(partner, null, null)),
        blockNumber: null,
        chainError: `the chain is unreachable (RPC ${rpcHost()}), so the balances below cannot be read. The addresses are unaffected.`,
      }
    }
  }
}

function toView(partner: Partner, depositUsdc: string | null, payoutUsdc: string | null): PartnerView {
  return {
    id: partner.id,
    name: partner.name,
    derivationIndex: partner.derivationIndex,
    deposit: { address: partner.depositAddress, explorerUrl: explorerAddressUrl(partner.depositAddress), usdc: depositUsdc },
    payout: { address: partner.payoutAddress, explorerUrl: explorerAddressUrl(partner.payoutAddress), usdc: payoutUsdc },
  }
}

/**
 * One condition: a name is text somebody can read. Missing, blank, whitespace or a novel are
 * the same mistake, and listing them separately would buy a longer file and no extra safety.
 *
 * Validated by hand: Nest's `ValidationPipe` reads the DTO class from decorator metadata
 * that tsx does not emit, so a `@Body() dto: Dto` here would be accepted without a single
 * check running (spec assumption 18).
 */
function readPartnerName(body: unknown): string {
  const raw: unknown = typeof body === 'object' && body !== null && 'name' in body ? body.name : undefined
  const name = typeof raw === 'string' ? raw.trim() : ''

  if (name === '' || name.length > MAX_NAME_LENGTH) {
    throw new BadRequestException(`name must be text of 1 to ${String(MAX_NAME_LENGTH)} characters.`)
  }

  return name
}
