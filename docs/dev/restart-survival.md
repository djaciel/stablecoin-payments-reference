# Restart survival: stopping the worker while a payment waits

A payment in flight must not depend on a process staying alive. The drill: a real payment, the
worker stopped while `watch` waits for its block to become final, the worker started again. What
you should see: **the payment finishes, and nothing that was already done runs again.**

## The drill

It sends real testnet USDC. You need the stack up. Press Pay on a small invoice on
`/admin/payables`: the payment's workflow starts by itself, and its reference is on the row. The
wait for finality is minutes long on Base Sepolia, enough to do this by hand:

```
# 1. press Pay on a small invoice on /admin/payables; its reference is PAY-XXXX
docker compose logs -f worker      # wait for "PAY-XXXX watch: not final"
docker compose stop worker         # then wait a minute
docker compose start worker
docker compose exec temporal temporal workflow show --address temporal:7233 -w PAY-XXXX
```

## What it looked like

PAY-6538, 0.25 USDC to Northwind. The worker log, trimmed to the step lines:

```
06:49:45.620  PAY-6538 sign: signed 0x0cba5688…0644 (nonce 5)
06:49:45.923  PAY-6538 execute: sent 0x0cba5688…0644
06:49:46.206  PAY-6538 watch: not final: in block 47145750, the final block is 47145595
                                         <- docker compose stop worker, 06:49:47
06:49:47.348  worker: SIGTERM received, draining in-flight steps
                                         <- docker compose start worker, 06:50:55
06:50:57.456  worker: polling task queue "payments" on temporal:7233 (namespace default)
06:50:58.164  PAY-6538 watch: not final: in block 47145750, the final block is 47145595
              ... nine more "not final" checks, ten seconds apart (a kill in between, see below)
06:53:02.442  PAY-6538 watch: paid: final (block 47145750, final 47145834) and the official Transfer is log 0
06:53:02.474  PAY-6538 settle: settled (ledger transaction 80305be8-…)
```

And the workflow's history (`temporal workflow show`, trimmed; the same history is at
`http://localhost:8080/namespaces/default/workflows/PAY-XXXX`):

```
  6  06:49:44.678  ActivityTaskStarted    sign     attempt 1
 12  06:49:45.636  ActivityTaskStarted    execute  attempt 1
 24  06:49:56.220  TimerFired                        <- no worker running
 28  06:50:57.661  WorkflowTaskStarted               <- the worker is back
 31  06:50:57.679  ActivityTaskStarted    watch    attempt 1
149  06:53:02.463  ActivityTaskStarted    settle   attempt 1
154  06:53:02.484  WorkflowExecutionCompleted
```

- **`sign` and `execute` ran once, attempt 1.** The worker that came back replayed the history and
  took their results from it. Nothing was signed or sent again: one transfer, nonce 5, and the
  treasury's next nonce is 6.
- **The timer fired while no worker was running.** It lives in Temporal, not in the worker; the
  next check waited on the task queue and ran as soon as a worker was polling.
- **Nothing settled on the event alone.** The Transfer was in the receipt from the first check;
  eleven checks said "not final" before one said "paid", three minutes after the send.

## Variations

Both were run in the same session as the drill.

- **`docker compose kill worker` instead of `stop`**, later in the same wait. SIGKILL: no
  "SIGTERM received", nothing drained, the container exits 137 and stays down (`RestartCount` 0).

  ```
  06:51:29.344  PAY-6538 watch: not final: in block 47145750, the final block is 47145595
                                         <- docker compose kill worker, 06:51:34
                                         <- docker compose start worker, 06:51:54
  06:51:57.661  worker: polling task queue "payments" on temporal:7233 (namespace default)
  06:52:00.091  PAY-6538 watch: not final: in block 47145750, the final block is 47145595
  ```

  The kill landed between two checks, so no step was running. One killed mid-run is retried as
  attempt 2 once its 30-second `startToCloseTimeout` passes (`workflows.ts`); every step re-reads
  the payment's row first, so running it again is harmless.
- **Start the workflow again for a payment that is already SENT.** PAY-8598 was sent by an
  earlier run that ended there. A new run of the same workflow is how a payment resumes:

  ```
  06:48:58.627  PAY-8598 sign: already signed 0x97a4d339…5751 (nonce 4)
  06:48:58.880  PAY-8598 execute: the network already knew 0x97a4d339…5751; nothing sent
  06:48:59.287  PAY-8598 watch: paid: final (block 47131497, final 47145595) and the official Transfer is log 56
  06:48:59.322  PAY-8598 settle: settled (ledger transaction 3869ec26-…)
  ```

  Once more after that, on the SETTLED payment: `execute` answers "nothing to send: SETTLED",
  `watch` answers from the audit row without asking the chain, `settle` answers "already settled".

## The worker restarts itself, except when you are the one who stopped it

The worker is the only service with `restart: unless-stopped`. It is there for the crash
experiment of §9, where a step kills its own process on purpose: the payment can only carry on if
something brings the worker back without a human in the loop.

The policy covers a process that ends by itself. Docker deliberately does not apply it to a
container you stopped or killed through Docker: both are recorded as "stopped by hand". So:

| What happened | Comes back on its own? |
|---|---|
| The worker process exits (crash, `process.exit(1)`, an unhandled error) | yes, within seconds (below: `RestartCount` 0 → 1) |
| `docker compose kill worker` | no, start it yourself (it exits 137, `RestartCount` stays 0; see Variations) |
| `docker compose stop worker` | no, start it yourself (it exits 0 after draining, as in the drill) |

The first row, measured with the process ended from inside the container
(`docker compose exec worker sh -c 'kill -TERM 1'`), which is what a process that dies of its own
accord looks like from Docker's side:

```
06:53:51.166  worker: SIGTERM received, draining in-flight steps
06:53:51.179  worker: shut down
                                         <- Docker restarted the container at 06:53:51.488
06:53:52.993  worker: polling task queue "payments" on temporal:7233 (namespace default)
```

About two seconds, with nobody typing anything, and `docker inspect` counts it: `RestartCount`
went from 0 to 1. That is the first restart only: Docker applies an exponential backoff to
consecutive restarts, so in a crash loop the delay keeps doubling, which is why the crash
experiment's evidence reads `RestartCount` and the container's timestamps instead of assuming a
fixed delay. (`kill -9 1` from inside does nothing at all: the kernel ignores it for PID 1.)

The cost of a restart policy is that a worker which cannot start at all looks like a container
that keeps coming back rather than one that stays down. That is why the startup failure says so:

```
worker: could not start — the container will be restarted, so expect this to repeat
```

If you see that line scrolling past every few seconds, the worker is in a crash loop and the error
after it is the real one.
