-- The watcher's two tables: what to look at, and how far it has looked.
--
-- Everything the watcher needs is here and nowhere else. It holds no seed, asks no signer
-- and reads no configuration file: a worker that can reach Postgres and an RPC endpoint can
-- do the whole job, which is what lets the schedule run in the plainest process in the repo.
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
  -- The last block that has been scanned AND whose findings are committed. The next tick
  -- starts at last_block + 1.
  --
  -- It is written in the same database transaction as whatever that tick posted, and that
  -- is the entire safety argument: a worker that dies mid-tick leaves the cursor where it
  -- was, so the range is scanned again rather than skipped. Re-scanning is free — the
  -- ledger's (kind, reference) unique index means the same transfer cannot be posted twice.
  last_block   bigint      NOT NULL,
  -- When the RPC was last asked, which is what the adaptive skip reads: once the treasury
  -- has been funded the watcher stops asking every 10 seconds and idles instead.
  last_scan_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE watcher_state IS
  'The watcher cursor. last_block advances only when the tick that scanned it commits, so the worker can die at any point without losing a transfer.';
