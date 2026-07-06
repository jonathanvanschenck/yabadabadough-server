# Allocations Implementation Plan

## Summary of decisions

1. **Drop the `allocations` table entirely.** An allocation *is* a transaction inside the
   month's single allocation transaction group (`allocation = 1`), dated at the start of the
   month. There is no second copy of the amount anywhere, and no "trigger" step. A new
   `models/Allocation.js` orchestrator (no table of its own, like how `MonthFinalization`
   orchestrates without users touching `FundFinalization`) provides the dedicated
   set/remove/copy interface.
2. **One transaction group per month** holding all of that month's allocations — mirroring
   the eom_cleanup pattern, and matching the intended webapp representation (the month's
   allocations render as one group). We accept the added edit complexity: allocations are
   added/replaced/removed inside the live group via new *internal methods on
   `TransactionGroup`* (which also keep the denormalized `split` flag in sync) — all table
   SQL stays in its owning model file; `Allocation` only composes model methods.
3. **Adopt the "source and sink" fund flag, named `pool`.** Monthly funds clean up directly
   to their nearest pool ancestor (no more depth-ordered cascade), and allocations draw from
   the nearest pool ancestor.
4. **Allocation sources are derived, not snapshotted.** `source_fund_id` on an allocation
   transaction is a denormalized value meaning "the target's nearest pool ancestor" — exactly
   as eom_cleanup routing is a pure function of the current hierarchy, re-derived when
   history is rerun. When the hierarchy changes, allocation transactions in *unfinalized*
   months are re-pointed at the new nearest pool; finalized months are immutable as always.
   (True snapshotting — "restructuring fund hierarchies" at a point in time without
   rewriting history — is an intended future feature; see below.)

---

## Decision 1: Drop the `allocations` table

Once an allocation immediately creates its transaction, the table holds nothing that the
transaction doesn't already hold:

| `allocations` column | Where it lives instead                          |
|----------------------|-------------------------------------------------|
| `fund_id`            | `transactions.target_fund_id`                   |
| `date`               | `transactions.date` / `transaction_groups.date` |
| `amount`             | `transactions.amount`                           |

Keeping the table would mean: a sync obligation between `allocations.amount` and
`transactions.amount` (the exact dual-bookkeeping we want to avoid), a `RESTRICT` FK dance on
delete, and a model whose every method is "do the thing to the transaction, then mirror it."
The only future feature a dedicated table would serve is a *recurring allocation template*
("every month, $400 to Groceries automatically") — and if that ever happens it wants a new,
differently-shaped table (fund, amount, recurrence rule) anyway, not this one. YAGNI.

**What identifies an allocation after the drop:**
- `transaction_groups.allocation = 1` (column already exists) — exactly one such group per
  month (enforced at the model layer; the group is created lazily on the month's first
  allocation and deleted when its last allocation is removed).
- A new denormalized `transactions.allocation` boolean (same pattern as the denormalized
  `transactions.date`), replacing `transactions.allocation_id`. This keeps per-fund
  allocation history queries join-free and lets a partial unique index enforce
  one-allocation-per-fund-per-month at the db level (all of a month's allocations share the
  group's som date, so uniqueness on `(target_fund_id, date)` is precisely per-month).

**The one-group-per-month shape** (vs. one group per allocation) costs us in-place group
editing that the codebase currently avoids ("delete and re-create" is the standing policy).
That editing machinery lives entirely in `TransactionGroup` as new internal methods
(`_add_transaction`, `_remove_transaction`, `_sync_split`) — **all SQL that touches the
`transaction_groups`/`transactions` tables stays in the TG/Transaction model files**, and
`Allocation` composes those methods without writing table SQL of its own. Group internals:
insert/replace/delete a transaction inside the live group, keep `split = (count > 1)` true
after every mutation, and drop the group entirely when it empties (groups hold ≥ 1
transaction). Every mutation runs inside a sqlite transaction with the finalized-month guard
applied via a shared `TransactionGroup.assert_month_unfinalized` helper (wrapping the
existing `month_is_finalized` stmt).

## Decision 2: The `pool` flag

- **It fixes a real gap.** Allocated money must come from somewhere, and "direct parent" is
  wrong whenever the hierarchy contains organizational/untracked funds between a budget and
  the account that actually holds the money. The flag marks the "real money" level explicitly.
- **It genuinely simplifies finalization.** Today's eom cleanup walks monthly funds bottom-up
  so nested monthly parents relay their children's inflows upward. With pools, every monthly
  fund sends exactly its own `eom_balance` straight to its nearest pool ancestor: no ordering,
  no relaying, no `depth_of`. The pool receives the same total either way; every monthly fund
  still lands at `sonm_balance = 0`; `eom_balance` semantics (excluding cleanups) are
  untouched. The two schemes are balance-equivalent — the new one is just simpler.
- **Symmetry.** Allocations flow pool → fund at start of month; cleanups flow fund → pool at
  end of month. One concept explains both directions.
- **Intended behavior change:** a monthly fund under a tracked non-monthly parent used to
  roll its surplus *into that parent*; under the pool rule the surplus bypasses it and lands
  in the pool above. To route surplus into an intermediate fund, mark it as a pool — which
  also, consistently, makes it the source of its children's allocations.

### Derived routing (no snapshots) and the future "restructuring" feature

All pool routing — eom cleanups *and* allocation sources — is a pure function of the current
hierarchy:

- **Finalized months**: immutable, as always. Their cleanup and allocation transactions keep
  whatever routing was in effect when they were written. Rerunning history (unfinalize →
  change hierarchy → re-finalize) regenerates cleanups with the new routing.
- **Unfinalized months**: allocation transactions are actively kept consistent. After any
  fund change that can affect pool resolution (a `parent_id` change or `pool` toggle), every
  allocation transaction dated after the last finalized month is re-derived:
  `source_fund_id = nearest pool ancestor of target`. If any target no longer resolves to a
  pool (or resolves to a pool whose `start_date` is after the allocation date), the change
  throws `ConflictError` — this is the allocation-orphan guard, symmetric with the monthly-
  fund orphan guard below.

**Documented future feature — hierarchy restructuring / snapshotting.** Today, any
routing-affecting attribute is effectively write-once against history: once a fund has ever
been a pool inside finalized months, un-pooling it means unfinalizing all the way back and
rewriting history as if it had never been a pool. Eventually we want to support declaring
hierarchy changes *at a point in time* (fund X stops being a pool as of month M; subtree Y
re-parents as of month M) without rewriting earlier months — i.e. snapshotting routing
per-month for finalizations and allocations consistently. That is out of scope here; this
plan should leave a note in `CLAUDE.md` marking it as intended direction.

**Invariants:**
- `pool = 1` requires `tracked = 1` and `monthly = 0` (db CHECK).
- A monthly fund must have a pool ancestor (hierarchy-global, enforced at the model layer;
  the db-level `parent_id IS NOT NULL` CHECK stays as a cheap backstop).
- An allocation's target must be tracked and have a pool ancestor. The target may itself be
  a pool (a pool that is a child of a pool can receive allocations — progressive saving into
  a sub-pool). Allocations to a root pool are impossible (no source) — outside money arrives
  via ordinary transactions, as today.
- Toggling `pool` is history-affecting → `assert_unfinalized` (past cleanups/allocations
  routed through it).
- Re-parenting is history-affecting when it can change *finalized* cleanup routing: if the
  moved fund is monthly **or has a monthly descendant**, `assert_unfinalized` applies (this
  generalizes the existing "a monthly fund's parent is part of its history" rule).
  Re-parenting purely organizational subtrees stays free; unfinalized allocations under a
  moved subtree are re-derived, not blocked (see above).
- **Orphan guards:** after any fund create/update (parent change, pool toggle, monthly
  toggle), (a) re-verify the global invariant "every monthly fund has a pool ancestor" with
  one recursive CTE, and (b) run the allocation re-derivation described above. Data volume is
  tiny; global checks are simpler and safer than computing the affected subtree.

---

## Schema changes (`db/migrations/_schema.sql` — edited in place, no migration)

### `funds`
```sql
pool              INTEGER NOT NULL DEFAULT 0
                    CHECK (pool IN (0,1)),
...
-- pools hold real money and are never monthly
CHECK (
    pool = 0
    OR (tracked = 1 AND monthly = 0)
),
```
Plus `CREATE INDEX idx_funds_pool ON funds(pool);`

### `allocations`
Delete the table and its two indexes. Delete `transactions.allocation_id` (+ index).

### `transaction_groups`
- Fix the copy-paste comment on `eom_cleanup` (it currently says "is intended as an
  allocation transaction").
- Add `CHECK (NOT (eom_cleanup = 1 AND allocation = 1))`.

### `transactions`
```sql
-- DENORMALIZED VALUES:
date                TEXT NOT NULL,
-- copied from parent group, marks this transaction as an allocation
allocation          INTEGER NOT NULL DEFAULT 0 CHECK (allocation IN (0,1)),
```
And a db-level backstop for one-allocation-per-fund-per-month (all of a month's allocations
share the group's som date):
```sql
CREATE UNIQUE INDEX idx_transactions_allocation_unique
    ON transactions(target_fund_id, date) WHERE allocation = 1;
```
`PRAGMA user_version` stays at 1 (fresh-schema only; the backup db predates this and is
expected to be recreated).

---

## Model changes

### `models/Fund.js`
- Plumb `pool` through `SELECT_COLUMNS`, constructor, `from_row`, `to_api` (under
  `status.pool`), `from_db` filter, `create`, `_create`, `_update`.
- New prepared stmts (funds-table SQL only — the transactions-side statements for
  re-derivation live in `Transaction.js`, see below):
  - `nearest_pool_ancestor`: recursive CTE walking `parent_id` upward from a fund, returning
    the first row with `pool = 1` (id + start_date).
  - `monthly_without_pool_exists`: recursive CTE verifying the global monthly invariant
    (returns a violating monthly fund id, if any).
- New instance method `nearest_pool(db)` → `Fund` or `null` (used by MonthFinalization and
  Allocation).
- `create`/`_create`: consistency checks — `pool` requires `tracked` and not `monthly`
  (mirroring the CHECKs with friendly errors); `monthly` requires a pool ancestor; pool
  ancestor's `start_date` must be ≤ the monthly fund's `start_date` (see Edge Cases).
- `_update`:
  - Extend `history_affected` with `next.pool !== fund.pool`, and widen the parent-change
    clause from "fund is/was monthly" to "fund is/was monthly OR has a monthly descendant".
  - After the update, when `parent_id` or `pool` changed: run the global monthly orphan
    guard, then re-derive `source_fund_id` for every unfinalized allocation transaction —
    loop in JS over `Transaction._unfinalized_allocations(db)` using `nearest_pool`,
    repointing via `Transaction._set_source(db, ...)` (both new internal methods on
    Transaction; Fund already requires Transaction, and no transactions-table SQL lands in
    Fund.js). Throw `ConflictError` if any target loses its pool or the new pool starts
    after the allocation's date.
- Update the `assert_unfinalized` doc comment to mention `pool`.

### `models/MonthFinalization.js`
- Replace the bottom-up cascade block (`depth_of`, deepest-first sort, relayed inflows) with:
  for each monthly fund, `amount = eom_balance` (signed), `counterparty = fund.nearest_pool(db)`
  (throw `ConflictError` naming the fund if missing — defensive; the Fund-layer invariant
  should make this unreachable). `cleanup_flows` bookkeeping stays (pools still need their
  inflows reflected in `sonm_balance`), but no longer feeds back into cleanup amounts.
- Cleanup transaction direction unchanged: surplus fund → pool, deficit pool → fund, zero
  amounts still recorded.
- Update the block comments that describe the bottom-up ordering.

### `models/Allocation.js` (new — the user-facing object)
An orchestrator over the month's single allocation group, extending `Base` (for the
transaction-wrapper machinery) but with **no table and no table SQL of its own**: every
read goes through `TransactionGroup.from_db` / `Transaction.from_db`, and every write goes
through `TransactionGroup` methods (public or internal). Sits at the top of the dependency
graph next to `MonthFinalization` (requires `Fund` and `TransactionGroup`; nothing requires
it back). Instances are read-model wrappers:

```js
{ fund_id, source_fund_id, amount, month /* som YDate */, date, group_id, transaction_id, created_at }
```

The month's allocation group: `allocation = 1`, dated `som_date`, description
`"Allocations for YYYY-MM"`, created lazily by the first `set` (via `TransactionGroup._create`)
and deleted by the last `remove`. All mutating methods run in one sqlite transaction and
apply the finalized-month guard via `TransactionGroup.assert_month_unfinalized`.

Static methods:
- `for_month(db, month)` → `[Allocation]` — wraps
  `TransactionGroup.from_db(db, { allocation: true, since: som, until: eom })`.
- `for_fund(db, fund_id, { since, until, limit, offset })` → allocation history for a fund —
  wraps `Transaction.from_db(db, { allocation: true, target_fund_id: fund_id, ... })`.
- `set(db, { month, fund_id, amount })` — create-or-replace one fund's allocation:
  - `amount > 0` (allocations are USER transactions; the zero-amount carve-out is for
    eom_cleanup only).
  - Target fund must exist, be tracked, have started by `som_date` (see Edge Cases), and
    resolve a nearest pool ancestor that has also started by `som_date`. The resolved pool
    becomes `source_fund_id` (the derived value at this moment; kept in sync thereafter by
    the Fund re-derivation hook).
  - Create the month's group if absent (`TransactionGroup._create`); otherwise remove the
    fund's existing transaction if present and add the new one, via
    `TransactionGroup._remove_transaction` / `_add_transaction` (which keep `split` in sync
    themselves).
- `remove(db, { month, fund_id })` — `TransactionGroup._remove_transaction`; drop the group
  via `TransactionGroup.delete` when it empties. Errors if absent.
- `copy_month(db, { from, to, on_conflict = "error" })` — copy every allocation in `from`
  into `to`, in one sqlite transaction, with three conflict modes for funds that already
  have an allocation in `to`:
  - `"error"` (default): throw `ConflictError` listing the conflicting funds.
  - `"merge"`: keep the destination's existing allocations, copy only the missing funds.
  - `"overwrite"`: replace conflicting allocations with the source month's amounts, copy the
    missing funds. (Allocations in `to` for funds *not* present in `from` are kept in every
    mode.)
  Sources are re-resolved against the current hierarchy (derived, not copied). Returns the
  resulting allocations for `to`.
- `create()` throws, pointing at `set` (matching the FundFinalization/Transaction pattern of
  guarded entry points).

### `models/TransactionGroup.js`
All group-table SQL stays here; `Allocation` never touches `transaction_groups` (or
`transactions`) directly.
- Public `create`: **reject** `allocation: true` and `eom_cleanup: true` (these flags are
  reserved for the Allocation / MonthFinalization internal `_create` paths). Delete the
  current `allocation_id` / `eom_cleanup_id` presence loops (the former is gone; the latter
  moves to being implicit in the internal path).
- `_create`: pass the group's `allocation` flag down to `Transaction._create_with_group` so
  the denormalized column is always consistent.
- New `assert_month_unfinalized(db, date)` static helper wrapping the existing
  `month_is_finalized` stmt; used by `create`, `delete`, and `Allocation`.
- New internal group-editing methods (for `Allocation`; callers own the sqlite transaction):
  - `_add_transaction(db, group, { source_fund_id, target_fund_id, amount, description, ... })`
    — delegates the insert to `Transaction._create_with_group` (with the group's date and
    `allocation` flag), then `_sync_split`.
  - `_remove_transaction(db, group, transaction_id)` — delegates the row delete to a new
    `Transaction._delete` internal, then `_sync_split`. (The transactions-table SQL lives in
    Transaction.js; TG orchestrates.)
  - `_sync_split(db, group_id)` — `UPDATE transaction_groups SET split = (count > 1)`.
- Implement `delete(db)` (currently `TODO` — useful generally, and lets the webapp drop a
  whole allocation month at once): refuse if the group's month is finalized
  (`assert_month_unfinalized`, same as create) — note this automatically covers eom_cleanup
  groups, which only ever exist inside finalized months (unfinalize removes them via its
  internal path); delete transactions then the group, in one sqlite transaction.

### `models/Transaction.js`
- Remove `allocation_id` everywhere (columns, constructor, `to_api`, `from_row`, create stmt,
  `_create_with_group` param, the commented-out FK check, `allocation_exists` stmt).
- Add `allocation` boolean everywhere instead, including a `from_db` filter (`allocation`)
  so per-fund allocation history is a direct query.
- New internal methods (all transactions-table SQL stays in this file):
  - `_delete(db, id)` — used by `TransactionGroup._remove_transaction` and `delete`.
  - `_unfinalized_allocations(db)` — allocation transactions dated after the latest
    finalized month (`(id, target_fund_id, source_fund_id, date)`), for the Fund
    re-derivation hook.
  - `_set_source(db, { id, source_fund_id })` — repoint one allocation transaction's source
    during re-derivation.

---

## Edge cases (decided here, tested below)

1. **Fund starts mid-month.** The month's allocations all live in one group dated `som_date`,
   and transactions may not predate `start_date` — so a fund starting mid-month **cannot
   receive an allocation in its start month**: `Allocation.set` hard-errors with a clear
   `ConflictError` (confirmed decision). Workarounds: create and manage an ordinary
   transaction group for the fund's first partial month, or backdate the fund's `start_date`
   to the start of the month. From its first full month onward it allocates normally.
2. **Pool starts after its dependents.** A monthly fund (or allocation target) whose nearest
   pool ancestor has a later `start_date` would produce cleanup/allocation transactions that
   predate the pool. Guarded three ways: `Fund.create`/`update` require pool-ancestor
   `start_date` ≤ monthly child's `start_date`; `Allocation.set` checks the pool has started
   by `som_date`; the re-derivation hook re-checks when hierarchy changes re-route existing
   allocations. Finalization keeps its defensive throw.
3. **Hierarchy changes re-route unfinalized allocations** (derived semantics): re-parenting
   or re-pooling re-points `source_fund_id` on every allocation transaction after the last
   finalized month, and throws if any allocation would be orphaned. Finalized allocations
   are untouched (immutable history).
4. **Allocations to future months** are ordinary transactions immediately;
   `calculate_balance_on(today)` naturally excludes them (date-bounded), `calculate_balance()`
   includes them — unchanged semantics, as intended.
5. **Finalization boundary.** Allocations for month M+1 are dated `som(M+1) = sonm(M)`.
   `sonm_balance` is a *forward* balance entering `sonm_date`, so it excludes them, and
   `net_transfer(since = sonm_date)` includes them — no double counting, consistent with the
   existing date/balance conventions.

---

## Test plan

### `test/models/test-allocation.js` (new)
Fixture mirroring the existing finalization tests, with `checking` now `pool: true`, monthly
`groceries`/`gas` under it, an untracked `external`, plus an organizational untracked fund
between a budget and the pool to prove "nearest pool ancestor" skips non-pools.
- `set`: first call creates the month's single group (`allocation = 1`, dated som,
  `split = false`); second fund's allocation lands in the *same* group and flips
  `split = true`; re-`set` for the same fund replaces (no duplicate; group count stable);
  balances reflect the transactions; rejects `amount <= 0`, untracked targets, targets with
  no pool ancestor, targets starting mid-month, finalized months.
- `remove`: deletes the transaction, re-derives `split`; removing the last allocation deletes
  the group; errors when absent; refuses finalized months.
- `for_month` / `for_fund`: shapes, ordering, month bounds.
- `copy_month`: copies amounts into the destination's single group; all three `on_conflict`
  modes (`error` throws and rolls back atomically; `merge` keeps destination values;
  `overwrite` replaces them; unrelated destination allocations survive every mode); sources
  re-resolved against the *current* hierarchy; refuses finalized destination months.
- Derived-source behavior: create allocations, re-parent the target's subtree under a
  different pool → `source_fund_id` re-points; un-pool the only pool above an allocated
  fund → throws (orphan guard).
- Finalize a month containing allocations → allocations counted in `eom_balance`; monthly
  fund's surplus math (allocation in, spending out) lands correctly; then verify the month's
  allocations are immutable (`set`/`remove`/`copy_month` into it throw `ConflictError`).

### `test/models/test-fund.js` (additions + fixture updates)
- `pool` create/update consistency: requires tracked, excludes monthly (model error and,
  bypassing the model, the db CHECK).
- Monthly fund without a pool ancestor → rejected at create; orphan guard: re-parenting a
  subtree out from under its pool, and un-pooling a load-bearing pool, both throw; both
  succeed when another pool ancestor exists above.
- A pool that is a child of a pool can receive allocations.
- History rules: toggling `pool` requires unfinalized; re-parenting a fund with a monthly
  *descendant* requires unfinalized; re-parenting a purely organizational fund does not
  (and triggers allocation re-derivation when allocations exist beneath it).
- Pool-starts-later-than-monthly-child rejection.
- Existing monthly fixtures gain `pool: true` on the parent.

### `test/models/test-month-finalization.js` (updates)
- Fixtures: `checking` becomes `pool: true`.
- Nested-monthly test now asserts the *direct* flows: each monthly fund's cleanup goes
  straight to the pool for exactly its own `eom_balance`; every monthly `sonm_balance = 0`;
  the pool's `sonm_balance` equals the old cascade result (balance-equivalence).
- Monthly fund under an intermediate untracked fund cleans up to the pool, skipping it.

### `test/models/test-transaction-group.js` / `test-transaction.js` (updates)
- Public `TransactionGroup.create` rejects `allocation: true` / `eom_cleanup: true`.
- `delete`: removes group + transactions; refuses finalized months (which inherently covers
  eom_cleanup groups — assert that too).
- `transactions.allocation` is populated from the group and filterable via
  `Transaction.from_db({ allocation })`; drop the `allocation_id` assertions.

---

## Documentation updates

### `CLAUDE.md`
- **Funds**: document `pool` (source/sink for descendants; requires tracked, never monthly;
  monthly funds and allocations require a pool ancestor; global orphan guards). Update the
  immutability list: `pool` joins the history-affecting fields, and the parent rule widens to
  "the parent of a monthly fund *or of any fund with a monthly descendant*".
- **Month Finalizations**: replace the "bottom-up through the hierarchy" sentence — cleanups
  now flow each monthly fund → nearest pool ancestor directly, no ordering.
- **Allocations**: rewrite the section — no table; each month has at most one allocation
  transaction group (`allocation = 1`, dated som) holding one transaction per allocated fund;
  `source_fund_id` is *derived* (nearest pool ancestor, kept in sync for unfinalized months
  when the hierarchy changes); managed exclusively through `models/Allocation.js`
  (`set` / `remove` / `for_month` / `for_fund` / `copy_month` with
  `on_conflict: error|merge|overwrite`); finalized months are immutable; funds cannot receive
  an allocation in a mid-month start month.
- **Future direction note**: hierarchy restructuring/snapshotting — supporting point-in-time
  routing changes (un-pooling a fund, re-parenting subtrees as of month M) without rewriting
  prior history, applied consistently to finalizations and allocations. Not supported today;
  routing-affecting changes require rewinding history.
- **Transactions**: `allocation_id` → denormalized `allocation` boolean; note the partial
  unique index.
- **Model pattern**: state the SQL-locality convention explicitly — each model file owns all
  SQL against its table; cross-model operations go through (internal) model methods. The only
  sanctioned exception is the existing one: small inline guard queries against *other* tables
  used solely to avoid circular requires (e.g. `month_is_finalized` in TransactionGroup,
  `finalized_months_since` in Fund).

### Schema comments
Keep the inline commentary current (pool CHECK rationale, the fixed eom_cleanup comment, the
purpose of the partial unique index).

---

## Suggested implementation order

1. Schema edits (+ fix the stale comment), and mechanical `allocation_id` → `allocation`
   plumbing through Transaction/TransactionGroup. Existing tests updated to compile.
2. `Fund.pool`: column plumbing, `nearest_pool`, create/update invariants, orphan guard,
   history rules (re-derivation hook lands with step 5, once allocations exist to re-derive;
   stub the query now). Fund tests.
3. `MonthFinalization` cleanup simplification. Finalization tests.
4. `TransactionGroup.delete` + public-create flag restrictions. Group tests.
5. `models/Allocation.js` + re-derivation hook in `Fund._update` + `test-allocation.js`.
6. `CLAUDE.md` (including the future-restructuring note) and schema comment pass.

## Resolved questions

1. **Name**: `pool`.
2. **`copy_month`**: one method, `on_conflict: "error" | "merge" | "overwrite"`, default
   `"error"`.
3. **Pools as children of pools**: can receive allocations.
4. **`TransactionGroup.delete`**: implemented generally; the finalized-month guard is the
   only guard needed (eom_cleanup groups only exist inside finalized months).
5. **Allocation sources**: derived from the current hierarchy, never snapshotted;
   snapshotting arrives later as part of the hierarchy-restructuring feature.
6. **SQL locality**: `Allocation` contains no table SQL; group editing lives in internal
   `TransactionGroup` methods, transaction-row SQL (including re-derivation) in
   `Transaction`, fund SQL in `Fund`.
7. **Mid-month fund starts**: allocations hard-error for the start month; users manage their
   own transaction group for the partial month or backdate `start_date` to the 1st.
