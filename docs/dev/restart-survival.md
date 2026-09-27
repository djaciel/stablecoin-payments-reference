# Restart survival: stopping the worker while a payment waits

Stop the worker while `watch` waits for a final block, then start it again. Expected: **the payment finishes, and nothing already done runs again.**

## The drill

It sends real testnet USDC, with the stack up. The wait for a final block takes minutes, so there is time to do it by hand.

```
# 1. press Pay on a small invoice in Invoices to pay; note its reference, PAY-XXXX
docker compose logs -f worker      # wait for "PAY-XXXX watch: not final"
docker compose stop worker         # then wait a minute
docker compose start worker
docker compose exec temporal temporal workflow show --address temporal:7233 -w PAY-XXXX
```

The same history is at `http://localhost:8080/namespaces/default/workflows/PAY-XXXX`.

## What it looked like

PAY-6538, 0.25 USDC. The worker log, trimmed:

```
06:49:45.620  PAY-6538 sign: signed 0x0cba5688…0644 (nonce 5)
06:49:45.923  PAY-6538 execute: sent 0x0cba5688…0644
06:49:46.206  PAY-6538 watch: not final: in block 47145750, the final block is 47145595
                                         <- docker compose stop worker
06:49:47.348  worker: SIGTERM received, draining in-flight steps
                                         <- docker compose start worker
06:50:58.164  PAY-6538 watch: not final: in block 47145750, the final block is 47145595
06:53:02.442  PAY-6538 watch: paid: final (block 47145750, final 47145834) and the official Transfer is log 0
06:53:02.474  PAY-6538 settle: settled (ledger transaction 80305be8-…)
```

The workflow history, trimmed:

```
  6  06:49:44.678  ActivityTaskStarted    sign     attempt 1
 12  06:49:45.636  ActivityTaskStarted    execute  attempt 1
 24  06:49:56.220  TimerFired                        <- no worker running
 31  06:50:57.679  ActivityTaskStarted    watch    attempt 1
149  06:53:02.463  ActivityTaskStarted    settle   attempt 1
154  06:53:02.484  WorkflowExecutionCompleted
```

- `sign` and `execute` ran once (attempt 1). One transfer, nonce 5; the next nonce is 6.
- The timer fired with no worker running: it lives in Temporal. The next check ran as soon as a worker was back.
- Nothing settled on the event alone: eleven "not final" checks came before "paid".

## Variations

- **`docker compose kill worker`** instead of `stop`: no SIGTERM, nothing drained, exit code 137, it stays down. A step killed mid-run is retried as attempt 2 after its 30 s `startToCloseTimeout`; every step reads the payment's row first, so a second run is harmless.
- **A new workflow for a payment already SENT** (PAY-8598): `sign` says "already signed", `execute` says "the network already knew … nothing sent", then `watch` and `settle` finish it.
- **The same again on a SETTLED payment**: `execute` says "nothing to send: SETTLED", `watch` answers from the audit row, `settle` says "already settled".

## The worker restarts itself, except when you are the one who stopped it

The worker is the only service with `restart: unless-stopped`.

| What happened | Comes back on its own? |
|---|---|
| The process exits (crash, `process.exit(1)`, an unhandled error) | yes, in about 2 s; `RestartCount` 0 → 1 |
| `docker compose kill worker` | no, start it yourself (exit 137, `RestartCount` stays 0) |
| `docker compose stop worker` | no, start it yourself (exit 0 after draining) |

- To see the first row: `docker compose exec worker sh -c 'kill -TERM 1'`. (`kill -9 1` from inside does nothing: PID 1 ignores it.)
- Docker waits longer after each restart in a row, so do not count on a fixed delay.
- A worker that cannot start at all logs a line starting with `worker: could not start` every few seconds. The error after it is the real one.

## The crash experiment: the same thing, without you

**Crash after signing** on Break it, or:

```
pnpm experiment:crash                # writes its own 0.01 USDC invoice, pays it, follows it
docker compose logs -f worker        # the crash, then "worker: started at …" seconds later
```

- `sign` stores the hash, the signed bytes and the nonce, commits, and calls `process.exit(1)`. Nothing was sent.
- Docker restarts the worker. About 30 s later `sign` runs again as attempt 2 and finds the hash.
- `execute` asks the network, does not find the transfer, and sends the same bytes: one transfer, one `sent` row at attempt 1 with `networkAlreadyKnew: false`.
- The flag is switched off in the same transaction that stores the hash, so the restarted worker does not crash again.
- Every other payment in flight loses one of its five attempts.
- The command prints `RestartCount` before and after, as proof the process really ended.
