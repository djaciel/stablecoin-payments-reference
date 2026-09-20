# Reader's map

This repository is the runnable companion to the article *New to Blockchain? How to Build a
Stablecoin Payment System Inside Your Product*. The article explains the design; this file
tells you where each idea lives in the code, what to open, and how to watch it run. It is a
map, not a manual: each entry is a few lines and points at one or two files.

Start with `docker compose up`. Everything below assumes the stack is running.

## What does what

Five libraries carry the whole demo; nothing is hand-rolled underneath them.

- **viem** talks to the blockchain: it generates the seed phrase and derives addresses in
  the signer, creates the client to Base Sepolia, reads balances, decodes the USDC transfer
  events and, later, signs and broadcasts transactions.
- **Temporal** (server + TypeScript SDK) is the durable workflow engine: it runs the payment
  steps, retries them and resumes them after a crash, and runs the scheduled jobs.
- **PostgreSQL** with **node-postgres** holds the books; the ledger rules are plain SQL
  (triggers and constraints), with no ORM in between.
- **NestJS** is the shape of the two services with HTTP routes, the api and the signer.
- **React + Vite** is the browser app.

## The system in one picture (article §3)

`docker-compose.yml` is the picture. Seven services, one per box in the article: Postgres
(the books), Temporal and its web UI (the durable workflow engine), `api` (the door),
`worker` (runs the workflow), `signer` (the only key holder), `ui` (the screens). Read the
comments next to each service for what waits on what and why no port of the signer is
published.

## The signing service, the only component that touches the key (§3, §11)

- `apps/signer/src/keys/keys.service.ts` — generates the company seed on first start into
  `./.keys/company/` (never printed, never leaves this file) and derives accounts from it:
  index 0 is the treasury, index n is the deposit address for partner n.
- `packages/chain/src/derive.ts` — the derivation itself: seed + index → account, the path
  every wallet uses.
- `apps/api/src/signer/signer-client.service.ts` — how the rest of the system asks the
  signer for an address without ever seeing the seed.

See it: `curl localhost:3000/treasury` prints the treasury address; the same address is in
`docker compose logs signer`. `docker compose down -v && docker compose up` keeps it, because
the seed lives on your disk, not in a volume.

## The durable workflow engine (§3, and the crash in §9)

- `apps/worker/src/workflows.ts` — `PaymentWorkflow`: the recipe, four steps in order
  (`sign`, `execute`, `watch`, `settle`). Today the steps are placeholders that only sleep.
- `apps/worker/src/activities.ts` — the steps themselves, each reporting its attempt number.
- `docs/dev/restart-survival.md` — the drill: kill the worker mid-step, start it again, and
  read in the log which step ran twice and which did not.

See it: `pnpm demo:workflow`, then open `http://localhost:8080` and find the run.

## The books: two entries before the money moves (§5, §6, §7)

- `migrations/0002_ledger.sql` — the whole rulebook in one file: the three tables (accounts,
  transactions, entries), the chart of accounts (`treasury:available`, `treasury:reserved`,
  `partner:payable` and the rest), the kinds of transaction, and the guards the database
  enforces itself: a posted entry cannot be edited or deleted, every transaction sums to
  zero, `treasury:available` never goes negative, and reserved money goes back to available
  only through a reversal with proof or a cancel.
- `packages/ledger/src/engine.ts` — the engine that writes a transaction: locks the accounts in
  a fixed order, checks the sum is zero before writing, replays the entries against the
  running balance so a negative is caught with the amounts, and refuses to run outside a
  transaction.
- `packages/ledger/src/errors.ts` — the three things the engine can answer with:
  insufficient funds, not zero-sum, rejected by the database.
- `packages/ledger/src/movements.ts` — the article's movements, one function per row of its
  tables: `reserve` (available → reserved, §5) and `settle` (reserved out, partner debt
  cleared, §7). They add no SQL of their own; the engine does the writing.
- `packages/ledger/src/seed.ts` — the article's opening figures (Available 10,000, Partner
  debt 1,000) and the race's 1,500, posted as real balanced transactions.
- `tests/db/race.db.test.ts` — §9's race: two payments of 1,000 against 1,500 at the same
  instant, one reserved, one rejected, available ends at 500. Next to it, a canary that
  proves the test really runs two things at once.

### When it fails, where is the money? The two release doors (§6)

Reserved money goes back to available in exactly two ways, and the database refuses every
other one whatever it is called: `reversal`, with proof that the transaction reverted
onchain, and `cancel`, only before anything was signed. Both write their reason to the audit
log in the same database transaction as the entries.

- `packages/ledger/src/movements.ts` — `reversal` (proof required by the type) and `cancel`
  (a reason required), next to `reserve` and `settle`.
- `migrations/0003_audit_log.sql` + `packages/ledger/src/audit.ts` — the append-only log
  every step writes to. An audit log you can edit is not an audit log; the trigger says so.
- `packages/db/src/guarded-update.ts` — how a state changes: one `UPDATE … WHERE status =
  expected`, exactly one row or a typed refusal. Every payment transition later uses it.
- `tests/db/release.db.test.ts` — the rule tried from every side: with proof, without
  proof, disguised as a settle, and by cancel. `tests/db/README.md` — the index: five
  invariants → the file that defends each → where the database enforces it.

See it: `pnpm ledger:seed --release=reversal` and `--release=cancel` print the release and
its audit line; `pnpm ledger:seed --walkthrough` prints the article's three snapshots (§5 →
reserve → §7 settle) from a fresh ledger; `pnpm ledger:seed --race` prints the 1,500 opening.
`pnpm test:db` runs the tests against a real Postgres (`tests/db/README.md` explains the
harness and lists which test defends which rule). Or break a rule by hand:
`docker compose exec postgres psql -U payments -d payments -c "UPDATE ledger_accounts SET balance_minor = -1 WHERE code = 'treasury:available'"`
is refused by the database.

## The chain: a receipt is not a payment (§7)

- `packages/chain/src/clients.ts` — the one client that talks to Base Sepolia (the public
  RPC by default; `RPC_URL` only if you want your own) and the explorer links.
- `packages/chain/src/usdc.ts` — the official USDC contract and `findSettlementLog`, the
  article's rule in one function: the event must come from the official contract, to the
  exact destination, for the exact amount — or it is not a payment. Its four tests are
  built from a real transaction's log.
- `apps/api/src/treasury/treasury.controller.ts` — `GET /treasury`: one read for the
  Start screen, with the onchain balances pinned to one block next to the ledger figures.

See it: `curl localhost:3000/treasury`. `docs/dev/faucets.md` explains how to fund the
address it prints (you need testnet USDC and Base Sepolia ETH for gas).

## The watcher: the books follow the chain

The chain does not tell you when money arrives; something has to look. A Temporal
schedule ticks every ten seconds inside the worker and asks the USDC contract, in one
request, for transfers to the addresses the database says to watch — only in blocks that
are already final, so nothing it posts can be undone.

- `apps/worker/src/watcher.ts` — one tick, top to bottom: final block → range → the logs →
  one `funding` entry per transfer, exactly once (the transaction hash and log index are
  the reference, and the database refuses a second one) → cursor moved in the same
  database transaction.
- `apps/worker/src/schedules.ts` — creates the schedule when the worker starts.
- `packages/chain/src/finality.ts` — what "final" means here (the chain's `safe` tag).
- `migrations/0004_watcher.sql` — the two small tables: which addresses to watch, and
  how far the watcher has read.

See it: fund the treasury, wait a few ticks, and the Start screen's two halves agree, with
the transaction that closed the gap named underneath. `docker compose logs -f worker`
shows every tick. Open `http://localhost:8080` and the schedule is listed there.

## The screens

- `apps/ui/src/app/App.tsx` — the shell and the two routes: `/admin` is the company,
  `/partner` is the partner's side.
- `apps/ui/src/admin/StartScreen.tsx` — where the demo starts: the treasury address, the
  faucet links, and what the chain holds next to what the books say.
- `apps/ui/src/api/client.ts` — everything the browser knows how to ask the api.

Open `http://localhost:5173/admin`.

## Not here yet

The watcher that posts what arrives (so the books follow the chain), the payment API with
its idempotency key (§4), the real chain steps (§7), the four failures (§9), reconciliation
(§10) and the partner side (§8) arrive in later phases; each will add its entry here when it
lands.
