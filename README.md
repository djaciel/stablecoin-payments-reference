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

That starts Postgres 16, Temporal (server and web UI), the API and the worker.

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
`POSTGRES_PORT`, `TEMPORAL_PORT` or `TEMPORAL_UI_PORT`.

The workflow is the part worth watching:

```sh
pnpm demo:workflow
```

It starts a `PaymentWorkflow` — four stubbed steps, about forty seconds — and prints its
timeline with the attempt number of each step. Kill the worker while it runs and the
workflow still finishes: the drill, with the log lines it produces, is in
[`docs/dev/restart-survival.md`](docs/dev/restart-survival.md).

## Checks

```sh
pnpm typecheck   # tsc over the whole workspace
pnpm lint        # eslint, type-aware
pnpm test        # the pure tests; they need no Docker
```

## Layout

- `apps/api` — the HTTP API (NestJS). Thin modules: business logic lives in `packages/`.
- `apps/worker` — the Temporal worker: the payment workflow and its steps.
- `packages/db` — the Postgres pool and the plain-SQL migration runner.
- `packages/domain` — a placeholder today; the types shared by the services (payment
  states, ledger accounts, money) arrive with the ledger.
- `migrations/` — the schema, one plain `.sql` file at a time.
- `scripts/` — the commands you run by hand, one file per `pnpm` script.
- `docker/` — what Postgres runs when its volume is created.

## License

MIT.
