-- Reconciliation runs: what the system found when it checked itself (article section 10).
--
-- These two tables are derived evidence, not the books, so they carry no append-only trigger and
-- no guard: everything here can be recomputed by running the check again. Nothing in the system
-- reads them back to decide anything. Reconciliation reports; it never posts a correcting entry.
--
-- Convention reminder from 0001_init.sql: no BEGIN/COMMIT/ROLLBACK here.

CREATE TABLE reconciliation_runs (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at    timestamptz NOT NULL,
  finished_at   timestamptz NOT NULL,
  -- The block the chain side was pinned to. Nullable because a database whose watcher has never
  -- scanned has no block to pin: the books know nothing about the chain yet, so there is nothing
  -- to compare them at.
  block_number  bigint,
  outcome       text        NOT NULL CHECK (outcome IN ('clean', 'mismatch', 'incomplete')),
  -- How many things were checked, how many of those carried an explained difference, and how many
  -- contradicted their own three versions. `checked` is the number of items.
  checked       int         NOT NULL,
  explained     int         NOT NULL,
  mismatched    int         NOT NULL,
  summary       text        NOT NULL
);

COMMENT ON TABLE reconciliation_runs IS
  'One row per reconciliation run, inserted once at the end with all its items in the same transaction: half a reconciliation is not evidence, and nothing ever updates a run row.';

CREATE TABLE reconciliation_items (
  id           bigserial   PRIMARY KEY,
  run_id       uuid        NOT NULL REFERENCES reconciliation_runs (id) ON DELETE CASCADE,
  -- `global` is the whole-treasury identity, which arrives with the screen that shows it.
  subject_type text        NOT NULL CHECK (subject_type IN ('payment', 'deposit', 'global')),
  -- A payment reference (PAY-4821), a deposit id, or 'global'.
  subject_id   text        NOT NULL,
  outcome      text        NOT NULL CHECK (outcome IN ('ok', 'explained', 'mismatch', 'unchecked')),
  -- The books minus the chain at the run's block, signed: positive when the books still hold money
  -- the chain has already moved, negative when the chain still shows money the books have released.
  -- NULL when this item contributes nothing to the difference, which is most of them.
  delta_minor  bigint,
  -- The sentence a human reads. Every non-null delta says in words which of the two it is.
  detail       text        NOT NULL,
  evidence     jsonb
);

CREATE INDEX reconciliation_items_by_run ON reconciliation_items (run_id, id);

COMMENT ON TABLE reconciliation_items IS
  'One row per thing checked in a run: every payment and every deposit, plus the global identity. What was asked for, what was recorded and what happened, in one sentence each.';
