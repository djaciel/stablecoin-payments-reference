-- The allowlist: the addresses the company may send money to.
--
-- Until now this was a join on the partners table, which quietly said that the only address you
-- may pay is a partner's. They are two different ideas, and this table separates them: a row here
-- is a decision somebody took, and the payment door reads nothing else.
--
-- Convention reminder from 0001_init.sql: no BEGIN/COMMIT/ROLLBACK here.

CREATE TABLE allowlist (
  -- Checksummed, like every address in this schema (0005_partners.sql says why): the payment door
  -- compares this text to the invoice's destination, and the same address written two ways is a
  -- payment refused for no reason.
  address    text        PRIMARY KEY,
  -- Whose address it is, in the words of whoever added it. A list of forty hex characters tells
  -- nobody anything.
  label      text        NOT NULL,
  -- The partner it belongs to, when it belongs to one. Null for an address somebody typed.
  partner_id uuid        REFERENCES partners (id),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE allowlist IS
  'The addresses the company may send money to. It answers one question, "may the company send money here", and the payment validations ask it exactly that. In a real system adding a row is a reviewed control; here any admin may, through POST /allowlist.';


-- Every partner already on the books keeps the address the company promised to pay it at.
-- Without this line every invoice written before today becomes unpayable, because the door would
-- start reading an empty table.
INSERT INTO allowlist (address, label, partner_id)
SELECT payout_address, name, id FROM partners;
