# States

Every state machine in the repo, what moves a row from one state to the next, and what the ledger
does on the way. A reference only: how to run the demo is in the [README](../README.md), where the
code lives is in [GUIDE.md](../GUIDE.md), and why these states exist is in the article (§6, §7).

- [Payments](#payments)
- [Why a payment failed](#why-a-payment-failed)
- [The two release doors](#the-two-release-doors)
- [Deposits](#deposits)
- [Payables and receivables](#payables-and-receivables)
- [Reconciliation outcomes](#reconciliation-outcomes)

Every transition is `UPDATE … SET status = $to WHERE … AND status = $from` and must change exactly
one row (`applyGuardedTransition`, `packages/db/src/guarded-update.ts`).

## Payments

Six public states: `CREATED`, `RESERVED`, `SENT`, `SETTLED`, `FAILED`, `REVIEW` (the CHECK in
`0007_payments.sql`). SETTLED and FAILED are final. REVIEW leaves only through resume.

| From → to | Trigger | Guard | Ledger | Its invoice |
|---|---|---|---|---|
| (none) → CREATED | `POST /payments` passes the idempotency gate | unique index on `idempotency_key` | nothing | nothing |
| CREATED → RESERVED | every check passes and the reserve posts | one database transaction with the reserve; the workflow starts after COMMIT | `reserve` | OPEN → PAYING |
| CREATED → FAILED | a check says no, or Available is short | the refusal is recorded, not rolled back | nothing | stays OPEN |
| RESERVED → SENT | a node accepted the broadcast | `tx_hash`, `signed_tx` and `nonce` stored before the first broadcast (`0008`) | nothing | stays PAYING |
| RESERVED → FAILED | `POST /payments/:reference/cancel` while no hash is stored | invoice lock, then the payment row lock, the hash read under it | `cancel` | PAYING → OPEN |
| RESERVED → REVIEW | `sign` or `execute` ran out of attempts or failed in a way retrying cannot fix | payment row lock; `review_from_status = RESERVED` | nothing | stays PAYING |
| SENT → SETTLED | its block is final AND the receipt carries the official contract's Transfer, exact amount, exact destination | invoice lock first; one transaction | `settle` | PAYING → PAID |
| SENT → FAILED | a receipt in a final block says reverted | invoice lock first; proof `{ txHash, blockNumber, reason }` stored with the entries | `reversal` | PAYING → OPEN |
| SENT → REVIEW | `watch`, `settle` or `reverse` gave up, a final receipt has no matching Transfer, or 30 minutes of checks gave no final answer | payment row lock; `review_from_status = SENT` | nothing | stays PAYING |
| REVIEW → RESERVED or SENT | `POST /payments/:reference/resume` | back to `review_from_status`, which is cleared; dispatched after COMMIT | nothing | stays PAYING |

- Signing does not change the status: a signed payment is still RESERVED, with its hash stored.
  A RESERVED payment with a hash holds that treasury nonce, and every payout signed after it waits
  for it.
- A scheduled payment is RESERVED with no hash until its `execute_at`; nothing is signed before.
- Each step gets 5 attempts, 1, 2, 4 and 8 s apart. The finality wait checks every 10 s, up to 180
  times.
- The dispatcher (every 10 s) starts a workflow for every RESERVED or SENT payment whose time has
  come and has none running. It never touches REVIEW.

## Why a payment failed

`payments.failure_reason`, the type `PaymentFailureReason` in `packages/domain/src/api.ts`. The six
door checks run in this order and the first that says no wins.

| Reason | Set by | Means | Money reserved first? |
|---|---|---|---|
| `payable_not_open` | the door | the invoice is PAYING or PAID already | no |
| `partner_inactive` | the door | the invoice's partner is `inactive` | no |
| `destination_not_allowlisted` | the door | the destination is not in `allowlist` | no |
| `amount_out_of_range` | the door | outside `MIN_PAYMENT_USDC` / `MAX_PAYMENT_USDC` (0.01 to 1,000, `apps/api/src/config.ts`) | no |
| `compliance_rejected` | the door | the compliance mock said no (its denylist is empty by default) | no |
| `insufficient_funds` | the door | the reserve would take Available below zero | no |
| `reverted` | the worker (`reverse`) | the transfer reverted in a final block | yes, given back by `reversal` |
| `cancelled` | the api (`cancel`) | cancelled before anything was signed | yes, given back by `cancel` |

The six "no" rows are the ones the screens call "Nothing was reserved." They answer 422; the other
two answer a replay with 200 ([api.md](api.md)).

## The two release doors

Money goes from Reserved back to Available in exactly two ways.

| Door | When | Proof | Conditions |
|---|---|---|---|
| `reversal` | SENT → FAILED `reverted` | `{ txHash, blockNumber, reason }` from a receipt in a final block, stored on the ledger transaction and in the `released` audit row | `CHECK (kind <> 'reversal' OR proof IS NOT NULL)` |
| `cancel` | RESERVED → FAILED `cancelled` | none from the chain: no signed bytes exist, so no node can include them | status RESERVED and `tx_hash` null, read under the payment row lock that `sign` also takes; the trigger in `0015` refuses a `cancel` for a payment that has a hash |

Any other posting that moves money from `treasury:reserved` to `treasury:available` is refused by
the database at COMMIT, whatever its `kind` says (`0002_ledger.sql`). Partner debt does not move
through either door: the invoice is still owed.

## Deposits

`deposits.status`, the CHECK in `0012_deposits.sql`.

| From → to | Trigger | Effect |
|---|---|---|
| (none) → DETECTED | the watcher sees a Transfer to a deposit address, in a final block or in the newer blocks after it | a row and a `detected` audit row; nothing in the ledger. The partner is set from the address |
| DETECTED → SETTLED | its block is final, and the receipt read again shows the official contract's Transfer at the recorded log index, to that address, for that amount | `deposit` posting, `matched_by` set, the matched receivable PAID, one transaction |

| `matched_by` | Rule, tried in this order |
|---|---|
| `hash` | a PAYING receivable of that partner whose `payment_tx_hash` is the deposit's hash |
| `amount` | else the partner's oldest OPEN receivable for the exact amount |
| `unmatched` | else none: the money is credited anyway, and `partner:receivable` goes down (below zero if nothing was owed) |

A deposit whose receipt is gone, or whose event no longer matches, stays DETECTED and gets a
`mismatched` audit row with the reason, a new one only when the reason changes. Nothing is credited, and reconciliation reports it as a
mismatch. A receipt in a different block corrects `block_number` and waits for that block.

## Payables and receivables

Both are `OPEN → PAYING → PAID` (CHECKs in `0006_payables.sql` and `0011_receivables.sql`).

| Invoice | OPEN → PAYING | PAYING → PAID | Back to OPEN |
|---|---|---|---|
| payable (the company owes) | a payment is RESERVED for it (`payment_reference` set) | its payment SETTLED | its payment FAILED `reverted` or `cancelled`: PAYING → OPEN, `payment_reference` cleared, paid again with a new key |
| receivable (a partner owes) | the partner's side stores its transaction hash, before sending | its deposit SETTLED, matched by hash | the partner's transfer was refused, reverted or was not the one asked for: PAYING → OPEN, hash cleared (`payment-refused`) |

A receivable can also go OPEN → PAID directly, when a deposit matches it by amount. A payment
refused at the door never touches its invoice. REVIEW keeps the invoice PAYING.

## Reconciliation outcomes

| Run (`reconciliation_runs.outcome`) | Means |
|---|---|
| `clean` | every item is `ok` or `explained`: books − chain at the block − what was in flight = 0 |
| `mismatch` | at least one item is a mismatch, the `global` one included; this outranks `incomplete` |
| `incomplete` | an item is `unchecked`, or there was no block to compare at; never reported as a mismatch |

| Item (`reconciliation_items.outcome`) | Means |
|---|---|
| `ok` | intent, ledger and chain agree |
| `explained` | a payment or deposit still moving, so the books and the chain may differ by it for now (`delta_minor`) |
| `mismatch` | the three versions disagree |
| `unchecked` | the chain did not answer for this item |

A run checks every payment, not only the settled ones, and every deposit, plus one `global` item
for the whole treasury. It writes only these two tables.
