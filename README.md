# Stablecoin Payments Reference

The runnable companion to the 57Blocks article "New to Blockchain? How to Build a
Stablecoin Payment System Inside Your Product". It shows what sits around a stablecoin
payment: a double-entry ledger, an explicit state machine, a durable workflow that
survives a restart, and failure experiments anyone can reproduce, all against a public
testnet.

Under construction. This is what runs today.

## Requirements

- Node 22 LTS on the host. Not Node 24: a native module further down this road does not
  build there.
- Docker with Compose v2.

## Run it

```sh
pnpm install
docker compose up
```

That starts Postgres 16, Temporal (server and web UI), the API, the worker, the signer and
the web UI. Then open:

- `http://localhost:5173/admin` — the company's side of the demo.
- `http://localhost:5173/partner` — what a partner sees.

`/admin` opens on the Start screen: the treasury address to fund, where to get testnet
USDC and gas (`docs/dev/faucets.md`), what the treasury holds on chain, and what the
ledger says about it — the two disagree until something posts the funding to the books.
The screens that do the work — payables, transfers, reconciliation, the failure
experiments — are added to this shell.

The browser only ever talks to `localhost:5173`. Everything under `/api` is forwarded to
the API container by the dev server, which is why none of this needs a CORS setting, an
API URL or an environment variable.

The API applies the SQL migrations and then serves:

```sh
curl -s http://localhost:3000/health
# {"status":"ok","database":"up"}
```

`/health` means "this service can reach its database": it runs a real query, and answers
503 `{"status":"degraded","database":"unreachable"}` when Postgres is gone. The worker
polls the `payments` task queue, and the Temporal web UI is at
`http://localhost:8080`. No environment variable has to be set for any of this. If one of
the ports is already taken on your machine, copy `.env.example` to `.env` and change
`POSTGRES_PORT`, `TEMPORAL_PORT`, `TEMPORAL_UI_PORT` or `UI_PORT`.

## The signer and the company seed

One process holds the company's key material, and it is the only one: `apps/signer`. On
its first start it generates a BIP-39 seed phrase into `./.keys/company/company.seed` —
your machine, mode `0600`, gitignored, testnet only — and logs the treasury address it
derives from it. Every address the company uses comes from that one seed by index on the
standard Ethereum path `m/44'/60'/0'/0/n`: index 0 is the treasury, index *n* is the
deposit address of partner *n*. The mnemonic never leaves the service: it is not logged,
not returned by any endpoint, and not readable through the API. The signer publishes no
port either, so only the other containers can reach it. A real treasury key would live in
custody infrastructure rather than in a file next to the code; this is a demo on a public
testnet, and it says so on every start.

The address the demo is built around is one call away:

```sh
curl -s http://localhost:3000/treasury
# {"address":"0x…"}
```

The seed sits on your machine rather than in a Docker volume on purpose. You fund that
treasury address by hand from a faucet, so `docker compose down -v` has to be safe: delete
the stack, keep the money. Delete `.keys/` and you start over with a new, unfunded
treasury.

The workflow is the part worth watching. Press Pay on a small invoice on `/admin/payables`:
the api commits the payment with its money reserved, then starts the workflow (its id is the
payment's reference, PAY-1234 below), and it sends real testnet USDC from the treasury.

Then open `http://localhost:8080/namespaces/default/workflows/PAY-1234`: `sign` stores the
hash before anything is sent, `execute` sends those bytes, `watch` waits for finality and the
Transfer event, `settle` moves the books. [`GUIDE.md`](GUIDE.md) says what to look at.

## Checks

```sh
pnpm typecheck   # tsc over the whole workspace
pnpm lint        # eslint, type-aware
pnpm test        # the pure tests; they need no Docker
```

## Layout

- `apps/api` — the HTTP API (NestJS). Thin modules: business logic lives in `packages/`.
- `apps/worker` — the Temporal worker: the payment workflow and its steps.
- `apps/signer` — the only process that touches the company seed (NestJS, no published
  port). It derives addresses today and signs transactions later.
- `apps/ui` — the two screens, `/admin` and `/partner` (React + Vite). `src/api/` is
  everything it knows about the API; `src/app/` is the shell both screens render inside.
- `packages/chain` — EVM access: address derivation from a seed by index, the Base Sepolia
  client, and the stablecoin contract with the rule that decides whether a transfer
  happened.
- `packages/db` — the Postgres pool and the plain-SQL migration runner.
- `packages/domain` — a placeholder today; the types shared by the services (payment
  states, ledger accounts, money) arrive with the ledger.
- `migrations/` — the schema, one plain `.sql` file at a time.
- `scripts/` — the commands you run by hand, one file per `pnpm` script.
- `docker/` — what Postgres runs when its volume is created.

## License

MIT.
