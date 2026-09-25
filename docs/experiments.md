# Experiments

The five Break it cards and the four `pnpm experiment:*` commands: what each one does, what it must
show, and where that evidence comes from. A reference only: how to start one is in the
[README](../README.md), where the code lives is in [GUIDE.md](../GUIDE.md), and why these failures
matter is in the article (§6, §9). Each card on the Break it screen explains itself in its own words.

- [The five experiments](#the-five-experiments)
- [What each one must show](#what-each-one-must-show)
- [Rules that apply to every run](#rules-that-apply-to-every-run)
- [Disarming by hand](#disarming-by-hand)

## The five experiments

| Card | Article | Command | Arms | Spends | Takes |
|---|---|---|---|---|---|
| Double click | §9 | `pnpm experiment:double-click` | nothing | its own 0.02 USDC invoice, plus gas | a few minutes |
| The race | §9 | `pnpm experiment:race` | nothing | nothing: it runs in the `payments_experiment` sandbox | seconds |
| Crash after signing | §9 | `pnpm experiment:crash` | `experiment.crash_after_signing` (one-shot) | its own 0.02 USDC invoice, plus gas | a few minutes |
| Node not responding | §9 | `pnpm experiment:stuck` | `experiment.blackhole_rpc` (`{ enabled, step }`) | its own 0.02 USDC invoice, plus gas | about five minutes |
| Revert the next payment | §6 | none: the card, or its switch | `experiment.revert_next_payment` (one-shot) | gas only: the transfer reverts | a few minutes |

The commands press the same api doors the cards press (`scripts/experiments/`). They need Node 22
and `pnpm install`, and call `API_URL` (default `http://localhost:3000`). The flags live in the
`settings` table; only the worker's payment steps read them ([api.md](api.md#endpoints-by-module)).

## What each one must show

| Experiment | What it does | Must show | Evidence from |
|---|---|---|---|
| Double click | writes an invoice, sends two `POST /payments` with the same `idempotency-key` at the same instant, follows the payment to SETTLED | one payment; one set of `reserve` entries; two answers with the same reference, 201 and 200 | the two answers; the payment's timeline; the books before and after |
| The race | `POST /experiments/race`: the sandbox is migrated, emptied and seeded with Available 1,500, then two payments of 1,000 with different keys go through the payment door at once | one RESERVED (201), one FAILED `insufficient_funds` (422); one `reserve`; Available 1,500 → 500, never below zero; the demo's books untouched | `RaceResult`, which names the database it ran in |
| Crash after signing | arms the flag and pays; `sign` stores hash, signed bytes and nonce, commits, and the worker kills its own process; Docker restarts it; `sign` reruns on attempt 2 and finds the hash; `execute` asks the network, does not find it and sends the same bytes | exactly one transfer on chain; the stored hash is the landed hash; one `sent` row, at attempt 1 with `networkAlreadyKnew: false`; the worker's restart count +1 | the timeline (`signed`, `sent`, `settled` rows); `docker inspect` for the restart count (the command only; a browser cannot read it) |
| Node not responding | arms the blackhole at `watch` (the card also offers `execute`), pays, waits for REVIEW, disarms, resumes | REVIEW with Reserved unchanged and the attempts in the `escalated` row; after resume, SETTLED with one `sent` row | the `escalated` row (step, attempts, last error); the books while in REVIEW; the timeline after resume |
| Revert the next payment | arms the flag and pays; `sign` uses a gas limit of 30,000, so the transfer is included and runs out of gas | FAILED `reverted` once the block is final; a `reversal` whose proof names the hash and the block; Available back; the invoice OPEN again | the `signed` row (`failureInjection`), the `released` row with its proof |

Blackhole at `execute` instead: the payment is signed and never sent, goes to REVIEW from RESERVED
holding its nonce, every payout signed after it waits, and Fund partner wallet answers 422 until it
is resumed.

## Rules that apply to every run

- **One at a time.** The screen runs one card at a time. Every card but the race, and the three
  commands that pay, first check `GET /payments` and refuse while any payment is CREATED, RESERVED
  or SENT. REVIEW, SETTLED and FAILED do not block.
- **A flag catches whatever moves next.** A card arms its flag last, right before its own payment,
  and disarms it when the payment ends, in a `finally`. The crash and stuck commands do the same.
  While any flag is armed, a red banner shows on every admin screen.
- **The crash really kills the worker.** Every payment in flight at that moment loses one of its
  five attempts on the step it was running.
- **The race never reaches the chain.** Its sandbox is created by the api with `CREATE DATABASE`
  (its only write to the demo database) and reseeded on every run.
- **`pnpm experiment:crash` finds the worker as `stablecoin-payments-reference-worker-1`.** Under
  another compose project name Docker cannot be asked; the command says so and the rest of the
  evidence still holds.
- To stop the worker by hand while a payment waits, the drill is
  [`docs/dev/restart-survival.md`](dev/restart-survival.md).

## Disarming by hand

If a run is interrupted (the tab closed, the command killed), a flag can stay armed. Press
**Disarm** on its card, or read and switch them off from a terminal:

```sh
curl -s localhost:3000/settings/experiments

curl -s -X PUT localhost:3000/settings/experiments -H 'content-type: application/json' \
  -d '{"revertNextPayment": false, "crashAfterSigning": false, "blackholeRpc": {"enabled": false, "step": "watch"}}'
```

The PUT changes only the fields it is sent. A payment left in REVIEW by an interrupted run is
resumed from the REVIEW queue on Transfers, or with `POST /payments/:reference/resume`.
