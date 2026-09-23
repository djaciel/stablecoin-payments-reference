# Database tests

**Do I need Docker?** For `pnpm test`, no. For `pnpm test:db`, yes.

```
pnpm test      # every package's own tests. Pure, fast, no database.
pnpm test:db   # this directory. Needs Postgres running.
```

The split is a directory, not a naming convention: everything under `tests/db/` needs a
database, everything outside it does not. Per-package Vitest runs cannot see this directory
at all, so `pnpm test` stays green on a machine that has never started Docker.

## Running them

```
docker compose up -d postgres
pnpm test:db
```

If port 5432 is taken on your machine, start the stack and run the tests with the same
override:

```
POSTGRES_PORT=55432 docker compose up -d postgres
POSTGRES_PORT=55432 pnpm test:db
```

## How isolation works

Every run drops and recreates a dedicated `payments_test` database and migrates it with the
real runner over the real files in `/migrations`. Two consequences worth knowing:

- The suite never writes to `payments`, so the demo's own data survives. It does connect to
  it, because `CREATE DATABASE` cannot run from inside the database being created — the only
  statements it issues there are the drop and the create of `payments_test`.
- The schema under test is the schema that ships. A migration that is broken in production is
  broken here too, because it is the same file going through the same runner. That is also
  why there is no separate test for the migration runner: every run of this suite is one.

Connection string resolution, in order: `TEST_DATABASE_URL`, then `DATABASE_URL` with its
database name swapped, then `localhost` on `POSTGRES_PORT`.

## The five invariants, and where each one is defended

The spec lists five invariants. This is the map from each one to the file that proves it and
the place that enforces it, so a review is a checklist rather than a reading exercise. Where
it can, a test violates the rule twice: through the code callers use, and through raw SQL,
because a guarantee that only holds for well-behaved callers is not a guarantee.

| # | Invariant | Proved by | Enforced at |
|---|---|---|---|
| 1 | Every ledger transaction sums to zero, per currency | `guards.db.test.ts` (and `walkthrough.db.test.ts`, which also checks no account's balance has drifted from its own entries) | engine check before the write, plus the deferred constraint trigger `ledger_entries_sum_to_zero` at COMMIT |
| 2 | Posted entries are immutable; corrections are new entries | `guards.db.test.ts` | `BEFORE UPDATE OR DELETE` triggers on both ledger tables — and `audit_log` has its own, with its own message |
| 3 | `treasury:available` and every `never negative` account stay at or above zero | `guards.db.test.ts`, `race.db.test.ts` | engine check under `SELECT … FOR UPDATE`, plus `CHECK (allows_negative OR balance_minor >= 0)` on the maintained balance |
| 4 | Transitions are guarded and change exactly one row | `guarded-transition.db.test.ts` | `applyGuardedTransition` in `packages/db`: `UPDATE … WHERE status = $expected`, then `rowCount === 1` or `TransitionRejected` |
| 5 | Reserved money is released only with proof the transfer can no longer land | `release.db.test.ts` (the ledger's two doors) and `cancel.db.test.ts` (the second door's conditions, and its race with `sign`) | `reversal` requires the proof argument; `CHECK (kind <> 'reversal' OR proof IS NOT NULL)`; and the deferred trigger `ledger_entries_release_is_allowed`, which refuses that movement of money under any kind but `reversal` and `cancel`, and refuses a `cancel` whose payment carries a hash (`0015`) |

And the article's idempotency key (§4, §9's double click), one test per claim, all in
`payments.db.test.ts`, calling `createPayment` from `apps/api/src/payments/create-payment.ts`
directly:

| Claim | Test | Enforced at |
|---|---|---|
| The same key and the same body is the same payment, with zero new rows in `payments`, `ledger_transactions`, `ledger_entries` or `audit_log` | "answers the same request twice…" | the unique index `payments_idempotency_key`: the second INSERT fails with 23505 and the winner is read back |
| The same key with a different body is refused, and nothing is written | "refuses the same key with a different body…" | the request fingerprint stored next to the key |
| Two calls with one key in parallel make one payment and one `reserve` | "makes one payment out of two parallel calls…" | the same index: the loser waits on it until the winner commits. A SELECT before the INSERT fails this test |

And §9's race at the payment door, in `race.db.test.ts` next to the same race at the ledger engine,
calling the same `createPayment`:

| Claim | Test | Enforced at |
|---|---|---|
| 1,500 and two payments of 1,000 with different keys: one is RESERVED and the other is recorded FAILED `insufficient_funds`, with one `reserve` in the books, Available 500 and Reserved 1,000 | "reserves one and records the other as FAILED insufficient_funds…" | the engine's check under `SELECT … FOR UPDATE` on `treasury:available`, and step 5 of `create-payment.ts`, which turns `InsufficientFunds` into a recorded refusal instead of a rollback. This is what `POST /experiments/race` runs |

And §7's Signed moment, in `signing.db.test.ts`, calling `signPayment` from
`apps/worker/src/sign.ts` with a signer that really signs (the published test mnemonic; real
bytes, no network):

| Claim | Test | Enforced at |
|---|---|---|
| A payment is signed once: two calls at the same instant and one after ask the signer once, the stored hash is the hash of the stored bytes, the payment stays RESERVED, one `signed` audit row | "signs a payment once…" | the payment row lock (`SELECT … FOR UPDATE`) and the re-check under it; `UNIQUE (tx_hash)` in `0008`. Without the lock this test fails |
| Two payments signed at the same instant get two nonces, though the chain's pending count told both 7 | "gives two payments signed at the same instant two nonces…" | the treasury's nonce lock (`pg_advisory_xact_lock`) and `max(pending, highest stored + 1)`; `UNIQUE (nonce)` in `0008`. Without the lock this test fails |

And §7's Paid moment, in `settlement.db.test.ts`, calling `settlePayment` from
`apps/worker/src/settle.ts` on a payment the api reserved and the row then marked SENT:

| Claim | Test | Enforced at |
|---|---|---|
| Settling is one transaction that posts once: run twice, it leaves Available 9,000, Reserved 0, Partner debt 0, the payment SETTLED, the invoice PAID, one `settle` and one `settled` audit row | "posts once however often it runs…" | the invoice lock, then the status read under it (SETTLED → nothing to do); the `(kind, reference)` unique index and the guarded SENT → SETTLED behind it |

And §6's two outcomes after the reserve, FAILED and REVIEW, side by side in `failure.db.test.ts`,
on a payment the api reserved and the row then marked SENT:

| Claim | Test | Enforced at |
|---|---|---|
| A final revert releases the money only with proof, reopens the invoice and posts once: run twice, it leaves Available 10,000, Reserved 0, Partner debt 1,000 (the invoice is still owed), the payment FAILED `reverted`, the invoice OPEN with no payment on it, one `reversal` whose proof names the hash and the block, one `failed` and one `released` row; a new key then reserves the same invoice again | "releases the money only with proof…" (`reversePayment`, from `apps/worker/src/reverse.ts`) | the invoice lock, then the status read under it (FAILED → nothing to do); the guarded SENT → FAILED and PAYING → OPEN; `reversal`'s required proof and `ledger_reversal_needs_proof` |
| No proof either way leaves the money where it is, there and back: escalated twice, it moves the payment SENT → REVIEW with `review_from_status` SENT and leaves Available 9,000, Reserved 1,000, Partner debt 1,000, the invoice PAYING, no ledger transaction but the seed's and the `reserve`, and one `escalated` row carrying the step, the attempts, the last error, the hash and the nonce; resumed twice, it is SENT again with `review_from_status` cleared, the same three figures and postings, and one `resumed` row | "goes to REVIEW and back on resume…" (`escalatePayment`, from `apps/worker/src/escalate.ts`; `resumePayment`, from `apps/api/src/payments/resume-payment.ts`) | the payment row lock, then the status read under it (REVIEW → nothing to escalate; not REVIEW → nothing to resume); the guarded SENT → REVIEW → SENT; no ledger call in `escalate` or `resumePayment` at all; `0010`'s CHECK that a REVIEW, and only a REVIEW, knows where it came from |

And §6's second release door, the one with no chain proof, in `cancel.db.test.ts`, calling
`cancelPayment` from `apps/api/src/payments/cancel-payment.ts` on a payment the api reserved and
nobody signed:

| Claim | Test | Enforced at |
|---|---|---|
| Cancelling before anything is signed releases the money and reopens the invoice: Available 10,000, Reserved 0, Partner debt 1,000 (the invoice is still owed), the payment FAILED `cancelled` with no hash, the invoice OPEN with no payment on it, one `cancel` whose `proof` column is empty, one `failed` / one `released` / one `reopened` row; a second cancel answers `not-cancellable` and writes nothing; a new key reserves the same invoice again | "gives the money back when nothing was signed…" | the invoice lock, then the payment row lock and the status read under it; the guarded RESERVED → FAILED and PAYING → OPEN; the `(kind, reference)` unique index |
| A payment whose bytes are signed cannot be cancelled: `signed-already`, zero rows written anywhere, Reserved still holding the 1,000 and the invoice still PAYING | "refuses a payment whose transaction is already signed…" | `tx_hash` read under `SELECT … FOR UPDATE`, before anything is written; `0015`'s trigger says the same thing to whoever posts the movement |
| Once a payment is cancelled there is nothing left to sign: `signPayment` answers `not-reserved` FAILED, never asks the signer, and leaves `tx_hash`, `signed_tx` and `nonce` null | "leaves nothing to sign once it has been cancelled…" | the same row lock, then `nothingToSign`'s status check under it. Without it a signature after the release would burn a treasury nonce on a FAILED payment, and every payout signed after it would wait behind that nonce |
| Cancel and `sign` at the same instant have exactly one winner: either a stored hash or a `cancel` transaction, never both and never neither, with Reserved at 1,000 when sign won and 0 when cancel won, and no deadlock in five runs | "lets sign or cancel win when they run at the same instant…" | the payment row lock both of them take — `signPayment` holds it across the signer call — so the loser reads the winner's row and returns without writing |

And §8's money coming in, in `deposits.db.test.ts`, calling `recordDetected`,
`promotableDeposits` and `settleDeposit` from `apps/worker/src/deposits.ts`:

| Claim | Test | Enforced at |
|---|---|---|
| A deposit is credited only once its block can no longer be replaced: of two DETECTED rows, only the one at or below the final block is offered for promotion, and the other has no `deposit` transaction and is still DETECTED | "is credited only once its block can no longer be replaced…" | `promotableDeposits`' `block_number <= $finalBlock`; nothing else reads a DETECTED row |
| The address decides whose money it is: two partners owing the same amount, and the deposit settles the invoice of the partner whose address it arrived at; a deposit nobody invoiced is credited anyway, flagged `unmatched`, and takes `partner:receivable` negative | "belongs to whoever owns the address it arrived at…" | `partner_id` written at detection from `watched_addresses`; the two matching statements in `settleDeposit`; `allows_negative` on `partner:receivable` |
| A second pass posts nothing twice: `recordDetected` twice leaves one row, `settleDeposit` twice answers `already-settled`, with one `deposit` transaction, one `paid` audit row and the invoice PAID | "cannot be recorded or credited twice…" | `UNIQUE (tx_hash, log_index)` with `ON CONFLICT DO NOTHING`; the deposit row lock and the status read under it; the `(kind, reference)` unique index |

And §10's check of all three at once, in `reconciliation.db.test.ts`, calling `reconcile` from
`apps/worker/src/reconcile.ts` with a **stub chain port**: a live system can only ever be clean, so
the disagreement is manufactured on the chain's side. The ledger's side cannot be corrupted at all
(it is append-only by trigger), and the demo's own books are never touched:

| Claim | Test | Enforced at |
|---|---|---|
| The three versions agree: a settled payment and a credited deposit, checked against receipts that carry the right Transfers, give one `ok` item each, no delta, and one run row written once with both its items | "finds the three versions agree…" | `reconcile`'s five steps: one `REPEATABLE READ` snapshot, the block `B = min(watcher cursor, final block)`, the chain reads outside any transaction, one item per row, then one INSERT of the run and its items together |
| §10's "a settled payment with no event": the receipt succeeded and carries a Transfer for another amount, so that item is a `mismatch` naming both numbers, the run is a `mismatch`, and the deposit's item is still `ok` | "flags a settled payment the chain never carried…" | `findSettlementLog` in `packages/chain/src/usdc.ts`, over the receipt for the hash stored on the payment. A status check alone passes this |
| A release whose proof is not true: the `reversal` names a transaction the chain says succeeded, so it is a `mismatch`. v1's open item, closed | "flags a release whose proof names a transaction that did not revert…" | `checkPayment`'s reversal rule: the receipt must be `reverted`, in the exact block the proof names, with no Transfer of that amount in its logs. The proof is read, never trusted |

Whether the transfer is final and carries the official Transfer event, or reverted in a final
block, is decided before this, by `paidVerdict` in `packages/chain/src/usdc.ts`, whose three
tests run in `pnpm test`.

Three notes on what a green suite does NOT say:

- **Invariant 5 is proved in both halves now.** The release cannot be written without its
  evidence, and evidence and entries commit together (`release.db.test.ts`); whether the hash
  inside a proof really reverted in the block it names is `reconciliation.db.test.ts`'s third
  claim, and the reconciler checks it against the chain on every run.
- **Invariant 4 is proved against a fixture table the test creates.** `payments` moves through
  the same helper, and the rest of the `cancel` rule — status RESERVED, no stored hash, read under
  the payment row lock — is `cancel.db.test.ts`'s.
- **The race proves an outcome, not an instant.** An outside observer cannot see a
  mid-transaction balance; "Available never goes negative" is carried by the final figure plus
  the `CHECK` that `guards.db.test.ts` violates on purpose.

## The article's numbers

`walkthrough.db.test.ts` asserts the figures the article prints, step by step: Available
10,000 and Partner debt 1,000 to start (§5, §7), 9,000 / 1,000 after the reserve (§5), then
Reserved 0 and Partner debt 0 after settling (§7). `release.db.test.ts` continues into §6:
Available back at 10,000 after either release door.

The same walk by hand, printed rather than asserted:

```
pnpm ledger:seed --walkthrough       # opening, after reserving, after settling
pnpm ledger:seed --release=reversal  # ... and the transfer reverted onchain (§6)
pnpm ledger:seed --release=cancel    # ... and nothing was ever signed
```

If one of those figures ever has to change here, the article changed first.

## The canary

`race.db.test.ts` ends with a test that is not about the ledger at all. It checks that this
harness can genuinely run two things at once, because a race test that cannot produce a race
passes for the wrong reason forever.

Its proof is the pair of **different `pg_backend_pid()` values** reported while both
transactions are open — the barrier does not release until the second one arrives, so getting
past it means they overlapped, and distinct pids mean two server-side sessions rather than one
connection used twice. If those numbers are ever equal, every concurrency assertion in this
repository is decoration.

It then performs an unguarded read-modify-write and shows an update being lost. That part is
the consequence, not the proof — the barrier arranges it — and it is there because it is
exactly the outcome `SELECT … FOR UPDATE` exists to prevent.

**When this test fails, fix the harness, not the ledger.** If it times out, the pool could not
hand out two connections at once.
