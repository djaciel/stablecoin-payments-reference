import { BadRequestException, Body, ConflictException, Controller, Get, Inject, Post } from '@nestjs/common'
import type { Pool } from '@payments/db'
import type { Allowlist, AllowlistedAddress } from '@payments/domain'
import { field, readAddress } from '../body'
import { DATABASE_POOL } from '../db/db.module'

/** The longest label the panel shows without wrapping into nonsense, like a partner's name. */
const MAX_LABEL_LENGTH = 80

const MALFORMED_ADDRESS = 'address must be an EVM address: 0x and 40 hexadecimal characters.'

/**
 * The addresses the company may send money to, read and added. A controller and nothing else:
 * the list is one table with no rules of its own, and the payment door reads it directly.
 *
 * Add-only, and open to any admin, because this demo has no auth. In a real system this is where a
 * four-eyes rule lives, next to compliance and custody.
 */
@Controller('allowlist')
export class AllowlistController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Get()
  list(): Promise<Allowlist> {
    return this.read()
  }

  /** Answers with the whole list, so the screen shows the new address without a second read. */
  @Post()
  async add(@Body() body: unknown): Promise<Allowlist> {
    const address = readAddress(body, 'address', MALFORMED_ADDRESS)
    const label = readLabel(body)

    const inserted = await this.pool.query(
      'INSERT INTO allowlist (address, label) VALUES ($1, $2) ON CONFLICT (address) DO NOTHING',
      [address, label],
    )
    if (inserted.rowCount === 0) {
      const existing = await this.pool.query<{ label: string }>('SELECT label FROM allowlist WHERE address = $1', [address])
      throw new ConflictException(`${address} is already on the allowlist, as “${existing.rows[0]?.label ?? ''}”.`)
    }

    return this.read()
  }

  /** The partners' addresses first, since they were there before anybody typed one. */
  private async read(): Promise<Allowlist> {
    const result = await this.pool.query<AllowlistRow>(
      `SELECT a.address, a.label, partners.name AS partner_name
         FROM allowlist a LEFT JOIN partners ON partners.id = a.partner_id
        ORDER BY (a.partner_id IS NULL), a.created_at DESC`,
    )
    return { addresses: result.rows.map(toAddress) }
  }
}

interface AllowlistRow {
  readonly address: string
  readonly label: string
  readonly partner_name: string | null
}

function toAddress(row: AllowlistRow): AllowlistedAddress {
  return { address: row.address, label: row.label, partnerName: row.partner_name }
}

/** One condition and one sentence, like a partner's name: a label is text somebody can read. */
function readLabel(body: unknown): string {
  const raw = field(body, 'label')
  const label = typeof raw === 'string' ? raw.trim() : ''
  if (label === '' || label.length > MAX_LABEL_LENGTH) {
    throw new BadRequestException(`label must say whose address this is, in 1 to ${String(MAX_LABEL_LENGTH)} characters.`)
  }
  return label
}
