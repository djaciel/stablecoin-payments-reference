import { ApplicationFailure, activityInfo, log } from '@temporalio/activity'
import { chainErrorMessage, createChainClient, rpcHost } from '@payments/chain'
import { applyGuardedTransition, inTransaction, type PoolClient } from '@payments/db'
import { AUDIT_ACTORS, AUDIT_SUBJECTS, PAYMENT_EVENTS, recordAudit } from '@payments/ledger'
import { BaseError, TransactionNotFoundError, type Hex } from 'viem'
import { workerPool } from './db'

const chain = createChainClient()

/** The `execute` activity: make sure the network has the stored bytes, then RESERVED → SENT. */
export async function execute(reference: string): Promise<string> {
  const { attempt } = activityInfo()
  const client = await workerPool().connect()
  try {
    // 1. The row. The bytes come from here and only from here, never from `sign`.
    const payment = await readPayment(client, reference)
    if (payment === undefined) {
      throw ApplicationFailure.nonRetryable(`${reference}: no payment has this reference`)
    }
    if (payment.status === 'SETTLED' || payment.status === 'FAILED') {
      return report(reference, `nothing to send: ${payment.status}`)
    }
    if (payment.tx_hash === null || payment.signed_tx === null) {
      throw ApplicationFailure.nonRetryable(`${reference}: execute before sign, no signed bytes are stored`)
    }
    const hash = payment.tx_hash as Hex

    // 2. Ask first. Found means a previous attempt sent these bytes and died before it could
    //    record SENT: nothing is sent again. Only this answer sets `networkAlreadyKnew`.
    const networkAlreadyKnew = await networkKnows(hash)
    let line = `the network already knew ${hash}; nothing sent`

    // 3. Not found: the same bytes, never a new signature.
    if (!networkAlreadyKnew) {
      const nodeError = await sendStoredBytes(hash, payment.signed_tx as Hex)
      line = nodeError === undefined ? `sent ${hash}` : `sent ${hash}; accepted after the node answered "${nodeError}"`
    }

    // 4. A node has them: RESERVED → SENT, once.
    if (payment.status === 'RESERVED') {
      await inTransaction(client, async () => {
        await applyGuardedTransition(client, {
          table: 'payments',
          idColumn: 'reference',
          id: reference,
          statusColumn: 'status',
          from: 'RESERVED',
          to: 'SENT',
        })
        await recordAudit(client, {
          actor: AUDIT_ACTORS.worker,
          subjectType: AUDIT_SUBJECTS.payment,
          subjectId: reference,
          event: PAYMENT_EVENTS.sent,
          context: { txHash: hash, networkAlreadyKnew, attempt, rpcHost: rpcHost() },
        })
      })
    }

    return report(reference, line)
  } catch (error) {
    log.error(`${reference} execute: attempt ${attempt} FAILED — ${chainErrorMessage(error)} [chain: ${rpcHost()}]`)
    throw error
  } finally {
    client.release()
  }
}

/**
 * Sends the stored bytes. A node that took them can still answer with an error ("already known",
 * a timeout after it took them), so the error class says nothing: an error is answered by asking
 * for the hash. Found means this attempt's bytes got through, and the node's words come back for
 * the log; not found is a retry of these same bytes. Undefined means a clean accept.
 */
async function sendStoredBytes(hash: Hex, signedTransaction: Hex): Promise<string | undefined> {
  let accepted: Hex
  try {
    accepted = await chain.sendRawTransaction({ serializedTransaction: signedTransaction })
  } catch (error) {
    if (await networkKnows(hash)) {
      return nodeAnswer(error)
    }
    // Rebuilt, not rethrown, and with no `cause`: viem's message quotes the request body, which is
    // the signed bytes, and Temporal would copy a cause into its history and the worker's log.
    // eslint-disable-next-line preserve-caught-error -- the cause is left out on purpose, see above
    throw new Error(`the node refused the stored bytes of ${hash}: ${nodeAnswer(error)}`)
  }

  if (accepted.toLowerCase() !== hash.toLowerCase()) {
    throw ApplicationFailure.nonRetryable(
      `the network accepted ${accepted} for the bytes stored as ${hash}; the stored hash would name a transaction nobody has`,
    )
  }
  return undefined
}

/** A node that does not know the hash answers null, which viem raises as `TransactionNotFoundError`. */
async function networkKnows(hash: Hex): Promise<boolean> {
  try {
    await chain.getTransaction({ hash })
    return true
  } catch (error) {
    if (error instanceof TransactionNotFoundError) {
      return false
    }
    throw error
  }
}

interface PaymentRow {
  readonly status: string
  readonly tx_hash: string | null
  readonly signed_tx: string | null
}

async function readPayment(client: PoolClient, reference: string): Promise<PaymentRow | undefined> {
  const result = await client.query<PaymentRow>('SELECT status, tx_hash, signed_tx FROM payments WHERE reference = $1', [
    reference,
  ])
  return result.rows[0]
}

/** The node's own words in one line, e.g. "InvalidInputRpcError: nonce too low". */
function nodeAnswer(error: unknown): string {
  return error instanceof BaseError && error.details ? `${error.name}: ${chainErrorMessage(error.details)}` : chainErrorMessage(error)
}

/** The step's one line: logged for the operator, returned so the Temporal UI shows it too. */
function report(reference: string, line: string): string {
  log.info(`${reference} execute: ${line}`)
  return line
}
