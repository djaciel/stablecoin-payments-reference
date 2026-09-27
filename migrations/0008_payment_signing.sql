-- What the `sign` step writes on a payment: the transaction's hash, its signed bytes and its
-- nonce. The guards below make the signing rule a property of the table, whoever writes.
--
-- Convention from 0001_init.sql: no BEGIN/COMMIT/ROLLBACK here.

ALTER TABLE payments
  ADD COLUMN tx_hash   text,
  ADD COLUMN signed_tx text,
  ADD COLUMN nonce     integer;

-- Stored together or not at all: a hash without its bytes cannot be re-sent, and bytes without
-- their hash cannot be asked about.
ALTER TABLE payments
  ADD CONSTRAINT payments_signed_together
  CHECK ((tx_hash IS NULL) = (signed_tx IS NULL) AND (tx_hash IS NULL) = (nonce IS NULL));

-- "store(hash) before broadcasting": a payment cannot be SENT, or SETTLED, without it.
ALTER TABLE payments
  ADD CONSTRAINT payments_sent_has_hash
  CHECK (status NOT IN ('SENT', 'SETTLED') OR tx_hash IS NOT NULL);

-- One transaction per payment, and one payment per nonce. Nonces belong to the address that
-- sends, and the treasury is the only sender of payments.
ALTER TABLE payments
  ADD CONSTRAINT payments_tx_hash_key UNIQUE (tx_hash),
  ADD CONSTRAINT payments_nonce_key UNIQUE (nonce);
