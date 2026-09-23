import { Controller, Get, Inject } from '@nestjs/common'
import { explorerTransactionUrl } from '@payments/chain'
import type { Pool } from '@payments/db'
import type { DepositSummary, Deposits } from '@payments/domain'
import { formatMinor } from '@payments/ledger'
import { DATABASE_POOL } from '../db/db.module'

/** The list shows the latest ones; the rest are still in the database, like payments. */
const LIST_LIMIT = 100

/**
 * The money that arrived, newest first. A read and nothing else: the watcher writes these rows,
 * and no request path ever creates, matches or credits a deposit.
 */
@Controller('deposits')
export class DepositsController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Get()
  async list(): Promise<Deposits> {
    const result = await this.pool.query<DepositRow>(
      `SELECT d.id, partners.name AS partner_name, d.amount_minor, d.status, d.deposit_address, d.block_number,
              d.tx_hash, d.matched_by, d.detected_at, r.id AS receivable_id, r.description AS receivable_description
         FROM deposits d
         JOIN partners ON partners.id = d.partner_id
         LEFT JOIN receivables r ON r.id = d.receivable_id
        ORDER BY d.detected_at DESC
        LIMIT ${String(LIST_LIMIT)}`,
    )
    return { deposits: result.rows.map(toView) }
  }
}

interface DepositRow {
  readonly id: string
  readonly partner_name: string
  readonly amount_minor: string
  readonly status: DepositSummary['status']
  readonly deposit_address: string
  readonly block_number: string
  readonly tx_hash: string
  readonly matched_by: DepositSummary['matchedBy']
  readonly detected_at: Date
  readonly receivable_id: string | null
  readonly receivable_description: string | null
}

function toView(row: DepositRow): DepositSummary {
  return {
    id: row.id,
    partnerName: row.partner_name,
    amount: formatMinor(BigInt(row.amount_minor)),
    status: row.status,
    depositAddress: row.deposit_address,
    blockNumber: row.block_number,
    transaction: { hash: row.tx_hash, explorerUrl: explorerTransactionUrl(row.tx_hash) },
    matchedBy: row.matched_by,
    receivable:
      row.receivable_id === null || row.receivable_description === null
        ? null
        : { id: row.receivable_id, description: row.receivable_description },
    detectedAt: row.detected_at.toISOString(),
  }
}
