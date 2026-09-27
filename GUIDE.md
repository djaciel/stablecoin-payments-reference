# Reader's map

This file tells you where each idea lives in the code and how to see it run, topic by topic. Tables, states and endpoints are in [`docs/`](docs/).

Everything below assumes `docker compose up` is running. Commands that start with `pnpm` run on your machine and need Node 22 (not 24) and `pnpm install`.

## The five libraries

Nothing is hand-rolled under these:

- **viem** talks to the chain: seeds and addresses, balances, transfer events, signing and sending.
- **Temporal** runs the payment's steps, retries them, and picks up after a crash.
- **PostgreSQL** with **node-postgres** holds the books; the ledger rules are plain SQL, no ORM.
- **NestJS** shapes the two HTTP services, the api and the signer.
- **React + Vite** is the browser app.

## The system at a glance

Seven services, each with one job.

- `docker-compose.yml`: the seven services, what waits on what, and why the signer publishes no port.
- `apps/worker/src/workflows.ts`: every workflow: the payment's steps, and the watcher, dispatcher and reconciler loops.
- `apps/worker/src/activities.ts`: the steps the worker can run, one file per step.
- `apps/worker/src/index.ts`: starts the worker and the three loops, or attaches to them if they are running.
- `packages/domain/src/temporal.ts`: what the api and the worker share about Temporal; a payment's workflow id is its reference.
- `migrations/0003_audit_log.sql`: the audit log, which nobody can edit or delete.
- `packages/ledger/src/audit.ts`: everything the audit log can say, in one place.
- `apps/api/src/payments/read-payments.ts`: the payment reads, including its story from the audit log.
- `apps/ui/src/admin/TransfersScreen.tsx`: every payment, and each payment's story step by step.

See it: open `http://localhost:8080`: `watcher`, `dispatcher` and `reconciler` are always running, plus one `PaymentWorkflow` per payment.

## Funding the treasury

Money on chain is not money in the books until something records it.

- `apps/ui/src/admin/StartScreen.tsx`: the treasury address, the faucet links, and the chain next to the books.
- `apps/api/src/treasury/treasury.controller.ts`: `GET /treasury`, the one read behind the Start screen.
- `apps/worker/src/watcher.ts`: every ten seconds, reads final blocks and records each transfer to the treasury once.
- `packages/chain/src/finality.ts`: what "final" means here (the chain's `safe` block).
- `migrations/0004_watcher.sql`: which addresses to watch, and how far the watcher has read.
- `apps/ui/src/partner/PartnerWalletCard.tsx`: the shared partner wallet and its **Fund partner wallet** button.
- `apps/api/src/treasury/fund-partner-wallet.service.ts`: sends 2 USDC and 0.005 ETH to that wallet, recorded as `demo:partner-funding` because it is not a payment.

See it: fund the treasury and watch the **Books** card catch up with the **Treasury** card; `docker compose logs -f worker` shows every tick.

## Paying a partner

One idempotency key, one payment: a retry or a double click gets the same payment back.

- `apps/api/src/payables/payables.service.ts`: writes an invoice the company owes, with its debt, in one transaction.
- `apps/api/src/payments/create-payment.ts`: the heart: record the intent, run the checks, reserve the money, then RESERVED or FAILED.
- `migrations/0007_payments.sql`: the payments table; its unique index on the idempotency key is the whole mechanism.
- `apps/api/src/payments/payments.controller.ts`: `POST /payments` and which outcome gets which status code.
- `apps/api/src/payments/compliance.ts`: a mock, marked as one, where a real screening provider plugs in.
- `apps/api/src/config.ts`: the limits a reader might change: invoice and payment amounts, the compliance denylist.
- `migrations/0013_allowlist.sql`: the addresses the company may pay.
- `apps/api/src/allowlist/allowlist.controller.ts`: read and add to the allowlist.
- `apps/api/src/body.ts`: the checks on what a person typed: ids, amounts, addresses, times.
- `apps/api/src/payments/dispatch.ts`: starts the payment's workflow, only after the database has committed.
- `apps/worker/src/dispatcher.ts`: every ten seconds, starts any payment whose start failed or whose time has come.
- `apps/ui/src/admin/PayablesScreen.tsx`: Pay and its dialog; the browser keeps one key per attempt.
- `apps/ui/src/admin/PayToAddressScreen.tsx`: pay an address somebody typed; a refusal, **Add to allowlist**, **Pay again**.
- `tests/db/payments.db.test.ts`: the same request twice writes nothing new; two parallel calls with one key make one payment.

See it: on **Pay to an address**, paste the partner wallet's address from `/partner` and press **Create and pay**: refused (`destination_not_allowlisted`), then **Add to allowlist** and **Pay again**.

## The ledger

Reserving moves money from Available to Reserved; the total does not change.

- `migrations/0002_ledger.sql`: the whole rulebook: the accounts, and the guards the database enforces itself.
- `packages/ledger/src/engine.ts`: writes one transaction: locks the accounts, checks it sums to zero, refuses a negative Available.
- `packages/ledger/src/movements.ts`: every movement the books know, one function each (`reserve`, `settle`, `reversal`, `cancel` and the rest).
- `packages/ledger/src/errors.ts`: the three answers the engine can refuse with.
- `packages/ledger/src/money.ts`: turns a typed "0.50" into exact minor units, with no floating point.
- `packages/ledger/src/seed.ts`: the example figures (10,000, 1,000 and the race's 1,500) as real entries.
- `migrations/0006_payables.sql`: the invoices the company owes; the debt is on the books from the moment one exists.
- `migrations/0014_scheduled_payments.sql`: a payment can wait for its time, with its money already reserved.
- `tests/db/guards.db.test.ts`: the database's guards, each broken on purpose.
- `tests/db/race.db.test.ts`: two payments of 1,000 against 1,500: one reserved, one refused, Available ends at 500.
- `tests/db/walkthrough.db.test.ts`: the example figures, checked step by step.
- `packages/domain/src/vocabulary.test.ts`: keeps the same words and figures everywhere in the code: states, `PAY-` references, account names, figures.

See it: on **Pay to an address**, pick **At a time** and press **Create and pay**: Reserved goes up at once, and nothing is signed until its time.

## Signing and sending

The hash is stored before anything is sent, so a retry sends the same bytes and never pays twice.

- `apps/worker/src/sign.ts`: reads the nonce and fees, asks the signer, stores the hash and the signed bytes.
- `apps/worker/src/execute.ts`: asks the network for that hash, and sends the same bytes only if it does not know them.
- `migrations/0008_payment_signing.sql`: the hash, the bytes and the nonce on the payment row, and the rules that guard them.
- `packages/chain/src/send.ts`: send signed bytes and wait for the receipt, for every sender in the repo.
- `apps/worker/src/watch.ts`: one check, no writes: not landed, not final, reverted, or paid.
- `packages/chain/src/usdc.ts`: the paid rule: the event must come from the official contract, with the exact amount and destination.
- `packages/chain/src/usdc.test.ts`: that rule checked against real receipts.
- `apps/worker/src/settle.ts`: Reserved out, Partner debt cleared, payment SETTLED and invoice PAID, all or nothing.
- `apps/worker/src/config.ts`: the gas headroom and fee cap a payout is signed with.
- `tests/db/signing.db.test.ts`: a payment is signed once however many ask; two payments get two nonces.
- `tests/db/settlement.db.test.ts`: the example figures after settling, even when it runs twice.

See it: pay a small invoice on **Invoices to pay** and run `docker compose logs -f worker`: sign, execute, a few `watch` checks, then settle.

## When a payment fails

Reserved money goes back only with proof that the transfer can no longer land.

- `apps/worker/src/reverse.ts`: a transfer that reverted in a final block: FAILED, money back to Available, invoice open again.
- `apps/api/src/payments/cancel-payment.ts`: cancel a payment nobody has signed; a payment with a hash is refused.
- `migrations/0015_cancel_needs_no_hash.sql`: the same cancel rule, in the database.
- `apps/worker/src/escalate.ts`: no proof either way: REVIEW, with the money still reserved.
- `migrations/0010_payment_review.sql`: a payment in REVIEW remembers where it came from.
- `apps/api/src/payments/resume-payment.ts`: an operator sends a payment back from REVIEW; the money stays reserved.
- `packages/db/src/guarded-update.ts`: every state change is one `UPDATE … WHERE status = expected`, or a clear refusal.
- `tests/db/release.db.test.ts`: the release rule tried from every side.
- `tests/db/failure.db.test.ts`: the FAILED and REVIEW figures on a real payment row.
- `tests/db/cancel.db.test.ts`: cancel before signing, after signing, and at the same instant as signing.
- `tests/db/guarded-transition.db.test.ts`: a state change that matched no row is caught, not ignored.

See it: on **Break it**, press **Run it** on **Revert a payment**, then open the payment's story on **Transfers**: Failed, then Released.

## Deposits

Each partner pays at its own address, so the address says whose money it is.

- `apps/api/src/partners/partners.service.ts`: creating a partner: its deposit address from the signer, its payout address, and the watcher told to watch.
- `migrations/0005_partners.sql`: the partners and the two addresses each one has.
- `apps/api/src/demo-scaffolding/partner-keys.service.ts`: the partner seed; the api holds it only because one machine plays both sides.
- `migrations/0011_receivables.sql`: the invoices partners owe the company.
- `apps/api/src/receivables/receivables.service.ts`: writes one, with what the partner owes on the books.
- `apps/api/src/demo-scaffolding/partner-payments.service.ts`: the partner's side of a payment: sign, store the hash, send.
- `apps/worker/src/watcher.ts`: also sees transfers to the deposit addresses, first as DETECTED.
- `apps/worker/src/deposits.ts`: records a deposit, credits it once its block is final, and matches it to an invoice.
- `migrations/0012_deposits.sql`: one row per arriving transfer, so the same money is never credited twice.
- `apps/api/src/deposits/deposits.controller.ts`: `GET /deposits`, newest first.
- `apps/ui/src/partner/PartnerHome.tsx`: what a partner sees: what it owes, where it pays, and Pay.
- `apps/ui/src/admin/PartnersScreen.tsx`: each partner's two addresses, with balances.
- `apps/ui/src/admin/ReceivablesScreen.tsx`: the invoices partners owe, with no Pay button (they pay from the other side).
- `tests/db/deposits.db.test.ts`: credited only when final, the address decides whose money it is, and nothing posts twice.

See it: pay an invoice on `/partner`, then watch **Money that arrived, newest first** on **Transfers**: DETECTED, then SETTLED.

## Failures you can cause

Each failure is a card you can run, and a command that does the same from a terminal.

- `apps/ui/src/admin/BreakItScreen.tsx`: the five cards and their **Run it**.
- `packages/domain/src/experiments.ts`: every failure switch in one place.
- `migrations/0009_settings.sql`: where the switches are stored; an absent row is off.
- `apps/api/src/experiments/experiments.controller.ts`: reads and sets the switches; the api never acts on one.
- `apps/worker/src/experiments.ts`: where the worker takes a switch, so exactly one payment breaks.
- `apps/api/src/experiments/race.ts`: the race, run in a separate database with the example figures.
- `apps/ui/src/api/client.ts`: `doubleClick`, the one place the browser makes two calls at once.
- `scripts/experiments/harness.ts`: what the four `pnpm experiment:*` commands share.
- `scripts/experiments/double-click.ts`, `race.ts`, `crash.ts`, `stuck.ts`: one command per failure.
- `tests/db/experiments.db.test.ts`: a switch breaks only the payment of its own invoice, so all cards can run at once.
- `docs/dev/restart-survival.md`: stop the worker by hand while a payment waits, and watch it finish.

See it: press **Run it** on **The race** (seconds, no money), or run `pnpm experiment:race`.

## Reconciliation

A separate process checks the books against the chain at one fixed block, and reports without fixing.

- `migrations/0016_reconciliation.sql`: the runs, and one item per payment or deposit checked.
- `apps/worker/src/reconcile.ts`: one run, top to bottom: one snapshot, one fixed block, the chain reads, the result.
- `apps/worker/src/reconcile-items.ts`: the rules for each item, and the total check (books, chain, in flight).
- `apps/api/src/reconciliation/reconciliation.controller.ts`: the runs, and **Run now**.
- `apps/api/src/reconciliation/read-reconciliation.ts`: reads what the worker wrote; the api computes nothing.
- `apps/ui/src/admin/ReconciliationScreen.tsx`: the Books, Chain and In flight cards, **Show all**, and the runs before.
- `tests/db/reconciliation.db.test.ts`: a clean run, a payment the chain never carried, and a difference nothing explains.

See it: press **Run now** on **Reconciliation**; the new run reads **Books and chain agree**, at the block it pinned.

## Keys and custody

Only the signer touches the key, so custody can change without rewriting the rest.

- `apps/signer/src/keys/keys.service.ts`: creates the company seed on first start and derives every company address from it.
- `packages/chain/src/derive.ts`: seed plus index gives an account (index 0 is the treasury).
- `apps/signer/src/sign/sign.controller.ts`: signs a transfer and returns the bytes and the hash; it talks to no node.
- `packages/chain/src/signer-client.ts`: how the api and the worker ask the signer, without ever seeing the seed.
- `apps/api/src/payments/compliance.ts`: the mock where real screening plugs in.
- `docs/integration-points.md`: where real auth, compliance, custody and bank money plug in.

See it: `docker compose ps` shows no published port for the signer; only the other containers can reach it.

## Running it and testing it

The README takes you from zero to a first payout; the tests guard the rules.

- `README.md`: start, fund, first payout, first deposit.
- `tests/db/README.md`: how the database tests run, and which test guards which rule.
- `vitest.db.config.mts`: the database test setup, apart from the pure tests.

See it: `pnpm test` (no Docker needed), then `pnpm test:db` (against the stack's Postgres, in its own database).

## The screens

- `apps/ui/src/app/App.tsx`: the routes and the tabs: Start, Partners, Invoices to pay, Pay to an address, Invoices to collect, Transfers, Reconciliation, Break it.
- `apps/ui/src/admin/`: one file per admin tab.
- `apps/ui/src/partner/`: the partner's side, `/partner`.
- `apps/ui/src/api/client.ts`: one function per api call.
- `apps/ui/src/api/usePolling.ts`: every screen refreshes every five seconds, from here.
- `apps/ui/src/app/usdc.ts`: how an amount is cut for the screen (cut, not rounded).
- `apps/ui/src/config.ts`: how many decimals the screens show (4).
