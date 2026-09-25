# Schema

The database as the 16 files in `migrations/` build it, and how to read it with `psql`. A
reference only: how to run the demo is in the [README](../README.md), where the code lives is in
[GUIDE.md](../GUIDE.md), and why the books work this way is in the article.

- [Tables](#tables)
- [Chart of accounts](#chart-of-accounts)
- [Posting kinds](#posting-kinds)
- [Guards the database enforces](#guards-the-database-enforces)
- [Reading the books with psql](#reading-the-books-with-psql)

Every amount is a `bigint` in minor units (USDC has 6 decimals: 1,000 USDC is `1000000000`). Every
address is stored checksummed.

## Tables

| Group | Table | What it holds | Key | The column people ask about |
|---|---|---|---|---|
| The books | `ledger_accounts` | the nine accounts below | `code` | `balance_minor`: kept by a trigger on every entry, on the account's normal side |
| | `ledger_transactions` | one row per posting | `id`, unique `(kind, reference)` | `kind`, `reference`, `proof` (a reversal's `{ txHash, blockNumber, reason }`) |
| | `ledger_entries` | the debit and credit lines of a posting | `id` | `direction` (`debit` / `credit`) with an `amount_minor` that is always positive |
| The payment path | `payments` | one row per idempotency key: the intent, then what the chain steps write | `id`, unique `reference` (`PAY-XXXX`), `idempotency_key`, `tx_hash`, `nonce` | `status` ([states.md](states.md)), `failure_reason`, `tx_hash` + `signed_tx` + `nonce`, `execute_at` (null = now), `review_from_status` |
| | `payables` | invoices the company owes | `id` | `status` OPEN / PAYING / PAID; `partner_id` is null for a payment to an address |
| | `allowlist` | addresses the company may send money to | `address` | `partner_id`: null for an address somebody typed |
| The partner side | `partners` | who the demo pays and gets paid by | `id`, unique `derivation_index` | `derivation_index` (1 or more): both of its addresses are derived at it |
| | `receivables` | invoices a partner owes the company | `id` | `payment_tx_hash`: written by the partner's side before its transfer is sent |
| | `deposits` | stablecoin arriving at a deposit address | `id`, unique `(tx_hash, log_index)` | `status` DETECTED / SETTLED, `matched_by` |
| The chain's edge | `watched_addresses` | the treasury and every deposit address | `address` | `role`: `treasury` or `deposit` |
| | `watcher_state` | how far the watcher has scanned | `name` (`usdc-transfers`) | `last_block`: moves in the same transaction as what that tick posted |
| Evidence | `audit_log` | what happened, to what, by whom | `id` | `subject_type` + `subject_id` (`payment` + `PAY-4821`), `event` (past tense), `context` (jsonb) |
| | `reconciliation_runs` | one row per run, written once at the end | `id` | `block_number` (the block the chain side was read at), `outcome` |
| | `reconciliation_items` | one row per thing a run checked | `id`, `run_id` | `delta_minor`: books minus chain at the run's block |
| Switches | `settings` | the Break it flags | `key` | `value` (jsonb); no row means off ([experiments.md](experiments.md)) |

`schema_migrations` belongs to the migration runner (`packages/db/src/migrate.ts`): one row per
file applied. `audit_log` uses the subject `invoice` for a payable and `receivable` for a
receivable.

## Chart of accounts

Inserted by `0002_ledger.sql`. A balance is held on the account's normal side, so Partner debt reads
positive while the company owes.

| Account | Name on screen | Type | Normal side | Can go negative |
|---|---|---|---|---|
| `treasury:available` | **Available** | asset | debit | no |
| `treasury:reserved` | **Reserved** | asset | debit | no |
| `partner:payable` | **Partner debt** | liability | credit | yes |
| `partner:receivable` | Partner receivables | asset | debit | yes: a deposit nobody invoiced takes it below zero |
| `deposits:onchain` | Deposits | asset | debit | no |
| `equity:opening` | internal | equity | credit | yes |
| `expense:services` | internal, no screen reads it | expense | debit | yes |
| `revenue:services` | internal, no screen reads it | revenue | credit | yes |
| `demo:partner-funding` | internal, labelled demo scaffolding | expense | debit | yes |

Available, Reserved and Partner debt are the article's three. Partner debt is one total for every
partner: what each one is owed comes from its invoices (the Partners screen), not from an account
of its own. Reconciliation compares Available + Reserved + Deposits with the chain; the other six
have no counterpart on the chain.

## Posting kinds

The `kind` CHECK in `0002_ledger.sql`, one function each in `packages/ledger/src/movements.ts`
(`seed` is in `seed.ts`).

| Kind | Posted when | Debit | Credit | Reference |
|---|---|---|---|---|
| `seed` | fixtures only: `pnpm ledger:seed`, the db tests, the race's sandbox | `treasury:available`, then `equity:opening` | `equity:opening`, then `partner:payable` | none |
| `funding` | the watcher sees stablecoin arrive at the treasury, in a final block | `treasury:available` | `equity:opening` | `tx:<hash>:<logIndex>` |
| `payable` | an invoice to a partner or to an address is created | `expense:services` | `partner:payable` | the payable's id |
| `receivable` | an invoice to a partner is created | `partner:receivable` | `revenue:services` | the receivable's id |
| `reserve` | a payment goes CREATED → RESERVED | `treasury:reserved` | `treasury:available` | `PAY-XXXX` |
| `settle` | a payment goes SENT → SETTLED | `partner:payable` | `treasury:reserved` | `PAY-XXXX` |
| `reversal` | a payment goes SENT → FAILED `reverted`, with proof | `treasury:available` | `treasury:reserved` | `PAY-XXXX` |
| `cancel` | a scheduled payment goes RESERVED → FAILED `cancelled`, nothing signed | `treasury:available` | `treasury:reserved` | `PAY-XXXX` |
| `deposit` | a deposit goes DETECTED → SETTLED | `deposits:onchain` | `partner:receivable` | the deposit's id |
| `scaffolding` | "Fund partner wallet" moved its stablecoin | `demo:partner-funding` | `treasury:available` | `tx:<hash>` |

Gas is never posted. Treasury top-ups from a faucet are `funding` rows; no screen lists them one
by one, the query below does.

## Guards the database enforces

They hold for every writer, a hand-typed statement in `psql` included.

| Guard | What it refuses | Where |
|---|---|---|
| Zero sum | a posting whose debits and credits differ, per currency; checked at COMMIT (deferred trigger `ledger_entries_sum_to_zero`) | `0002_ledger.sql` |
| Never negative | Available, Reserved or Deposits below zero: `CHECK (allows_negative OR balance_minor >= 0)` on the kept balance; the engine also takes `SELECT … FOR UPDATE` on the accounts first | `0002_ledger.sql`, `packages/ledger/src/engine.ts` |
| Append-only ledger | `UPDATE` or `DELETE` on `ledger_entries` and `ledger_transactions` | `0002_ledger.sql` |
| Append-only audit log | `UPDATE` or `DELETE` on `audit_log` (a log you can edit records what the last writer wanted) | `0003_audit_log.sql` |
| One posting per event | a second `(kind, reference)`; seeds carry no reference | `0002_ledger.sql` |
| The release rule | money from `treasury:reserved` back to `treasury:available` under any kind but `reversal` or `cancel`; a `reversal` with no `proof`; a `cancel` for a payment that carries a hash | `0002_ledger.sql`, `0015_cancel_needs_no_hash.sql` |
| One payment per key | a second payment with the same `idempotency_key` | `0007_payments.sql` |
| Signed means stored | `tx_hash`, `signed_tx` and `nonce` apart; SENT or SETTLED with no hash; a hash or a nonce used twice | `0008_payment_signing.sql` |
| REVIEW knows its origin | REVIEW without `review_from_status`, or the column set outside REVIEW | `0010_payment_review.sql` |
| One deposit per transfer | a second row for the same `(tx_hash, log_index)`; SETTLED without `matched_by`; `unmatched` with an invoice | `0012_deposits.sql` |

`TRUNCATE` does not fire the append-only triggers. `pnpm ledger:seed` uses it, which is why that
command empties the books (entries, transactions, balances back to zero), the audit log, the payments and the payables.

## Reading the books with psql

Run from the repository with the stack up. The prefix opens `psql` in the Postgres container; every
line is a `SELECT` and changes nothing. Amounts are shown in whole USDC.

```sh
# the nine balances
docker compose exec postgres psql -U payments -d payments -c "SELECT code, round(balance_minor / 1e6, 6) AS usdc FROM ledger_accounts ORDER BY code"

# one payment's entries, reserve to settle (or to its release)
docker compose exec postgres psql -U payments -d payments -c "SELECT t.created_at, t.kind, e.account_code, e.direction, round(e.amount_minor / 1e6, 6) AS usdc, t.proof FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id WHERE t.reference = 'PAY-7699' ORDER BY e.id"

# one payment's audit trail, with its invoice's rows
docker compose exec postgres psql -U payments -d payments -c "SELECT at, actor, subject_type, event, context FROM audit_log WHERE subject_id = 'PAY-7699' OR context->>'reference' = 'PAY-7699' ORDER BY id"

# the accruals no screen shows: expense:services and revenue:services, invoice by invoice
docker compose exec postgres psql -U payments -d payments -c "SELECT e.account_code, t.kind, round(e.amount_minor / 1e6, 6) AS usdc, coalesce(p.description, r.description) AS invoice FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id LEFT JOIN payables p ON p.id::text = t.reference LEFT JOIN receivables r ON r.id::text = t.reference WHERE e.account_code IN ('expense:services', 'revenue:services') ORDER BY e.id"

# treasury top-ups, one funding posting per transfer that arrived
docker compose exec postgres psql -U payments -d payments -c "SELECT t.created_at, t.reference, round(e.amount_minor / 1e6, 6) AS usdc FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id AND e.account_code = 'treasury:available' WHERE t.kind = 'funding' ORDER BY t.created_at"

# the deposits, and how each one was matched
docker compose exec postgres psql -U payments -d payments -c "SELECT d.detected_at, p.name AS partner, round(d.amount_minor / 1e6, 6) AS usdc, d.status, d.matched_by, r.description AS invoice FROM deposits d JOIN partners p ON p.id = d.partner_id LEFT JOIN receivables r ON r.id = d.receivable_id ORDER BY d.detected_at"

# the latest reconciliation runs
docker compose exec postgres psql -U payments -d payments -c "SELECT finished_at, block_number, outcome, checked, explained, mismatched FROM reconciliation_runs ORDER BY finished_at DESC LIMIT 5"

# the latest run, item by item
docker compose exec postgres psql -U payments -d payments -c "SELECT subject_type, subject_id, outcome, delta_minor, detail FROM reconciliation_items WHERE run_id = (SELECT id FROM reconciliation_runs ORDER BY finished_at DESC LIMIT 1) ORDER BY id"
```

Exporting the latest run for finance, one CSV row per item with its evidence (`-T` keeps the file
free of terminal line endings; the file is written on your machine, the database is only read):

```sh
docker compose exec -T postgres psql -U payments -d payments -c "COPY (SELECT r.block_number, r.outcome AS run_outcome, i.subject_type, i.subject_id, i.outcome, i.delta_minor, i.detail, i.evidence FROM reconciliation_runs r JOIN reconciliation_items i ON i.run_id = r.id WHERE r.id = (SELECT id FROM reconciliation_runs ORDER BY finished_at DESC LIMIT 1) ORDER BY i.id) TO STDOUT WITH CSV HEADER" > reconciliation-run.csv
```

`PAY-7699` is a payment on the author's machine. Use a reference from your own Transfers screen, or
`SELECT reference, status FROM payments ORDER BY created_at DESC LIMIT 10`.
