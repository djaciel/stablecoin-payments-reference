import type { ObservedTransfer } from '@payments/chain'
import { applyGuardedTransition, inTransaction, type PoolClient } from '@payments/db'
import {
  AUDIT_ACTORS,
  AUDIT_SUBJECTS,
  DEPOSIT_EVENTS,
  RECEIVABLE_EVENTS,
  deposit as depositMovement,
  formatMinor,
  recordAudit,
  type MinorUnits,
} from '@payments/ledger'

/**
 * The deposit half of a watcher tick: record what arrived, then credit what the chain can no
 * longer take back. Plain functions taking the caller's client and no Temporal API, so
 * `tests/db/deposits.db.test.ts` calls them directly — the shape `settle.ts` uses.
 */

/** The books are USDC-only. */
const CURRENCY = 'USDC'

/** How a deposit found the invoice it paid, stored on the row so a screen never has to guess. */
export type MatchedBy = 'hash' | 'amount' | 'unmatched'

/** What `settle` gets from `watch`, read a second time from the receipt at promotion. */
export interface DepositEvidence {
  readonly txHash: string
  readonly blockNumber: number
  readonly finalBlock: number
  readonly logIndex: number
}

/** A DETECTED deposit whose block is final: everything the promotion pass needs to check it. */
export interface PromotableDeposit {
  readonly id: string
  readonly txHash: string
  readonly logIndex: number
  readonly fromAddress: string
  readonly depositAddress: string
  readonly partnerId: string
  readonly amountMinor: MinorUnits
  readonly currency: string
  readonly blockNumber: bigint
}

export type SettleDepositOutcome =
  | { readonly kind: 'settled'; readonly matchedBy: MatchedBy; readonly receivableId: string | null; readonly ledgerTransactionId: string }
  /** Credited before: a worker that died after COMMIT, or a range scanned twice. */
  | { readonly kind: 'already-settled' }

/** What one transfer to a deposit address did to the table, and the tick's line for it. */
export interface DetectedOutcome {
  readonly recorded: boolean
  readonly line: string
}

/**
 * Writes the DETECTED row, or finds it is already there. Runs inside the tick's transaction, so
 * the row and the cursor commit together.
 *
 * `(tx_hash, log_index)` is what makes the tail pass free: the same Transfer is read every tick
 * until its block is final, and every read after the first conflicts and does nothing.
 */
export async function recordDetected(
  client: PoolClient,
  observed: ObservedTransfer,
  partnerId: string,
  finalBlock: bigint,
): Promise<DetectedOutcome> {
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO deposits (tx_hash, log_index, from_address, deposit_address, partner_id, amount_minor, currency, block_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tx_hash, log_index) DO NOTHING
     RETURNING id`,
    [
      observed.txHash,
      observed.logIndex,
      observed.from,
      observed.to,
      partnerId,
      observed.amount.toString(),
      CURRENCY,
      observed.blockNumber.toString(),
    ],
  )

  const id = inserted.rows[0]?.id
  const amount = `${formatMinor(observed.amount)} ${CURRENCY}`
  if (id === undefined) {
    return { recorded: false, line: `${observed.txHash}:${String(observed.logIndex)}: already detected, nothing to do` }
  }

  await recordAudit(client, {
    actor: AUDIT_ACTORS.watcher,
    subjectType: AUDIT_SUBJECTS.deposit,
    subjectId: id,
    event: DEPOSIT_EVENTS.detected,
    context: {
      txHash: observed.txHash,
      logIndex: observed.logIndex,
      blockNumber: observed.blockNumber,
      finalBlock,
      amountMinor: observed.amount,
      currency: CURRENCY,
      partnerId,
      depositAddress: observed.to,
      from: observed.from,
    },
  })

  const final = observed.blockNumber <= finalBlock ? 'final' : 'not final yet'
  return { recorded: true, line: `deposit ${id}: ${amount} at ${observed.to}, block ${observed.blockNumber} (${final}) — detected, nothing credited` }
}

/**
 * Deposits whose block the chain has agreed not to replace, oldest first. Everything else stays
 * where it is: a row above the final block is something the chain showed us, not money.
 */
export async function promotableDeposits(client: PoolClient, finalBlock: bigint): Promise<PromotableDeposit[]> {
  const result = await client.query<DepositRow>(
    `SELECT id, tx_hash, log_index, from_address, deposit_address, partner_id, amount_minor, currency, block_number
       FROM deposits
      WHERE status = 'DETECTED' AND block_number <= $1
      ORDER BY detected_at`,
    [finalBlock.toString()],
  )
  return result.rows.map(toPromotable)
}

/**
 * A receipt that now names another block: the stored one is corrected and the deposit waits for
 * THAT block to be final. This is what a reorganisation looks like from here, and it costs
 * nothing because a DETECTED row has never been credited.
 */
export async function correctBlock(client: PoolClient, depositId: string, blockNumber: bigint): Promise<void> {
  await client.query(`UPDATE deposits SET block_number = $2 WHERE id = $1 AND status = 'DETECTED'`, [
    depositId,
    blockNumber.toString(),
  ])
}

/**
 * The second look disagreed: no receipt any more, or a receipt whose logs no longer carry the
 * expected Transfer. The row stays DETECTED and nothing is credited; the reason goes in the log,
 * where the Transfers screen reads it.
 */
export async function markMismatched(client: PoolClient, deposit: PromotableDeposit, reason: string): Promise<void> {
  // Said once, not once every ten seconds: the promotion pass meets a deposit like this on every
  // tick for as long as it exists, and an append-only log would fill up with the same sentence.
  const said = await client.query<{ reason: string | null }>(
    `SELECT context->>'reason' AS reason FROM audit_log
      WHERE subject_type = $1 AND subject_id = $2 AND event = $3
      ORDER BY id DESC LIMIT 1`,
    [AUDIT_SUBJECTS.deposit, deposit.id, DEPOSIT_EVENTS.mismatched],
  )
  if (said.rows[0]?.reason === reason) {
    return
  }

  await recordAudit(client, {
    actor: AUDIT_ACTORS.watcher,
    subjectType: AUDIT_SUBJECTS.deposit,
    subjectId: deposit.id,
    event: DEPOSIT_EVENTS.mismatched,
    context: { txHash: deposit.txHash, blockNumber: deposit.blockNumber, reason },
  })
}

/**
 * DETECTED → SETTLED, posted once: one transaction that credits the books and settles the invoice
 * the money belongs to. No chain reads — the caller has already re-read the receipt and checked
 * the event, because an RPC call inside this transaction would hold the ledger's locks for as
 * long as the internet felt like it.
 */
export async function settleDeposit(client: PoolClient, depositId: string, evidence: DepositEvidence): Promise<SettleDepositOutcome> {
  return inTransaction(client, async () => {
    // 1. The deposit row first, so two promotions of the same deposit queue instead of racing.
    const locked = await client.query<DepositRow & { status: string }>(
      `SELECT id, tx_hash, log_index, from_address, deposit_address, partner_id, amount_minor, currency, block_number, status
         FROM deposits WHERE id = $1 FOR UPDATE`,
      [depositId],
    )
    const row = locked.rows[0]
    if (row === undefined) {
      throw new Error(`no deposit has the id ${depositId}`)
    }
    if (row.status === 'SETTLED') {
      return { kind: 'already-settled' }
    }
    const money = toPromotable(row)

    // 2. The invoice, locked before the accounts (the order `settle.ts` and `create-payment.ts`
    //    use), and found by two statements a reader can read in the order the rule is written.
    const byHash = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM receivables
        WHERE payment_tx_hash = $1 AND partner_id = $2 AND status = 'PAYING'
          FOR UPDATE`,
      [money.txHash, money.partnerId],
    )
    const byAmount =
      byHash.rows[0] !== undefined
        ? undefined
        : await client.query<{ id: string; status: string }>(
            `SELECT id, status FROM receivables
              WHERE partner_id = $1 AND status = 'OPEN' AND amount_minor = $2
              ORDER BY created_at LIMIT 1
                FOR UPDATE`,
            [money.partnerId, money.amountMinor.toString()],
          )

    const invoice = byHash.rows[0] ?? byAmount?.rows[0]
    const matchedBy: MatchedBy = byHash.rows[0] !== undefined ? 'hash' : invoice === undefined ? 'unmatched' : 'amount'

    // 3. The books: Dr Deposits / Cr Partner receivables, at the amount the event carried. An
    //    unmatched deposit is credited too — money that arrived is money that arrived, and
    //    `partner:receivable` going negative is what "they paid before we invoiced" looks like.
    const ledgerTransactionId = await depositMovement(client, {
      depositId: money.id,
      amount: money.amountMinor,
      currency: money.currency,
    })

    // 4. The deposit and its invoice, in the same transaction as the entries.
    await applyGuardedTransition(client, {
      table: 'deposits',
      idColumn: 'id',
      id: money.id,
      statusColumn: 'status',
      from: 'DETECTED',
      to: 'SETTLED',
      extraSet: { matched_by: matchedBy, receivable_id: invoice?.id ?? null, settled_at: new Date() },
    })
    if (invoice !== undefined) {
      await applyGuardedTransition(client, {
        table: 'receivables',
        idColumn: 'id',
        id: invoice.id,
        statusColumn: 'status',
        from: invoice.status,
        to: 'PAID',
        extraSet: { deposit_id: money.id },
      })
      await recordAudit(client, {
        actor: AUDIT_ACTORS.watcher,
        subjectType: AUDIT_SUBJECTS.receivable,
        subjectId: invoice.id,
        event: RECEIVABLE_EVENTS.paid,
        context: { depositId: money.id, txHash: money.txHash, amountMinor: money.amountMinor, matchedBy },
      })
    }

    // 5. The evidence, next to the entries it justifies.
    await recordAudit(client, {
      actor: AUDIT_ACTORS.watcher,
      subjectType: AUDIT_SUBJECTS.deposit,
      subjectId: money.id,
      event: DEPOSIT_EVENTS.settled,
      context: {
        ...evidence,
        amountMinor: money.amountMinor,
        currency: money.currency,
        matchedBy,
        receivableId: invoice?.id ?? null,
        ledgerTransactionId,
      },
    })

    return { kind: 'settled', matchedBy, receivableId: invoice?.id ?? null, ledgerTransactionId }
  })
}

interface DepositRow {
  readonly id: string
  readonly tx_hash: string
  readonly log_index: number
  readonly from_address: string
  readonly deposit_address: string
  readonly partner_id: string
  readonly amount_minor: string
  readonly currency: string
  readonly block_number: string
}

function toPromotable(row: DepositRow): PromotableDeposit {
  return {
    id: row.id,
    txHash: row.tx_hash,
    logIndex: row.log_index,
    fromAddress: row.from_address,
    depositAddress: row.deposit_address,
    partnerId: row.partner_id,
    amountMinor: BigInt(row.amount_minor),
    currency: row.currency,
    blockNumber: BigInt(row.block_number),
  }
}
