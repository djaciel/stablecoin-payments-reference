-- Deposits: money arriving at a partner's deposit address, and the foreign key 0011 promised.
--
-- A row is written the moment the watcher sees the Transfer, which is BEFORE the block is final,
-- so a deposit is a thing on screen long before it is money in the books. Nothing here credits
-- anything: the credit is a ledger transaction posted when the row goes DETECTED -> SETTLED.
--
-- Convention reminder from 0001_init.sql: no BEGIN/COMMIT/ROLLBACK here.

CREATE TABLE deposits (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  tx_hash         text        NOT NULL,
  -- Position of the Transfer inside that transaction. With the hash it names one event for ever,
  -- which is what makes re-scanning a range free: the second INSERT simply conflicts.
  log_index       integer     NOT NULL,
  -- Who sent it. Never used to attribute the money, only to show it: the article's rule is the
  -- address it ARRIVED at, and an exchange or a custodian sends from an address nobody recognises.
  from_address    text        NOT NULL,
  deposit_address text        NOT NULL,
  -- The attribution itself (article section 8), carried from the first moment: the address belongs to
  -- one partner, so the row knows whose money it is before anyone looks at amounts or invoices.
  partner_id      uuid        NOT NULL REFERENCES partners (id),
  amount_minor    bigint      NOT NULL CHECK (amount_minor > 0),
  currency        text        NOT NULL DEFAULT 'USDC',
  -- Where the chain said it was when it was detected. Corrected at promotion if the receipt then
  -- names another block, which is what a reorganisation looks like from here.
  block_number    bigint      NOT NULL,
  status          text        NOT NULL DEFAULT 'DETECTED' CHECK (status IN ('DETECTED', 'SETTLED')),
  -- The invoice this deposit paid, and which of the three rules found it.
  receivable_id   uuid        REFERENCES receivables (id),
  matched_by      text        CHECK (matched_by IN ('hash', 'amount', 'unmatched')),
  detected_at     timestamptz NOT NULL DEFAULT now(),
  settled_at      timestamptz,

  -- One Transfer, one row, for ever.
  CONSTRAINT deposits_one_row_per_transfer UNIQUE (tx_hash, log_index),
  -- Credited and attributed happen together: a SETTLED deposit always says how it was matched,
  -- and a DETECTED one never claims to have been.
  CONSTRAINT deposits_settled_knows_its_rule CHECK ((status = 'SETTLED') = (matched_by IS NOT NULL)),
  -- "Unmatched" means exactly that: money credited with no invoice behind it.
  CONSTRAINT deposits_unmatched_has_no_invoice CHECK (matched_by IS DISTINCT FROM 'unmatched' OR receivable_id IS NULL)
);

COMMENT ON TABLE deposits IS
  'USDC arriving at a deposit address. DETECTED is what the chain showed; SETTLED is what the books were told, and only a final block with the official contract Transfer for the exact amount at the exact address gets there.';


-- 0011 created this column without a reference because this table did not exist yet, the way
-- payables.payment_reference waited for 0007.
ALTER TABLE receivables
  ADD CONSTRAINT receivables_deposit_fk FOREIGN KEY (deposit_id) REFERENCES deposits (id);
