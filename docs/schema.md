# Schema

The database built by the 16 files in `migrations/`, and how to read it with `psql`. Amounts are `bigint` in minor units (1,000 USDC is `1000000000`). Addresses are stored checksummed.

## Tables

| Table | Holds | Columns to know |
|---|---|---|
| `ledger_accounts` | the nine accounts below | `code`, `balance_minor` (kept by a trigger) |
| `ledger_transactions` | one row per posting | `kind`, `reference` (unique together), `proof` on a reversal |
| `ledger_entries` | the lines of a posting | `direction` (`debit` or `credit`), `amount_minor` (always positive) |
| `payments` | one row per idempotency key | `reference` (`PAY-XXXX`), `status`, `failure_reason`, `tx_hash`, `signed_tx`, `nonce`, `execute_at` (null = now), `review_from_status` |
| `payables` | invoices the company owes | `status`, `partner_id` (null when paying an address) |
| `allowlist` | addresses the company may pay | `address`, `partner_id` (null for a typed address) |
| `partners` | who the demo pays and gets paid by | `derivation_index` (1 or more, unique): both its addresses come from it |
| `receivables` | invoices a partner owes | `status`, `payment_tx_hash` (written before the partner sends) |
| `deposits` | stablecoin arriving at a deposit address | `(tx_hash, log_index)` unique, `status`, `matched_by` |
| `watched_addresses` | the treasury and every deposit address | `role`: `treasury` or `deposit` |
| `watcher_state` | how far the watcher has read | `last_block` |
| `audit_log` | what happened, to what, by whom | `subject_type` + `subject_id` (`payment` + `PAY-4821`), `event`, `context` |
| `reconciliation_runs` | one row per run | `block_number`, `outcome` |
| `reconciliation_items` | one row per thing a run checked | `outcome`, `delta_minor` (books minus chain) |
| `settings` | the Break it flags | `key`, `value`; no row means off |

- `schema_migrations`: one row per applied migration (`packages/db/src/migrate.ts`).
- In `audit_log`, a payable's subject is `invoice` and a receivable's is `receivable`.
- Statuses are in [states.md](states.md), the flags in [experiments.md](experiments.md).

## Chart of accounts

From `0002_ledger.sql`. A balance is kept on its normal side, so Partner debt is positive while the company owes.

| Account | On screen | Type | Normal side | Can go negative |
|---|---|---|---|---|
| `treasury:available` | **Available** | asset | debit | no |
| `treasury:reserved` | **Reserved** | asset | debit | no |
| `partner:payable` | **Partner debt** | liability | credit | yes |
| `partner:receivable` | Partner receivables | asset | debit | yes (a deposit nobody invoiced) |
| `deposits:onchain` | Deposits | asset | debit | no |
| `equity:opening` | none | equity | credit | yes |
| `expense:services` | none | expense | debit | yes |
| `revenue:services` | none | revenue | credit | yes |
| `demo:partner-funding` | demo scaffolding | expense | debit | yes |

Reconciliation compares Available + Reserved + Deposits with the chain. Partner debt is one total; each partner's share comes from its invoices.

## Posting kinds

The `kind` CHECK in `0002_ledger.sql`; one function each in `packages/ledger/src/movements.ts`.

| Kind | When | Debit | Credit | Reference |
|---|---|---|---|---|
| `seed` | fixtures: `pnpm ledger:seed`, db tests, the race | `treasury:available`, `equity:opening` | `equity:opening`, `partner:payable` | none |
| `funding` | stablecoin arrives at the treasury (final block) | `treasury:available` | `equity:opening` | `tx:<hash>:<logIndex>` |
| `payable` | an invoice to pay is created | `expense:services` | `partner:payable` | payable id |
| `receivable` | an invoice to collect is created | `partner:receivable` | `revenue:services` | receivable id |
| `reserve` | payment CREATED → RESERVED | `treasury:reserved` | `treasury:available` | `PAY-XXXX` |
| `settle` | payment SENT → SETTLED | `partner:payable` | `treasury:reserved` | `PAY-XXXX` |
| `reversal` | payment SENT → FAILED `reverted` | `treasury:available` | `treasury:reserved` | `PAY-XXXX` |
| `cancel` | payment RESERVED → FAILED `cancelled` | `treasury:available` | `treasury:reserved` | `PAY-XXXX` |
| `deposit` | deposit DETECTED → SETTLED | `deposits:onchain` | `partner:receivable` | deposit id |
| `scaffolding` | Fund partner wallet | `demo:partner-funding` | `treasury:available` | `tx:<hash>` |

Gas is never posted.

## Guards the database enforces

They hold for every writer, `psql` included.

| Guard | Refuses | Where |
|---|---|---|
| Zero sum | debits and credits that differ, checked at COMMIT | `0002_ledger.sql` |
| Never negative | Available, Reserved or Deposits below zero | `0002_ledger.sql` |
| Append-only | `UPDATE` or `DELETE` on `ledger_entries`, `ledger_transactions`, `audit_log` | `0002_ledger.sql`, `0003_audit_log.sql` |
| One posting per event | a second `(kind, reference)` | `0002_ledger.sql` |
| Release rule | Reserved back to Available by any kind but `reversal` (needs `proof`) or `cancel` (needs no hash) | `0002_ledger.sql`, `0015_cancel_needs_no_hash.sql` |
| One payment per key | a second `idempotency_key` | `0007_payments.sql` |
| Signed means stored | hash, signed bytes and nonce not set together; SENT with no hash; a hash or nonce used twice | `0008_payment_signing.sql` |
| REVIEW knows its origin | REVIEW without `review_from_status` | `0010_payment_review.sql` |
| One deposit per transfer | a second `(tx_hash, log_index)`; SETTLED without `matched_by` | `0012_deposits.sql` |

`TRUNCATE` skips the append-only triggers: `pnpm ledger:seed` uses it to empty the books, the audit log, payments and payables.

## Reading the books with psql

Run from the repository with the stack up. Every line only reads. Amounts are in whole USDC. Replace `PAY-7699` with a reference from your Transfers screen.

```sh
# the latest payments, to pick a reference
docker compose exec postgres psql -U payments -d payments -c "SELECT reference, status FROM payments ORDER BY created_at DESC LIMIT 10"
# the nine balances
docker compose exec postgres psql -U payments -d payments -c "SELECT code, round(balance_minor / 1e6, 6) AS usdc FROM ledger_accounts ORDER BY code"
# one payment's entries
docker compose exec postgres psql -U payments -d payments -c "SELECT t.created_at, t.kind, e.account_code, e.direction, round(e.amount_minor / 1e6, 6) AS usdc, t.proof FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id WHERE t.reference = 'PAY-7699' ORDER BY e.id"
# one payment's audit trail, with its invoice's rows
docker compose exec postgres psql -U payments -d payments -c "SELECT at, actor, subject_type, event, context FROM audit_log WHERE subject_id = 'PAY-7699' OR context->>'reference' = 'PAY-7699' ORDER BY id"
# expense:services and revenue:services, invoice by invoice
docker compose exec postgres psql -U payments -d payments -c "SELECT e.account_code, t.kind, round(e.amount_minor / 1e6, 6) AS usdc, coalesce(p.description, r.description) AS invoice FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id LEFT JOIN payables p ON p.id::text = t.reference LEFT JOIN receivables r ON r.id::text = t.reference WHERE e.account_code IN ('expense:services', 'revenue:services') ORDER BY e.id"
# treasury top-ups
docker compose exec postgres psql -U payments -d payments -c "SELECT t.created_at, t.reference, round(e.amount_minor / 1e6, 6) AS usdc FROM ledger_transactions t JOIN ledger_entries e ON e.transaction_id = t.id AND e.account_code = 'treasury:available' WHERE t.kind = 'funding' ORDER BY t.created_at"
# deposits and how each was matched
docker compose exec postgres psql -U payments -d payments -c "SELECT d.detected_at, p.name AS partner, round(d.amount_minor / 1e6, 6) AS usdc, d.status, d.matched_by, r.description AS invoice FROM deposits d JOIN partners p ON p.id = d.partner_id LEFT JOIN receivables r ON r.id = d.receivable_id ORDER BY d.detected_at"
# the latest reconciliation runs
docker compose exec postgres psql -U payments -d payments -c "SELECT finished_at, block_number, outcome, checked, explained, mismatched FROM reconciliation_runs ORDER BY finished_at DESC LIMIT 5"
# the latest run, item by item
docker compose exec postgres psql -U payments -d payments -c "SELECT subject_type, subject_id, outcome, delta_minor, detail FROM reconciliation_items WHERE run_id = (SELECT id FROM reconciliation_runs ORDER BY finished_at DESC LIMIT 1) ORDER BY id"
# the latest run as a CSV file on your machine (-T keeps terminal line endings out)
docker compose exec -T postgres psql -U payments -d payments -c "COPY (SELECT r.block_number, r.outcome AS run_outcome, i.subject_type, i.subject_id, i.outcome, i.delta_minor, i.detail, i.evidence FROM reconciliation_runs r JOIN reconciliation_items i ON i.run_id = r.id WHERE r.id = (SELECT id FROM reconciliation_runs ORDER BY finished_at DESC LIMIT 1) ORDER BY i.id) TO STDOUT WITH CSV HEADER" > reconciliation-run.csv
```
