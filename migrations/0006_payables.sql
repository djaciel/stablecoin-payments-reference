-- Payables: the invoices the company owes. Creating one also puts its debt on the books
-- (Dr expense:services / Cr partner:payable, reference = the payable id) in the same database
-- transaction, so an invoice never exists without its debt, or the reverse.
--
-- Convention reminder from 0001_init.sql: no BEGIN/COMMIT/ROLLBACK here.

CREATE TABLE payables (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Nullable for one case only: the ad-hoc "pay to an address", which has no partner and
  -- arrives with the allowlist.
  partner_id        uuid        REFERENCES partners (id),
  -- Copied from the partner's payout address when the invoice is created, not joined: what
  -- the company promised to pay is the address it promised to pay it to, even if the
  -- partner's row changes later.
  destination       text        NOT NULL,
  -- Minor units, like every amount in the ledger. An invoice for nothing is not a debt.
  amount_minor      bigint      NOT NULL CHECK (amount_minor > 0),
  currency          text        NOT NULL DEFAULT 'USDC',
  -- What the invoice is for, in the words of whoever created it: the line a human reads.
  description       text        NOT NULL,
  status            text        NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'PAYING', 'PAID')),
  -- The payment that pays it, once there is one. The foreign key arrives with 0007_payments.sql.
  payment_reference text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE payables IS
  'Invoices the company owes. Each one is also a payable ledger transaction whose reference is this id; partner:payable is their total, and this table is the per-partner view of it.';
