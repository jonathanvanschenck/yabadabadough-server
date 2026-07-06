## Project Overview

Personal finance server application built with Node.js and SQLite. Manages funds (hierarchical), transactions, allocations, and bank statement reconciliation. Supports monthly budgets with end-of-month finalization.

## Commands

### Testing
- Run all tests: `npm test`
- Run specific test file: `npx mocha test/models/test-fund.js`
- Test pattern: Files named `test-*.js` in `test/` directory (recursive)

### Database
- Database path configured via `.env` file: `YDD_SQLITE_PATH`
- Database uses WAL mode and foreign key constraints
- Schema version tracked via `PRAGMA user_version`
- Fresh schema applied automatically to new databases via `db/migrations/_schema.sql`

## Architecture

### Database Layer (`lib/db.js`)

Central module for database operations:
- `create_connection(config)`: Creates SQLite connection with WAL mode, foreign keys enabled
- `initialize_db(db)`: Applies schema for new databases, handles migrations for existing ones
- Caches prepared statements and transactions on `db.prepared_stmts` and `db.prepared_transactions` Maps
- Exports `ConflictError` and `ForeignKeyError` for model validation

### Data Type Conventions

**Currency**: Stored as INTEGER with 4 decimal places (e.g., 10000 = $1.00)
- `currency2stmt(value)`: Converts float to 4-decimal integer
- `stmt2currency(value)`: Converts 4-decimal integer to float

**Dates**: Stored as TEXT in 'YYYY-MM-DD' format
- Use `YDate` class (lib/YDate.js) for date handling
- `ydate2stmt(value)`: Converts YDate to string
- `stmt2ydate(value)`: Parses string to YDate

**Booleans**: Stored as INTEGER 0/1
- `boolean2stmt(value)`: Converts boolean to 0/1
- `stmt2boolean(value)`: Converts 0/1 to boolean

**Datetime**: ISO 8601 format with timezone
- `datetime2stmt(value)`: Converts Date to ISO string
- `stmt2datetime(value)`: Parses ISO string to Date

### Date & Balance Conventions

- **"Forward balance entering date D"**: includes every transaction *before* D, but NOT
  transactions on D itself. Every stored balance is a forward balance (`funds.start_balance`,
  `fund_finalizations.sonm_balance`), and the API exposes them as `{ date, forward_balance }` pairs.
- **"Balance on date D"**: includes every transaction up to *and on* D. Only returned from
  calculation methods (`fund.calculate_balance_on(db, date)`), never stored.
- The one exception: `fund_finalizations.eom_balance` is the balance on `eom_date` *excluding*
  eom_cleanup transactions — a surplus/loss history snapshot, NOT a reconciliation point.
- `Transaction.net_transfer` bounds (`since`/`until`) are both inclusive, so
  `balance_on(D) = forward_balance_entering(C) + net_transfer(since=C, until=D)`.
- Transactions may not predate a tracked fund's `start_date` (enforced at transaction creation).

### Model Pattern (`models/Base.js`)

Base class for all models with pattern:

**Static properties**:
- `PREPARED_STMTS`: Object mapping statement keys to SQL strings
- `PREPARED_TRANSACTIONS`: Object mapping transaction keys to functions
- `ORDER_BY_MAP`: Valid column names for ordering

**Statement caching**:
- `build_stmt(db, key, sql)`: Creates/retrieves cached prepared statement
- `get_stmt(db, key)`: Retrieves statement from PREPARED_STMTS
- Similar pattern for `build_transaction()` and `get_transaction()`

**Model methods**:
- `static create(db, {...})`: Creates new record, returns model instance
    - This method assumes inputs have been type checked, but the method will run consistency checks,
      and then db-related conflict/missing resource checks in a transaction.
- `static from_db(db, {...})`: Flexible query method with filtering
- `static for_id(db, id)`: Retrieves single record by ID
- `static from_row(row)`: Converts DB row to model instance
- `instance.to_api()`: Serializes for API response
- `instance.update(db, {...})`: Updates record
- `instance.delete(db)`: Deletes record

### Schema Hierarchy

**Funds** (`funds` table):
- Hierarchical structure via `parent_id` (self-referencing)
- Triggers prevent cycles in hierarchy
- `tracked=1` funds have `start_date`/`start_balance` (untracked funds must not); there is no
  stored running balance — balances are calculated from the cache point plus net transfers since
- `monthly=1` funds reset at end of month (requires parent_id and tracked=1)
- `finalization_id` references the most recent fund finalization; the model-level "cache"
  (`cached_date`/`cached_balance`) falls back to the start values (backdated to the first of the
  month) when the fund has never been finalized, so callers always have one place to look
- History-affecting fields (`start_date`, `start_balance`, `tracked`, `monthly`, a monthly fund's
  `parent_id`) are immutable while any finalizations exist (`fund.assert_unfinalized`)

**Transaction Groups** (`transaction_groups` table):
- Container for one or more related transactions
- May link to `bank_statement_items` via `statement_id`
- Has `date` field (YYYY-MM-DD)
- Has several denormalized values (`split`,`allocation`,`eom_cleanup`) for easier querying

**Transactions** (`transactions` table):
- Moves money from `source_fund_id` to `target_fund_id`
- Belongs to `transaction_groups` via `group_id`
- May link to `allocations` (via `allocation_id`) or `fund_finalizations` (via `eom_cleanup_id`)
- Date denormalized from group for query performance
- Zero amounts are allowed at the db/model level (needed for eom_cleanup transactions); USER
  transactions must be positive, enforced at the API layer

**Allocations** (`allocations` table):
- Scheduled fund contributions

**Month Finalizations** (`month_finalizations` table, `models/MonthFinalization.js`):
- Is the parent of the Fund Finalizations for bucketing into a single month
- Stores `som_date` (first day of month), `eom_date` (last day of month), and `sonm_date` (first
  day of next month) for easy querying; `UNIQUE(som_date)` prevents double-finalization
- `MonthFinalization.create(db, { month, recursive })` is the ONLY way to finalize: users work on
  months as a whole, never on individual funds. Months finalize contiguously (oldest first);
  `recursive: true` auto-finalizes intervening months
- Finalizing computes each tracked fund's eom balance, inserts one `eom_cleanup` transaction group
  zeroing every monthly fund into its parent (bottom-up through the hierarchy, so nested monthly
  parents include child inflows), and repoints `funds.finalization_id`
- `month.unfinalize(db)` reverses this, strictly LIFO (latest month only), and repoints funds at
  their previous finalization
- Once a month is finalized, no transaction groups may be added in (or before) it
- The server intentionally does NOT restrict finalizing the current/future month (timezone
  complications); a premature finalization can be unfinalized

**Fund Finalizations** (`fund_finalizations` table, `models/FundFinalization.js`):
- Historical record of end-of-month (excluding monthly budget cleanups) and start-of-next-month
  balances; managed internally by MonthFinalization (plus Fund creation backfill), never created
  directly
- Stores `eom_balance` (4 decimal) at end of `eom_date`. It does NOT include the "reset
  monthly-type funds to zero" cleanup transaction — its whole purpose is to track surplus/loss in
  monthly-type funds historically (`fund.finalization_history(db)`)
- Stores `sonm_balance` (4 decimal) entering `sonm_date` (denormalized onto this table), used to
  quickly reconcile a fund from a cached starting point
- `UNIQUE(month_id, fund_id)`; the most recent id is referenced on the funds table
- Tracked funds created with a `start_date` in/before finalized months are backfilled
  automatically (`eom = sonm = start_balance`); backdated monthly funds must start at 0

### YDate Class (`lib/YDate.js`)

Wrapper around dayjs for strict YYYY-MM-DD date handling:
- `YDate.parse(str)`: Returns YDate or null (validates exact format)
- `ydate.toString()`: Returns 'YYYY-MM-DD' string
- `ydate.toJSON()`: Returns 'YYYY-MM-DD' string
- `ydate.end_of_month()`: Returns YDate for last day of month
- `ydate.start_of_month()`: Returns YDate for first day of month
- `ydate.start_of_next_month()`: Returns YDate for first day of the next month
- `ydate.offset_days(days)`: Returns YDate offset by the given number of days

### Test Pattern

Tests use Mocha + Chai with in-memory SQLite:

```javascript
let db;
beforeEach(() => {
    db = create_connection({ path: ":memory:" });
    initialize_db(db)
});
```

Each test gets fresh database initialized with current schema.
