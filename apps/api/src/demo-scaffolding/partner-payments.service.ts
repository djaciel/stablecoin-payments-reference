import { ConflictException, Logger, NotFoundException, UnprocessableEntityException } from '@nestjs/common'
import {
  BroadcastRefused,
  CHAIN,
  ERC20_ABI,
  GAS_AT_INCLUSION,
  ReceiptMissing,
  USDC_ADDRESS,
  chainErrorMessage,
  explorerTransactionUrl,
  findSettlementLog,
  readUsdcBalance,
  rpcHost,
  sendSigned,
  transactionCost,
  waitForReceipt,
  type ChainClient,
  type ExpectedTransfer,
  type Receipt,
} from '@payments/chain'
import { applyGuardedTransition, inTransaction, type Pool, type PoolClient } from '@payments/db'
import type { PartnerPaymentReceipt } from '@payments/domain'
import {
  AUDIT_ACTORS,
  AUDIT_SUBJECTS,
  RECEIVABLE_EVENTS,
  formatMinor,
  recordAudit,
  type MinorUnits,
} from '@payments/ledger'
import { encodeFunctionData, formatEther, keccak256, parseEther, type Address, type Hex } from 'viem'
import { readReceivable, receivableView, type Receivable } from '../receivables/receivables.service'
import type { PartnerKeysService } from './partner-keys.service'

/** Defined here and not in the module, for the same cycle reason as `RECEIVABLES_SERVICE`. */
export const PARTNER_PAYMENTS_SERVICE = Symbol('PARTNER_PAYMENTS_SERVICE')

/** The invoices are USDC-only, like the books. */
const CURRENCY = 'USDC'

/** What every chain message in here is about, so they all name the same thing. */
const WHAT = 'the transfer'

/** One wallet has one nonce: every payment from the shared wallet queues behind this lock. */
const PARTNER_WALLET_LOCK = 'partner-wallet-nonce'

/** The same headroom the treasury uses: a transfer that runs out of gas costs gas and transfers nothing. */
const GAS_ESTIMATE_HEADROOM_PERCENT = 20n

/**
 * What the wallet must hold beyond the invoice, so the transfer can pay for itself. A USDC
 * transfer on Base Sepolia costs on the order of 0.0000002 ETH, so being wrong in this
 * direction only costs a refusal that "Fund partner wallet" fixes.
 */
const GAS_ALLOWANCE = parseEther('0.0001')

/**
 * What the company has done about this money, which is nothing: the endpoint says so itself,
 * because "sent" and "paid" are different moments and only the watcher decides the second one.
 */
const NOT_CREDITED_YET =
  'The company has not credited anything yet: its watcher credits this once the block is final and the event checks out.'

/** How many times to ask for the balances at a block the answering node may not have yet. */
const BALANCE_READ_ATTEMPTS = 3
const BALANCE_READ_WAIT_MS = 1_500

/**
 * The other side paying an invoice: one stablecoin transfer from the shared partner wallet to
 * the deposit address the company gave that partner.
 *
 * The signing happens here, in the api, and never in the signer: the signer's one job is the
 * company seed, and a service holding both would erase the boundary the architecture exists to
 * teach. Everything else is `treasury/fund-partner-wallet.service.ts` in miniature — refuse
 * first and say where to fix it, store the hash before broadcasting, and believe no receipt
 * until the official contract's event says the money moved. The two share the sending itself
 * (`sendSigned`, `waitForReceipt` in `packages/chain`).
 *
 * The company's books do not move here at all. They move when its own watcher sees the money.
 */
export class PartnerPaymentsService {
  private readonly logger = new Logger(PartnerPaymentsService.name)

  constructor(
    private readonly pool: Pool,
    private readonly chain: ChainClient,
    private readonly partnerKeys: PartnerKeysService,
  ) {}

  async pay(receivableId: string): Promise<PartnerPaymentReceipt> {
    const client = await this.pool.connect()
    try {
      // 0. One at a time. Two clicks would read the same nonce and sign two transactions of
      //    which only one can ever land. Session-level, so it covers the whole call.
      const taken = await client.query<{ locked: boolean }>('SELECT pg_try_advisory_lock(hashtext($1)) AS locked', [
        PARTNER_WALLET_LOCK,
      ])
      if (taken.rows[0]?.locked !== true) {
        throw new ConflictException('the partner wallet is already sending a payment; try again in a few seconds.')
      }

      try {
        return await this.send(client, receivableId)
      } finally {
        // Swallowed like the migration runner's: releasing the connection drops the lock anyway,
        // and an error thrown from here would replace whatever the call was really answering.
        await client.query('SELECT pg_advisory_unlock(hashtext($1))', [PARTNER_WALLET_LOCK]).catch(() => undefined)
      }
    } finally {
      client.release()
    }
  }

  private async send(client: PoolClient, receivableId: string): Promise<PartnerPaymentReceipt> {
    // 1. The invoice and the address it is paid at. Read without a row lock on purpose: the
    //    guarded transition in step 4 is the guard, and a row lock held across the chain reads
    //    below would be a lock held for as long as the internet feels like it (`sign.ts`).
    const invoice = await readReceivable(client, receivableId)
    if (invoice === undefined) {
      throw new NotFoundException(`no invoice has the id ${receivableId}. GET /receivables lists them.`)
    }
    refuseIfNotOpen(invoice)

    // The account never leaves this method and is never logged: it can sign, so it is spending
    // power over the partner wallet even though it does not carry the seed phrase.
    const account = this.partnerKeys.partnerWallet()
    const from = account.address

    // 2. What the wallet holds, both balances at one block: at `latest` a load-balanced RPC
    //    answers the two calls from nodes at different heights.
    const block = await this.chain.getBlockNumber()
    const [usdc, eth] = await Promise.all([
      readUsdcBalance(this.chain, from, block),
      this.chain.getBalance({ address: from, blockNumber: block }),
    ])
    refuseIfShort({ usdc, eth, amount: invoice.amountMinor })

    // 3. The numbers a signature needs and a key cannot look up.
    const nonce = await this.chain.getTransactionCount({ address: from, blockTag: 'pending' })
    const { maxFeePerGas, maxPriorityFeePerGas } = await this.chain.estimateFeesPerGas()
    const gas = await this.estimateTransferGas(invoice, from)

    // 4. Signed, then stored and committed BEFORE the bytes are broadcast. The hash comes from
    //    the signature, so the transaction has its name before any node has heard of it, and
    //    that name is how the company will attribute the deposit instead of guessing.
    const signedTransaction = await account.signTransaction({
      to: USDC_ADDRESS,
      value: 0n,
      data: encodeFunctionData({
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [invoice.depositAddress, invoice.amountMinor],
      }),
      type: 'eip1559',
      chainId: CHAIN.id,
      nonce,
      gas,
      maxFeePerGas,
      maxPriorityFeePerGas,
    })
    const signed = { hash: keccak256(signedTransaction), signedTransaction }
    await this.storeHash(client, invoice, { hash: signed.hash, from, nonce })

    // 5. Only now does the chain hear about it.
    await this.broadcast(client, invoice, signed)

    // 6. A successful receipt is not a payment: the official contract, the exact destination,
    //    the exact amount — or the invoice goes back to OPEN and the answer says what was seen.
    const receipt = await this.awaitReceipt(signed.hash)
    await this.verifyTransfer(client, invoice, receipt, from)

    // 7. The evidence, which is why this endpoint is synchronous: there is nothing to poll for.
    const cost = transactionCost(receipt)
    return {
      receivable: receivableView({ ...invoice, status: 'PAYING', paymentTxHash: signed.hash }),
      transaction: {
        hash: signed.hash,
        explorerUrl: explorerTransactionUrl(signed.hash),
        blockNumber: receipt.blockNumber.toString(),
      },
      from,
      to: invoice.depositAddress,
      amount: formatMinor(invoice.amountMinor),
      gasEth: formatEther(cost.l2FeeWei + cost.l1FeeWei),
      gasBasis: GAS_AT_INCLUSION,
      credit: NOT_CREDITED_YET,
      partnerWallet: await this.readWalletAt(from, receipt.blockNumber),
    }
  }

  /** The chain decides how much gas a transfer needs; the headroom is this repo's. */
  private async estimateTransferGas(invoice: Receivable, from: Address): Promise<bigint> {
    try {
      const estimate = await this.chain.estimateContractGas({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [invoice.depositAddress, invoice.amountMinor],
        account: from,
      })
      return (estimate * (100n + GAS_ESTIMATE_HEADROOM_PERCENT)) / 100n
    } catch (error) {
      throw new UnprocessableEntityException(
        `the chain (RPC ${rpcHost()}) would not price ${WHAT}, so nothing was signed: ${chainErrorMessage(error)}`,
      )
    }
  }

  /**
   * The hash on the invoice, OPEN → PAYING and the audit row, in one transaction committed
   * before anything is sent. The ordering IS the claim this endpoint makes, and this row is how
   * it is proved afterwards: its time is earlier than the block the transfer landed in.
   */
  private async storeHash(client: PoolClient, invoice: Receivable, sent: { hash: Hex; from: Address; nonce: number }): Promise<void> {
    await inTransaction(client, async () => {
      await applyGuardedTransition(client, {
        table: 'receivables',
        idColumn: 'id',
        id: invoice.id,
        statusColumn: 'status',
        from: 'OPEN',
        to: 'PAYING',
        extraSet: { payment_tx_hash: sent.hash },
      })
      await recordAudit(client, {
        actor: AUDIT_ACTORS.api,
        subjectType: AUDIT_SUBJECTS.receivable,
        subjectId: invoice.id,
        event: RECEIVABLE_EVENTS.paymentSent,
        context: {
          txHash: sent.hash,
          amountMinor: invoice.amountMinor,
          currency: CURRENCY,
          from: sent.from,
          to: invoice.depositAddress,
          nonce: sent.nonce,
          demoScaffolding: true,
        },
      })
    })
  }

  /**
   * `sendSigned` does the sending and the hash check; what a refusal means here is this line.
   * A hash the network renamed is not a refusal and is not caught: those bytes may be in flight
   * under the name it gave, so the stored hash stays where a human can find it.
   */
  private async broadcast(client: PoolClient, invoice: Receivable, signed: { hash: Hex; signedTransaction: Hex }): Promise<void> {
    try {
      await sendSigned(this.chain, signed, WHAT)
    } catch (error) {
      if (error instanceof BroadcastRefused) {
        const reopened = await this.returnToOpen(client, invoice, { txHash: signed.hash, reason: error.message })
        throw new UnprocessableEntityException(`${error.message}. Nothing left the partner wallet. ${reopened}`)
      }
      throw error
    }
  }

  private async awaitReceipt(hash: Hex): Promise<Receipt> {
    try {
      return await waitForReceipt(this.chain, hash, WHAT)
    } catch (error) {
      if (error instanceof ReceiptMissing) {
        // Left PAYING on purpose: the money may still land, and what decides is the company's
        // watcher, not the end of this request.
        throw new UnprocessableEntityException(
          `${error.message}. The invoice stays PAYING because the money may still land; the company credits it when its watcher sees it. See ${explorerTransactionUrl(hash)}`,
        )
      }
      throw error
    }
  }

  /** The paid rule, on the payer's side: without the event, nothing was paid. */
  private async verifyTransfer(client: PoolClient, invoice: Receivable, receipt: Receipt, from: Address): Promise<void> {
    const problem = transferProblem(receipt, { from, to: invoice.depositAddress, amount: invoice.amountMinor })
    if (problem === undefined) {
      return
    }
    const reopened = await this.returnToOpen(client, invoice, { txHash: receipt.transactionHash, reason: problem })
    throw new UnprocessableEntityException(`${problem} ${reopened} See ${explorerTransactionUrl(receipt.transactionHash)}`)
  }

  /**
   * Payable again, with the hash cleared and one `payment-refused` row saying why — without it
   * the log would show a `payment-sent` hash next to an invoice that is OPEN and blank.
   *
   * It never throws, and answers with the sentence the caller adds to its refusal: the chain
   * already said something, and replacing that with a database error would hide it. When this
   * is the part that failed, the log gets the detail and nobody is told the invoice is OPEN.
   */
  private async returnToOpen(
    client: PoolClient,
    invoice: Receivable,
    refused: { txHash: Hex; reason: string },
  ): Promise<string> {
    try {
      await inTransaction(client, async () => {
        await applyGuardedTransition(client, {
          table: 'receivables',
          idColumn: 'id',
          id: invoice.id,
          statusColumn: 'status',
          from: 'PAYING',
          to: 'OPEN',
          extraSet: { payment_tx_hash: null },
        })
        await recordAudit(client, {
          actor: AUDIT_ACTORS.api,
          subjectType: AUDIT_SUBJECTS.receivable,
          subjectId: invoice.id,
          event: RECEIVABLE_EVENTS.paymentRefused,
          context: { txHash: refused.txHash, reason: refused.reason, currency: CURRENCY, demoScaffolding: true },
        })
      })
      return 'The invoice is OPEN again.'
    } catch (error) {
      this.logger.error(
        `${invoice.id} stays PAYING: it could not be put back to OPEN after "${refused.reason}" — ${messageOf(error)}`,
      )
      return 'The invoice could not be put back to OPEN and is still PAYING; the api log says why.'
    }
  }

  /**
   * What the wallet holds after, read at the block the transfer landed in and never at `latest`:
   * a node that has not seen that block yet would report the money as still being there. Retried
   * for the same reason; when it still fails the answer carries no balances, which a screen can
   * say honestly — the money moved either way.
   */
  private async readWalletAt(wallet: Address, blockNumber: bigint): Promise<PartnerPaymentReceipt['partnerWallet']> {
    for (let attempt = 1; attempt <= BALANCE_READ_ATTEMPTS; attempt += 1) {
      try {
        const [usdc, eth] = await Promise.all([
          readUsdcBalance(this.chain, wallet, blockNumber),
          this.chain.getBalance({ address: wallet, blockNumber }),
        ])
        return { usdc: formatMinor(usdc), eth: formatEther(eth) }
      } catch (error) {
        if (attempt === BALANCE_READ_ATTEMPTS) {
          this.logger.warn(
            `the partner wallet's balances at block ${String(blockNumber)} could not be read (RPC ${rpcHost()}): ${chainErrorMessage(error)}`,
          )
          return null
        }
        await wait(BALANCE_READ_WAIT_MS)
      }
    }
    return null
  }
}

/** One condition, one 422: an invoice that is not OPEN has already been paid, or is being paid. */
function refuseIfNotOpen(invoice: Receivable): void {
  if (invoice.status === 'OPEN') {
    return
  }
  const transaction = invoice.paymentTxHash === null ? '' : ` by transaction ${invoice.paymentTxHash}`
  const already = invoice.status === 'PAYING' ? 'it is already being paid' : 'it is already paid'
  throw new UnprocessableEntityException(
    `"${invoice.description}" is ${invoice.status}: ${already}${transaction}. Nothing was signed and nothing was sent.`,
  )
}

/** One condition, one 422: enough stablecoin for the invoice, enough of the native currency to send it. */
function refuseIfShort(held: { usdc: bigint; eth: bigint; amount: MinorUnits }): void {
  if (held.usdc >= held.amount && held.eth >= GAS_ALLOWANCE) {
    return
  }
  throw new UnprocessableEntityException(
    [
      `the partner wallet cannot pay ${formatMinor(held.amount)} ${CURRENCY}:`,
      `it holds ${formatMinor(held.usdc)} ${CURRENCY} and ${formatEther(held.eth)} ETH, and it needs the ${formatMinor(held.amount)} ${CURRENCY}`,
      `plus about ${formatEther(GAS_ALLOWANCE)} ETH for the fee, which is paid in the network's own currency and never in stablecoin.`,
      'Press "Fund partner wallet" on the company\'s Start screen. Nothing was signed and nothing was sent.',
    ].join(' '),
  )
}

/** `undefined` when the receipt is the transfer that was asked for; otherwise what went wrong. */
function transferProblem(receipt: Receipt, expected: ExpectedTransfer): string | undefined {
  if (receipt.status !== 'success') {
    return `${WHAT} ${receipt.transactionHash} reverted on chain, so nothing was transferred.`
  }
  try {
    findSettlementLog(receipt.logs, expected)
    return undefined
  } catch (error) {
    // The rule refusing is the rule working, and the answer repeats what the chain recorded.
    return `the transaction ${receipt.transactionHash} succeeded but is not ${WHAT} this api asked for: ${
      error instanceof Error ? error.message : String(error)
    }`
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
