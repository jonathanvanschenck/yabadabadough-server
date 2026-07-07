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

### Scripts
- Create a user (bootstrap; no API yet): `node scripts/create-user.js <email> <password> [--admin]`
- Reset a password: `node scripts/create-user.js <email> <new-password> --set-password`

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

**SQL locality convention**: each model file owns ALL SQL against its table; cross-model
operations go through (possibly internal `_`-prefixed) model methods, never inline SQL at the
call site (e.g. Allocation edits groups only via `TransactionGroup._add_transaction` /
`_remove_transaction`). The only sanctioned exception: small inline guard queries against
*other* tables used solely to avoid circular requires (e.g. `month_is_finalized` in
TransactionGroup, `finalized_months_since` in Fund).

### Schema Hierarchy

**Funds** (`funds` table):
- Hierarchical structure via `parent_id` (self-referencing)
- Triggers prevent cycles in hierarchy
- `tracked=1` funds have `start_date`/`start_balance` (untracked funds must not); there is no
  stored running balance — balances are calculated from the cache point plus net transfers since
- `monthly=1` funds reset at end of month (requires parent_id, tracked=1, and a pool ancestor)
- `pool=1` funds are the source/sink of money for their descendants: allocations draw from the
  nearest pool ancestor, and monthly funds return their EOM balances directly to it (skipping
  intermediate non-pool funds). Pools require tracked=1 and monthly=0 (db CHECK). The "every
  monthly fund has a pool ancestor" invariant is hierarchy-global, enforced at the model layer
  on every fund create/update (plus: a monthly fund may not start before its pool ancestor).
  `fund.nearest_pool(db)` resolves the ancestor
- `finalization_id` references the most recent fund finalization; the model-level "cache"
  (`cached_date`/`cached_balance`) falls back to the start values (backdated to the first of the
  month) when the fund has never been finalized, so callers always have one place to look
- History-affecting fields (`start_date`, `start_balance`, `tracked`, `monthly`, `pool`, and the
  `parent_id` of any fund that is or contains a monthly fund) are immutable while any
  finalizations exist (`fund.assert_unfinalized`)

**Transaction Groups** (`transaction_groups` table):
- Container for one or more related transactions
- May be linked FROM `bank_statement_items` (via that table's `group_id`); groups hydrate a
  `statements` array on read (correlated subquery, like `transactions`), and `from_db` filters
  on `has_statements`. Linking happens only in `TransactionGroup.create_from_statements`;
  public `create` has no statement surface
- Has `date` field (YYYY-MM-DD)
- Has several denormalized values (`split`,`allocation`,`eom_cleanup`) for easier querying; the
  `allocation`/`eom_cleanup` flags are reserved for the internal Allocation / MonthFinalization
  paths — public `create` rejects them (at most one of the two, db CHECK)
- `group.delete(db)` removes a group and its transactions; the only guard is the finalized-month
  check (which inherently protects eom_cleanup groups — they only exist inside finalized months).
  `TransactionGroup.assert_month_unfinalized(db, date)` is the shared guard helper

**Transactions** (`transactions` table):
- Moves money from `source_fund_id` to `target_fund_id`
- Belongs to `transaction_groups` via `group_id`
- May link to `fund_finalizations` (via `eom_cleanup_id`)
- Date and `allocation` flag denormalized from group for query performance; a partial unique
  index on `(target_fund_id, date) WHERE allocation = 1` backstops
  one-allocation-per-fund-per-month
- Zero amounts are allowed at the db/model level (needed for eom_cleanup transactions); USER
  transactions must be positive, enforced at the API layer

**Bank Statement Items** (`bank_statement_items` table, `models/BankStatementItem.js`):
- One imported bank statement line, deduped on `(source, key)` — `key` is externally derived, so
  re-syncing via `BankStatementItem.import_many` never duplicates rows and NEVER updates existing
  ones (user state must survive re-syncs). Bank facts (`source`, `key`, `amount`, `date`) are
  immutable; only `ignored`/`note` are mutable (`item.update`)
- `amount` is signed (negative = money leaving that bank account) and is intentionally NEVER
  checked against the linked group's transaction amounts (transfers make any simple rule
  ambiguous)
- Always in exactly one of three derivable states: *pending* (`ignored = 0`, `group_id` NULL),
  *ignored* (`ignored = 1`), or *reconciled* (`group_id` set). Ignored+linked is impossible: a
  single-row db CHECK backstops the model-layer checks
- `group_id` lives on THIS table (not on `transaction_groups`) so transfer-type events — two
  items from two different bank imports (e.g. checking → savings) — can share one group. Linked
  via `TransactionGroup.create_from_statements(db, { statement_ids, ... })`: one id normally,
  both sides' ids for a transfer; group `date` defaults to the LATEST item date, `description`
  to the items' notes (fallback: keys)
- Unlinking only via group deletion (FK `ON DELETE SET NULL` releases items to pending) or
  `TransactionGroup.delete_statement_item(db, item, { with_group = true })`. Deletion lives on
  TransactionGroup (the with_group arm deletes a group in the same sqlite transaction, and the
  require direction is strictly TG → BSI); `item.delete()` is a throwing stub pointing there
- **Deletion hazard (by design, documented on the method)**: deleting is for undoing bad
  imports, NOT for hiding items (use `ignored`). `with_group` destroys the group's real
  transactions, and any deleted item REAPPEARS as pending on the next re-sync (its dedupe row
  is gone) — reconciling it again double-counts

**Allocations** (`models/Allocation.js` — intentionally NO table):
- A start-of-month transfer into a fund ("monthly" budgets and progressive saving), created
  immediately as a real transaction — no trigger step, no second copy of the amount
- Each month has at most ONE allocation transaction group (`allocation = 1`, dated the first of
  the month) holding one transaction per allocated fund; created lazily on the month's first
  allocation, deleted when the last is removed, `split` kept in sync
- The money comes from the target's nearest pool ancestor. `source_fund_id` is DERIVED, never
  snapshotted: hierarchy changes repoint allocations in unfinalized months
  (`Fund._rederive_allocation_sources`, which also rejects changes that would orphan one);
  finalized months keep their historical routing
- Managed exclusively through `Allocation.set` / `remove` / `for_month` / `for_fund` /
  `copy_month({ from, to, on_conflict: "error"|"merge"|"overwrite" })`; the model owns no table
  SQL — it composes TransactionGroup/Transaction methods
- Targets must be tracked, started by the first of the month (a fund starting mid-month cannot
  receive an allocation for that month — hard error by design; use an ordinary transaction group
  or backdate `start_date` to the 1st), and have a pool ancestor that has also started (pools
  under pools may receive allocations)
- Finalized months are immutable: allocations there cannot be set/removed/overwritten

**Month Finalizations** (`month_finalizations` table, `models/MonthFinalization.js`):
- Is the parent of the Fund Finalizations for bucketing into a single month
- Stores `som_date` (first day of month), `eom_date` (last day of month), and `sonm_date` (first
  day of next month) for easy querying; `UNIQUE(som_date)` prevents double-finalization
- `MonthFinalization.create(db, { month, recursive })` is the ONLY way to finalize: users work on
  months as a whole, never on individual funds. Months finalize contiguously (oldest first);
  `recursive: true` auto-finalizes intervening months
- Finalizing computes each tracked fund's eom balance, inserts one `eom_cleanup` transaction group
  zeroing every monthly fund directly into its nearest pool ancestor (no ordering or relaying —
  each monthly fund moves exactly its own eom balance, even when monthly funds nest), and
  repoints `funds.finalization_id`
- `month.unfinalize(db)` reverses this, strictly LIFO (latest month only), and repoints funds at
  their previous finalization
- Once a month is finalized, no transaction groups may be added in (or before) it
- The server intentionally does NOT restrict finalizing the current/future month (timezone
  complications); a premature finalization can be unfinalized

**Future direction — hierarchy restructuring / snapshotting** (not supported today): routing
(pool flags, parents of monthly funds) is currently write-once against history — changing it
requires unfinalizing all the way back and rewriting history as if the hierarchy had always
looked that way. Eventually we want point-in-time hierarchy changes ("X stops being a pool as of
month M") without rewriting earlier months, applied consistently to finalizations and
allocations.

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

**Users** (`users` table, `models/User.js`):
- Email is normalized (lowercase + trim) at every model boundary and stored normalized, so the
  column `UNIQUE` gives case-insensitive uniqueness. Minimal format check (contains `@`);
  passwords are min 8 chars, enforced in `create`/`set_password`
- Passwords are salted scrypt hashes (node built-in crypto, no deps) stored as ONE
  self-describing string: `scrypt$N$r$p$salt_b64$hash_b64`. Verification parses params from the
  stored string (not code constants), so cost can be raised later without invalidating existing
  hashes. `to_api` NEVER includes `password_hash`
- `update` handles only `email`/`admin`; passwords change via `set_password` (fresh salt).
  Password changes deliberately do NOT revoke sessions — that's API-layer policy (one
  `Session.revoke_all` call). `User.authenticate` returns `User | null` and burns a dummy scrypt
  verify on unknown emails (user-enumeration timing resistance). No last-admin guard by design
- JWT payloads (signing/verification is future API-controller work; the model only renders
  payload objects, with `typ` + `v` claims discriminating kinds):
  - access (~1h, `User.ACCESS_TOKEN_TTL_S`, stateless): `{ v, typ: "access", sub, email, admin, sid }`
  - auth (~1w, session-bound): `{ v, typ: "auth", sub, sid, token }`
  Rendered by `user.to_access_token_payload(session)` / `to_auth_token_payload(session)`;
  `User.from_token_payload(payload)` is the db-free inverse for access payloads (unsaved
  instance, `admin` may be ~1h stale — use `for_id` when freshness matters). NOTHING may assume
  `sid` is non-null: future API-key credentials will mint access tokens with no session
- Bootstrap via `scripts/create-user.js` (also the forgotten-password recovery path)

**Sessions** (`user_sessions` table, `models/Session.js`):
- A session row IS the right to refresh: refreshable iff the row exists and `expires_at` is in
  the future. Logout (`session.delete`) and revoke-all (`Session.revoke_all(db, user_id)`) are
  row deletions — no revoked flag. `Session.prune` reclaims expired rows
- `token` is a per-session random secret (16 bytes hex) embedded in the auth payload and
  required to match (timing-safe) at refresh — defends against sqlite id reuse and is the hook
  for future refresh-token rotation. NEVER in `to_api`
- `Session.for_auth_payload(db, payload)` is the refresh guard: checks `typ`/`v`, row exists,
  secret matches, `sub` owns the session, not expired; touches `last_used_at`; returns the
  fresh Session. Expiry is FIXED at creation (`ttl_days`, default `Session.DEFAULT_TTL_DAYS` =
  7) — refreshes never extend it (no sliding window in v1)
- Require direction is strictly `Session → User` (user existence via FK, mapped to
  `ForeignKeyError`); `User` never requires `Session` — list a user's sessions via
  `Session.from_db(db, { user_id, active })`. User deletion cascades sessions at the db layer
- Accepted staleness window (by design): access tokens are stateless, so logout / revoke-all /
  admin changes / user deletion do not kill OUTSTANDING access tokens — they die at their ≤1h
  expiry. Controllers guarding sensitive actions can re-check with `User.for_id` /
  `Session.for_id`

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
