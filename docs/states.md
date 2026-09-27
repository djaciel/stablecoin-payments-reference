# States

Every state machine in the repo. Each transition is one guarded `UPDATE … WHERE status = $from` that must change one row (`packages/db/src/guarded-update.ts`).

## Payments

`CREATED`, `RESERVED`, `SENT`, `SETTLED`, `FAILED`, `REVIEW` (`0007_payments.sql`). SETTLED and FAILED are final. REVIEW leaves only by resume.

| From → to | When | Ledger |
|---|---|---|
| (none) → CREATED | `POST /payments` with a new idempotency key | nothing |
| CREATED → RESERVED | every door check passes | `reserve` |
| CREATED → FAILED | a door check says no, or Available is short | nothing |
| RESERVED → SENT | a node accepted the broadcast | nothing |
| RESERVED → FAILED | `POST /payments/:reference/cancel` while no hash is stored | `cancel` |
| RESERVED → REVIEW | `sign` or `execute` ran out of attempts, or hit an error a retry cannot fix | nothing |
| SENT → SETTLED | final block, and the receipt has the official Transfer, exact amount and destination | `settle` |
| SENT → FAILED | the receipt in a final block says reverted | `reversal` |
| SENT → REVIEW | `watch`, `settle` or `reverse` gave up, the final receipt has no matching Transfer, or 30 minutes with no final answer | nothing |
| REVIEW → RESERVED or SENT | `POST /payments/:reference/resume` (back to `review_from_status`) | nothing |

- A signed payment is still RESERVED, with its hash stored. Every payout signed after it waits for its nonce.
- A scheduled payment stays RESERVED with no hash until `execute_at`.
- Each step gets 5 attempts, 1, 2, 4 and 8 s apart.
- The finality check runs every 10 s, up to 180 times.
- Every 10 s the dispatcher starts a workflow for each due RESERVED or SENT payment without one. Never for REVIEW.

## Why a payment failed

`payments.failure_reason`. The door checks run in this order; the first "no" wins.

| Reason | Means | Money was reserved |
|---|---|---|
| `payable_not_open` | the invoice is PAYING or PAID | no |
| `partner_inactive` | the partner is `inactive` | no |
| `destination_not_allowlisted` | the address is not in `allowlist` | no |
| `amount_out_of_range` | outside 0.01 to 1,000 USDC (`apps/api/src/config.ts`) | no |
| `compliance_rejected` | the compliance mock said no (empty denylist by default) | no |
| `insufficient_funds` | Available would go below zero | no |
| `reverted` | the transfer reverted in a final block | yes, given back by `reversal` |
| `cancelled` | cancelled before signing | yes, given back by `cancel` |

Door reasons answer 422. The last two answer a replay with 200 ([api.md](api.md#post-payments-codes-and-replays)).

## The two release doors

The only two ways from Reserved back to Available; the database refuses any other.

| Door | When | Needs |
|---|---|---|
| `reversal` | SENT → FAILED `reverted` | proof `{ txHash, blockNumber, reason }` from a final receipt |
| `cancel` | RESERVED → FAILED `cancelled` | no hash stored (checked under the row lock `sign` also takes) |

Partner debt does not move: the invoice is still owed.

## Deposits

| From → to | When | Effect |
|---|---|---|
| (none) → DETECTED | the watcher sees a Transfer to a deposit address | a row and an audit row; no ledger |
| DETECTED → SETTLED | final block, and the receipt still shows that Transfer | `deposit` posting, matched receivable PAID |

| `matched_by` | Rule, tried in this order |
|---|---|
| `hash` | the partner's PAYING receivable with this hash |
| `amount` | the partner's oldest OPEN receivable for the exact amount |
| `unmatched` | none: credited anyway, `partner:receivable` goes down |

A deposit whose receipt is gone or no longer matches stays DETECTED, with a `mismatched` audit row.

## Payables and receivables

| Invoice | OPEN → PAYING | PAYING → PAID | Back to OPEN |
|---|---|---|---|
| payable | its payment is RESERVED | its payment SETTLED | its payment FAILED `reverted` or `cancelled` |
| receivable | the partner stores its hash, before sending | its deposit SETTLED | the partner's transfer was refused, reverted or wrong |

A receivable matched by amount goes OPEN → PAID directly. A door refusal never touches the invoice; REVIEW keeps it PAYING.

## Reconciliation outcomes

A run checks every payment, every deposit and one `global` treasury item, every 10 minutes or on demand.

| Run | Means |
|---|---|
| `clean` | every item is `ok` or `explained` |
| `mismatch` | at least one item is a mismatch (this wins over `incomplete`) |
| `incomplete` | an item is `unchecked`, or there was no block to compare at |

| Item | Means |
|---|---|
| `ok` | intent, ledger and chain agree |
| `explained` | still moving: books and chain differ by it for now |
| `mismatch` | they disagree |
| `unchecked` | the chain did not answer for this item |
