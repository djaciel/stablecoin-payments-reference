# Integration points

What this demo mocks or leaves out, and where a real system plugs each piece in.

## Where a real system plugs in

| Piece | In this demo | Where a real one goes |
|---|---|---|
| **Auth** | None. Published ports are bound to `127.0.0.1`. Temporal (7233) and its UI (8080) have no auth either. | A Nest guard on the admin controllers, all except `GET /partners/view` and `POST /demo/partner-payments`. A real partner is known by its session, not `?partnerId=`. |
| **Compliance** | A mock: `screenPayment` in `apps/api/src/payments/compliance.ts` refuses only `COMPLIANCE_DENYLIST` (`apps/api/src/config.ts`), empty by default. | Replace the body of `screenPayment`. It runs at the door before the reserve, inside a transaction that holds the invoice's row lock, so a slow call holds that lock. |
| **Custody** | `apps/signer` holds the company seed (`.keys/company/`, a file, testnet only). | Replace the signer behind the same calls: an address by index, and signed bytes plus hash for a given nonce and fees. The repo stores the hash before sending, so a provider that signs and sends in one step needs its own answer to that. |
| **Partner keys** | The partner seed lives in the api (`apps/api/src/demo-scaffolding/`) so one machine plays both sides. | Nowhere. Everything under `/demo` goes away. |
| **Fiat ramps** | None. The treasury is funded from faucets ([faucets.md](dev/faucets.md)). | An on-ramp that delivers to the treasury is posted as `funding` with no change. An off-ramp is a payout: its address on the allowlist, an invoice, a payment. |
| **Allowlist review** | `POST /allowlist`: add-only, any admin can add. Partner addresses are added with the partner. | A four-eyes rule (one person proposes, another approves) on `POST /allowlist`, the only table the door reads. |
| **Sweeping deposit addresses** | Not done. Money stays on each deposit address; `deposits:onchain` is their total. | One transaction per address, which first needs the network's native coin for gas. Needs a signer route for deposit addresses and a posting kind from `deposits:onchain` to `treasury:available`. |
| **RPC redundancy** | One endpoint, `RPC_URL` (default `https://sepolia.base.org`). It refuses log ranges over 1,000 blocks (`MAX_RANGE_BLOCKS` in `apps/worker/src/watcher.ts`). | A second provider in `createChainClient` (`packages/chain/src/clients.ts`), for example viem's `fallback` transport. |
| **Finality** | `safe` block tag (`packages/chain/src/finality.ts`). | `FINALITY_MODE`: `safe`, `finalized` or `depth` (with `FINALITY_DEPTH`). |
| **A second chain** | One chain (`CHAIN` in `clients.ts`), one contract (`USDC_ADDRESS` in `packages/chain/src/usdc.ts`). The books are USDC only. | Per chain: its own client, contract, watched addresses, nonces and a `watcher_state` row. |
| **Tax and accounting** | `expense:services` and `revenue:services` are placeholders. | The company's own chart of accounts. |

## What a single-node demo leaves open

- **Postgres down for more than about 15 s** sends every payment in flight to REVIEW, money still in Reserved. Each needs a resume.
- **Fund partner wallet can race a payment's nonce** for a few seconds. At worst a payment sits in REVIEW from RESERVED until someone edits its row by hand. Never a double payment.
- **A graceful worker restart** costs the running step one of its 5 attempts.
- **One of everything**: one api, worker, signer, Temporal server and Postgres, no replicas.
- **The app connects to Postgres as superuser** (`docker/postgres-init/01-roles.sql`). A real deployment uses a plain role that owns only its schema.
- **`audit_log` has no retention or redaction policy** for `context`.
- **`PAY-XXXX` is four random digits**: 10,000 references in total.
- **A replay sent after its scheduled time answers 400** ([api.md](api.md#known-limitation-a-replay-after-its-scheduled-time)).
