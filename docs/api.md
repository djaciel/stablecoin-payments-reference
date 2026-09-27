# API

Every endpoint of the api (`http://localhost:3000`) and of the signer. Response types are in `packages/domain/src/`.

## Conventions

- **No auth** ([integration-points.md](integration-points.md)).
- Amounts are strings in whole USDC (`"0.50"`), up to 6 decimals. A JSON number is refused.
- A refusal is `{ statusCode, message, error }`, with one sentence in `message`. Bad JSON is 400.
- If the RPC fails, a GET still answers 200: chain figures are `null`, with a `chainError` sentence.
- 503: the signer (or Temporal) did not answer; nothing was written.

## Endpoints, by module

| Method | Path | Body | Answers | Codes |
|---|---|---|---|---|
| GET | `/health` | | `Health` | 200; 503 database unreachable |
| GET | `/treasury` | | `Treasury` | 200; 503 signer |
| POST | `/treasury/fund-partner-wallet` | | `PartnerWalletFunding` | 200; 422 treasury short, nonce held by a signed payment, or chain refused; 503 signer |
| GET | `/partners` | | `Partners` | 200 |
| POST | `/partners` | `{ name }` (1 to 80 chars) | `Partners` | 201; 400; 503 signer |
| GET | `/partners/view?partnerId=` | | `PartnerView` (no `partnerId`: the first partner) | 200; 400 |
| GET | `/payables` | | `Payables` | 200 |
| POST | `/payables` | `{ partnerId }` or `{ destination }`, plus `{ amount, description }` | `Payables` | 201; 400; 422 partner inactive |
| POST | `/payments` | header `idempotency-key` (1 to 200 chars); `{ payableId, executeAt? }` | `PaymentView` | [below](#post-payments-codes-and-replays) |
| GET | `/payments` | | `Payments` (latest 100) | 200 |
| GET | `/payments/:reference` | | `PaymentView` | 200; 404 |
| GET | `/payments/:reference/timeline` | | `PaymentTimeline` | 200; 404 |
| POST | `/payments/:reference/cancel` | | `PaymentView` | 200; 404; 409 `cannot_cancel_after_signing`; 409 not RESERVED |
| POST | `/payments/:reference/resume` | | `PaymentView` | 200; 404; 409 not in REVIEW |
| GET | `/receivables` | | `Receivables` | 200 |
| POST | `/receivables` | `{ partnerId, amount, description }` | `Receivables` | 201; 400; 422 partner inactive |
| GET | `/deposits` | | `Deposits` (latest 100) | 200 |
| GET | `/allowlist` | | `Allowlist` | 200 |
| POST | `/allowlist` | `{ address, label }` (label 1 to 80 chars) | `Allowlist` | 201; 400; 409 already listed |
| GET | `/settings/experiments` | | `Experiments` | 200 |
| PUT | `/settings/experiments` | any of the `Experiments` fields | `Experiments` | 200; 400 |
| POST | `/experiments/race` | | `RaceResult` | 200; 500 sandbox unusable |
| GET | `/reconciliation/runs` | | `ReconciliationRuns` (latest 20) | 200 |
| GET | `/reconciliation/runs/:id` | | `ReconciliationRunView` | 200; 404 |
| POST | `/reconciliation/run` | | `{ startedAs, temporalUrl }` | 202; 503 Temporal |
| POST | `/demo/partner-payments` | `{ receivableId }` | `PartnerPaymentReceipt` | 200; 400; 404; 409 wallet busy or invoice changed; 422 not OPEN, wallet short, or chain refused |

- Invoice `amount`: 0.01 to 1,000 USDC; `description`: 1 to 200 chars. A `destination` invoice is a payment to an address.
- `executeAt`: ISO time, up to 24 hours ahead.
- Cancel and resume write nothing when they answer 409.
- The allowlist is add-only.
- `Experiments` is `{ revertNextPayment: { enabled, payableId? }, crashAfterSigning: { enabled, payableId? }, blackholeRpc: { enabled, step, payableId? } }`, `step` being `execute` or `watch`. A PUT changes only what it sends.
- `/demo/*` is the partner's side, played by the same machine.

## `POST /payments`: codes and replays

| Code | When | Body |
|---|---|---|
| 201 | new key, RESERVED | `PaymentView` |
| 200 | same key, same body (a replay) | the payment as it is now |
| 409 | same key, different body | the refusal |
| 422 | new key refused at the door ([reasons](states.md#why-a-payment-failed)) | `PaymentView`, FAILED with `reason` (recorded) |
| 400 | no key, bad or unknown `payableId`, bad `executeAt` | the refusal |

- A replay answers the first outcome's code, with the current state. So a payment that later reverted replays as 200 with `status: FAILED`.
- "Same body": `payableId` (any case) plus `executeAt` if sent.
- Two calls with one key at the same moment make one payment.

## Known limitation: a replay after its scheduled time

`executeAt` is checked before the key, so a replay sent after its time answers **400**. The payment still runs. After `executeAt`, read it with `GET /payments/:reference` instead.

## The signer

The only holder of the company seed. Port 3001, compose network only. Called through `packages/chain/src/signer-client.ts`. It never returns a key and reads no chain.

| Method | Path | Body | Answers | Codes |
|---|---|---|---|---|
| GET | `/health` | | `{ status: "ok", seed: "loaded" }` | 200 |
| GET | `/addresses/treasury` | | `{ index: 0, address }` | 200 |
| POST | `/addresses/deposit` | `{ index }`, 1 or more | `{ index, address }` | 200; 400 |
| POST | `/sign/transfer` | `{ to, amountMinor, nonce, gas, maxFeePerGas, maxPriorityFeePerGas }` | `{ hash, signedTransaction }` (USDC) | 200; 400 |
| POST | `/sign/native-transfer` | `{ to, valueWei, nonce, gas, maxFeePerGas, maxPriorityFeePerGas }` | `{ hash, signedTransaction }` (native coin) | 200; 400 |

Amounts, gas and fees are integer strings; `nonce` is a number.
