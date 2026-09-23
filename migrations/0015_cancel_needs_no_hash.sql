-- The release rule's second half, in the database (invariant 5, article section 6).
--
-- `0002_ledger.sql` already refuses to move money out of treasury:reserved and back into
-- treasury:available under any kind but `reversal` and `cancel`. This adds the condition that
-- makes `cancel` honest: nothing was ever signed. A payment with a stored hash has bytes that
-- any node can still include, so its money can only be released by what the chain says.
--
-- It refuses a `cancel` when a payment with that reference EXISTS AND CARRIES A HASH. It cannot
-- demand that a payment exist: `pnpm ledger:seed --release=cancel` and `tests/db/release.db.test.ts`
-- post the article's cancel for PAY-4821 with no row in `payments` at all, and those are
-- ledger-level fixtures this rule has no business breaking.
--
-- Belt and braces: the primary guard is `cancelPayment` reading `tx_hash` under the payment's
-- own row lock, the lock `signPayment` holds across the signer call. This one catches the
-- movement whoever writes it, including straight through the engine.
--
-- Convention from 0001_init.sql: no BEGIN/COMMIT/ROLLBACK here.

CREATE OR REPLACE FUNCTION ledger_assert_release_is_allowed() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  releases_hold         boolean;
  transaction_kind      text;
  transaction_reference text;
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

  SELECT kind, reference INTO transaction_kind, transaction_reference
    FROM ledger_transactions WHERE id = NEW.transaction_id;

  IF transaction_kind NOT IN ('reversal', 'cancel') THEN
    RAISE EXCEPTION
      'ledger transaction % releases a hold (treasury:reserved back to treasury:available) but is recorded as %; only a reversal (with proof) or a cancel may do that',
      NEW.transaction_id, transaction_kind
      USING ERRCODE = 'restrict_violation';
  END IF;

  IF transaction_kind = 'cancel' AND EXISTS (
    SELECT 1 FROM payments WHERE reference = transaction_reference AND tx_hash IS NOT NULL
  ) THEN
    RAISE EXCEPTION
      'ledger transaction % cancels %, but that payment already carries a signed transaction; those bytes can still land, so only the chain can release its money',
      NEW.transaction_id, transaction_reference
      USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NULL;
END;
$$;
