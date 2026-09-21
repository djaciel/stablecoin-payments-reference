-- The partners table, and the foreign key 0004_watcher.sql promised it would bring.
--
-- A partner is one row and two addresses derived at the same index: the deposit address the
-- company controls (company seed, held by the signer) and the payout address the partner
-- controls (partner seed, demo scaffolding in the api). The addresses themselves are not
-- inserted here — they only exist once the seeds have been generated at runtime, so the api
-- bootstraps the first two partners on start.
--
-- Convention reminder from 0001_init.sql: no BEGIN/COMMIT/ROLLBACK here.

CREATE TABLE partners (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text        NOT NULL,
  -- The index both seeds are derived at. Unique because two partners sharing an index would
  -- share a deposit address, and the whole attribution rule is that the address says who
  -- paid; positive because index 0 is the treasury in the company seed and the shared
  -- partner wallet in the partner seed, and neither is ever handed out.
  derivation_index integer     NOT NULL UNIQUE CHECK (derivation_index > 0),
  -- Checksummed, like every address in this schema: the same address written two ways is
  -- how a watcher misses money.
  deposit_address  text        NOT NULL,
  -- The partner's own money. It never appears on the company's books; the allowlist row it
  -- also gets, so the company may pay it, arrives with the allowlist in Phase 8.
  payout_address   text        NOT NULL,
  -- Read by the "is this partner active" validation when payments arrive. Nothing changes it
  -- yet, so every partner is active.
  status           text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE partners IS
  'The companies the demo pays and gets paid by. Each carries the index its two addresses are derived at: deposit_address from the company seed (the signer), payout_address from the partner seed (demo scaffolding in the api).';


-- 0004 created this column without a reference because this table did not exist yet. A
-- deposit address that names a partner who is gone is a transfer nobody can attribute.
ALTER TABLE watched_addresses
  ADD CONSTRAINT watched_addresses_partner_fk FOREIGN KEY (partner_id) REFERENCES partners (id);
