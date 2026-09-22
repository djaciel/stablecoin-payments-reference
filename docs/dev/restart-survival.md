# Restart survival: killing the worker mid-step

> **Out of date.** The drill below was run on placeholder steps and `pnpm demo:workflow`, both
> gone now that `sign` and `execute` are real. It is rewritten on a real payment's wait for
> finality when that step lands; the restart facts in it (what Docker restarts, and why) still hold.

The claim this repo has to back is that a payment in flight does not depend on a process
staying alive. This is the drill that proves it, before there is any payment logic to get
in the way: the payment workflow with all four of its steps stubbed out, a worker killed
while `execute` is running, and the same workflow finishing on a worker that was not there
when it started.

What you should see: **the step that was interrupted runs again, the steps that had
already finished do not.**

The workflow is `PaymentWorkflow` and its steps are the real ones — `sign`, `execute`,
`watch`, `settle`. Only their bodies are placeholders: today each one sleeps ten seconds
and reports its attempt number, so a whole run takes about forty. Phase 5 fills them in;
the drill below does not change.

## Before you start

- `docker compose up -d` — postgres, temporal, temporal-ui, api and worker.
- Node 22 on your machine for `pnpm demo:workflow`. Not Node 24: `pnpm install` crashes
  there while unpacking Temporal's native module. The containers are unaffected, they run
  Node 22 themselves.

Check the worker is polling:

```
docker compose logs worker | grep polling
```

```
worker: polling task queue "payments" on temporal:7233 (namespace default)
```

## The drill

**1. Start the workflow** (terminal A):

```
pnpm demo:workflow
```

```
demo: started PAY-8386 on task queue "payments", waiting for the result...
demo: follow it at http://localhost:8080/namespaces/default/workflows/PAY-8386
```

**2. Watch it from two places.** The worker log in terminal B:

```
docker compose logs -f worker
```

and the Temporal UI at the link the script printed. The UI is the same history the worker
replays from, drawn as a timeline: every step, every attempt, and the moment Temporal gave
up on a worker that had stopped answering. It is also where the payment progress view will
link to from Phase 5 onwards.

**3. Kill the worker while `execute` is running** — roughly fifteen seconds in, once you
have seen `execute: start (attempt 1)`:

```
docker compose kill worker
```

`kill` sends SIGKILL. Nothing is drained, nothing is handed back: the process is simply
gone in the middle of a step, which is the situation worth testing.

**4. Bring it back:**

```
docker compose start worker
```

**5. Terminal A never noticed.** It is waiting on Temporal, not on the worker:

```
demo: PAY-8386 finished
  sign (attempt 1)
  execute (attempt 2)
  watch (attempt 1)
  settle (attempt 1)
```

## The evidence

Worker log across the kill (real run, timestamps as logged):

```
20:18:58  PAY-8386 sign: start (attempt 1)
20:19:08  PAY-8386 sign: done (attempt 1)
20:19:08  PAY-8386 execute: start (attempt 1)
                                        <- docker compose kill  worker, 20:19:09
                                        <- docker compose start worker, 20:19:11
20:19:14  worker: polling task queue "payments" on temporal:7233 (namespace default)
20:19:15  PAY-8386 execute: start (attempt 2)   <- only the interrupted step comes back
20:19:25  PAY-8386 execute: done (attempt 2)
20:19:25  PAY-8386 watch: start (attempt 1)
20:19:35  PAY-8386 watch: done (attempt 1)
20:19:35  PAY-8386 settle: start (attempt 1)
20:19:45  PAY-8386 settle: done (attempt 1)
20:19:45  PAY-8386: sign (attempt 1) → execute (attempt 2) → watch (attempt 1) → settle (attempt 1)
```

Two things to read out of it:

- **`sign` never appears again after the restart.** Its result is in the workflow's
  history in Postgres. The new worker replays that history to rebuild the workflow's
  state, and a step whose result is already recorded is not executed a second time.
- **`execute` comes back as attempt 2, four seconds after the worker returns.** The step
  heartbeats every second against a five-second `heartbeatTimeout`, so Temporal declares
  the attempt dead shortly after the beats stop and reschedules it. Without heartbeats you
  would wait for `startToCloseTimeout` — a minute here — before seeing anything happen.

Also worth noticing: the retry is at the level of the *step*, not the workflow. Work
inside a step is not checkpointed, so a step that dies halfway runs again from its
beginning. That is exactly why `execute` stores the transaction hash **before**
broadcasting and, on retry, re-sends the same signed transaction rather than signing a
new one with a new nonce. The mechanism you are looking at here is what makes that rule
necessary.

## The worker restarts itself — except when you are the one who killed it

The worker is the only service with `restart: unless-stopped`. It is there for the crash
experiment of §9, where the `sign` step stores the hash and then kills its own process on
purpose: the payment can only carry on if something brings the worker back without a human
in the loop.

The policy covers a process that ends by itself, and Docker deliberately does not apply it
to a container you stopped or killed through Docker — both are recorded as "stopped by
hand". So:

| What happened | Comes back on its own? |
|---|---|
| The worker process exits (crash, `process.exit(1)`, an unhandled error) | yes, in about a second |
| `docker compose kill worker` | no — start it yourself |
| `docker compose stop worker` | no — start it yourself |

The first row, measured. The process was ended from inside the container
(`docker compose exec worker sh -c 'kill -TERM 1'`), which is what any process that dies
of its own accord looks like from Docker's side:

```
20:26:47.100  PAY-6977 execute: start (attempt 1)
20:26:47.391  worker: SIGTERM received, draining in-flight steps
20:26:47.411  worker: shut down
                                       <- Docker restarted the container at 20:26:47.709
20:26:48.815  worker: polling task queue "payments" on temporal:7233 (namespace default)
20:26:48.828  PAY-6977 execute: start (attempt 2)
```

About one and a half seconds from the process ending to the step running again, with
nobody typing anything. `docker inspect` counts it: `RestartCount: 1`. That second is the
first restart only: Docker applies an exponential backoff to consecutive restarts, so in a
crash loop the delay keeps doubling, which is why Phase 7's evidence reads `RestartCount`
and the container's timestamps instead of assuming a fixed delay.

The cost of a restart policy is that a worker which cannot start at all looks like a
container that keeps coming back rather than one that stays down. That is why the startup
failure says so in the log:

```
worker: could not start — the container will be restarted, so expect this to repeat
```

If you see that line scrolling past every few seconds, the worker is in a crash loop and
the error after it is the real one.

## Variations

All four were run while writing this page.

- **Kill it twice, both times during the same step.** It comes back as attempt 3 and the
  workflow still finishes (`PAY-7319`: `sign (attempt 1) → execute (attempt 3) → watch
  (attempt 1) → settle (attempt 1)`). Keep going and it keeps retrying: this workflow uses
  the SDK's default retry policy, where `maximumAttempts` is unlimited. Fine for a step
  that only sleeps, wrong for a step that moves money — Phase 5 sets an explicit limit and
  escalates to REVIEW instead of retrying forever.
- **Leave it dead for four minutes.** Nothing expires. The workflow sat in `execute` from
  20:20:12 to 20:24:32, picked up attempt 2 the moment a worker came back, and finished.
- **`docker compose restart temporal` mid-run.** The workflow survives that too, with
  every step still on attempt 1 (`PAY-1268`, restarted while `execute` was running): its
  state is in Postgres, not in Temporal's memory.
- **`docker compose stop worker` instead of `kill`.** The step still comes back as attempt
  2, but for a completely different reason, and the logs show it:

  ```
  20:28:01.730  PAY-1584 execute: start (attempt 1)
  20:28:01.983  worker: SIGTERM received, draining in-flight steps
  20:28:01.983  Worker state changed { state: 'STOPPING' }
  20:28:01.984  Worker state changed { state: 'DRAINING' }
  20:28:02.001  Worker state changed { state: 'DRAINED' }
  20:28:02.001  Worker state changed { state: 'STOPPED' }
  20:28:02.008  worker: shut down
  20:28:07.910  PAY-1584 execute: start (attempt 2)
  ```

  SIGTERM reaches the worker, it tells Temporal it is going away, and Temporal reschedules
  the work immediately instead of waiting out the heartbeat timeout. The whole stop takes
  **0.25 s and exits 0** — a container whose PID 1 ignores SIGTERM instead takes Docker's
  full ten-second grace period and then dies with 137.

  What draining does *not* do is let the running step finish: it cancels in-flight steps
  so another worker can pick them up at once. Temporal's `sleep` is cancellation-aware, so
  the step ends there and is retried — orderly, not graceful.

  Letting a step run to completion before shutdown is a deliberate choice
  (`shutdownGraceTime` plus a step that ignores cancellation), and it belongs with the real
  steps in Phase 5, where "finish broadcasting before you die" actually means something.
