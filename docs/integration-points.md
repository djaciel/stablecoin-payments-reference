# Integration points

What this demo mocks or leaves out, and where a real system would plug each piece in. A reference
only: how to run the demo is in the [README](../README.md), where the code lives is in
[GUIDE.md](../GUIDE.md), and why these pieces sit outside the design is in the article (§8, §11).

- [Where a real system plugs in](#where-a-real-system-plugs-in)
- [What a single-node demo leaves open](#what-a-single-node-demo-leaves-open)

## Where a real system plugs in

| Piece | In this demo | Where a real one plugs in |
|---|---|---|
| **Auth** | None. Every api route is open to whoever reaches port 3000, and `/admin` and `/partner` are two screens of one local app. All published ports are bound to `127.0.0.1`. | A Nest guard on the admin controllers: everything except `GET /partners/view` and `POST /demo/partner-payments`, which the `/partner` screen uses. Today `/partner` names its partner with `?partnerId=` in the query string; a real partner is identified by its session, and it pays from its own system, not through the company's api. The Temporal UI (8080) and Temporal (7233) have no auth either. |
| **Compliance** | A mock: `screenPayment` in `apps/api/src/payments/compliance.ts` refuses only the addresses in `COMPLIANCE_DENYLIST` (`apps/api/src/config.ts`), empty by default. | Replace the body of `screenPayment` with the provider's call. It runs at the payment door after the invoice, partner, allowlist and amount checks and before the reserve, so a "no" records FAILED `compliance_rejected` with nothing reserved. The door runs inside one database transaction holding the invoice's row lock, so a slow call there holds that lock. |
| **Custody** | `apps/signer` is the only holder of the company seed (`.keys/company/`, a file on disk, testnet only). It publishes no port; the api and the worker reach it on the compose network through `packages/chain/src/signer-client.ts`. It reads no chain and never returns a key. | Replace the signer behind the same calls: an address by index, and "sign this transfer with this nonce and these fees" answered with the signed bytes and their hash. Nothing else holds a key, so nothing else changes. The rest of the repo stores that hash before anything is sent (§7); a provider that only signs and sends in one step needs its own answer to that. |
| **Partner keys** | The partner seed lives in the api (`apps/api/src/demo-scaffolding/`), so one machine can play both sides. Labelled demo scaffolding on every screen that uses it. | Nowhere. A real company never holds its partners' keys; everything under `/demo` goes away. |
| **Fiat ramps** | None. The treasury is funded from testnet faucets ([`docs/dev/faucets.md`](dev/faucets.md)). | Stablecoin arriving at the treasury is posted as `funding` whoever sent it, so an on-ramp that delivers to the treasury address is booked with no change. An off-ramp is a payout like any other: the ramp's address on the allowlist, an invoice, a payment. |
| **The allowlist as a reviewed control** | The `allowlist` table and `POST /allowlist`: add-only, no auth, any admin can add. Partners' payout addresses are added when the partner is created. | A four-eyes rule (one person proposes, another approves) on `POST /allowlist`. The payment door reads only this table, so that is the single place the review has to live. |
| **Sweeping deposit addresses** | Not done. Money stays on each deposit address; `deposits:onchain` is their total, and reconciliation reads every watched address at the run's block. Nothing sends the deposit addresses the network's own currency. | A sweep is one transaction per address, and the address it leaves from first needs the network's own currency for the fee (§8). It would need a signer route that signs from a deposit address and a posting kind that moves `deposits:onchain` into `treasury:available`; neither exists. |
| **RPC redundancy** | One endpoint, `RPC_URL` (default `https://sepolia.base.org`), read in `packages/chain/src/clients.ts`. A public node's limits change: this one now refuses log ranges over 1,000 blocks (`MAX_RANGE_BLOCKS` in `apps/worker/src/watcher.ts`). | `createChainClient` is the one place every chain read is built; a second provider goes there (viem's `fallback` transport). |
| **Finality** | `safe` block tag by default (`packages/chain/src/finality.ts`). | `FINALITY_MODE` = `safe`, `finalized` or `depth` (with `FINALITY_DEPTH`), read in one place. |
| **A second chain** | One chain (`CHAIN` in `clients.ts`) and one stablecoin contract (`USDC_ADDRESS` in `packages/chain/src/usdc.ts`). Every ledger entry carries a currency, but the books are USDC-only. | Per chain: its own client, contract, watched addresses, treasury nonces and a `watcher_state` row (keyed by scan name, so a second scan is a row, not a migration). |
| **Tax and accounting** | Nothing. `expense:services` and `revenue:services` are the demo's own placeholders. | The company's chart of accounts, defined with its advisors. |

## What a single-node demo leaves open

- **Postgres down for more than about 15 s** sends every payment in flight to REVIEW: each step
  reads its row first and runs out of its 5 attempts. The money stays in Reserved; each one needs a
  resume.
- **Fund partner wallet can race a payment's nonce** in a window of seconds. The 422 when a signed
  payment holds the nonce narrows it; it does not close it. Worst case a payment sits in REVIEW
  from RESERVED and only a hand edit of its row frees it. Never a double payment.
- **A graceful worker restart** costs the running step one of its 5 attempts.
- **One of everything**: one api, one worker, one signer, one Temporal server, one Postgres, with
  no replicas.
- **The application connects to Postgres as its superuser** (`docker/postgres-init/01-roles.sql`
  says why). A real deployment gives it a plain role that owns only its schema.
- **`audit_log` has no retention or redaction policy** for what goes into `context`.
- **`PAY-XXXX` is four random digits**: 10,000 references in total. A real system uses a longer id.
- **A replay sent after its scheduled time answers 400**, not the recorded outcome
  ([api.md](api.md#known-limitation-a-replay-after-its-scheduled-time)).
