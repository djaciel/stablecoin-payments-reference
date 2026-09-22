-- Receivables: the invoices a partner owes the company. Creating one also puts the accrual on the
-- books (Dr partner:receivable / Cr revenue:services, reference = the receivable id) in the same
-- database transaction, so an invoice never exists without its accrual, or the reverse.
--
-- Convention reminder from 0001_init.sql: no BEGIN/COMMIT/ROLLBACK here.

CREATE TABLE receivables (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Never null, unlike a payable's: the money is attributed by the address it arrives at, and
  -- that address belongs to a partner.
  partner_id      uuid        NOT NULL REFERENCES partners (id),
  -- Minor units, like every amount in the ledger. An invoice for nothing is not an invoice.
  amount_minor    bigint      NOT NULL CHECK (amount_minor > 0),
  currency        text        NOT NULL DEFAULT 'USDC',
  -- What the invoice is for, in the words of whoever created it: the line a human reads.
  description     text        NOT NULL,
  status          text        NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'PAYING', 'PAID')),
  -- The hash the partner's side records BEFORE broadcasting its transfer, which is how the
  -- deposit that arrives can be matched back to this invoice. Unique: one transaction pays at
  -- most one invoice.
  payment_tx_hash text        UNIQUE,
  -- The deposit that settled it. The foreign key arrives with 0012_deposits.sql, the way
  -- payables.payment_reference waited for 0007.
  deposit_id      uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE receivables IS
  'Invoices a partner owes the company. Each one is also a receivable ledger transaction whose reference is this id; partner:receivable is their total, and this table is the per-partner view of it.';
