import { BadRequestException, Body, Controller, Get, Inject, Logger, Post, Query, ServiceUnavailableException } from '@nestjs/common'
import { SignerUnavailableError, chainErrorMessage, explorerAddressUrl, readUsdcBalance, rpcHost, type ChainClient } from '@payments/chain'
import type { PartnerSummary, PartnerView, Partners } from '@payments/domain'
import { formatMinor } from '@payments/ledger'
import { formatEther, type Address } from 'viem'
import { CHAIN_CLIENT } from '../chain/chain.module'
import { receivableView } from '../receivables/receivables.service'
import { PARTNERS_SERVICE, type Partner, type PartnersService } from './partners.service'

/** The longest name the screen shows without wrapping into nonsense. */
const MAX_NAME_LENGTH = 80

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
  async list(): Promise<Partners> {
    const partners = await this.partners.list()
    return this.withBalances(partners)
  }

  /**
   * The whole `/partner` screen in one read: the selector's list, the selected partner with the
   * address it pays AT, what it owes, and the wallet it pays FROM. The payout addresses stay out:
   * that is the company's side of the pair, and this screen belongs to the partner.
   *
   * Declared before any route with a parameter would be: Nest matches in declaration order, so a
   * later `@Get(':id')` would otherwise swallow `/partners/view`.
   */
  @Get('view')
  async view(@Query('partnerId') partnerId?: string): Promise<PartnerView> {
    const asked = partnerId === undefined || partnerId === '' ? null : partnerId
    const partners = await this.partners.list()
    // Ordered by derivation index, so the default is the first partner the demo created.
    const selected = asked === null ? partners[0] : partners.find((partner) => partner.id === asked)
    if (selected === undefined && asked !== null) {
      throw new BadRequestException('partnerId must be the id of a partner, as GET /partners/view lists them.')
    }

    const list = partners.map((partner) => ({ id: partner.id, name: partner.name }))
    const receivables = selected === undefined ? [] : await this.partners.receivablesOf(selected.id)
    const partnerWallet = this.partners.partnerWalletAddress()
    const wallet = await this.readWalletBalances(partnerWallet)

    return {
      partners: list,
      partner:
        selected === undefined
          ? null
          : {
              id: selected.id,
              name: selected.name,
              // The address only: what sits on it is the company's money, and the admin's
              // Partners screen is where that balance belongs.
              deposit: { address: selected.depositAddress, explorerUrl: explorerAddressUrl(selected.depositAddress) },
            },
      receivables: receivables.map(receivableView),
      partnerWallet: {
        address: partnerWallet,
        explorerUrl: explorerAddressUrl(partnerWallet),
        usdc: wallet.usdc,
        eth: wallet.eth,
      },
      blockNumber: wallet.blockNumber,
      ...(wallet.chainError === undefined ? {} : { chainError: wallet.chainError }),
    }
  }

  /**
   * Creating a partner derives the next pair of addresses and starts watching the deposit
   * one. The answer carries balances too, so the screen can draw the new row before its
   * next poll.
   */
  @Post()
  async create(@Body() body: unknown): Promise<Partners> {
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
   * The same rule as `withBalances`: the addresses and the invoices come from Postgres and must
   * still be on screen when a public RPC has a bad minute, so this failure arrives as data.
   *
   * Two reads, both about the wallet the partner pays FROM, pinned to one block.
   */
  private async readWalletBalances(
    partnerWallet: Address,
  ): Promise<{ usdc: string | null; eth: string | null; blockNumber: string | null; chainError?: string }> {
    try {
      const blockNumber = await this.chain.getBlockNumber()
      const [usdc, eth] = await Promise.all([
        readUsdcBalance(this.chain, partnerWallet, blockNumber),
        this.chain.getBalance({ address: partnerWallet, blockNumber }),
      ])
      return { usdc: formatMinor(usdc), eth: formatEther(eth), blockNumber: blockNumber.toString() }
    } catch (error) {
      this.logger.error(`the RPC at ${rpcHost()} did not answer: ${chainErrorMessage(error)}`)
      return {
        usdc: null,
        eth: null,
        blockNumber: null,
        chainError: `the chain is unreachable (RPC ${rpcHost()}), so your wallet's balances cannot be read. The invoices and the addresses are unaffected.`,
      }
    }
  }

  /**
   * The one dependency whose failure is NOT an error: an RPC hiccup must not blank a list
   * that Postgres answered perfectly well. The addresses are the point; the balances are
   * the extra.
   */
  private async withBalances(partners: readonly Partner[]): Promise<Partners> {
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

function toView(partner: Partner, depositUsdc: string | null, payoutUsdc: string | null): PartnerSummary {
  return {
    id: partner.id,
    name: partner.name,
    derivationIndex: partner.derivationIndex,
    deposit: { address: partner.depositAddress, explorerUrl: explorerAddressUrl(partner.depositAddress), usdc: depositUsdc },
    payout: { address: partner.payoutAddress, explorerUrl: explorerAddressUrl(partner.payoutAddress), usdc: payoutUsdc },
    owes: formatMinor(partner.owesMinor),
    owed: formatMinor(partner.owedMinor),
    arrived: formatMinor(partner.arrivedMinor),
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
