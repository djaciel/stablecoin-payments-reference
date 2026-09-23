-- When a payment should run. Null means now: nothing waits, and every payment written before
-- today reads that way. A time means the money is already reserved and the transfer leaves later.
--
-- Who reads it: the dispatcher (`apps/worker/src/dispatcher.ts`), whose tick starts a workflow
-- only for a payment whose time has come, and the api, which for the same reason does not start
-- one itself. No CHECK against now(): now() is not immutable, and "in the future, at most a day
-- ahead" is a rule about the request, so the api owns it.
--
-- Convention from 0001_init.sql: no BEGIN/COMMIT/ROLLBACK here.

ALTER TABLE payments
  ADD COLUMN execute_at timestamptz;

COMMENT ON COLUMN payments.execute_at IS
  'When this payment runs. Null runs it now. The money is reserved when the payment is recorded either way, so a scheduled one holds its amount under Reserved, with no hash and no nonce, until its time.';
