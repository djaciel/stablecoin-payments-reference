import { Logger, type OnApplicationBootstrap } from '@nestjs/common'
import { inTransaction, type Pool, type PoolClient } from '@payments/db'
import { getAddress, type Address } from 'viem'
import type { PartnerKeysService } from '../demo-scaffolding/partner-keys.service'
import type { SignerClient } from '../signer/signer-client.service'

/**
 * Here rather than in `partners.module.ts`, like the treasury's token: the module registers
 * the controller, so a token defined there and imported by the controller is a cycle.
 */
export const PARTNERS_SERVICE = Symbol('PARTNERS_SERVICE')

/** A partner as the database holds it. Balances and links are the controller's business. */
export interface Partner {
  readonly id: string
  readonly name: string
  readonly derivationIndex: number
  /** Company seed, from the signer. Where this partner pays what it owes. */
  readonly depositAddress: Address
  /** Partner seed, demo scaffolding. Where the company pays what it owes this partner. */
  readonly payoutAddress: Address
}

/**
 * The two partners the demo starts with. Plausible names on purpose: they end up in the
 * article's screenshots.
 */
const BOOTSTRAP_PARTNER_NAMES = ['Northwind Logistics', 'Bluefin Studio']

export class PartnersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PartnersService.name)

  constructor(
    private readonly signer: SignerClient,
    private readonly partnerKeys: PartnerKeysService,
    private readonly pool: Pool,
  ) {}

  /**
   * The two starting partners cannot be a migration: their addresses do not exist until both
   * seeds have been generated, which happens at runtime. Idempotent, so every restart after
   * the first is a no-op.
   *
   * A failure here does not stop the api — the screens still work and the error line says
   * what is missing — because the usual cause is a signer that is still waking up.
   */
  async onApplicationBootstrap(): Promise<void> {
    try {
      const existing = await this.list()
      if (existing.length > 0) {
        return
      }
      for (const name of BOOTSTRAP_PARTNER_NAMES) {
        const partner = await this.create(name)
        this.logger.log(`bootstrapped partner ${partner.name} at index ${partner.derivationIndex}`)
      }
    } catch (error) {
      this.logger.error(
        `the demo's first partners could not be created, so /admin/partners is empty until the api restarts: ${messageOf(error)}`,
      )
    }
  }

  async list(): Promise<Partner[]> {
    const result = await this.pool.query<PartnerRow>(
      `SELECT id, name, derivation_index, deposit_address, payout_address
         FROM partners ORDER BY derivation_index`,
    )
    return result.rows.map(toPartner)
  }

  /**
   * Creates the partner and registers its deposit address for watching, in one transaction.
   *
   * The signer is asked inside that transaction, which is not the usual rule — the watcher
   * deliberately keeps its RPC calls outside one — and it is right here: the alternative is
   * an index reserved by a creation that then failed, or a partner row with nobody watching
   * its deposit address. The call is bounded (a 5 s timeout, over the compose network) and
   * the only lock held is on this table.
   */
  async create(name: string): Promise<Partner> {
    const client = await this.pool.connect()
    try {
      return await inTransaction(client, async () => {
        const index = await nextDerivationIndex(client)
        const deposit = await this.signer.depositAddress(index)
        const payout = this.partnerKeys.payoutAccount(index).address

        const inserted = await client.query<PartnerRow>(
          `INSERT INTO partners (name, derivation_index, deposit_address, payout_address)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, derivation_index, deposit_address, payout_address`,
          [name, index, getAddress(deposit.address), getAddress(payout)],
        )
        const partner = toPartner(requireRow(inserted.rows[0]))

        await client.query(
          `INSERT INTO watched_addresses (address, role, partner_id) VALUES ($1, 'deposit', $2)`,
          [partner.depositAddress, partner.id],
        )

        return partner
      })
    } finally {
      client.release()
    }
  }
}

interface PartnerRow {
  readonly id: string
  readonly name: string
  readonly derivation_index: number
  readonly deposit_address: string
  readonly payout_address: string
}

function toPartner(row: PartnerRow): Partner {
  return {
    id: row.id,
    name: row.name,
    derivationIndex: row.derivation_index,
    depositAddress: getAddress(row.deposit_address),
    payoutAddress: getAddress(row.payout_address),
  }
}

/**
 * The next free index, locked so two creations cannot read the same maximum. The unique
 * constraint would catch that anyway, but as a 500 on a demo screen rather than a queue of
 * one behind the other.
 */
async function nextDerivationIndex(client: PoolClient): Promise<number> {
  await client.query('LOCK TABLE partners IN EXCLUSIVE MODE')
  const result = await client.query<{ next: string }>(
    'SELECT coalesce(max(derivation_index), 0) + 1 AS next FROM partners',
  )
  return Number(requireRow(result.rows[0]).next)
}

/** `RETURNING` and an aggregate both always give a row; this is what says so to the types. */
function requireRow<T>(row: T | undefined): T {
  if (row === undefined) {
    throw new Error('postgres returned no row for a statement that always returns one')
  }
  return row
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
