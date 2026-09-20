import { Logger, type OnApplicationBootstrap } from '@nestjs/common'
import { explorerTransactionUrl } from '@payments/chain'
import type { Pool } from '@payments/db'
import { ACCOUNTS, formatMinor, getBalances, type AccountCode } from '@payments/ledger'
import { getAddress, type Address } from 'viem'
import type { SignerClient } from '../signer/signer-client.service'

/**
 * Here rather than in `treasury.module.ts`, unlike the other tokens in this api: the module
 * registers the controller, so a token defined there and imported by the controller is a
 * cycle — and the symptom is a runtime `Cannot access 'X' before initialization`.
 */
export const TREASURY_SERVICE = Symbol('TREASURY_SERVICE')

/** The published names of the three figures the article prints, as decimal strings. */
export interface LedgerFigures {
  readonly available: string
  readonly reserved: string
  readonly partnerDebt: string
}

/** Which transaction put the money in the books — the watcher's own answer. */
export interface LastFunding {
  readonly amount: string
  readonly txHash: string
  readonly blockNumber: string
  readonly explorerUrl: string
  readonly at: string
}

/**
 * Everything `GET /treasury` knows that is not HTTP, plus the one thing the api does for the
 * watcher: it registers the address to watch. That cannot be a migration — the address does
 * not exist until the signer has generated the seed — and doing it here is what lets the
 * worker need neither the signer nor a seed.
 */
export class TreasuryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TreasuryService.name)

  constructor(
    private readonly signer: SignerClient,
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

  async ledgerFigures(): Promise<LedgerFigures> {
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

  /**
   * Read from the audit log rather than the entries: which transaction put the money there is
   * an audit question. The two cannot disagree — the watcher writes both in one transaction.
   */
  async lastFunding(): Promise<LastFunding | null> {
    const result = await this.pool.query<{ at: Date; context: Record<string, unknown> }>(
      `SELECT at, context FROM audit_log
        WHERE actor = 'watcher' AND subject_type = 'treasury' AND event = 'funded'
        ORDER BY id DESC LIMIT 1`,
    )
    const row = result.rows[0]
    if (row === undefined) {
      return null
    }

    const txHash = String(row.context['txHash'])
    return {
      // Minor units are written to the log as a decimal string (JSON has no bigint).
      amount: formatMinor(BigInt(String(row.context['amountMinor']))),
      txHash,
      blockNumber: String(row.context['blockNumber']),
      explorerUrl: explorerTransactionUrl(txHash),
      at: row.at.toISOString(),
    }
  }
}
