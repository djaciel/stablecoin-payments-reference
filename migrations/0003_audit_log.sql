-- The audit log: what happened, to what, decided by whom.
--
-- Two things make it worth having. The state catalog says a payment that ends in REVIEW does
-- so "with full context in the audit log", and that context is what a human reads while
-- deciding what to do about real money. Reconciliation reads it too, to explain a difference
-- between the books and the chain.
--
-- It is append-only, and that is the whole idea: a log you can edit after the fact records
-- whatever the last writer wanted to be true, which is not evidence of anything. The trigger
-- below is what turns "we do not edit the log" from a habit into a property of the database,
-- for every writer, including a psql session that never heard of this repository.
--
-- No foreign key to ledger_transactions, on purpose. Most of what belongs here is not a
-- money movement at all — a payment escalated to REVIEW, a deposit whose event did not match
-- at finality, an RPC that stopped answering — and a column that is NULL for nine events out
-- of ten is not a relationship. The visible cost: `pnpm ledger:seed` truncates the ledger, so
-- it has to truncate this table by name too (CASCADE will not reach it), or the log narrates
-- releases whose transactions no longer exist.
--
-- Note on retention and redaction: neither exists here. This is a demo whose subjects are
-- testnet addresses and payment references. A production system would need a policy, and it
-- would start by deciding what may go into `context` at all.
--
-- Convention reminder from 0001_init.sql: no BEGIN/COMMIT/ROLLBACK here. The `BEGIN` below
-- opens a plpgsql block, which is a different keyword that happens to be spelled the same.

CREATE TABLE audit_log (
  id           bigserial   PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  -- Which part of the system acted. A small known set rather than free text, so a reader can
  -- filter by it: api, worker, watcher, admin, seed (packages/ledger/src/audit.ts).
  actor        text        NOT NULL,
  -- What was acted on: 'payment' + 'PAY-4821', 'deposit' + its id, 'ledger' + a reference.
  subject_type text        NOT NULL,
  subject_id   text        NOT NULL,
  -- What happened, in the past tense: 'reserved', 'sent', 'settled', 'released'.
  event        text        NOT NULL,
  -- Everything a human would ask next: amounts, hashes, block numbers, the error that caused
  -- an escalation. Never a private key, never a connection string.
  context      jsonb       NOT NULL DEFAULT '{}'::jsonb
);

-- The read path is always "everything that happened to this subject, in order".
CREATE INDEX audit_log_by_subject ON audit_log (subject_type, subject_id, id);

-- Its own function and its own message, rather than reusing the ledger's: telling someone to
-- post a correcting transaction is good advice about money and nonsense about a log entry.
--
-- A violator sees: the audit log is append-only: UPDATE on audit_log is not allowed.
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
