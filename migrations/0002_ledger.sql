-- The double-entry ledger: the rulebook of the money, in one file.
--
-- Three tables, the chart of accounts, and four guards. The guards are the point. Each one
-- turns a promise the article makes into a property of the database, so a hand-typed INSERT
-- in psql is held to exactly the same rules as the posting engine in packages/ledger:
--
--   Guard 1  entries are append-only              -> invariant 2
--   Guard 2  a transaction sums to zero, deferred -> invariant 1
--   Guard 3  the maintained balance + its CHECK   -> invariant 3
--   Guard 4  a release needs a reversal or cancel -> invariant 5
--
-- (Invariant 4, the guarded state transition, belongs to the payments table and arrives with
-- the phase that creates it.)
--
-- Money is bigint minor units everywhere. USDC has 6 decimals, so 1,000 USDC is 1000000000.
-- No floating point ever touches an amount in this repository.
--
-- Convention reminder from 0001_init.sql: no BEGIN/COMMIT/ROLLBACK here. The `BEGIN` below
-- open plpgsql blocks, which is a different keyword that happens to be spelled the same.


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
  -- Per row, not a rule naming treasury:available: which accounts may not go below zero is
  -- data in the chart of accounts, not a condition repeated in SQL.
  allows_negative boolean     NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),

  -- Guard 3, the half that does the refusing. A violator sees:
  --   new row for relation "ledger_accounts" violates check constraint
  --   "ledger_accounts_balance_never_negative"
  CONSTRAINT ledger_accounts_balance_never_negative
    CHECK (allows_negative OR balance_minor >= 0)
);

COMMENT ON TABLE ledger_accounts IS 'Chart of accounts. balance_minor is maintained by trigger, never written by hand.';

CREATE TABLE ledger_transactions (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Every movement this system knows how to make. One list, in one place: a posting
  -- function for a kind arrives with the phase that needs it, but the vocabulary is here.
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
  -- `tx:<hash>` for something seen onchain. Plain text; whether it becomes a foreign key to
  -- `payments` is the payments phase's call.
  reference  text,
  currency   text        NOT NULL,
  -- Evidence that a transfer can no longer land: { txHash, blockNumber, reason }. Stored
  -- next to the entries it justifies, so a release in the books can always be traced back
  -- to the transaction that reverted onchain.
  proof      jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),

  -- Guard 4, first half. No proof means no reversal: the payment goes to REVIEW with the
  -- money still held, which is the article's §6. Enforced here and not only in code,
  -- because the engine underneath the code is public.
  CONSTRAINT ledger_reversal_needs_proof
    CHECK (kind <> 'reversal' OR proof IS NOT NULL)
);

-- The same payment cannot be reserved twice, which is what the double-click experiment
-- asserts at the ledger level. Partial, because fixtures and seeds carry no reference.
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
  -- The ledger is USDC-only (spec assumption 2). If a second currency ever arrives, the
  -- check that an entry is denominated in its account's currency goes here, as a
  -- BEFORE INSERT trigger: until then it would guard a case that cannot happen.
  currency       text        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_by_account ON ledger_entries (account_code, id);


-- ---------------------------------------------------------------------------------------
-- Guard 1 — append-only (invariant 2)
--
-- A posted entry is history. A mistake is corrected by posting more entries, never by
-- editing what was already written, because a ledger whose past can be rewritten is not
-- evidence of anything. REVOKE would not be enough: the application connects as the owner
-- of these tables, so a permission cannot stop it and a trigger can.
--
-- A violator sees: ledger rows are append-only: UPDATE on ledger_entries is not allowed.
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
-- Debits count positive and credits negative, so "the books balance" is literally a sum
-- that has to be zero.
--
-- DEFERRABLE INITIALLY DEFERRED, and that is the whole design: a transaction's entries are
-- inserted one row at a time and are legitimately unbalanced in between, so the question
-- can only be asked at COMMIT. It also means the rejection arrives from COMMIT, not from
-- the INSERT that caused it.
--
-- A violator sees: ledger transaction <uuid> is off by 1000000000 in USDC; debits and
-- credits must cancel out.
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
-- The delta lands on the account's normal side: a debit adds to a debit-normal account and
-- subtracts from a credit-normal one. Keeping the balance in a trigger rather than in the
-- engine is what makes the CHECK on ledger_accounts mean something — it fires for every
-- writer, including one that never heard of packages/ledger.
--
-- Note it fires per row, in order. An account that ends a posting whole can still be
-- overdrawn halfway through it, and the CHECK fires there. The engine replays entries the
-- same way for the same reason.
--
-- Serializing concurrent writers is the engine's job (SELECT ... FOR UPDATE). This is the
-- last line of defence, not the first.
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
-- The CHECK above makes a *reversal* impossible without proof, but on its own it guards a
-- label, not a movement of money. Any other kind could write the reversal's entry pair
-- (debit treasury:available, credit treasury:reserved) and release a hold with no evidence
-- at all; a settle doing that would look perfectly legal to the schema. That door was open
-- in version 1 of this repo until a review found it.
--
-- So the rule is about what the money did. Any transaction taking money out of
-- treasury:reserved and putting it back into treasury:available IS a release, and there are
-- exactly two of those:
--
--   reversal — the broadcast transaction reverted onchain, and the proof says which one.
--   cancel   — a scheduled payment cancelled before anything was signed. No signed bytes
--              exist, so no node can ever include them: that absence IS the proof.
--
-- Deferred, like the zero-sum check, because a transaction's entries arrive one row at a
-- time and only the finished set says what the transaction did.
--
-- A violator sees: ledger transaction <uuid> releases a hold ... but is recorded as settle.
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
-- The chart of accounts
--
-- The first five are the accounts a reader of the article will recognise; the last four are
-- their counterparts, which exist because double-entry has no one-sided movements. Balances
-- start at zero: money arrives through postings, never through a migration.
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
