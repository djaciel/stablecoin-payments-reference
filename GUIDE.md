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
  events, and signs and broadcasts transactions.
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
- `packages/chain/src/signer-client.ts` — how the api and the worker ask the signer for an
  address or a signature without ever seeing the seed.

See it: `curl localhost:3000/treasury` prints the treasury address; the same address is in
`docker compose logs signer`. `docker compose down -v && docker compose up` keeps it, because
the seed lives on your disk, not in a volume.

## Two seeds, and the partners between them (§8)

You know who paid by where the money came in, never by who sent it. That is why each partner
has a deposit address derived from the company seed: the address IS the attribution. The
other side of the pair, the payout address, belongs to the partner and comes from a second
seed this demo only holds because one machine has to play both sides.

- `apps/api/src/demo-scaffolding/partner-keys.service.ts` — the partner seed, generated into
  `./.keys/partner/` on first start. In the api and never in the signer, on purpose; the file
  says why, and so does the label on every address it produces.
- `apps/api/src/partners/partners.service.ts` — creating a partner: the next index, the
  deposit address from the signer, the payout address from the partner seed, and the row that
  tells the watcher to watch the deposit address — one transaction, or nothing.
- `migrations/0005_partners.sql` — the table, and the two addresses each partner carries.
- `apps/ui/src/admin/PartnersScreen.tsx` — both address families side by side, with balances.

See it: open `http://localhost:5173/admin/partners`, add a partner, and watch its deposit
address appear in `SELECT * FROM watched_addresses` and in the watcher's next tick without a
restart. Send test USDC to a deposit address: the balance on the screen goes up and the books
do not move, because crediting a deposit to a partner is the receivables flow, later.

## The durable workflow engine (§3, and the crash in §9)

- `apps/worker/src/workflows.ts` — `PaymentWorkflow`, the recipe: `sign`, `execute`, `watch`
  on a durable timer until the payment is paid, then `settle`. Each step gets the payment's
  reference and nothing else, and a worker that dies mid-run picks up from Temporal's history.
- `apps/worker/src/activities.ts` — the list of steps the worker runs, one file per step.
- `apps/worker/src/index.ts` — starts the worker. On shutdown an in-flight step is cancelled
  and simply runs again as attempt 2: every step re-reads the row and skips what is done.
- `docs/dev/restart-survival.md` — the drill, on a real payment: the worker stopped while the
  payment waits for finality, started again, and the history showing `sign` and `execute` ran
  once. Also what Docker restarts on its own and what it does not.

See it: follow the drill in `docs/dev/restart-survival.md`, or press Pay on a small invoice and
open `http://localhost:8080/namespaces/default/workflows/<its reference>`: `sign`, `execute`, the
`watch` checks with a 10 s timer between them, then `settle`. Start it again once it has settled
(the command is under "Signed, then sent" below) and the new run signs and sends nothing.

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

### The invoice that becomes a debt (§5, §7)

The company owes a partner from the moment an invoice exists, so the books move when it is
created, not when it is paid: one transaction writes the invoice and Dr `expense:services` /
Cr `partner:payable`, the article's Partner debt. Either both exist or neither does.

- `migrations/0006_payables.sql` — the invoices the company owes. The destination is copied
  from the partner at creation, because what was promised is the address it was promised to.
- `apps/api/src/payables/payables.service.ts` — creating an invoice in one transaction (the
  row, the debt, the audit line), and the one read the screen needs.
- `apps/api/src/payables/payables.controller.ts` — `GET /payables` and `POST /payables`, with
  the checks on what a person typed.
- `packages/ledger/src/movements.ts` — `payable`, the movement that puts the debt on the
  books, named by the invoice so it can only be posted once.
- `packages/ledger/src/money.ts` — `toMinorFromDecimal`: the one place a typed "0.50" becomes
  exact minor units, with no floating point. `money.test.ts` pins it.
- `apps/api/src/config.ts` — the numbers a reader might change: the invoice and payment
  limits, and the compliance mock's denylist.

See it: create an invoice on `/admin/payables` and watch Partner debt go up there and on the
Start screen, while Available and Reserved do not move.

## The payment API: one key, one payment (§4, §5, §9)

A payment is created, checked and has its money set aside in one database transaction,
before anything is signed. The idempotency key is what makes a double click, a retry or a
lost answer safe: the same key always gets the same payment back.

- `apps/api/src/payments/create-payment.ts` — the heart, in six steps read top to bottom:
  record the intent (CREATED), lock the invoice, run the checks, reserve the money, then
  RESERVED or FAILED with a reason. It never opens its own transaction; the caller owns it.
- `migrations/0007_payments.sql` — the payments table. Its unique index on the idempotency
  key IS the whole mechanism: a second request with the same key waits for the first one to
  commit, then gets its answer.
- `apps/api/src/payments/payments.controller.ts` — `POST /payments` (the `idempotency-key`
  header plus `{ payableId }`) and `GET /payments/:reference`, and which outcome gets which
  code: 201 created, 200 replay, 409 same key with a different body, 422 refused.
- `apps/api/src/payments/compliance.ts` — a mock, and marked as one: the place where a real
  compliance provider plugs in.
- `tests/db/payments.db.test.ts` — the three claims, against a real Postgres: the same request
  twice writes nothing new, the same key with a different body is refused, and two parallel
  calls with one key make one payment.
- `apps/ui/src/admin/PayablesScreen.tsx` — Pay and its confirmation. The browser makes one key
  per attempt and keeps it across clicks, so a double click cannot pay twice; after a
  refusal, the next attempt gets a new key.

See it: press Pay on `/admin/payables` and Reserved goes up in the api's answer, before
anything is signed; only then is the payment signed, sent and settled. Pay an invoice larger
than Available and read the refusal on its row. From the shell, send the same key twice and
read the same reference back (it pays the invoice with real testnet USDC, so pick a small one):

```
curl -s -X POST localhost:3000/payments -H 'idempotency-key: try-1' \
  -H 'content-type: application/json' -d '{"payableId":"<an OPEN invoice id from /payables>"}'
```

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

The chain does not tell you when money arrives; something has to look. One Temporal
workflow that never ends does it — tick, wait ten seconds, tick again — asking the USDC
contract, in one request, for transfers to the addresses the database says to watch, only
in blocks that are already final, so nothing it posts can be undone.

- `apps/worker/src/watcher.ts` — one tick, top to bottom: final block → range → the logs →
  one `funding` entry per transfer, exactly once (the transaction hash and log index are
  the reference, and the database refuses a second one) → cursor moved in the same
  database transaction.
- `apps/worker/src/workflows.ts` — `WatcherWorkflow`: the loop, and the failed tick it
  survives. `apps/worker/src/index.ts` starts it when the worker boots if it is not
  already running, which is also the only thing that brings it back if you terminate it.
- `packages/chain/src/finality.ts` — what "final" means here (the chain's `safe` tag).
- `migrations/0004_watcher.sql` — the two small tables: which addresses to watch, and
  how far the watcher has read.

See it: fund the treasury, wait a few ticks, and the Start screen's two halves agree.
`docker compose logs -f worker` shows every tick. Open `http://localhost:8080/namespaces/default/workflows/watcher` and
there is one entry, id `watcher`, running since the worker started.

## The one movement that is not a payment (§5)

"Fund partner wallet" moves USDC and gas from the treasury to the wallet the partners pay
from. It is demo plumbing, not a payment — and it is still posted to the books, under a label
that says what it is. Gas never reaches the books at all; it goes to the audit log.

- `apps/signer/src/sign/sign.controller.ts` — the signer learns to sign: an ERC-20 transfer
  and a plain ether one. It is told the nonce and the gas fields because it talks to no node,
  and it answers with the raw bytes plus the hash, which exists before anything is broadcast.
- `apps/api/src/treasury/fund-partner-wallet.service.ts` — the seven steps, in order: read the balances,
  refuse if short, fetch nonce and fees, sign both and broadcast both, check the USDC receipt
  against the official contract, post one entry, answer with both hashes.
- `packages/ledger/src/movements.ts` — `scaffolding`: Dr `demo:partner-funding` / Cr
  `treasury:available`, named by the transaction hash so the same one cannot post twice.

See it: `curl -s -X POST localhost:3000/treasury/fund-partner-wallet`, or the button on
`/admin`. Then `SELECT kind, reference FROM ledger_transactions ORDER BY created_at DESC
LIMIT 1` and the audit row next to it, which carries the gas the books refuse to hold. The
watcher posts nothing for it: it looks for money arriving, and this is money leaving.

## Signed, then sent: the hash before the broadcast (§7)

`sign` stores the hash, the signed bytes and the nonce on the payment row (still RESERVED)
before anything leaves; `execute` asks the network for that hash and sends the same bytes only
if it does not know them, so a retry or a crash (§9) can never pay twice.

- `apps/worker/src/sign.ts` — the `sign` step, numbered: read the payment, read the nonce and
  fees from the chain, lock the row and the treasury's nonce, ask the signer, store and commit.
- `apps/worker/src/execute.ts` — the `execute` step: the bytes from the row, the network asked
  by hash, the same bytes sent if it does not know them, then RESERVED → SENT.
- `migrations/0008_payment_signing.sql` — the three columns, and the table refusing a SENT
  payment without a hash, a hash without its bytes, and two payments on one nonce.
- `apps/worker/src/workflows.ts` — `PaymentWorkflow` calls `sign` then `execute`, with the
  reference and nothing else; the retries are explicit, and unbounded for now.
- `apps/worker/src/config.ts` — the gas headroom and the fee cap a payout is signed with; the
  signed bytes are never re-priced.
- `packages/chain/src/signer-client.ts` — how the worker asks the signer to sign. It holds no key.
- `docker-compose.yml` — the worker waits for the signer and knows its URL, and never holds the seed.
- `tests/db/signing.db.test.ts` — two claims against a real Postgres, with a signer that really
  signs: a payment is signed once however many ask at once, and two payments signed together
  get two nonces.
- `apps/api/src/payments/create-payment.ts` — `GET /payments/:reference` carries the hash and
  its explorer link once the payment is signed.
- `apps/api/src/payables/payables.service.ts` — the Payables read carries it too, for each
  invoice's payment.
- `packages/domain/src/api.ts` — `PaymentView.transaction`: the hash and its explorer link,
  present once signed.
- `apps/ui/src/admin/PayablesScreen.tsx` — the invoice row shows the hash with its explorer
  link, and where the payment stands: "Signed, not sent yet." or "Sent, waiting for the network."

See it (this sends real testnet USDC from the treasury): press Pay on a small invoice on
`/admin/payables`; its workflow runs on to SETTLED ("Paid" below). While it waits for finality,
its row shows SENT with the hash, and
`SELECT at, event, context->>'txHash' FROM audit_log WHERE subject_id = 'PAY-XXXX' ORDER BY id`
shows `signed` before `sent`, with the same hash. Start it again once it has settled:

```
docker compose exec temporal temporal workflow start --address temporal:7233 \
  --task-queue payments --type PaymentWorkflow --workflow-id PAY-XXXX --input '"PAY-XXXX"'
```

`sign` answers "already signed", `execute` "nothing to send: SETTLED", and nothing is sent. Until the
payment settles, the Start screen's onchain USDC is lower than Available + Reserved: the money
has left, and the books wait for finality and the Transfer event.

## Paid: finality and the event, then the books (§7)

A payment is paid only when its block is final AND its receipt carries the official contract's
Transfer event, exact amount and destination; the event alone is not enough. Then the books, the
payment and the invoice move in one transaction, which posts once however often it runs.

- `packages/chain/src/usdc.ts` — `paidVerdict`, the whole rule in one place, next to
  `findSettlementLog`: not landed, not final, reverted, or paid.
- `packages/chain/src/usdc.test.ts` — both conditions pinned with a real log: the right event
  above the final block is not paid yet; at the final block it is.
- `apps/worker/src/watch.ts` — `watch`, one check and no writes: the receipt, the final block
  (`safe`, never `latest`), the verdict. Reverted or wrong: it retries, the money stays reserved.
- `apps/worker/src/settle.ts` — the `settle` step: lock the invoice, then Dr Partner debt / Cr
  Reserved, SENT → SETTLED, the invoice PAID, and the evidence in the audit log, all or nothing.
- `apps/worker/src/workflows.ts` — the loop: `watch`, a durable 10 s timer, `watch` again, until
  paid; then `settle`.
- `tests/db/settlement.db.test.ts` — §7's figures on a real payment row, settled twice: Available
  9,000, Reserved 0, Partner debt 0, one `settle` in the ledger. Indexed in `tests/db/README.md`.
- `docs/dev/restart-survival.md` — the same wait, with the worker stopped in the middle of it.
- `apps/ui/src/admin/PayablesScreen.tsx` — a settled payment's row says it is paid, with its hash.

See it (this sends real testnet USDC): press Pay on a small invoice on `/admin/payables`, then

```
docker compose logs -f worker   # watch: not final … → watch: paid → settle: settled
```

The Start screen and `curl localhost:3000/treasury` then agree again: onchain USDC equals
Available plus Reserved, Reserved and Partner debt are down by the payment, and Available did not
move. The invoice on `/admin/payables` is PAID.

## From the click to the chain: dispatch after COMMIT (§3, §4)

Pay commits the payment with its money reserved, and only then starts its workflow: a refusal is
always in the api's answer, and no workflow exists for a payment that rolled back. A start that
fails is picked up within ten seconds by a second loop, and the workflow id is the reference, so
starting twice is harmless.

- `apps/api/src/payments/payments.controller.ts` — `POST /payments`: the transaction commits,
  then a RESERVED payment is dispatched, on a 201 and on a replay. The answer does not change.
- `apps/api/src/payments/dispatch.ts` — `dispatchPayment`: the start, with a 3 s deadline; a
  failure is one warning naming the reference, and the payment stays committed.
- `apps/api/src/temporal/temporal.module.ts` — the api's Temporal client, connected lazily so the
  api takes payments while Temporal is down; closed on shutdown.
- `packages/domain/src/temporal.ts` — what the api and the worker share: where Temporal is, the
  workflow's name, and how it is started (id = reference; a running one is attached to).
- `apps/worker/src/dispatcher.ts` — the dispatcher's tick, with its rule and query at the top:
  every RESERVED or SENT payment has a running workflow. REVIEW is left for a human.
- `apps/worker/src/workflows.ts` — `DispatcherWorkflow`: the watcher's loop with another tick
  (tick, a durable 10 s timer, a fresh run after an hour).
- `apps/worker/src/index.ts` — starts both loops at boot, or attaches to them if they are running.
- `docker-compose.yml` — the api knows Temporal's address and waits for it at startup.
- `apps/ui/src/admin/PayablesScreen.tsx` — the Pay dialog says what happens now: reserved first,
  then signed and sent, and the row follows it.
- `docs/dev/restart-survival.md` — the drill now starts by pressing Pay.

See it (this sends real testnet USDC): press Pay on a small invoice on `/admin/payables` and its
row goes RESERVED → SENT with the hash → SETTLED; finality takes minutes. In
`http://localhost:8080/namespaces/default/workflows` there are two workflows that never end,
`watcher` and `dispatcher`, and one `PaymentWorkflow` per payment, named by its reference. For the
dispatcher: `docker compose stop temporal`, press Pay (still 201 RESERVED, and `docker compose logs
api` has the warning), `docker compose start temporal`, and `docker compose logs worker` says
`dispatcher: started PAY-XXXX (RESERVED, had no running workflow)`.

## The screens

- `apps/ui/src/app/App.tsx` — the shell and the two routes: `/admin` is the company,
  `/partner` is the partner's side.
- `apps/ui/src/admin/StartScreen.tsx` — where the demo starts: the treasury address, the
  faucet links, what the chain holds next to what the books say, and the partner wallet with
  the button that funds it.
- `apps/ui/src/admin/PartnersScreen.tsx` — the partners, each with its two addresses.
- `apps/ui/src/admin/PayablesScreen.tsx` — the invoices the company owes, the books they move,
  and Pay, with each invoice's payment on its row.
- `apps/ui/src/api/client.ts` — how the browser asks the api: one function per endpoint.
  The shapes of the answers are in `packages/domain/src/api.ts`, which the api writes with
  and the browser reads.

Open `http://localhost:5173/admin`.

## Not here yet

The payment's story step by step on screen, what happens
when a transfer fails (§6), the four failures as buttons (§9), reconciliation (§10) and the
partner side that pays a receivable (§8) arrive in later phases; each will add its entry here
when it lands.
