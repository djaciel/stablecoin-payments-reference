-- The watcher's two tables: what to look at, and how far it has looked. Everything it needs
-- is here, so a worker that can reach Postgres and an RPC endpoint can do the whole job.
--
-- Convention reminder from 0001_init.sql: no BEGIN/COMMIT/ROLLBACK here.


-- ---------------------------------------------------------------------------------------
-- What to watch
-- ---------------------------------------------------------------------------------------

CREATE TABLE watched_addresses (
  -- Checksummed, exactly as the chain package writes it. One row per address, so
  -- registering the same address twice is an ON CONFLICT DO NOTHING rather than a decision.
  address    text        PRIMARY KEY,
  -- What arriving money MEANS at this address, which is the only reason the role exists:
  -- at the treasury it is funding (posted straight to the books), at a deposit address it
  -- is a partner paying an invoice (a DETECTED deposit first, credited at finality).
  role       text        NOT NULL CHECK (role IN ('treasury', 'deposit')),
  -- Which partner a deposit address belongs to. NULL for the treasury. No foreign key yet:
  -- the partners table arrives in T-10 and brings it.
  partner_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE watched_addresses IS
  'Addresses the watcher asks the chain about, and later the set reconciliation compares: treasury + every deposit address. The api registers the treasury at startup; partners add their deposit address when they are created.';


-- ---------------------------------------------------------------------------------------
-- How far it has looked
-- ---------------------------------------------------------------------------------------

CREATE TABLE watcher_state (
  -- One row per scan, and there is exactly one scan today: 'usdc-transfers'. A name rather
  -- than a singleton row with no key, so a second kind of scan does not need a migration.
  name         text        PRIMARY KEY,
  -- The last block scanned AND committed; the next tick starts at last_block + 1. Written in
  -- the same transaction as whatever that tick posted, which is the entire safety argument: a
  -- worker that dies mid-tick re-scans the range instead of skipping it, and re-scanning is
  -- free because (kind, reference) means the same transfer cannot be posted twice.
  last_block   bigint      NOT NULL,
  -- When the RPC was last asked. The adaptive skip reads it: once something has been funded
  -- and the watcher is caught up, it idles instead of asking every 10 seconds.
  last_scan_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE watcher_state IS
  'The watcher cursor. last_block advances only when the tick that scanned it commits, so the worker can die at any point without losing a transfer.';
