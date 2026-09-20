# Reader's map

This repository is the runnable companion to the article *New to Blockchain? How to Build a
Stablecoin Payment System Inside Your Product*. The article explains the design; this file
tells you where each idea lives in the code, what to open, and how to watch it run. It is a
map, not a manual: each entry is a few lines and points at one or two files.

Start with `docker compose up`. Everything below assumes the stack is running.

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
- `packages/ledger/src/post.ts` — the engine that writes a transaction: locks the accounts in
  a fixed order, checks the sum is zero before writing, replays the entries against the
  running balance so a negative is caught with the amounts, and refuses to run outside a
  transaction.
- `packages/ledger/src/errors.ts` — the three things the engine can answer with:
  insufficient funds, not zero-sum, rejected by the database.
- `packages/ledger/src/postings.ts` — the article's movements, one function per row of its
  tables: `reserve` (available → reserved, §5) and `settle` (reserved out, partner debt
  cleared, §7). They add no SQL of their own; the engine does the writing.
- `packages/ledger/src/seed.ts` — the article's opening figures (Available 10,000, Partner
  debt 1,000) and the race's 1,500, posted as real balanced transactions.
- `tests/db/race.db.test.ts` — §9's race: two payments of 1,000 against 1,500 at the same
  instant, one reserved, one rejected, available ends at 500. Next to it, a canary that
  proves the test really runs two things at once.

See it: `pnpm ledger:seed --walkthrough` prints the article's three snapshots (§5 → reserve
→ §7 settle) from a fresh ledger; `pnpm ledger:seed --race` prints the 1,500 opening.
`pnpm test:db` runs the tests against a real Postgres (`tests/db/README.md` explains the
harness and lists which test defends which rule). Or break a rule by hand:
`docker compose exec postgres psql -U payments -d payments -c "UPDATE ledger_accounts SET balance_minor = -1 WHERE code = 'treasury:available'"`
is refused by the database.

## The screens

- `apps/ui/src/app/App.tsx` — the shell and the two routes: `/admin` is the company,
  `/partner` is the partner's side.
- `apps/ui/src/api/client.ts` — everything the browser knows how to ask the api.

Open `http://localhost:5173/admin`.

## Not here yet

The payment API with its idempotency key (§4), the real chain steps (§7), the four failures
(§9), reconciliation (§10) and the partner side (§8) arrive in later phases; each will add
its entry here when it lands.
