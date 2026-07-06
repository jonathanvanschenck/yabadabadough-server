# Finalizations

Finalizations exist to do 3 main things:

1. Cache `sonm_balance`s so that recalculating fund balances has a cached point to calculate
   against, rather than having to always start from the start of the fund.
2. Indicate that all transactions up to a point have been accounted for in the system.
3. Historically track surplus/loss in monthly-type funds (which zero out at the start of each
   month) via `eom_balance`.


## Date & balance conventions

These conventions apply everywhere (db columns, model methods, API):

- **"Forward balance entering date D"**: the balance including every transaction *before* D, but
  NOT including any transactions on D itself. Every cached/stored balance in the system is a
  forward balance:
    - `funds.start_balance` is the forward balance entering `funds.start_date`.
    - `fund_finalizations.sonm_balance` is the forward balance entering `sonm_date` (it DOES
      include eom_cleanup transactions, which are dated `eom_date`).
    - Over the API, all cached values are exposed as `{ date, forward_balance }` pairs.
- **"Balance on date D"**: the balance including every transaction up to *and on* D. This is what
  users get from `calculate_balance_on(db, date)`, and it is the only thing we call a plain
  "balance".
- The two relate by: `balance_on(D) = forward_balance_entering(C) + net_transfer(since=C, until=D)`
  where both bounds of `net_transfer` are **inclusive** (which matches the existing
  `Transaction.net_transfer` implementation). Equivalently, `sonm_balance` is the "balance on
  `eom_date`".
- **The one exception**: `fund_finalizations.eom_balance` is the balance on `eom_date` *excluding*
  eom_cleanup transactions. It is not usable as a reconciliation point; its whole purpose is to
  historically record surplus/loss in monthly-type funds before they were zeroed out.
- Transactions may not be dated before a tracked fund's `start_date` (enforced at transaction
  creation). This is what makes it safe to backdate the fallback cache date to the start of the
  month (see "Fund balance calculation" below).


## Schema changes

We are NOT writing a migration -- edit `db/migrations/_schema.sql` directly (dev database will be
rebuilt). Changes:

- **`funds`**:
    - Remove the `balance` column entirely (see "Fund balance calculation").
    - Replace the tracking CHECK with a symmetric consistency check: tracked funds MUST have
      `start_date` and `start_balance`; untracked funds MUST NOT have either:
      ```sql
      CHECK (
          (tracked = 1 AND start_date IS NOT NULL AND start_balance IS NOT NULL)
          OR (tracked = 0 AND start_date IS NULL AND start_balance IS NULL)
      )
      ```
- **`fund_finalizations`**:
    - Denormalize `sonm_date TEXT NOT NULL` onto the table (copied from the parent
      `month_finalizations` row) so the funds cache join and "cache before date" lookups don't
      need a second join.
    - Add `UNIQUE(month_id, fund_id)` -- a fund can only be finalized once per month.
    - Add index on `(fund_id, sonm_date)` for "latest cache before date" lookups.
- **`month_finalizations`**:
    - Add `UNIQUE(som_date)` -- a month can only be finalized once.
- **`transactions`**:
    - Relax `CHECK (amount > 0)` to `CHECK (amount >= 0)`. Zero-amount transactions are needed so
      that every monthly fund gets an eom_cleanup transaction each month, even when its balance is
      already zero. USERS should still never create zero-amount transactions -- that will
      eventually be enforced at the API layer, not in the db.


## Month Finalizations

A month can be "finalized" (triggered by the user, *not* automatically), meaning all tracked funds
in that month are finalized. Finalization is orchestrated by a dedicated `MonthFinalization` model
-- users work on months as a whole and never finalize/unfinalize individual funds, in the same way
a user never inserts a raw transaction directly but only a transaction group.

At finalization time, if any of the finalized funds are monthly-type, a single new transaction
group is inserted with the `eom_cleanup` flag set (dated `eom_date`) so that all of the
eom_cleanup transactions for the month stay bundled. Every monthly fund gets exactly one cleanup
transaction in this group, even when the cleanup amount is zero.

Months must be finalized contiguously: the month being finalized must immediately follow the
latest finalized month (or, if nothing has been finalized yet, be the earliest month in which any
tracked fund starts). Both workflows are supported:

1. Default: throw an error if previous months are not finalized.
2. `recursive: true`: automatically finalize prior months first, oldest to newest, back to the
   contiguity point.

The server does NOT enforce literal time constraints (e.g. "you can't finalize the current
month"). Timezones make that complicated, and a premature finalization can always be undone by
unfinalizing.


## Fund Finalizations

When a fund is finalized as part of a month finalization:

1. Its balance on `eom_date` (excluding any cleanup transactions) is computed from its current
   cache point (see fallback logic below) and stored as `eom_balance`.
2. If it is a monthly-type fund, a cleanup transaction is added that zeros the fund out into its
   parent (part of the month's single `eom_cleanup` transaction group). Direction depends on sign:
   surplus flows fund -> parent, deficit flows parent -> fund, and a zero balance gets a
   zero-amount transaction (fund -> parent) so the record always exists.
3. The fund's forward balance entering `sonm_date` (i.e. *including* cleanup transactions) is
   stored as `sonm_balance`.
4. `funds.finalization_id` is updated to point at the new `fund_finalizations` row.

Tracked funds whose `start_date` is after `eom_date` have not started yet and are skipped.
Untracked funds are never finalized.

**Nested monthly funds**: a monthly fund's parent may itself be monthly. Cleanup amounts must be
computed bottom-up through the fund hierarchy (deepest children first), so that a monthly parent's
cleanup amount includes the cleanup inflows from its monthly children. This guarantees
`sonm_balance = 0` for every monthly fund.

**sonm is computed analytically, not re-queried**: `sonm_balance` is NOT NULL, and the cleanup
transactions that affect it reference the `fund_finalizations` rows (`transactions.eom_cleanup_id`),
so the finalization rows must be inserted *before* the cleanup transactions exist. Rather than
insert-then-update, compute sonm at insert time:

- monthly fund: `sonm_balance = 0`
- any other fund: `sonm_balance = eom_balance + (incoming cleanup amounts) - (outgoing cleanup amounts)`

This is safe because the entire month finalization runs inside a single sqlite transaction --
nothing can interleave between computing the balances and inserting the cleanup transactions. The
source MUST carry comments calling out that the insert order here is load-bearing and must not be
reordered.


## Unfinalizations

Once a month has been finalized, no transactions/transaction groups dated in that month (or any
previous month) may be added or removed. To modify a previously finalized month, it must first be
unfinalized.

Unfinalization is strictly **LIFO**: only the most recent finalized month may be unfinalized
(otherwise the contiguous chain of cache points would have gaps). Unfinalizing a month, inside a
single sqlite transaction:

1. Verify it is the latest `month_finalizations` row; error otherwise.
2. Delete the cleanup transactions referencing this month's `fund_finalizations` rows, then the
   `eom_cleanup` transaction group. (Order matters: `transactions.eom_cleanup_id` is
   `ON DELETE RESTRICT`, so the transactions must go before the finalization rows.)
3. Delete the `month_finalizations` row (its `fund_finalizations` rows go via `ON DELETE CASCADE`;
   `funds.finalization_id` is nulled automatically via `ON DELETE SET NULL`).
4. **Repoint** each affected fund's `finalization_id` at its `fund_finalizations` row for the
   previous month, or leave NULL if none exists (fund is back to its start values).


## Enforcement rules

- **No transactions in finalized months**: `TransactionGroup.create` errors if the group's date is
  <= the latest `month_finalizations.eom_date`. (Deletion in finalized months must likewise be
  blocked when delete is implemented.) The eom_cleanup group created *during* finalization is
  itself dated inside the month being finalized, so `MonthFinalization` calls an internal
  unguarded create variant -- the source must carry comments explaining why the guard is skipped
  there (the whole finalization is one sqlite transaction, so the "finalized" state and the
  cleanup group land atomically).
- **No transactions before a fund starts**: transaction creation errors if the transaction date
  precedes the `start_date` of a tracked source or target fund. (This protects `start_balance`
  semantics and makes the backdated fallback cache date valid.)
- **No rewriting history under a finalization**: fields that affect historical balances --
  `start_date`, `start_balance`, `tracked`, `monthly`, and `parent_id` (when the fund is monthly,
  since past cleanups flowed to the old parent) -- are immutable while any `fund_finalizations`
  rows exist for the fund. This is safeguarded by a single dedicated guard method (e.g.
  `fund.assert_unfinalized(db)`) that `update()`/`delete()` call whenever a history-affecting
  change is requested. The user workflow for such a change is: unfinalize back to the fund's
  start, make the change, re-finalize up to the present.
- To avoid circular `require()`s, lower-level models (`Fund`, `TransactionGroup`) implement these
  guards with their own inline prepared statements against the finalization tables rather than
  requiring `MonthFinalization`.


## Fund balance calculation

The `balance` column is removed from the funds table. Users query for the balance on a certain
date (or calculate it themselves) instead.

**Cache fallback**: the fund API's `cache` value falls back to the starting values when the fund
has never been finalized, so callers always have exactly one place to look:

- finalized:   `cache = { date: sonm_date, forward_balance: sonm_balance }`
- never finalized: `cache = { date: start_of_month(start_date), forward_balance: start_balance }`

The fallback `date` is backdated to the first of the month so that the cache date is *always* a
first-of-month. This is valid only because transactions cannot predate `start_date` (enforced
above) -- there is nothing between the first of the month and `start_date` to miss.

**Fund query helpers** to add:

- `calculate_balance_on(db, date)`: balance on `date` (inclusive), computed as
  `cache.forward_balance + net_transfer(since = cache.date, until = date)` using the best cache
  point at or before `date`. Dates before `start_date` error.
- `calculate_balance(db)`: current balance = cache + net transfer since cache date, unbounded.
- `cached_forward_balance_before(db, date)`: the `{ date, forward_balance }` cache point
  immediately at-or-before the provided date (equivalently the "forward balance for month X"),
  using the same fallback logic.
- `finalization_history(db, {...})`: the fund's `fund_finalizations` rows (via the
  `FundFinalization` model), supporting the surplus/loss tracking workflow for monthly funds via
  `eom_balance`.


## Edge cases and subtleties

- **Backdated fund creation**: if a new tracked fund is created with a `start_date` in or before an
  already-finalized month, fund creation backfills `fund_finalizations` rows (inside the creation
  transaction) for every finalized month from the fund's start month forward, so the fund's
  finalization point matches every other fund. Since the fund is new and transactions cannot
  predate `start_date` (and cannot be added to finalized months at all), every backfilled row is
  simply `eom_balance = sonm_balance = start_balance`. No cleanup transactions are inserted --
  finalized months' transaction groups are immutable.
- **Backdated monthly funds must start at zero**: for a monthly fund the backfilled rows must
  satisfy `sonm_balance = 0`, which is only consistent if `start_balance = 0`. Creation of a
  monthly fund backdated past a finalization therefore errors unless `start_balance` is 0. The
  source must carry a comment explaining this gotcha.
- **Monthly conversion**: a fund may not be converted between `monthly` and `not monthly` (nor have
  the other history-affecting fields changed -- see enforcement rules) without unfinalizing back to
  the start of that fund and re-finalizing back up to the present.


## API conventions

- All cached values are exposed as `{ date, forward_balance }` objects (e.g. `fund.start`,
  `fund.cache`), making the "entering the date, exclusive" semantics explicit in the field name.
- "Balance" (unqualified) always means "balance on a date, inclusive of that date's transactions"
  and is only returned from the calculation methods, never stored.
- `eom_balance` keeps its name on the finalization API but is documented as the pre-cleanup
  snapshot used for surplus/loss history, not a reconciliation point.


---

# Implementation plan

Each step should land with its tests passing (`npm test`). In-memory sqlite test pattern per
CLAUDE.md.

## Step 1 -- Schema (`db/migrations/_schema.sql`)

1. `funds`: drop `balance` column; replace tracked CHECK with the symmetric
   tracked-implies-start / untracked-implies-no-start CHECK above.
2. `transactions`: `CHECK (amount >= 0)`.
3. `fund_finalizations`: add `sonm_date TEXT NOT NULL`, `UNIQUE(month_id, fund_id)`, and index
   `idx_fund_finalizations_fund_id_sonm_date ON fund_finalizations(fund_id, sonm_date)`.
4. `month_finalizations`: add `UNIQUE(som_date)`.
5. Leave `PRAGMA user_version = 1` (no migration; fresh schema only).

## Step 2 -- Small fixes (no behavior change)

1. `models/Transaction.js`: fix stale table name `fund_eom_finalizations` ->
   `fund_finalizations` in the `eom_cleanup_exists` statement.
2. `models/Fund.js`:
    - constructor: `this.cached_balance = cached_balance; this.cached_date = cached_date;`
      (currently assigns to `this.calculate_balance`/`this.calculate_date`, clobbering the
      `calculate_balance` method).
    - `from_row()`: pass `cached_balance`/`cached_date` through (converted).
    - `to_api()`: fix inverted `root: !!this.parent_id` -> `root: !this.parent_id`.
    - `finalize_month()` stub: will be removed in Step 6 (orchestration moves to
      `MonthFinalization`).
3. `CLAUDE.md`: fix `fund_eom_finalizations` reference; update funds description ("tracked=1
   funds maintain running balance" -> balance is calculated, not stored); document the
   forward-balance date conventions briefly.

## Step 3 -- Remove `funds.balance` + cache fallback (`models/Fund.js`)

1. Remove `balance` from `SELECT_COLUMNS`, constructor, `from_row`, `to_api`, and the `create`
   INSERT.
2. Update the finalization join to select `fund_finalizations.sonm_balance AS cached_balance`
   and `fund_finalizations.sonm_date AS cached_date` (was incorrectly `eom_balance`/`eom_date`).
3. Implement cache fallback in the model layer: when `finalization_id` is NULL, `cache` falls
   back to `{ date: start_date.start_of_month(), forward_balance: start_balance }` (backdating
   per the conventions section). `to_api()` emits `start` and `cache` as
   `{ date, forward_balance }`; untracked funds emit `start: null, cache: null`.
4. Rework `calculate_balance_on(db, date)` to compute from the cache point at-or-before `date`
   (falling back to start values); error for dates before `start_date`. Implement
   `calculate_balance(db)` and `cached_forward_balance_before(db, date)`.
5. Tests: `test/models/test-fund.js` -- fallback cache shape/backdating, balance-on-date math
   against known transactions, pre-start-date errors, untracked funds.

## Step 4 -- Transaction guards

1. `models/Transaction.js` `_create_with_group`:
    - relax `amount <= 0` throw to `amount < 0` (zero allowed internally; API-level positivity
      for user input comes later, per plan).
    - add prepared stmt checking that for each tracked source/target fund,
      `@date >= funds.start_date`; throw `ConflictError` otherwise.
2. `models/TransactionGroup.js`:
    - add inline prepared stmt `month_is_finalized`:
      `SELECT 1 FROM month_finalizations WHERE eom_date >= @date LIMIT 1`.
    - public `create()` errors when the group date falls in a finalized month.
    - keep `_create` (the inner transaction body) unguarded; `MonthFinalization` will call it
      directly for the eom_cleanup group, with comments at both sites explaining that the guard
      is intentionally skipped because the cleanup group is part of the finalization's own sqlite
      transaction.
3. Tests: `test/models/test-transaction-group.js` / `test-transaction.js` -- reject groups dated
   in finalized months, reject transactions predating a fund's start_date, allow zero-amount via
   internal path.

## Step 5 -- `models/FundFinalization.js` (new)

Read-mostly model following the Base pattern:

1. `from_row`, `for_id`, `to_api` (exposing `month_id`, `fund_id`, `eom_balance`, and
   `sonm: { date, forward_balance }`).
2. `from_db(db, { fund_id, month_id, since, until, ... })` for history queries.
3. Internal `_create` used only by `MonthFinalization`/`Fund` backfill (no public `create` --
   users never finalize funds directly).
4. Tests: `test/models/test-fund-finalization.js` -- query/serialization round-trips.

## Step 6 -- `models/MonthFinalization.js` (new)

The orchestrator; requires `Fund`, `FundFinalization`, `TransactionGroup` (nothing requires it
back).

1. `for_id`, `from_db`, `latest(db)`, `from_row`, `to_api`.
2. `create(db, { month, recursive = false })` where `month` is any `YDate` in the target month.
   Inside one sqlite transaction (`build_transaction`):
    1. Compute `som/eom/sonm` from `month` (via `YDate` helpers).
    2. Contiguity check: latest finalization's `sonm_date` must equal this `som_date`. If there is
       a gap: error, or recurse oldest-first when `recursive`. If nothing is finalized yet, the
       target month must be the earliest start month among tracked funds (recursion bottoms out
       there); finalizing a month before any tracked fund starts errors.
    3. Select tracked funds with `start_date <= eom_date`.
    4. Batch-compute each fund's balance on `eom_date` from its cache point
       (`Transaction.net_transfers`, `since = cache date`, `until = eom_date`).
    5. Compute cleanup amounts bottom-up through the hierarchy (children before parents) so
       nested monthly parents include child cleanup inflows; derive each fund's `sonm_balance`
       analytically (monthly -> 0; others -> eom + net cleanup flow).
       // ORDER IS LOAD-BEARING: sonm values are computed before the cleanup transactions
       // exist; safe only because this all happens in one sqlite transaction. Do not reorder.
    6. Insert the `month_finalizations` row, then `fund_finalizations` rows (with `sonm_date`
       denormalized).
    7. If any monthly funds were finalized, insert the single `eom_cleanup` transaction group
       (dated `eom_date`) via `TransactionGroup._create` (unguarded -- see Step 4 comments),
       one transaction per monthly fund with `eom_cleanup_id` set, zero amounts allowed.
    8. Update `funds.finalization_id` for every finalized fund.
3. `unfinalize(db)` / `delete(db)`, inside one sqlite transaction:
    1. Assert this is the latest finalization (LIFO); error otherwise.
    2. Delete cleanup transactions, then the eom_cleanup group (RESTRICT ordering).
    3. Delete the month row (fund rows CASCADE; `funds.finalization_id` SET NULL).
    4. Repoint each affected fund's `finalization_id` to its previous month's
       `fund_finalizations` row (single UPDATE-from-subquery using the `(fund_id, sonm_date)`
       index), leaving NULL where none exists.
4. Tests: `test/models/test-month-finalization.js` -- the big one:
    - single-month finalize: eom/sonm values, cleanup group contents, `finalization_id` pointers.
    - monthly surplus, deficit, and zero-balance cleanup directions/amounts.
    - nested monthly funds (bottom-up cleanup).
    - funds started mid-month and funds not yet started (skipped).
    - contiguity: gap errors without `recursive`, succeeds with it; double-finalize errors
      (UNIQUE som_date).
    - transaction-group guard: inserts blocked in/before finalized months, allowed after.
    - unfinalize: LIFO enforcement, cleanup group removal, `finalization_id` repointing across
      multiple months, full unfinalize back to start restores fallback cache.
    - balance calculation from cache equals balance calculated from scratch.

## Step 7 -- Fund creation backfill + history guard (`models/Fund.js`)

1. In `_create`: if tracked and `start_date`'s month is at or before the latest finalized month,
   insert backfilled `fund_finalizations` rows (`eom = sonm = start_balance`) for each finalized
   month from the fund's start month forward, and set `finalization_id` to the latest one.
   // Monthly gotcha: backfilled monthly funds must have start_balance = 0, since sonm_balance
   // must be 0 and finalized months' transaction groups are immutable (no cleanup transactions
   // can be added retroactively). Error otherwise.
2. Add `assert_unfinalized(db)` guard; implement `update(db, ...)` so that history-affecting
   fields (`start_date`, `start_balance`, `tracked`, `monthly`, `parent_id`-when-monthly) call
   the guard, while safe fields (`name`, `color`, `note`-like) do not. `delete(db)` also guards.
3. Implement `finalization_history(db, {...})` delegating to `FundFinalization.from_db`.
4. Tests: backfill for plain and monthly funds (incl. the start_balance=0 requirement), guard
   rejects history edits on finalized funds and allows them after full unfinalization, safe-field
   updates always allowed.

## Step 8 -- Docs sweep

Update `CLAUDE.md`: new models, date/balance conventions, finalization lifecycle (finalize /
unfinalize LIFO / backfill), and the removal of `funds.balance`.
