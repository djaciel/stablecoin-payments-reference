# Experiments

The five Break it cards and the four `pnpm experiment:*` commands.

## The five experiments

| Card | Command | Flag it arms | Costs | Takes |
|---|---|---|---|---|
| Double click | `pnpm experiment:double-click` | none | 0.01 USDC + gas | a few minutes |
| The race | `pnpm experiment:race` | none | nothing (runs in the `payments_experiment` sandbox) | seconds |
| Crash after signing | `pnpm experiment:crash` | `experiment.crash_after_signing`, one-shot | 0.01 USDC + gas | a few minutes |
| Node not responding | `pnpm experiment:stuck` | `experiment.blackhole_rpc`, at `watch` | 0.01 USDC + gas | about 5 minutes |
| Revert a payment | none | `experiment.revert_next_payment`, one-shot | gas only | a few minutes |

- Commands (`scripts/experiments/`) need Node 22 and `pnpm install`, and call `API_URL` (default `http://localhost:3000`).
- Flags live in `settings` as `{ enabled, payableId? }` (the blackhole adds `step`). Only the worker reads them.

## What each one must show

| Experiment | What it does | Must show |
|---|---|---|
| Double click | two `POST /payments`, same key, same moment | one payment, one `reserve`, answers 201 and 200 with one reference |
| The race | sandbox with Available 1,500; two payments of 1,000, different keys, at once | one RESERVED (201), one FAILED `insufficient_funds` (422), Available 1,500 → 500 |
| Crash after signing | the worker dies right after storing the hash; after the restart `sign` (attempt 2) finds it and `execute` sends the same bytes | one transfer, the stored hash landed, one `sent` row with `networkAlreadyKnew: false`, restart count +1 (command only) |
| Node not responding | `watch` gets no answer until REVIEW; then it disarms and resumes | REVIEW with Reserved unchanged and an `escalated` row, then SETTLED with one `sent` row |
| Revert a payment | signed with a gas limit of 30,000, so it reverts on chain | FAILED `reverted`, a `reversal` with proof, Available back, invoice OPEN |

The blackhole at `execute` is api only (`"step": "execute"`): the payment is signed, never sent, and sits in REVIEW holding its nonce. Later payouts wait and Fund partner wallet answers 422 until it is resumed.

## Rules that apply to every run

- **All five cards can run at once.** Each writes its own invoice, arms its flag for it (`payableId`), pays, and disarms at the end.
- **A card or command will not start while its own flag is armed.**
- **A card's Arm switch sets no invoice:** a one-shot flag hits the next payment signed, the blackhole every payment in flight.
- **A red banner shows on admin screens while any flag is armed.**
- **`pnpm experiment:double-click` refuses to start** while any payment is CREATED, RESERVED or SENT.
- **The crash kills the real worker:** other payments in flight lose one of their five attempts.
- **The race never reaches the chain.** Its sandbox database is created once and reseeded on every run.
- **`pnpm experiment:crash` reads the restart count of `stablecoin-payments-reference-worker-1`.** Under another compose project name it says it cannot.
- Stopping the worker by hand: [restart-survival.md](dev/restart-survival.md).

## Disarming by hand

An interrupted run can leave a flag armed. Press **Disarm** on its card, or:

```sh
curl -s localhost:3000/settings/experiments
curl -s -X PUT localhost:3000/settings/experiments -H 'content-type: application/json' -d '{"revertNextPayment": {"enabled": false}, "crashAfterSigning": {"enabled": false}, "blackholeRpc": {"enabled": false, "step": "watch"}}'
```

A payment left in REVIEW is resumed from Transfers, or with `POST /payments/:reference/resume`.
