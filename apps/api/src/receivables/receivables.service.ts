import { BadRequestException, UnprocessableEntityException } from '@nestjs/common'
import { explorerTransactionUrl } from '@payments/chain'
import { getAddress, type Address } from 'viem'
import { inTransaction, type Pool, type PoolClient } from '@payments/db'
import type { ReceivableSummary } from '@payments/domain'
import {
  ACCOUNTS,
  AUDIT_ACTORS,
  AUDIT_SUBJECTS,
  RECEIVABLE_EVENTS,
  formatMinor,
  getBalances,
  receivable,
  recordAudit,
  type AccountCode,
  type MinorUnits,
} from '@payments/ledger'

/** Defined here and not in the module, for the same cycle reason as `PAYABLES_SERVICE`. */
export const RECEIVABLES_SERVICE = Symbol('RECEIVABLES_SERVICE')

/** The books are USDC-only. */
const CURRENCY = 'USDC'

/** Missing, malformed or nobody's: the same mistake, so the same sentence. */
export const UNKNOWN_PARTNER = 'partnerId must be the id of a partner, as GET /receivables lists them.'

/** An invoice a partner owes, as the database holds it. The controller formats the amount. */
export interface Receivable {
  readonly id: string
  readonly partnerName: string
  readonly amountMinor: MinorUnits
  readonly description: string
  readonly status: ReceivableSummary['status']
  /** Stored before the partner broadcasts its transfer, which is what lets a deposit match back. */
  readonly paymentTxHash: string | null
  /** The transaction of the deposit that settled it, once the watcher credited one. */
  readonly depositTxHash: string | null
  /** Where this invoice is paid: the partner's deposit address, which is the attribution itself. */
  readonly depositAddress: Address
}

/** Everything the Receivables screen shows. */
export interface ReceivablesOverview {
  readonly receivables: readonly Receivable[]
  readonly partners: readonly { readonly id: string; readonly name: string }[]
  /** `partner:receivable` and `deposits:onchain`: the two figures this side of the books moves. */
  readonly partnerReceivable: MinorUnits
  readonly deposits: MinorUnits
}

export interface NewReceivable {
  readonly partnerId: string
  readonly amountMinor: MinorUnits
  readonly description: string
}

export class ReceivablesService {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<ReceivablesOverview> {
    const client = await this.pool.connect()
    try {
      return await inTransaction(client, async () => {
        // One snapshot for the three reads, so an invoice created in between cannot show on the
        // books and not in the list.
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ')

        const receivables = await readReceivables(client)
        const partners = await client.query<{ id: string; name: string }>(
          "SELECT id, name FROM partners WHERE status = 'active' ORDER BY derivation_index",
        )
        const balances = await getBalances(client)
        const of = (code: AccountCode): MinorUnits => balances.find((balance) => balance.code === code)?.balanceMinor ?? 0n

        return {
          receivables,
          partners: partners.rows,
          partnerReceivable: of(ACCOUNTS.partnerReceivable),
          deposits: of(ACCOUNTS.depositsOnchain),
        }
      })
    } finally {
      client.release()
    }
  }

  /**
   * One transaction: the invoice and its accrual. The row, the `receivable` movement and the
   * audit line commit together, or a refusal anywhere leaves none of them behind.
   */
  async create(input: NewReceivable): Promise<string> {
    const client = await this.pool.connect()
    try {
      return await inTransaction(client, async () => {
        const partner = await readActivePartner(client, input.partnerId)

        const inserted = await client.query<{ id: string }>(
          `INSERT INTO receivables (partner_id, amount_minor, currency, description)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [partner.id, input.amountMinor.toString(), CURRENCY, input.description],
        )
        const id = inserted.rows[0]?.id
        if (id === undefined) {
          throw new Error('postgres returned no row for an INSERT … RETURNING')
        }

        const ledgerTransactionId = await receivable(client, { receivableId: id, amount: input.amountMinor, currency: CURRENCY })

        await recordAudit(client, {
          actor: AUDIT_ACTORS.admin,
          subjectType: AUDIT_SUBJECTS.receivable,
          subjectId: id,
          event: RECEIVABLE_EVENTS.created,
          context: {
            amountMinor: input.amountMinor,
            currency: CURRENCY,
            partnerId: partner.id,
            partnerName: partner.name,
            // In the row on purpose: this address is the attribution the invoice will be settled by.
            depositAddress: partner.deposit_address,
            ledgerTransactionId,
          },
        })

        return id
      })
    } finally {
      client.release()
    }
  }
}

interface PartnerRow {
  readonly id: string
  readonly name: string
  readonly deposit_address: string
  readonly status: 'active' | 'inactive'
}

async function readActivePartner(client: PoolClient, partnerId: string): Promise<PartnerRow> {
  const result = await client.query<PartnerRow>(
    'SELECT id, name, deposit_address, status FROM partners WHERE id = $1',
    [partnerId],
  )
  const partner = result.rows[0]
  if (partner === undefined) {
    throw new BadRequestException(UNKNOWN_PARTNER)
  }
  if (partner.status !== 'active') {
    throw new UnprocessableEntityException(`${partner.name} is inactive, and invoices are only created for active partners.`)
  }
  return partner
}

interface ReceivableRow {
  readonly id: string
  readonly partner_name: string
  readonly amount_minor: string
  readonly description: string
  readonly status: ReceivableSummary['status']
  readonly payment_tx_hash: string | null
  readonly deposit_tx_hash: string | null
  readonly deposit_address: string
}

/** One invoice, written once: every read of one goes through this SELECT and `toReceivable`. */
const READ_RECEIVABLE = `SELECT r.id, partners.name AS partner_name, r.amount_minor, r.description, r.status,
          r.payment_tx_hash, d.tx_hash AS deposit_tx_hash, partners.deposit_address
     FROM receivables r
     JOIN partners ON partners.id = r.partner_id
     LEFT JOIN deposits d ON d.id = r.deposit_id`

/**
 * Newest first, for one partner or for all of them. Exported because the partner screen reads the
 * same rows from its own snapshot (`GET /partners/view`) rather than paying a second round trip.
 */
export async function readReceivables(db: Pool | PoolClient, partnerId?: string): Promise<Receivable[]> {
  const result = await db.query<ReceivableRow>(
    `${READ_RECEIVABLE} WHERE $1::uuid IS NULL OR r.partner_id = $1 ORDER BY r.created_at DESC`,
    [partnerId ?? null],
  )
  return result.rows.map(toReceivable)
}

/** The one invoice a partner is about to pay (`demo-scaffolding/partner-payments.service.ts`). */
export async function readReceivable(db: Pool | PoolClient, id: string): Promise<Receivable | undefined> {
  const result = await db.query<ReceivableRow>(`${READ_RECEIVABLE} WHERE r.id = $1`, [id])
  const row = result.rows[0]
  return row === undefined ? undefined : toReceivable(row)
}

/** One invoice as both screens show it. Shared, so the two reads cannot describe it differently. */
export function receivableView(invoice: Receivable): ReceivableSummary {
  return {
    id: invoice.id,
    partnerName: invoice.partnerName,
    amount: formatMinor(invoice.amountMinor),
    description: invoice.description,
    status: invoice.status,
    transaction:
      invoice.paymentTxHash === null
        ? null
        : { hash: invoice.paymentTxHash, explorerUrl: explorerTransactionUrl(invoice.paymentTxHash) },
    // Usually the same transaction as the one above: the company's own proof of it, read off the
    // chain rather than off what the partner said it was about to send.
    deposit:
      invoice.depositTxHash === null
        ? null
        : { hash: invoice.depositTxHash, explorerUrl: explorerTransactionUrl(invoice.depositTxHash) },
  }
}

function toReceivable(row: ReceivableRow): Receivable {
  return {
    id: row.id,
    partnerName: row.partner_name,
    amountMinor: BigInt(row.amount_minor),
    description: row.description,
    status: row.status,
    paymentTxHash: row.payment_tx_hash,
    depositTxHash: row.deposit_tx_hash,
    depositAddress: getAddress(row.deposit_address),
  }
}
