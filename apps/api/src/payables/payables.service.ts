import { BadRequestException, UnprocessableEntityException } from '@nestjs/common'
import { inTransaction, type Pool, type PoolClient } from '@payments/db'
import type { PayableSummary } from '@payments/domain'
import { ACCOUNTS, getBalances, payable, recordAudit, type MinorUnits } from '@payments/ledger'

/** Defined here and not in the module, for the same cycle reason as `PARTNERS_SERVICE`. */
export const PAYABLES_SERVICE = Symbol('PAYABLES_SERVICE')

/** The books are USDC-only (spec assumption 2). */
const CURRENCY = 'USDC'

/** Missing, malformed or nobody's: the same mistake, so the same sentence. */
export const UNKNOWN_PARTNER = 'partnerId must be the id of a partner, as GET /payables lists them.'

/** An invoice as the database holds it. Formatting and links are the controller's business. */
export interface Payable {
  readonly id: string
  readonly partnerName: string | null
  readonly destination: string
  readonly amountMinor: MinorUnits
  readonly description: string
  readonly status: PayableSummary['status']
}

/** Everything the Payables screen shows. */
export interface PayablesOverview {
  readonly payables: readonly Payable[]
  readonly partners: readonly { readonly id: string; readonly name: string }[]
  /** `partner:payable`: what the company owes all partners together. */
  readonly partnerDebt: MinorUnits
}

export interface NewPayable {
  readonly partnerId: string
  readonly amountMinor: MinorUnits
  readonly description: string
}

export class PayablesService {
  constructor(private readonly pool: Pool) {}

  async list(): Promise<PayablesOverview> {
    const client = await this.pool.connect()
    try {
      const payables = await client.query<PayableRow>(
        `SELECT p.id, partners.name AS partner_name, p.destination, p.amount_minor, p.description, p.status
           FROM payables p
           LEFT JOIN partners ON partners.id = p.partner_id
          ORDER BY p.created_at DESC`,
      )
      const partners = await client.query<{ id: string; name: string }>(
        "SELECT id, name FROM partners WHERE status = 'active' ORDER BY derivation_index",
      )
      const debt = (await getBalances(client)).find((balance) => balance.code === ACCOUNTS.partnerPayable)

      return {
        payables: payables.rows.map(toPayable),
        partners: partners.rows,
        partnerDebt: debt?.balanceMinor ?? 0n,
      }
    } finally {
      client.release()
    }
  }

  /**
   * One transaction: the invoice and its debt. The row, the `payable` movement and the audit
   * line commit together, or a refusal anywhere leaves none of them behind.
   */
  async create(input: NewPayable): Promise<string> {
    const client = await this.pool.connect()
    try {
      return await inTransaction(client, async () => {
        const partner = await readActivePartner(client, input.partnerId)

        const inserted = await client.query<{ id: string }>(
          `INSERT INTO payables (partner_id, destination, amount_minor, currency, description)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING id`,
          [partner.id, partner.payout_address, input.amountMinor.toString(), CURRENCY, input.description],
        )
        const id = inserted.rows[0]?.id
        if (id === undefined) {
          throw new Error('postgres returned no row for an INSERT … RETURNING')
        }

        const ledgerTransactionId = await payable(client, { payableId: id, amount: input.amountMinor, currency: CURRENCY })

        await recordAudit(client, {
          actor: 'admin',
          subjectType: 'invoice',
          subjectId: id,
          event: 'created',
          context: {
            amountMinor: input.amountMinor,
            currency: CURRENCY,
            partnerId: partner.id,
            partnerName: partner.name,
            destination: partner.payout_address,
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
  readonly payout_address: string
  readonly status: 'active' | 'inactive'
}

async function readActivePartner(client: PoolClient, partnerId: string): Promise<PartnerRow> {
  const result = await client.query<PartnerRow>(
    'SELECT id, name, payout_address, status FROM partners WHERE id = $1',
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

interface PayableRow {
  readonly id: string
  readonly partner_name: string | null
  readonly destination: string
  readonly amount_minor: string
  readonly description: string
  readonly status: PayableSummary['status']
}

function toPayable(row: PayableRow): Payable {
  return {
    id: row.id,
    partnerName: row.partner_name,
    destination: row.destination,
    amountMinor: BigInt(row.amount_minor),
    description: row.description,
    status: row.status,
  }
}
