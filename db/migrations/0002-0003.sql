-- Migration 2 -> 3: outstanding-item tracking on transaction groups.
--
--   expects_statement  a bank line is EXPECTED for this group but has not been
--                      imported yet -- a written-but-uncashed check, a pending
--                      ACH, a promised refund.
--   reference          free-form instrument reference (a check number, a wire
--                      confirmation, an invoice id): the exact key for matching
--                      a cleared item back to the group that predicted it.
--
-- "Outstanding" itself is NOT stored: it is expects_statement = 1 with no
-- linked bank_statement_items, so linking an item clears it with no write and
-- unlinking one restores it.
--
-- Keep both columns in sync with _schema.sql (which fresh databases get
-- directly). The internal-group rule rides on the column-level CHECK rather
-- than a table-level one because ALTER TABLE cannot add a table constraint.

ALTER TABLE transaction_groups ADD COLUMN expects_statement INTEGER NOT NULL DEFAULT 0
    CHECK (
        expects_statement IN (0,1)
        AND NOT (expects_statement = 1 AND (allocation = 1 OR eom_cleanup = 1))
    );

ALTER TABLE transaction_groups ADD COLUMN reference TEXT;

CREATE INDEX idx_transaction_groups_expects_statement
    ON transaction_groups(expects_statement);
-- Partial: this index exists to resolve a cleared item back to the group that
-- named it, and an unreferenced group is the overwhelming majority case
CREATE INDEX idx_transaction_groups_reference
    ON transaction_groups(reference COLLATE NOCASE) WHERE reference IS NOT NULL;

PRAGMA user_version = 3;
