import { Logger, type OnApplicationBootstrap } from '@nestjs/common'
import { inTransaction, type Pool, type PoolClient } from '@payments/db'
import { getAddress, type Address } from 'viem'
import type { PartnerKeysService } from '../demo-scaffolding/partner-keys.service'
import { readReceivables, type Receivable } from '../receivables/receivables.service'
import type { SignerClient } from '@payments/chain'
import type { MinorUnits } from '@payments/ledger'

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
  /** What this partner owes: its OPEN and PAYING invoices. */
  readonly owesMinor: MinorUnits
  /** What the company owes it: its OPEN and PAYING payables. */
  readonly owedMinor: MinorUnits
  /** What arrived at its deposit address and was credited: its SETTLED deposits. */
  readonly arrivedMinor: MinorUnits
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

  /**
   * The shared wallet every partner pays from: demo scaffolding, from the partner seed. Here
   * because the partner screen shows it next to the address it pays at, in one read.
   */
  partnerWalletAddress(): Address {
    return this.partnerKeys.partnerWallet().address
  }

  /** What one partner owes, newest first. The rows live in `receivables/`; this is the pool they need. */
  receivablesOf(partnerId: string): Promise<Receivable[]> {
    return readReceivables(this.pool, partnerId)
  }

  /**
   * Every partner with the three figures the screen puts next to its two addresses. One query:
   * the sums come from the invoice tables, which are the per-partner view of three ledger
   * accounts that stay whole, so nothing here asks the chain.
   */
  async list(): Promise<Partner[]> {
    const result = await this.pool.query<PartnerRow>(
      `SELECT p.id, p.name, p.derivation_index, p.deposit_address, p.payout_address,
              (SELECT coalesce(sum(amount_minor), 0) FROM receivables
                WHERE partner_id = p.id AND status IN ('OPEN', 'PAYING')) AS owes_minor,
              (SELECT coalesce(sum(amount_minor), 0) FROM payables
                WHERE partner_id = p.id AND status IN ('OPEN', 'PAYING')) AS owed_minor,
              (SELECT coalesce(sum(amount_minor), 0) FROM deposits
                WHERE partner_id = p.id AND status = 'SETTLED') AS arrived_minor
         FROM partners p ORDER BY p.derivation_index`,
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

        const inserted = await client.query<Omit<PartnerRow, 'owes_minor' | 'owed_minor' | 'arrived_minor'>>(
          `INSERT INTO partners (name, derivation_index, deposit_address, payout_address)
           VALUES ($1, $2, $3, $4)
           RETURNING id, name, derivation_index, deposit_address, payout_address`,
          [name, index, getAddress(deposit.address), getAddress(payout)],
        )
        // A partner created a second ago owes nothing and is owed nothing.
        const partner = toPartner({ ...requireRow(inserted.rows[0]), owes_minor: '0', owed_minor: '0', arrived_minor: '0' })

        await client.query(
          `INSERT INTO watched_addresses (address, role, partner_id) VALUES ($1, 'deposit', $2)`,
          [partner.depositAddress, partner.id],
        )
        // And the company may pay it from now on: registering the payout address here is what
        // `0013_allowlist.sql` backfilled for the partners that already existed.
        await client.query(
          // DO NOTHING rather than fail: an address somebody had already added by hand is on the
          // list, which is all this statement wants.
          'INSERT INTO allowlist (address, label, partner_id) VALUES ($1, $2, $3) ON CONFLICT (address) DO NOTHING',
          [partner.payoutAddress, partner.name, partner.id],
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
  readonly owes_minor: string
  readonly owed_minor: string
  readonly arrived_minor: string
}

function toPartner(row: PartnerRow): Partner {
  return {
    id: row.id,
    name: row.name,
    derivationIndex: row.derivation_index,
    depositAddress: getAddress(row.deposit_address),
    payoutAddress: getAddress(row.payout_address),
    owesMinor: BigInt(row.owes_minor),
    owedMinor: BigInt(row.owed_minor),
    arrivedMinor: BigInt(row.arrived_minor),
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
