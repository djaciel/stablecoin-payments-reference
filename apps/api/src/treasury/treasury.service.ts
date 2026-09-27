import { Logger, type OnApplicationBootstrap } from '@nestjs/common'
import type { Pool } from '@payments/db'
import type { LedgerFigures } from '@payments/domain'
import {
  ACCOUNTS,
  formatMinor,
  getBalances,
  type AccountBalance,
  type AccountCode,
} from '@payments/ledger'
import { getAddress, type Address } from 'viem'
import type { PartnerKeysService } from '../demo-scaffolding/partner-keys.service'
import type { SignerClient } from '@payments/chain'

/**
 * Here rather than in `treasury.module.ts`, unlike the other tokens in this api: the module
 * registers the controller, so a token defined there and imported by the controller is a
 * cycle — and the symptom is a runtime `Cannot access 'X' before initialization`.
 */
export const TREASURY_SERVICE = Symbol('TREASURY_SERVICE')

/**
 * Who the treasury is, what the books say about it, and the one thing the api does for the
 * watcher: registering the address to watch. Money leaving the treasury is the other file,
 * `fund-partner-wallet.service.ts`.
 */
export class TreasuryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TreasuryService.name)

  constructor(
    private readonly signer: SignerClient,
    private readonly partnerKeys: PartnerKeysService,
    private readonly pool: Pool,
  ) {}

  /**
   * Runs once, before the api serves, and idempotent so every restart is a no-op. A failure
   * here does not stop the api: the screen still works and what is lost is the watcher's
   * input, which is what the error line says.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const address = await this.address()
      await this.pool.query(
        `INSERT INTO watched_addresses (address, role) VALUES ($1, 'treasury')
         ON CONFLICT (address) DO NOTHING`,
        [address],
      )
      this.logger.log(`treasury ${address} is registered in watched_addresses; the watcher will post what arrives`)
    } catch (error) {
      this.logger.error(
        `the treasury address could not be registered for watching, so funding will NOT be posted until the api restarts: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  /** Checksummed, because it is compared against addresses decoded from chain logs. */
  async address(): Promise<Address> {
    const { address } = await this.signer.treasuryAddress()
    return getAddress(address)
  }

  /**
   * The shared wallet every partner pays from — demo scaffolding, from the partner seed, and
   * NOT registered in `watched_addresses`: the watcher posts money arriving, and this address
   * is where the demo's money goes, not where it comes from.
   */
  partnerWalletAddress(): Address {
    return this.partnerKeys.partnerWallet().address
  }

  /** The three figures the Books card shows. */
  async ledgerFigures(): Promise<LedgerFigures> {
    const balances = await this.readBalances()
    const of = (code: AccountCode): string => formatMinor(balanceOf(balances, code))
    return {
      available: of(ACCOUNTS.treasuryAvailable),
      reserved: of(ACCOUNTS.treasuryReserved),
      partnerDebt: of(ACCOUNTS.partnerPayable),
    }
  }

  /** What the books say the treasury can still spend, in minor units. */
  async availableMinor(): Promise<bigint> {
    return balanceOf(await this.readBalances(), ACCOUNTS.treasuryAvailable)
  }

  private async readBalances(): Promise<AccountBalance[]> {
    const client = await this.pool.connect()
    try {
      return await getBalances(client)
    } finally {
      client.release()
    }
  }
}

function balanceOf(balances: readonly AccountBalance[], code: AccountCode): bigint {
  return balances.find((balance) => balance.code === code)?.balanceMinor ?? 0n
}
