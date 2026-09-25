# API

Every endpoint of the api (`http://localhost:3000`) and of the signer, with what it answers and
when. A reference only: how to run the demo is in the [README](../README.md), where the code lives
is in [GUIDE.md](../GUIDE.md), and why the payment door works this way is in the article (§4, §9).

- [Conventions](#conventions)
- [Endpoints, by module](#endpoints-by-module)
- [`POST /payments`: codes and replays](#post-payments-codes-and-replays)
- [Known limitation: a replay after its scheduled time](#known-limitation-a-replay-after-its-scheduled-time)
- [The signer](#the-signer)

## Conventions

- **No auth.** Every route is open to whoever reaches the port. Where a real system adds it:
  [integration-points.md](integration-points.md).
- Amounts on the wire are decimal strings in whole USDC (`"0.50"`), at most 6 decimals. A JSON
  number is refused: it is a float. Answers carry amounts the same way.
- The response types are in `packages/domain/src/api.ts` (`Experiments` in `packages/domain/src/experiments.ts`), under the names used below.
- Every refusal is one condition and one sentence: Nest's `{ statusCode, message, error }`, with
  the sentence in `message`. Malformed JSON is a 400.
- A GET that also reads the chain answers 200 when the RPC fails: the chain figures come back
  `null` with a `chainError` sentence, and the database half is still there.
- 503 means the signer (or Temporal, for the reconciliation run) did not answer, and nothing was
  written.

## Endpoints, by module

**Health**

| Method | Path | Body | Answers | Codes |
|---|---|---|---|---|
| GET | `/health` | | `Health`: `{ status: "ok", database: "up" }` | 200; 503 `{ status: "degraded", database: "unreachable" }` |

**Treasury**

| Method | Path | Body | Answers | Codes |
|---|---|---|---|---|
| GET | `/treasury` | | `Treasury`: address, balances on chain at one block, Available / Reserved / Partner debt, the partner wallet | 200; 503 signer |
| POST | `/treasury/fund-partner-wallet` | none | `PartnerWalletFunding`: both transactions, gas spent, the ledger reference | 200; 422 treasury short, a signed payment holds the nonce, or the chain refused or reverted it; 503 signer |

**Partners**

| Method | Path | Body | Answers | Codes |
|---|---|---|---|---|
| GET | `/partners` | | `Partners`: each partner's two addresses, balances, owes / owed / arrived | 200 |
| POST | `/partners` | `{ name }` (1 to 80 characters) | `Partners` | 201; 400; 503 signer |
| GET | `/partners/view?partnerId=` | | `PartnerView`: everything `/partner` shows; no `partnerId` = the first partner | 200; 400 unknown `partnerId` |

**Payables** (invoices the company owes)

| Method | Path | Body | Answers | Codes |
|---|---|---|---|---|
| GET | `/payables` | | `Payables`: invoices, the form's partners, Available / Reserved / Partner debt | 200 |
| POST | `/payables` | `{ partnerId }` or `{ destination }`, exactly one, plus `{ amount, description }` | `Payables` | 201; 400; 422 partner inactive |

`amount` is 0.01 to 1,000 USDC; `description` 1 to 200 characters. An invoice to a `destination`
is how a payment to an address starts.

**Payments**

| Method | Path | Body | Answers | Codes |
|---|---|---|---|---|
| POST | `/payments` | header `idempotency-key` (1 to 200 characters); `{ payableId, executeAt? }` | `PaymentView` | 201, 200, 409, 422, 400 (below) |
| GET | `/payments` | | `Payments`: the latest 100, newest first, with the REVIEW context | 200 |
| GET | `/payments/:reference` | | `PaymentView` | 200; 404 |
| GET | `/payments/:reference/timeline` | | `PaymentTimeline`: the payment, its audit rows in order, its Temporal link | 200; 404 |
| POST | `/payments/:reference/cancel` | none | `PaymentView`, FAILED `cancelled` | 200; 404; 409 `cannot_cancel_after_signing` when a hash is stored; 409 when not RESERVED |
| POST | `/payments/:reference/resume` | none | `PaymentView`, back to RESERVED or SENT | 200; 404; 409 when not in REVIEW |

`executeAt` is an ISO time in the future, at most 24 hours ahead. Cancel and resume write nothing
when they answer 409.

**Receivables** (invoices partners owe)

| Method | Path | Body | Answers | Codes |
|---|---|---|---|---|
| GET | `/receivables` | | `Receivables`: invoices, the form's partners, `partner:receivable` and `deposits:onchain` | 200 |
| POST | `/receivables` | `{ partnerId, amount, description }` | `Receivables` | 201; 400; 422 partner inactive |

**Deposits**

| Method | Path | Body | Answers | Codes |
|---|---|---|---|---|
| GET | `/deposits` | | `Deposits`: the latest 100, newest first, with `matchedBy` | 200 |

**Allowlist**

| Method | Path | Body | Answers | Codes |
|---|---|---|---|---|
| GET | `/allowlist` | | `Allowlist`: partners' addresses first, then typed ones | 200 |
| POST | `/allowlist` | `{ address, label }` (label 1 to 80 characters) | `Allowlist` | 201; 400; 409 already listed |

Add-only: there is no route that removes an address.

**Experiments**

| Method | Path | Body | Answers | Codes |
|---|---|---|---|---|
| GET | `/settings/experiments` | | `Experiments`: `{ revertNextPayment, crashAfterSigning, blackholeRpc: { enabled, step } }` | 200 |
| PUT | `/settings/experiments` | any of those fields; only the ones sent change | `Experiments` | 200; 400 unknown or malformed field |
| POST | `/experiments/race` | none | `RaceResult`, from the `payments_experiment` sandbox | 200; 500 the sandbox could not be used |

**Reconciliation**

| Method | Path | Body | Answers | Codes |
|---|---|---|---|---|
| GET | `/reconciliation/runs` | | `ReconciliationRuns`: the latest 20 | 200 |
| GET | `/reconciliation/runs/:id` | | `ReconciliationRunView`: the run, every item, the identity | 200; 404 |
| POST | `/reconciliation/run` | none | `{ startedAs, temporalUrl }`: the workflow id and its page | 202; 503 Temporal |

202 because the run happens in the worker and takes seconds to minutes; the screen polls the list
until it appears.

**Demo scaffolding** (the partner's side, played by the same machine)

| Method | Path | Body | Answers | Codes |
|---|---|---|---|---|
| POST | `/demo/partner-payments` | `{ receivableId }` | `PartnerPaymentReceipt`: the hash, the block, what the wallet holds after | 200; 400; 404; 409 wallet busy or invoice changed; 422 not OPEN, wallet short, or the chain refused |

## `POST /payments`: codes and replays

| Code | When | Body |
|---|---|---|
| 201 | a new key: the payment is recorded and RESERVED | `PaymentView` |
| 200 | the same key with the same body: a replay, nothing written | the same payment, as it is now |
| 409 | the same key with a different body | the refusal; nothing written |
| 422 | a new key refused at the door (the six reasons in [states.md](states.md#why-a-payment-failed)) | `PaymentView`, FAILED with `reason`; the refusal is recorded |
| 400 | no key, a malformed `payableId` or one that names no invoice, a bad `executeAt` | the refusal; nothing written |

**The replay rule:** a replay answers the code of the first outcome, and a body with the current
state. A replay of a door refusal is 422 again. A replay of a payment that later reverted or was
cancelled is 200 with `status: FAILED` and its reason: a client that reads only codes never takes a
refusal for an acceptance, and one that reads the body sees where the payment is now.

"The same body" is `payableId` (case ignored) plus `executeAt` when sent; whitespace and key order
do not matter. Two calls with one key at the same instant make one payment: the loser waits on the
unique index and reads the winner.

## Known limitation: a replay after its scheduled time

`executeAt` is checked ("in the future") before the idempotency key is looked up. So a replay of a
scheduled payment sent **after** its time answers **400**, not the recorded outcome. The payment
itself is not affected: it was recorded the first time and runs at its time.

For a client: retry a scheduled payment only before its `executeAt`. After that, read it with
`GET /payments/:reference` instead of sending it again.

## The signer

The only holder of the company seed. It listens on port 3001 **on the compose network only**: no
port is published, because anything that can reach it can ask it to sign. The api and the worker
call it through `packages/chain/src/signer-client.ts`. It never returns key material and reads no
chain: the caller sends every number a transaction needs.

| Method | Path | Body | Answers | Codes |
|---|---|---|---|---|
| GET | `/health` | | `{ status: "ok", seed: "loaded" }` | 200 |
| GET | `/addresses/treasury` | | `{ index: 0, address }` | 200 |
| POST | `/addresses/deposit` | `{ index }`, 1 or more | `{ index, address }` | 200; 400 (index 0 is the treasury and is never handed out) |
| POST | `/sign/transfer` | `{ to, amountMinor, nonce, gas, maxFeePerGas, maxPriorityFeePerGas }` | `{ hash, signedTransaction }`: a USDC transfer from the treasury | 200; 400 |
| POST | `/sign/native-transfer` | `{ to, valueWei, nonce, gas, maxFeePerGas, maxPriorityFeePerGas }` | `{ hash, signedTransaction }`: the network's own currency, for gas | 200; 400 |

Amounts, gas and fees are whole numbers written as strings; `nonce` is a number. The USDC contract
is fixed in the signer, not sent by the caller.
