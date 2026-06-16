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
- `tracked=1` funds maintain running balance
- `monthly=1` funds reset at end of month (requires parent_id and tracked=1)
- `last_som_cache_id` references most recent start-of-month balance cache for rapid reconciliation

**Transaction Groups** (`transaction_groups` table):
- Container for one or more related transactions
- May link to `bank_statement_items` via `statement_id`
- Has `date` field (YYYY-MM-DD)

**Transactions** (`transactions` table):
- Moves money from `source_fund_id` to `target_fund_id`
- Belongs to `transaction_groups` via `group_id`
- May link to `allocations` or `fund_eom_finalizations`
- Date denormalized from group for query performance

**Allocations** (`allocations` table):
- Scheduled fund contributions

**Fund SOM Cachings** (`fund_som_cachings` table):
- Caches start-of-month balances for tracked funds
- Enables rapid balance reconciliation when new transactions are inserted
- Each record stores `som_balance` (4 decimal) at a specific `date` (first day of month)
- Funds link to most recent cache via `funds.last_som_cache_id`

**Fund EOM Finalizations** (`fund_eom_finalizations` table):
- Historical record of end-of-month balances for monthly funds
- Stores `eom_balance` (4 decimal) at `date` (last day of month)
- Used for historical reference rather than active reconciliation

### YDate Class (`lib/YDate.js`)

Wrapper around dayjs for strict YYYY-MM-DD date handling:
- `YDate.parse(str)`: Returns YDate or null (validates exact format)
- `ydate.toString()`: Returns 'YYYY-MM-DD' string
- `ydate.toJSON()`: Returns 'YYYY-MM-DD' string
- `ydate.end_of_month()`: Returns YDate for last day of month
- `ydate.start_of_month()`: Returns YDate for first day of month

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
