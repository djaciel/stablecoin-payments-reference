-- Where a payment in REVIEW came from, so resuming it knows where to go back to. The `escalate`
-- step writes it; resume clears it.
--
-- Convention from 0001_init.sql: no BEGIN/COMMIT/ROLLBACK here.

ALTER TABLE payments
  ADD COLUMN review_from_status text CHECK (review_from_status IN ('RESERVED', 'SENT'));

-- A REVIEW always knows where it came from, and only a REVIEW has it.
ALTER TABLE payments
  ADD CONSTRAINT payments_review_knows_its_origin
  CHECK ((status = 'REVIEW') = (review_from_status IS NOT NULL));
