import { Logger, UnprocessableEntityException, type OnApplicationBootstrap } from '@nestjs/common'
import {
  ERC20_ABI,
  USDC_ADDRESS,
  chainErrorMessage,
  explorerTransactionUrl,
  findSettlementLog,
  readUsdcBalance,
  rpcHost,
  type ChainClient,
} from '@payments/chain'
import type { Pool, PoolClient } from '@payments/db'
import {
  ACCOUNTS,
  formatMinor,
  getBalances,
  recordAudit,
  scaffolding,
  scaffoldingReference,
  toMinor,
  withLedgerTransaction,
  type AccountBalance,
  type AccountCode,
} from '@payments/ledger'
import { formatEther, getAddress, parseEther, type Address, type Hex } from 'viem'
import type { PartnerKeysService } from '../demo-scaffolding/partner-keys.service'
import type { SignedTransaction, SignerClient } from '../signer/signer-client.service'

/**
 * Here rather than in `treasury.module.ts`, unlike the other tokens in this api: the module
 * registers the controller, so a token defined there and imported by the controller is a
 * cycle — and the symptom is a runtime `Cannot access 'X' before initialization`.
 */
export const TREASURY_SERVICE = Symbol('TREASURY_SERVICE')

/** The books are USDC-only (spec assumption 2). Gas is onchain and in the audit log, never here. */
const CURRENCY = 'USDC'

/**
 * What one click sends to the partner wallet. Constants and not a form: the first version of
 * a demo tool needs no decisions, and these two are small enough that a faucet-funded treasury
 * can do it several times — enough USDC for a few receivables, enough gas for many transfers.
 */
const FUNDING_USDC = toMinor(2)
const FUNDING_ETH = parseEther('0.005')

/** A plain ether transfer costs exactly this much gas. There is nothing to estimate. */
const NATIVE_TRANSFER_GAS = 21_000n

/**
 * Headroom over the estimate for the USDC transfer. The estimate is made against the current
 * state, and the state moves: a transaction that runs out of gas still costs gas and transfers
 * nothing, which is the one failure worth a line of code to avoid.
 */
const GAS_ESTIMATE_HEADROOM_PERCENT = 20n

/**
 * What the treasury must hold beyond the ether it is sending, so that both transactions can
 * pay for themselves. A USDC transfer on Base Sepolia costs on the order of 0.0000002 ETH, so
 * this is hundreds of times what two of them need — being wrong in this direction only costs
 * a refusal the tester can fix at a faucet.
 */
const GAS_ALLOWANCE = parseEther('0.0001')

/**
 * What the treasury must hold for the button to be allowed to run — what it sends, plus the
 * allowance the two transactions pay themselves with. `refuseIfShort` checks exactly these
 * and `GET /treasury` publishes them, so the screen disables the button on the api's own
 * thresholds instead of on a copy of the amounts, which is 0.0001 ETH short.
 */
const REQUIRED_USDC = FUNDING_USDC
const REQUIRED_ETH = FUNDING_ETH + GAS_ALLOWANCE

const FAUCET_DOC = 'docs/dev/faucets.md'

/**
 * How the gas figure is qualified wherever it is published — the audit row and the screen.
 *
 * Base serves `l1Fee` as soon as the transaction is included, and that first answer can be an
 * over-estimate the node later revises (one run here recorded ~2.5× the settled cost). The
 * receipt is still the only honest source available without re-reading the chain, so the
 * figure is kept, split in two, and labelled.
 */
const GAS_BASIS = 'as reported at inclusion; the explorer is the source'

/** How long to wait for a receipt before giving up. Base Sepolia produces a block every ~2 s. */
const RECEIPT_TIMEOUT_MS = 60_000

/** How many times to ask for the balances at a block the answering node may not have yet. */
const BALANCE_READ_ATTEMPTS = 3
const BALANCE_READ_WAIT_MS = 1_500

/**
 * The receipt as this chain formats it. Base is an L2, so a viem receipt from it carries the
 * cost of posting the transaction's data to Ethereum (`l1Fee`) next to the usual gas fields.
 */
type Receipt = Awaited<ReturnType<ChainClient['waitForTransactionReceipt']>>

/** The published names of the three figures the article prints, as decimal strings. */
export interface LedgerFigures {
  readonly available: string
  readonly reserved: string
  readonly partnerDebt: string
}

/** One of the two transactions "Fund partner wallet" sends, as a screen shows it. */
export interface FundingTransfer {
  readonly hash: Hex
  readonly explorerUrl: string
  /** Decimal, in whole tokens: USDC for the transfer, ETH for the gas. */
  readonly amount: string
  readonly blockNumber: string
}

/**
 * What one click sends, and what the treasury must hold for the api to let it run. Decimal,
 * in whole tokens. Published so the screen and the refusal cannot disagree.
 */
export interface FundingAmounts {
  readonly usdc: string
  readonly eth: string
  /** The minimum `fundPartnerWallet` refuses below: on chain for both, in the books for USDC. */
  readonly requires: { readonly usdc: string; readonly eth: string }
}

/**
 * What the two transactions cost to run, from the receipts. Never posted to the books.
 *
 * In two halves because they are not equally final: the L2 fee is settled the moment the
 * receipt exists, the L1 fee is the node's figure at inclusion. `basis` says so in the one
 * sentence a screen can print.
 */
export interface GasSpent {
  readonly totalEth: string
  readonly l2Eth: string
  readonly l1Eth: string
  readonly basis: string
}

export interface PartnerWalletFunding {
  readonly usdc: FundingTransfer
  readonly gas: FundingTransfer
  readonly gasSpent: GasSpent
  readonly ledger: {
    readonly reference: string
    /** False when this hash was already posted — see `postScaffolding`. */
    readonly posted: boolean
  }
  /** Read at the block the transactions landed in, or null when that read failed. */
  readonly balances: {
    readonly treasury: { readonly usdc: string; readonly eth: string }
    readonly partnerWallet: { readonly usdc: string; readonly eth: string }
    readonly blockNumber: string
  } | null
}

/**
 * Everything `GET /treasury` knows that is not HTTP, the one thing the api does for the watcher
 * (it registers the address to watch), and the one movement that takes money out of the
 * treasury without being a payment.
 */
export class TreasuryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(TreasuryService.name)

  constructor(
    private readonly signer: SignerClient,
    private readonly partnerKeys: PartnerKeysService,
    private readonly chain: ChainClient,
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

  /** What the button is about to send, so the screen and the api never disagree about it. */
  fundingAmounts(): FundingAmounts {
    return {
      usdc: formatMinor(FUNDING_USDC),
      eth: formatEther(FUNDING_ETH),
      requires: { usdc: formatMinor(REQUIRED_USDC), eth: formatEther(REQUIRED_ETH) },
    }
  }

  async ledgerFigures(): Promise<LedgerFigures> {
    const balances = await this.readBalances()
    const of = (code: AccountCode): string => formatMinor(balanceOf(balances, code))
    return {
      available: of(ACCOUNTS.treasuryAvailable),
      reserved: of(ACCOUNTS.treasuryReserved),
      partnerDebt: of(ACCOUNTS.partnerPayable),
    }
  }

  /**
   * "Fund partner wallet": two transactions from the treasury and one entry in the books.
   *
   * It is the only place money leaves the treasury without being a payment, which is why the
   * entry it writes is labelled `demo:partner-funding` instead of hiding among the payments.
   * It is also this repo's first broadcast, in miniature: the signer holds the key and reads
   * no chain, the api holds the chain and holds no key, the hash exists before the broadcast,
   * and a receipt is not accepted as money moved until the official contract's event says so.
   */
  async fundPartnerWallet(): Promise<PartnerWalletFunding> {
    // 1. Who, and what each side holds right now.
    const treasury = await this.address()
    const partnerWallet = this.partnerWalletAddress()
    const block = await this.chain.getBlockNumber()
    const [usdcBalance, ethBalance] = await Promise.all([
      readUsdcBalance(this.chain, treasury, block),
      this.chain.getBalance({ address: treasury, blockNumber: block }),
    ])
    const available = balanceOf(await this.readBalances(), ACCOUNTS.treasuryAvailable)

    // 2. Refuse before anything is signed, and say where to fix it.
    this.refuseIfShort({ usdcBalance, ethBalance, available })

    // 3. The numbers the signer cannot look up, because it never talks to a node.
    const nonce = await this.chain.getTransactionCount({ address: treasury, blockTag: 'pending' })
    const { maxFeePerGas, maxPriorityFeePerGas } = await this.chain.estimateFeesPerGas()
    const transferGas = await this.estimateTransferGas(treasury, partnerWallet)

    // 4. Sign both, broadcast both, then wait. Consecutive nonces, so the network orders
    // them for us; waiting for the first receipt before sending the second would only make
    // the modal slower to finish saying the same thing.
    const usdcSigned = await this.signer.signTransfer({
      to: partnerWallet,
      amount: FUNDING_USDC,
      nonce,
      gas: transferGas,
      maxFeePerGas,
      maxPriorityFeePerGas,
    })
    const gasSigned = await this.signer.signNativeTransfer({
      to: partnerWallet,
      amount: FUNDING_ETH,
      nonce: nonce + 1,
      gas: NATIVE_TRANSFER_GAS,
      maxFeePerGas,
      maxPriorityFeePerGas,
    })

    const usdcHash = await this.broadcast(usdcSigned, 'the USDC transfer')
    const gasHash = await this.broadcast(gasSigned, 'the gas transfer')

    const [usdcReceipt, gasReceipt] = await Promise.all([
      this.awaitReceipt(usdcHash, 'the USDC transfer'),
      this.awaitReceipt(gasHash, 'the gas transfer'),
    ])

    // 5. A successful receipt is not a payment. This is: the official contract, the exact
    // destination, the exact amount — or nothing is posted and the answer says what was seen.
    this.verifyTransfer(usdcReceipt, { from: treasury, to: partnerWallet })

    // 6. The entry and its audit row, together.
    const gasSpent = addCosts(costOf(usdcReceipt), costOf(gasReceipt))
    const posted = await this.postScaffolding({ usdcReceipt, gasReceipt, gasSpent })

    // 7. What the screen shows, with the balances pinned to the block the money landed in.
    return {
      usdc: transferView(usdcReceipt, formatMinor(FUNDING_USDC)),
      gas: transferView(gasReceipt, formatEther(FUNDING_ETH)),
      gasSpent: gasSpentView(gasSpent),
      ledger: { reference: scaffoldingReference(usdcReceipt.transactionHash), posted },
      balances: await this.readBalancesAt(landedBlock(usdcReceipt, gasReceipt), treasury, partnerWallet),
    }
  }

  /** One condition, one 422: enough USDC on chain AND in the books, enough ether for both. */
  private refuseIfShort(held: { usdcBalance: bigint; ethBalance: bigint; available: bigint }): void {
    const shortOfUsdc = held.usdcBalance < REQUIRED_USDC
    const shortOfBooks = held.available < REQUIRED_USDC
    const shortOfEther = held.ethBalance < REQUIRED_ETH

    if (!shortOfUsdc && !shortOfBooks && !shortOfEther) {
      return
    }

    throw new UnprocessableEntityException(
      [
        `the treasury cannot fund the partner wallet with ${formatMinor(FUNDING_USDC)} USDC and ${formatEther(FUNDING_ETH)} ETH,`,
        `which needs it to hold at least ${formatMinor(REQUIRED_USDC)} USDC and ${formatEther(REQUIRED_ETH)} ETH (the extra ether runs the two transactions).`,
        `It holds ${formatMinor(held.usdcBalance)} USDC and ${formatEther(held.ethBalance)} ETH on chain, and the books show ${formatMinor(held.available)} USDC available.`,
        shortOfBooks && !shortOfUsdc
          ? 'The money is on chain but not in the books yet — the watcher posts it within a few seconds of the block becoming final.'
          : `Fund it from a faucet first: ${FAUCET_DOC}.`,
        'Nothing was signed and nothing was posted.',
      ].join(' '),
    )
  }

  /** The chain decides how much gas an ERC-20 transfer needs; the headroom is this repo's. */
  private async estimateTransferGas(treasury: Address, partnerWallet: Address): Promise<bigint> {
    try {
      const estimate = await this.chain.estimateContractGas({
        address: USDC_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'transfer',
        args: [partnerWallet, FUNDING_USDC],
        account: treasury,
      })
      return (estimate * (100n + GAS_ESTIMATE_HEADROOM_PERCENT)) / 100n
    } catch (error) {
      throw new UnprocessableEntityException(
        `the chain (RPC ${rpcHost()}) would not price the USDC transfer, so nothing was signed: ${chainErrorMessage(error)}`,
      )
    }
  }

  /**
   * Sends the raw bytes and checks the network agreed about their name.
   *
   * The equality is not ceremony: the hash was computed from the signature before anything
   * was broadcast, and everything downstream — the explorer link, the ledger reference, the
   * retry that must re-send these exact bytes — is that hash. A node answering with a
   * different one would make all of it point at a transaction nobody has.
   */
  private async broadcast(signed: SignedTransaction, what: string): Promise<Hex> {
    let accepted: Hex
    try {
      accepted = await this.chain.sendRawTransaction({ serializedTransaction: signed.signedTransaction })
    } catch (error) {
      throw new UnprocessableEntityException(
        `the chain (RPC ${rpcHost()}) refused ${what}: ${chainErrorMessage(error)}. Nothing was posted to the books.`,
      )
    }

    if (accepted !== signed.hash) {
      throw new Error(
        `the network accepted a different transaction than the one signed for ${what}: ${accepted} instead of ${signed.hash}. The stored hash would be worthless.`,
      )
    }
    return accepted
  }

  private async awaitReceipt(hash: Hex, what: string): Promise<Receipt> {
    try {
      return await this.chain.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS })
    } catch (error) {
      throw new UnprocessableEntityException(
        `${what} was broadcast as ${hash} but no receipt arrived (RPC ${rpcHost()}): ${chainErrorMessage(error)}. Nothing was posted to the books; check ${explorerTransactionUrl(hash)} before sending again.`,
      )
    }
  }

  /** Step 5's two checks, with the article's rule doing the second one. */
  private verifyTransfer(receipt: Receipt, parties: { from: Address; to: Address }): void {
    if (receipt.status !== 'success') {
      throw new UnprocessableEntityException(
        `the USDC transfer ${receipt.transactionHash} reverted on chain, so nothing was transferred and nothing was posted. See ${explorerTransactionUrl(receipt.transactionHash)}`,
      )
    }

    try {
      findSettlementLog(receipt.logs, { ...parties, amount: FUNDING_USDC })
    } catch (error) {
      // The rule refusing is the rule working. Nothing is posted and the answer repeats what
      // the chain actually recorded.
      throw new UnprocessableEntityException(
        `the transaction ${receipt.transactionHash} succeeded but is not the transfer this api asked for, so the books were left alone: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }

  /**
   * The entry and the audit row in one database transaction.
   *
   * Idempotent by reference, like the watcher's funding: the transaction hash names the
   * ledger transaction, and `(kind, reference)` is unique, so presenting the same hash twice
   * posts once. Clicking the button twice is NOT one funding — the second click signs a new
   * transaction with a new hash, and the books show two entries, which is exactly what
   * happened.
   */
  private async postScaffolding(landed: {
    usdcReceipt: Receipt
    gasReceipt: Receipt
    gasSpent: GasCost
  }): Promise<boolean> {
    const txHash = landed.usdcReceipt.transactionHash
    const reference = scaffoldingReference(txHash)

    return withLedgerTransaction(this.pool, async (client) => {
      if (await alreadyPosted(client, reference)) {
        this.logger.warn(`${reference} was already posted; the books were left as they are`)
        return false
      }

      const ledgerTransactionId = await scaffolding(client, { txHash, amount: FUNDING_USDC, currency: CURRENCY })

      // Everything the books deliberately refuse to hold. The gas is real money and it is
      // recorded here, from the receipts, because a balance read before and after would be
      // answered by two nodes at different heights and could report zero. Its two halves are
      // stored apart and dated: the L1 half is the node's figure at inclusion, not a
      // settled cost, and a reader adding them up should know that before they do.
      await recordAudit(client, {
        actor: 'api',
        subjectType: 'demo',
        subjectId: reference,
        event: 'partner-wallet-funded',
        context: {
          usdcTxHash: txHash,
          usdcAmountMinor: FUNDING_USDC,
          usdcBlockNumber: landed.usdcReceipt.blockNumber,
          gasTxHash: landed.gasReceipt.transactionHash,
          gasAmountWei: FUNDING_ETH,
          gasBlockNumber: landed.gasReceipt.blockNumber,
          gasSpent: {
            l2FeeWei: landed.gasSpent.l2FeeWei,
            l1FeeWei: landed.gasSpent.l1FeeWei,
            note: GAS_BASIS,
          },
          currency: CURRENCY,
          ledgerTransactionId,
        },
      })

      return true
    })
  }

  /**
   * The four balances after the money moved, read at the block it landed in.
   *
   * Never at `latest`: the public RPC is load balanced and its nodes lag each other, so the
   * figures would be read at two heights, and a node that has not seen the block yet would
   * report the money as still being where it was.
   *
   * That lag is also why this retries. The block is seconds old, so the node that answers may
   * genuinely not have it yet and says `Requested resource not found` — measured live, it has
   * it a second or two later. When it still does not, the answer carries no balances at all,
   * which a screen can say honestly; the money is on chain either way.
   */
  private async readBalancesAt(
    blockNumber: bigint,
    treasury: Address,
    partnerWallet: Address,
  ): Promise<PartnerWalletFunding['balances']> {
    for (let attempt = 1; attempt <= BALANCE_READ_ATTEMPTS; attempt += 1) {
      try {
        const [treasuryUsdc, treasuryEth, partnerUsdc, partnerEth] = await Promise.all([
          readUsdcBalance(this.chain, treasury, blockNumber),
          this.chain.getBalance({ address: treasury, blockNumber }),
          readUsdcBalance(this.chain, partnerWallet, blockNumber),
          this.chain.getBalance({ address: partnerWallet, blockNumber }),
        ])
        return {
          treasury: { usdc: formatMinor(treasuryUsdc), eth: formatEther(treasuryEth) },
          partnerWallet: { usdc: formatMinor(partnerUsdc), eth: formatEther(partnerEth) },
          blockNumber: blockNumber.toString(),
        }
      } catch (error) {
        if (attempt === BALANCE_READ_ATTEMPTS) {
          this.logger.warn(
            `the balances at block ${blockNumber} could not be read after ${attempt} attempts (RPC ${rpcHost()}): ${chainErrorMessage(error)}`,
          )
          return null
        }
        await wait(BALANCE_READ_WAIT_MS)
      }
    }
    return null
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function balanceOf(balances: readonly AccountBalance[], code: AccountCode): bigint {
  return balances.find((balance) => balance.code === code)?.balanceMinor ?? 0n
}

/** The two halves of what running a transaction cost, in wei. Never added up silently. */
interface GasCost {
  /** Executing it on Base: settled as soon as the receipt exists. */
  readonly l2FeeWei: bigint
  /** Posting its bytes to Ethereum: the node's figure at inclusion — see `GAS_BASIS`. */
  readonly l1FeeWei: bigint
}

/**
 * What running one transaction cost, from the receipt and never from the difference between
 * two balance reads (v1's lesson: a lagging node makes that subtraction report zero).
 *
 * Two fees, because Base is an L2: the gas it burns executing the transaction, and `l1Fee`,
 * what it pays Ethereum to store the transaction's bytes. Leaving the second one out reports
 * a cost that does not match the treasury's balance, and on a cheap L2 it is the bigger half
 * — the same half the node only estimates at inclusion, which is why they stay separate.
 */
function costOf(receipt: Receipt): GasCost {
  return { l2FeeWei: receipt.gasUsed * receipt.effectiveGasPrice, l1FeeWei: receipt.l1Fee ?? 0n }
}

function addCosts(first: GasCost, second: GasCost): GasCost {
  return { l2FeeWei: first.l2FeeWei + second.l2FeeWei, l1FeeWei: first.l1FeeWei + second.l1FeeWei }
}

/** The same figure the audit row keeps, in ether and with its caveat attached. */
function gasSpentView(cost: GasCost): GasSpent {
  return {
    totalEth: formatEther(cost.l2FeeWei + cost.l1FeeWei),
    l2Eth: formatEther(cost.l2FeeWei),
    l1Eth: formatEther(cost.l1FeeWei),
    basis: GAS_BASIS,
  }
}

/** The later of the two blocks: at that height both transactions have happened. */
function landedBlock(first: Receipt, second: Receipt): bigint {
  return first.blockNumber > second.blockNumber ? first.blockNumber : second.blockNumber
}

function transferView(receipt: Receipt, amount: string): FundingTransfer {
  return {
    hash: receipt.transactionHash,
    explorerUrl: explorerTransactionUrl(receipt.transactionHash),
    amount,
    blockNumber: receipt.blockNumber.toString(),
  }
}

async function alreadyPosted(client: PoolClient, reference: string): Promise<boolean> {
  const existing = await client.query("SELECT 1 FROM ledger_transactions WHERE kind = 'scaffolding' AND reference = $1", [
    reference,
  ])
  return existing.rows.length > 0
}
