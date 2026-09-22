-- The failure-injection flags, one row each (their keys and meanings: packages/domain/src/experiments.ts).
-- Written by the admin api, read only by the worker's payment steps. An absent row is off, so a
-- fresh database, and the tests' truncation, start with every flag off.
--
-- Convention from 0001_init.sql: no BEGIN/COMMIT/ROLLBACK here.

CREATE TABLE settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
