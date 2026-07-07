
CREATE TABLE users (
    id                  INTEGER PRIMARY KEY,
    email               TEXT NOT NULL UNIQUE, -- stored normalized (lowercase, trimmed)

    -- Self-describing salted hash: "scrypt$N$r$p$salt_b64$hash_b64".
    -- Params live in the string so cost can be raised without breaking
    -- existing hashes. NEVER exposed via to_api.
    password_hash       TEXT NOT NULL,

    admin               INTEGER NOT NULL DEFAULT 0 CHECK (admin IN (0,1)),

    -- Meta data
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- A session row IS the right to refresh an access token: refreshable iff the
-- row exists and expires_at is in the future. Logout / revoke-all = row
-- deletion (no revoked flag).
CREATE TABLE user_sessions (
    id                  INTEGER PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id)
                            ON DELETE CASCADE
                            ON UPDATE CASCADE,

    -- Per-session random secret, embedded in the auth-token payload and
    -- required to match (timing-safe) at refresh: defends against sqlite id
    -- reuse and is the hook for future rotation. NEVER exposed via to_api.
    token               TEXT NOT NULL UNIQUE,

    note                TEXT,               -- optional device/client label

    expires_at          TEXT NOT NULL,      -- ISO 8601 datetime
    last_used_at        TEXT,               -- ISO 8601, touched on every refresh

    -- Meta data
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_expires_at ON user_sessions(expires_at);


CREATE TABLE funds (
    id                INTEGER PRIMARY KEY,
    name              TEXT NOT NULL UNIQUE,

    parent_id         INTEGER REFERENCES funds(id)
                        ON DELETE RESTRICT
                        ON UPDATE CASCADE, -- NULL for roots


    -- finalization_id INTEGER, -- SEE Below for where this gets added

    -- Must be set if tracked, must be null if untracked, see check below
    tracked           INTEGER NOT NULL CHECK (tracked IN (0,1)),
    start_date        TEXT,    -- 'YYYY-MM-DD'
    start_balance     INTEGER, -- 4 point decimal (Forward balance entering start_date)
    -- NOTE : there is intentionally no running `balance` column; balances are
    --        always calculated from a cached finalization point (or the start
    --        values) plus the net transactions since.


    monthly           INTEGER NOT NULL DEFAULT 0
                        CHECK (monthly IN (0,1)),

    -- Pools are the source/sink of money for their descendants: allocations
    -- draw from the nearest pool ancestor, and monthly funds return their EOM
    -- balances directly to it
    pool              INTEGER NOT NULL DEFAULT 0
                        CHECK (pool IN (0,1)),

    color             TEXT,


    -- Meta data
    created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    -- Tracked funds MUST have start values; untracked funds MUST NOT
    CHECK (
        (tracked = 1 AND start_date IS NOT NULL AND start_balance IS NOT NULL)
        OR (tracked = 0 AND start_date IS NULL AND start_balance IS NULL)
    ),
    -- monthlys MUST have a parent into which their EOM balances flow
    -- NOTE : monthlys additionally require a POOL ancestor; that is a
    --        hierarchy-global invariant enforced at the model layer
    CHECK (
        monthly = 0
        OR parent_id IS NOT NULL
    ),
    -- monthlys require tracking
    CHECK (
        monthly = 0
        OR tracked = 1
    ),
    -- pools hold real money (tracked) and are never monthly
    CHECK (
        pool = 0
        OR (tracked = 1 AND monthly = 0)
    )
) STRICT;
CREATE INDEX idx_funds_parent_id on funds(parent_id);
CREATE INDEX idx_funds_tracked on funds(tracked);
CREATE INDEX idx_funds_tracked_only on funds(tracked) WHERE tracked = 1;
CREATE INDEX idx_funds_monthly on funds(monthly);
CREATE INDEX idx_funds_pool on funds(pool);



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

-- NOTE : there is intentionally NO allocations table. An allocation is a
--        transaction inside the month's single allocation transaction group
--        (transaction_groups.allocation = 1, dated the first of the month),
--        managed via models/Allocation.js.

CREATE TABLE month_finalizations (
    id                  INTEGER PRIMARY KEY,

    som_date            TEXT NOT NULL, -- YYYY-MM-DD
    eom_date            TEXT NOT NULL, -- YYYY-MM-DD
    sonm_date           TEXT NOT NULL, -- YYYY-MM-DD

    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    -- A month may only be finalized once
    UNIQUE (som_date)
) STRICT;
CREATE INDEX idx_month_finalizations_eom_date ON month_finalizations(eom_date);
CREATE INDEX idx_month_finalizations_som_date ON month_finalizations(som_date);
CREATE INDEX idx_month_finalizations_sonm_date ON month_finalizations(sonm_date);

CREATE TABLE fund_finalizations (
    id                  INTEGER PRIMARY KEY,
    month_id            INTEGER NOT NULL REFERENCES month_finalizations(id)
                            ON DELETE CASCADE
                            ON UPDATE CASCADE,
    fund_id             INTEGER NOT NULL REFERENCES funds(id)
                            ON DELETE RESTRICT
                            ON UPDATE CASCADE,

    eom_balance         INTEGER NOT NULL, -- 4 decimal, balance in fund at eom, note this does NOT include the final transaction whereby budgets are cleaned up
    sonm_balance        INTEGER NOT NULL, -- 4 decimal, balance in fund going into the start of the next month (e.g. DOES include final transactions that clean up budgets)

    -- DENORMALIZED VALUES:
    -- Copied from parent month_finalizations row so cache lookups don't need a second join
    sonm_date           TEXT NOT NULL, -- YYYY-MM-DD

    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    -- A fund may only be finalized once per month
    UNIQUE (month_id, fund_id)
) STRICT;
CREATE INDEX idx_fund_finalizations_month_id ON fund_finalizations(month_id);
CREATE INDEX idx_fund_finalizations_fund_id ON fund_finalizations(fund_id);
-- For "latest cache point at-or-before date" lookups
CREATE INDEX idx_fund_finalizations_fund_id_sonm_date ON fund_finalizations(fund_id, sonm_date);

CREATE TABLE transaction_groups (
    id                  INTEGER PRIMARY KEY,
    date                TEXT NOT NULL, -- YYYY-MM-DD
    description         TEXT NOT NULL,
    note                TEXT,

    -- NOTE : bank statement items reference groups (bank_statement_items.group_id),
    --        not the other way around -- see that table below

    -- DENORMALIZED VALUES:
    -- Reference value for if this group has multiple transactions
    split               INTEGER NOT NULL CHECK (split IN (0,1)),
    -- is an end-of-month budget cleanup group (managed by MonthFinalization)
    eom_cleanup         INTEGER NOT NULL DEFAULT '0' CHECK (eom_cleanup IN (0,1)),
    -- is the month's allocation group (managed by Allocation)
    allocation          INTEGER NOT NULL DEFAULT '0' CHECK (allocation IN (0,1)),

    -- Meta
    created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    -- A group is at most one of eom_cleanup / allocation
    CHECK (
        NOT (eom_cleanup = 1 AND allocation = 1)
    )
) STRICT;
CREATE INDEX idx_transaction_groups_date ON transaction_groups(date);
CREATE INDEX idx_transaction_groups_split ON transaction_groups(split);
CREATE INDEX idx_transaction_groups_allocation ON transaction_groups(allocation);
CREATE INDEX idx_transaction_groups_eom_cleanup ON transaction_groups(eom_cleanup);

-- NOTE : this table is defined AFTER transaction_groups (its reconciliation
--        target) so that group_id and its cross-column CHECK can live in the
--        table definition
CREATE TABLE bank_statement_items (
    id                  INTEGER PRIMARY KEY,
    source              TEXT NOT NULL, -- which bank
    key                 TEXT NOT NULL, -- bank-scoped unique key for this item

    -- User has chosen to NOT create a transaction group for this item
    ignored             INTEGER NOT NULL DEFAULT 0 CHECK (ignored IN (0,1)),

    -- Which transaction group reconciles this item. The FK lives on THIS
    -- side (not on transaction_groups) so that transfer-type events -- two
    -- items from two different bank imports -- can share a single group
    group_id            INTEGER REFERENCES transaction_groups(id)
                            ON DELETE SET NULL
                            ON UPDATE CASCADE,

    -- Meta data
    amount              INTEGER NOT NULL, -- 4 decimal, signed: negative = money leaving the bank account
    date                TEXT NOT NULL, -- YYYY-MM-DD
    note                TEXT,

    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),

    -- Idempotent re-import key
    UNIQUE (source, key),

    -- An ignored item must not be linked to a group
    CHECK (NOT (ignored = 1 AND group_id IS NOT NULL))
) STRICT;
CREATE INDEX idx_bank_statement_items_source ON bank_statement_items(source);
CREATE INDEX idx_bank_statement_items_key ON bank_statement_items(key);
CREATE INDEX idx_bank_statement_items_group_id ON bank_statement_items(group_id);
CREATE INDEX idx_bank_statement_items_ignored ON bank_statement_items(ignored);

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

    -- NOTE : zero amounts are allowed at the db level so that every monthly fund
    --        gets an eom_cleanup transaction each finalized month (even at zero
    --        balance). USERS should never create zero-amount transactions; that
    --        is enforced at the API layer, not here.
    amount              INTEGER NOT NULL CHECK (amount >= 0), -- 4 decimal
    description         TEXT NOT NULL,
    note                TEXT,

    -- If this transaction exists because it is and eom budget clean up,
    --  this is the backref to that finalization
    eom_cleanup_id      INTEGER REFERENCES fund_finalizations(id)
                            ON DELETE RESTRICT
                            ON UPDATE CASCADE,

    -- DENORMALIZED VALUES:
    date                TEXT NOT NULL, -- YYYY-MM-DD, copied from parent for faster queries
    -- copied from the parent group, marks this transaction as an allocation
    allocation          INTEGER NOT NULL DEFAULT 0 CHECK (allocation IN (0,1)),

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
CREATE INDEX idx_transactions_allocation ON transactions(allocation);
-- Backstop for one-allocation-per-fund-per-month: a month's allocations all
-- share the group's som date, so uniqueness on (target, date) is per-month
CREATE UNIQUE INDEX idx_transactions_allocation_unique
    ON transactions(target_fund_id, date) WHERE allocation = 1;



-- Add column to funds now that fund_finalizations exists
ALTER TABLE funds
    ADD COLUMN finalization_id INTEGER REFERENCES fund_finalizations(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE;
CREATE INDEX idx_funds_finalization_id ON funds(finalization_id);


PRAGMA user_version = 1;
