-- The double-entry ledger: three tables, the chart of accounts, and four guards. The guards
-- are enforced by the database, so a hand-typed INSERT in psql is held to exactly the same
-- rules as the posting engine in packages/ledger.
--
-- Money is bigint minor units everywhere (USDC has 6 decimals, so 1,000 USDC is 1000000000);
-- no floating point ever touches an amount. Convention from 0001_init.sql: no
-- BEGIN/COMMIT/ROLLBACK here — the `BEGIN` below opens plpgsql blocks, a different keyword
-- that happens to be spelled the same.


-- ---------------------------------------------------------------------------------------
-- The tables
-- ---------------------------------------------------------------------------------------

CREATE TABLE ledger_accounts (
  code            text PRIMARY KEY,
  kind            text        NOT NULL CHECK (kind IN ('asset', 'liability', 'equity', 'expense', 'revenue')),
  normal_side     text        NOT NULL CHECK (normal_side IN ('debit', 'credit')),
  currency        text        NOT NULL,
  -- Held on the account's normal side, which is why partner:payable, a liability, reads
  -- 1000000000 rather than -1000000000 when the company owes a thousand.
  balance_minor   bigint      NOT NULL DEFAULT 0,
  -- Which accounts may not go below zero is data in the chart of accounts, not a condition
  -- repeated in SQL.
  allows_negative boolean     NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Guard 3 (invariant 3), the half that does the refusing.
  CONSTRAINT ledger_accounts_balance_never_negative
    CHECK (allows_negative OR balance_minor >= 0)
);

COMMENT ON TABLE ledger_accounts IS 'Chart of accounts. balance_minor is maintained by trigger, never written by hand.';

CREATE TABLE ledger_transactions (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Every movement this system knows how to make. One list, in one place.
  kind       text        NOT NULL CHECK (kind IN (
                           'seed',        -- test and demo fixtures
                           'funding',     -- USDC arriving at the treasury, seen onchain
                           'payable',     -- the company owes a partner
                           'receivable',  -- a partner owes the company
                           'reserve',     -- CREATED -> RESERVED, money set aside
                           'settle',      -- SENT -> SETTLED, the debt is paid
                           'reversal',    -- SENT -> FAILED, the transfer reverted onchain
                           'cancel',      -- RESERVED -> FAILED, nothing was ever signed
                           'deposit',     -- a partner's payment arrived at a deposit address
                           'scaffolding'  -- demo plumbing, never a real payment
                         )),
  -- What this movement belongs to: a payment reference (PAY-4821), an invoice id, or
  -- `tx:<hash>` for something seen onchain.
  reference  text,
  currency   text        NOT NULL,
  -- Evidence that a transfer can no longer land: { txHash, blockNumber, reason }. Stored next
  -- to the entries it justifies, so a release can be traced back to what reverted onchain.
  proof      jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Guard 4 (invariant 5), first half. No proof means no reversal: the payment goes to REVIEW
  -- with the money still held.
  CONSTRAINT ledger_reversal_needs_proof
    CHECK (kind <> 'reversal' OR proof IS NOT NULL)
);

-- The same payment cannot be reserved twice. Partial, because fixtures and seeds carry no
-- reference.
CREATE UNIQUE INDEX ledger_transactions_one_kind_per_reference
  ON ledger_transactions (kind, reference)
  WHERE reference IS NOT NULL;

CREATE TABLE ledger_entries (
  id             bigserial   PRIMARY KEY,
  transaction_id uuid        NOT NULL REFERENCES ledger_transactions (id),
  account_code   text        NOT NULL REFERENCES ledger_accounts (code),
  direction      text        NOT NULL CHECK (direction IN ('debit', 'credit')),
  -- Always positive: which way the money moves is the direction column's job.
  amount_minor   bigint      NOT NULL CHECK (amount_minor > 0),
  -- The ledger is USDC-only (spec assumption 2), so nothing checks an entry against its
  -- account's currency yet.
  currency       text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_by_account ON ledger_entries (account_code, id);


-- ---------------------------------------------------------------------------------------
-- Guard 1 — append-only (invariant 2)
--
-- A mistake is corrected by posting more entries, never by editing what was written. REVOKE
-- would not be enough: the application connects as the owner of these tables, so a permission
-- cannot stop it and a trigger can.
-- ---------------------------------------------------------------------------------------

CREATE FUNCTION ledger_no_update_or_delete() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'ledger rows are append-only: % on % is not allowed. Post a correcting transaction instead.',
    TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER ledger_entries_are_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_no_update_or_delete();

CREATE TRIGGER ledger_transactions_are_append_only
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_no_update_or_delete();


-- ---------------------------------------------------------------------------------------
-- Guard 2 — zero sum per transaction, per currency (invariant 1)
--
-- Debits count positive and credits negative, so "the books balance" is a sum that has to be
-- zero. DEFERRABLE INITIALLY DEFERRED is the whole design: a transaction's entries are
-- inserted one row at a time and are legitimately unbalanced in between, so the question can
-- only be asked at COMMIT — which is also where the rejection arrives from.
-- ---------------------------------------------------------------------------------------

CREATE FUNCTION ledger_assert_zero_sum() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  imbalance bigint;
BEGIN
  SELECT coalesce(sum(CASE WHEN direction = 'debit' THEN amount_minor ELSE -amount_minor END), 0)
    INTO imbalance
    FROM ledger_entries
   WHERE transaction_id = NEW.transaction_id
     AND currency = NEW.currency;

  IF imbalance <> 0 THEN
    RAISE EXCEPTION
      'ledger transaction % is off by % in %; debits and credits must cancel out',
      NEW.transaction_id, imbalance, NEW.currency
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_sum_to_zero
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_zero_sum();


-- ---------------------------------------------------------------------------------------
-- Guard 3 — the maintained balance (invariant 3)
--
-- The delta lands on the account's normal side. Keeping the balance in a trigger rather than
-- in the engine is what makes the CHECK on ledger_accounts mean something — it fires for every
-- writer, including one that never heard of packages/ledger.
--
-- It fires per row, in order: an account that ends a posting whole can still be overdrawn
-- halfway through it, and the CHECK fires there. The engine replays entries the same way.
-- ---------------------------------------------------------------------------------------

CREATE FUNCTION ledger_apply_entry_to_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  side  text;
  delta bigint;
BEGIN
  SELECT normal_side INTO side FROM ledger_accounts WHERE code = NEW.account_code;

  IF side = NEW.direction THEN
    delta := NEW.amount_minor;
  ELSE
    delta := -NEW.amount_minor;
  END IF;

  UPDATE ledger_accounts
     SET balance_minor = balance_minor + delta
   WHERE code = NEW.account_code;

  RETURN NULL;
END;
$$;

CREATE TRIGGER ledger_entries_maintain_balance
  AFTER INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION ledger_apply_entry_to_balance();


-- ---------------------------------------------------------------------------------------
-- Guard 4 — reserved money is released only with proof (invariant 5)
--
-- The CHECK above guards the `reversal` label, not the movement: any other kind could write
-- the same entry pair and release a hold with no evidence. So this rule is about what the
-- money did. Any transaction taking money out of treasury:reserved and back into
-- treasury:available IS a release, and only two kinds may do it — `reversal`, whose proof says
-- which transaction reverted, and `cancel`, where no signed bytes exist so no node can ever
-- include them and that absence IS the proof.
--
-- Deferred, like the zero-sum check: only the finished set of entries says what a transaction
-- did.
-- ---------------------------------------------------------------------------------------

CREATE FUNCTION ledger_assert_release_is_allowed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  releases_hold    boolean;
  transaction_kind text;
BEGIN
  SELECT
    bool_or(e.account_code = 'treasury:available' AND e.direction = 'debit')
      AND bool_or(e.account_code = 'treasury:reserved' AND e.direction = 'credit')
    INTO releases_hold
    FROM ledger_entries e
   WHERE e.transaction_id = NEW.transaction_id;

  IF NOT releases_hold THEN
    RETURN NULL;
  END IF;

  SELECT kind INTO transaction_kind FROM ledger_transactions WHERE id = NEW.transaction_id;

  IF transaction_kind NOT IN ('reversal', 'cancel') THEN
    RAISE EXCEPTION
      'ledger transaction % releases a hold (treasury:reserved back to treasury:available) but is recorded as %; only a reversal (with proof) or a cancel may do that',
      NEW.transaction_id, transaction_kind
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_release_is_allowed
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_release_is_allowed();


-- ---------------------------------------------------------------------------------------
-- The chart of accounts. Balances start at zero: money arrives through postings, never
-- through a migration.
-- ---------------------------------------------------------------------------------------

INSERT INTO ledger_accounts (code, kind, normal_side, currency, allows_negative) VALUES
  ('treasury:available',   'asset',     'debit',  'USDC', false), -- "Available"
  ('treasury:reserved',    'asset',     'debit',  'USDC', false), -- "Reserved"
  ('partner:payable',      'liability', 'credit', 'USDC', true),  -- "Partner debt"
  ('partner:receivable',   'asset',     'debit',  'USDC', true),  -- what partners owe us
  ('deposits:onchain',     'asset',     'debit',  'USDC', false), -- money sitting on deposit addresses
  ('equity:opening',       'equity',    'credit', 'USDC', true),  -- counterpart of funding
  ('expense:services',     'expense',   'debit',  'USDC', true),  -- counterpart of a payable
  ('revenue:services',     'revenue',   'credit', 'USDC', true),  -- counterpart of a receivable
  ('demo:partner-funding', 'expense',   'debit',  'USDC', true);  -- demo scaffolding, labelled everywhere it shows
