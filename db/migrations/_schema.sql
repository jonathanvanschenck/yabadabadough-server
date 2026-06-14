
CREATE TABLE funds (
    id                INTEGER PRIMARY KEY,
    name              TEXT NOT NULL UNIQUE,

    parent_id         INTEGER REFERENCES funds(id)
                        ON DELETE RESTRICT
                        ON UPDATE CASCADE, -- NULL for roots


    -- last_finalization_id INTEGER, -- SEE Below for where this gets added

    -- Can be null only if not tracked, see check below
    tracked           INTEGER NOT NULL CHECK (tracked IN (0,1)),
    start_date        TEXT,    -- 'YYYY-MM-DD'
    start_balance     INTEGER, -- 4 point decimal
    balance           INTEGER, -- 4 point decimal


    monthly           INTEGER NOT NULL DEFAULT 0
                        CHECK (monthly IN (0,1)),

    color             TEXT,


    -- Meta data
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    -- Tracking requires that we have a balance, and can't be montly
    CHECK (
        tracked = 0
        OR (
            balance IS NOT NULL
            AND start_date IS NOT NULL
            AND start_balance IS NOT NULL
        )
    ),
    -- monthlys MUST have a parent into which their EOM balances flow
    CHECK (
        monthly = 0 
        OR parent_id IS NOT NULL
    ),
    -- monthlys require tracking
    CHECK (
        monthly = 0
        OR tracked = 1
    )
) STRICT;
CREATE INDEX idx_funds_parent_id on funds(parent_id);
CREATE INDEX idx_funds_tracked on funds(tracked);
CREATE INDEX idx_funds_tracked_only on funds(tracked) WHERE tracked = 1;
CREATE INDEX idx_funds_monthly on funds(monthly);



-- =====================================================
-- BEFORE INSERT: Prevent cycles when creating new funds
-- =====================================================
DROP TRIGGER IF EXISTS funds_prevent_cycle_insert;

CREATE TRIGGER funds_prevent_cycle_insert
BEFORE INSERT ON funds
FOR EACH ROW
WHEN NEW.parent_id IS NOT NULL
BEGIN
    SELECT RAISE(ABORT, 'Insert would create a cycle in the fund hierarchy')
    WHERE 
        -- Prevent self-reference
        NEW.parent_id = NEW.id

        OR EXISTS (
            WITH RECURSIVE ancestors(id, depth) AS (
                -- Start from the proposed parent
                SELECT parent_id, 1 AS depth
                FROM funds
                WHERE id = NEW.parent_id

                UNION ALL

                -- Walk up the tree
                SELECT f.parent_id, a.depth + 1
                FROM funds f
                JOIN ancestors a ON f.id = a.id
                WHERE a.depth < 50                    -- Safety limit
            )
            SELECT 1 FROM ancestors WHERE id = NEW.id
        );
END;


-- =====================================================
-- BEFORE UPDATE: Prevent cycles when changing parent_id
-- =====================================================
DROP TRIGGER IF EXISTS funds_prevent_cycle_update;

CREATE TRIGGER funds_prevent_cycle_update
BEFORE UPDATE OF parent_id ON funds
FOR EACH ROW
WHEN NEW.parent_id IS NOT NULL 
  AND NEW.parent_id != OLD.parent_id
BEGIN
    SELECT RAISE(ABORT, 'Update would create a cycle in the fund hierarchy')
    WHERE 
        -- Prevent self-reference
        NEW.parent_id = NEW.id

        OR EXISTS (
            WITH RECURSIVE ancestors(id, depth) AS (
                -- Start from the proposed new parent
                SELECT parent_id, 1 AS depth
                FROM funds
                WHERE id = NEW.parent_id

                UNION ALL

                -- Walk up the tree
                SELECT f.parent_id, a.depth + 1
                FROM funds f
                JOIN ancestors a ON f.id = a.id
                WHERE a.depth < 50                    -- Safety limit
            )
            SELECT 1 FROM ancestors WHERE id = NEW.id
        );
END;

CREATE TABLE bank_statement_items (
    id                  INTEGER PRIMARY KEY,
    source              TEXT NOT NULL, -- which bank
    key                 TEXT NOT NULL, -- bank-scoped unique key for this item

    -- Meta data
    amount              INTEGER NOT NULL, -- 4 decimal
    date                TEXT NOT NULL, -- YYY-MM-DD
    note                TEXT,

    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    UNIQUE (source, key)
) STRICT;
CREATE INDEX idx_bank_statement_items_source ON bank_statement_items(source);
CREATE INDEX idx_bank_statement_items_key ON bank_statement_items(key);


CREATE TABLE allocations (
    id                  INTEGER PRIMARY KEY,
    fund_id             INTEGER NOT NULL REFERENCES funds(id)
                            ON DELETE RESTRICT
                            ON UPDATE CASCADE,

    date                TEXT NOT NULL, -- YYYY-MM-DD, when this allocation should be applied
    amount              INTEGER NOT NULL CHECK (amount > 0), -- 4 decimal

    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX idx_allocations_fund_id ON allocations(fund_id);
CREATE INDEX idx_allocations_date ON allocations(date);

CREATE TABLE fund_eom_finalizations (
    id                  INTEGER PRIMARY KEY,
    fund_id             INTEGER NOT NULL REFERENCES funds(id)
                            ON DELETE RESTRICT
                            ON UPDATE CASCADE,

    date                TEXT NOT NULL, -- YYYY-MM-DD, last day of the month finalized
    eom_balance         INTEGER NOT NULL, -- 4 decimal, balance in fund at eom, note this does NOT include the final transaction whereby budgets are cleaned up

    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX idx_fund_eom_finalizations_fund_id ON fund_eom_finalizations(fund_id);
CREATE INDEX idx_fund_eom_finalizations_date ON fund_eom_finalizations(date);

CREATE TABLE transaction_groups (
    id                  INTEGER PRIMARY KEY,
    description         TEXT NOT NULL,
    note                TEXT,

    -- Reference value for if this group has multiple transactions
    split               INTEGER NOT NULL CHECK (split IN (0,1)),

    -- Not null if this group arose from a bank statement item
    statement_id        INTEGER REFERENCES bank_statement_items(id)
                            ON DELETE SET NULL
                            ON UPDATE CASCADE,


    created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX idx_transaction_groups_statement_id ON transaction_groups(statement_id);

CREATE TABLE transactions (
    id                  INTEGER PRIMARY KEY,
    source_fund_id      INTEGER NOT NULL REFERENCES funds(id)
                            ON DELETE RESTRICT
                            ON UPDATE CASCADE,
    target_fund_id      INTEGER NOT NULL REFERENCES funds(id)
                            ON DELETE RESTRICT
                            ON UPDATE CASCADE,
    group_id            INTEGER NOT NULL REFERENCES transaction_groups(id)
                            ON DELETE RESTRICT
                            ON UPDATE CASCADE,

    amount              INTEGER NOT NULL CHECK (amount > 0), -- 4 decimal
    date                TEXT NOT NULL, -- YYYY-MM-DD
    description         TEXT NOT NULL,
    note                TEXT,

    -- If this transaction exists because it is and eom budget clean up,
    --  this is the backref to that finalization
    eom_cleanup_id      INTEGER REFERENCES fund_eom_finalizations(id)
                            ON DELETE RESTRICT
                            ON UPDATE CASCADE,

    -- If this transaction exists because of an allocation, this is the backref
    allocation_id       INTEGER REFERENCES allocations(id)
                            ON DELETE RESTRICT
                            ON UPDATE CASCADE,


    -- Meta data
    created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    -- Transactions cannot be to themselves
    CHECK (
        source_fund_id <> target_fund_id
    )
) STRICT;
CREATE INDEX idx_transactions_source_fund_id ON transactions(source_fund_id);
CREATE INDEX idx_transactions_target_fund_id ON transactions(target_fund_id);
CREATE INDEX idx_transactions_group_id ON transactions(group_id);
CREATE INDEX idx_transactions_date ON transactions(date);
CREATE INDEX idx_transactions_eom_cleanup_id ON transactions(eom_cleanup_id);
CREATE INDEX idx_transactions_allocation_id ON transactions(allocation_id);



-- Add column to funds now that fund_eom_finalizations exists
ALTER TABLE funds
    ADD COLUMN last_finalization_id INTEGER REFERENCES fund_eom_finalizations(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE;
CREATE INDEX idx_funds_last_finalization_id ON funds(last_finalization_id);



PRAGMA user_version = 1;
