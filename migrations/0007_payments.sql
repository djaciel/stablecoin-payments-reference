-- Payments: the intent recorded before anything else happens, and the unique
-- index that gives its idempotency key a meaning. The columns the chain steps write (tx_hash,
-- signed_tx, nonce, execute_at) arrive with the code that writes them.
--
-- Convention reminder from 0001_init.sql: no BEGIN/COMMIT/ROLLBACK here — the `BEGIN` below
-- opens a plpgsql block.

CREATE TABLE payments (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- PAY-XXXX: what the API answers with, and the ledger's reference.
  reference           text        NOT NULL UNIQUE,
  -- The six public states, all of them from the start: the state catalog is complete even
  -- while only CREATED, RESERVED and FAILED are reachable.
  status              text        NOT NULL
                                  CHECK (status IN ('CREATED', 'RESERVED', 'SENT', 'SETTLED', 'FAILED', 'REVIEW')),
  -- The invoice this pays. Nullable for the ad-hoc payment to an address, which arrives with
  -- the allowlist.
  payable_id          uuid        REFERENCES payables (id),
  destination         text        NOT NULL,
  amount_minor        bigint      NOT NULL CHECK (amount_minor > 0),
  currency            text        NOT NULL,
  -- Why a FAILED payment failed, as a short code a screen can print: insufficient_funds, ...
  failure_reason      text,
  idempotency_key     text        NOT NULL,
  -- sha256 of the request, so a retry can be told apart from a different request that reuses
  -- the key.
  request_fingerprint text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- THIS INDEX IS THE WHOLE IDEMPOTENCY MECHANISM. A second INSERT with the same key waits here
-- until the first transaction commits, then fails with unique_violation (23505), and the api
-- answers it with the payment that won. Checking with a SELECT before inserting would not
-- work: two requests in parallel both find nothing, and both insert.
CREATE UNIQUE INDEX payments_idempotency_key ON payments (idempotency_key);

COMMENT ON TABLE payments IS
  'Payment intents. One row per idempotency key; the reference names its ledger movements (reserve, settle, reversal, cancel).';


-- updated_at follows every UPDATE, whoever writes it: the api today, the workflow steps later.
CREATE FUNCTION payments_touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER payments_updated_at
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_touch_updated_at();


-- The link 0006_payables.sql promised: an invoice can only point at a payment that exists.
ALTER TABLE payables
  ADD CONSTRAINT payables_payment_reference_fk FOREIGN KEY (payment_reference) REFERENCES payments (reference);
