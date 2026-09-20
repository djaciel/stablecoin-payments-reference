-- The audit log: what happened, to what, decided by whom. It is what a human reads while
-- deciding what to do about a payment in REVIEW, and what reconciliation reads to explain a
-- difference between the books and the chain.
--
-- No foreign key to ledger_transactions, on purpose: most of what belongs here is not a money
-- movement at all, and a column that is NULL nine times out of ten is not a relationship. The
-- visible cost is that `pnpm ledger:seed` has to truncate this table by name (CASCADE will not
-- reach it), or the log narrates releases whose transactions no longer exist.
--
-- No retention and no redaction: a production system would need a policy for what may go into
-- `context` at all.
--
-- Convention from 0001_init.sql: no BEGIN/COMMIT/ROLLBACK here — the `BEGIN` below opens a
-- plpgsql block, a different keyword that happens to be spelled the same.

CREATE TABLE audit_log (
  id           bigserial   PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  -- A small known set rather than free text, so a reader can filter by it (see audit.ts).
  actor        text        NOT NULL,
  -- What was acted on: 'payment' + 'PAY-4821', 'deposit' + its id.
  subject_type text        NOT NULL,
  subject_id   text        NOT NULL,
  -- Past tense, always: 'reserved', 'sent', 'settled', 'released'.
  event        text        NOT NULL,
  -- Everything a human would ask next. Never a private key, never a connection string.
  context      jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- The read path is always "everything that happened to this subject, in order".
CREATE INDEX audit_log_by_subject ON audit_log (subject_type, subject_id, id);

-- Append-only, for every writer including a psql session: a log you can edit after the fact
-- records whatever the last writer wanted to be true. Its own message rather than the ledger's,
-- because telling someone to post a correcting transaction is nonsense about a log entry.
CREATE FUNCTION audit_no_update_or_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'the audit log is append-only: % on % is not allowed. Record what happened next as a new event.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER audit_log_is_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_no_update_or_delete();
