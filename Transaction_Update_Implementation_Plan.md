# Transaction (Group) Update Implementation Plan

Adds **real in-place updates** for transaction groups and their transactions, replacing the
current "delete and re-create" workflow. Supersedes the
`PATCH /api/transactions/transaction-group/:group_id` bullet under *Outstanding — blocked on
model-layer TODOs* in `API_Implementation_Plan.md`.

## Status: IMPLEMENTED (2026-07-07)

All five commits landed as planned (model validator extraction + `Transaction#update`;
`TransactionGroup#update`; `TransactionGroup.edit_transactions`; the three PATCH endpoints;
docs). 521 tests passing. The sections below are the as-built record. One deviation from the
plan: the allocation/eom_cleanup refusals got explicit API-layer 409 guards
(`assert_group_editable` / `assert_transaction_editable` in `collections/Transactions.js`),
mirroring the DELETE endpoint's existing allocation guard, instead of relying on the model's
plain-Error → 400 mapping — a group you may not edit is a conflict of state, not a bad
parameter. The model refusals remain as backstop.

## Why this exists (the problem being fixed)

Today `TransactionGroup#update` and `Transaction#update` are throwing TODOs; the documented
workflow is delete-then-recreate. That has two defects:

1. **Non-atomic rollback.** The client does it as two HTTP calls = two SQLite transactions. If
   the recreate fails (bad body, finalized month, fund start-date conflict), the original group
   is already gone with nothing to restore.
2. **Identity / reconciliation loss.** A recreate mints a **new group id**. Because
   `bank_statement_items.group_id` is `ON DELETE SET NULL`, deleting a *reconciled* group
   releases its statement items back to *pending* — the new group does not re-link them, and the
   next bank re-sync sets up a double-count. Wrapping delete+recreate in one transaction fixes
   (1) but **not** (2).

Only an in-place update that keeps the group id and its statement links is correct. That is what
this plan builds.

## Scope

**In scope (v1):**
- Edit a group's scalar fields: `description`, `note`, `date` (date cascades to child transactions).
- Add / remove / edit **lines** (transactions) within an existing group, atomically.
- Edit a single existing transaction's `amount`, `source_fund_id`, `target_fund_id`,
  `description`, `note` directly.

**Explicitly out of scope (documented follow-ups):**
- **Editing a single transaction's `date` independently.** `date` is a group-level fact
  (denormalized onto transactions); it is only editable via the group so the two never desync.
- **Creating/deleting a *whole group*** — unchanged; still `POST`/`DELETE` on the group. A group
  always holds ≥1 line, so emptying a group via the line editor is refused (delete the group
  instead).
- **Allocation / eom_cleanup groups.** These stay owned by the `Allocation` /
  `MonthFinalization` paths and are refused by every edit path here, matching `create`/`delete`.

## API surface (three write endpoints, decided)

All under the existing `collections/Transactions.js` (prefix `/api/transactions`).

| Endpoint | Scope | Body | Notes |
|---|---|---|---|
| `PATCH /transaction-group/:group_id` | group scalars | `description?`, `note?`, `date?` | date cascades to every line |
| `PATCH /transaction-group/:group_id/transactions` | the line set | `add?`, `update?`, `remove?` | one atomic op; add/remove/edit lines |
| `PATCH /transaction/:transaction_id` | one line | `amount?`, `source_fund_id?`, `target_fund_id?`, `description?`, `note?` | in-place edit only; **no** create/delete, **no** `date` |

**"Writes go through groups" — relaxed, deliberately.** The `/transaction` resource was
GET-only (all writes via the group). It now also accepts an in-place field `PATCH`, but
**structural** create/delete of a line still happens only through the group's `.../transactions`
editor (a line cannot exist without a group, and a group cannot be emptied). Update the
read-only note in the file and docs to say exactly this.

## Design principles carried over from the models

- **No stored running balance.** Balances are derived (`Transaction.net_transfer`), so an edit
  needs no balance recomputation — the next query reflects it, and the API invalidates
  `fund-balance`. (The stray `// TODO : trigger fund balance re-calculation` in `_create` is a
  no-op for the same reason.)
- **The finalized-month guard is the cache protector.** A finalization's stored cache point
  (`sonm_balance`) only sums transactions before its `sonm_date`. Refusing edits in (or into)
  finalized months guarantees an edit can never invalidate a stored cache point. This guard is
  load-bearing and appears on every path below.
- **SQL locality.** Each model owns its own table's SQL. `Transaction._update` edits the
  `transactions` table and lives on `Transaction`; the group's date-cascade writes the
  `transactions` table through a new `Transaction` method, never inline SQL. Cross-table *guard*
  reads (`month_finalizations`) use the sanctioned inline-guard exception to avoid a circular
  require.
- **Reuse the existing primitives.** `TransactionGroup._add_transaction` /
  `_remove_transaction` (built for Allocation, they keep `split` in sync) are the building blocks
  for the line editor; the model already owns them.
- **Atomicity.** Every edit (including the whole add/update/remove batch) runs inside one
  `build_transaction`, so a failed consistency check rolls the entire batch back — the original
  rows are untouched. This is the direct fix for the rollback concern.

---

## Phase 1 — Model layer

### 1.1 `Transaction`: extract shared field validation

`_create_with_group` currently inlines the per-transaction consistency checks. Extract them so
both `_create_with_group` and the new `_update` reuse exactly the same rules:

```js
// Runs the model-level consistency + FK + start-date checks for a transaction's
// money-bearing fields against a given date. Shared by _create_with_group and _update.
static _assert_transaction_valid(db, { source_fund_id, target_fund_id, amount, date, description }) {
    if ( !source_fund_id ) throw new Error("Missing source fund id");
    if ( !target_fund_id ) throw new Error("Missing target fund id");
    if ( source_fund_id == target_fund_id ) throw new ConflictError("Source and target funds cannot be the same");
    if ( amount < 0 ) throw new Error("Transaction amount cannot be negative");
    if ( !description ) throw new Error("Missing description");

    if ( !this.get_stmt(db, "fund_exists").get({ id: source_fund_id }) )
        throw new ForeignKeyError("Source fund does not exist: " + source_fund_id);
    if ( !this.get_stmt(db, "fund_exists").get({ id: target_fund_id }) )
        throw new ForeignKeyError("Target fund does not exist: " + target_fund_id);

    const _date = ydate2stmt(date);
    if ( this.get_stmt(db, "fund_starts_after").get({ id: source_fund_id, date: _date }) )
        throw new ConflictError("Transaction predates the source fund's start_date");
    if ( this.get_stmt(db, "fund_starts_after").get({ id: target_fund_id, date: _date }) )
        throw new ConflictError("Transaction predates the target fund's start_date");
}
```

`_create_with_group` keeps its `group_id`/`date` presence checks and calls this for the rest — no
behavior change, verified by the existing create tests.

### 1.2 `Transaction`: new prepared statements

```js
month_is_finalized: `                       // inline guard, mirrors TransactionGroup's, avoids circular require
    SELECT 1 FROM month_finalizations WHERE eom_date >= @date LIMIT 1
`,
update: `                                   // money-bearing fields only; date/allocation/group_id/eom_cleanup_id untouched
    UPDATE transactions
    SET source_fund_id = @source_fund_id,
        target_fund_id = @target_fund_id,
        amount         = @amount,
        description    = @description,
        note           = @note
    WHERE id = @id
`,
set_date_for_group: `                       // used by TransactionGroup#update's date cascade (keeps the denormalized copy in sync)
    UPDATE transactions SET date = @date WHERE group_id = @group_id
`,
```

### 1.3 `Transaction#update` (real implementation)

Replace the throwing TODO. Edits money-bearing/cosmetic fields of one existing line; does not
touch `date` (group-level) or `allocation`.

```js
static _update(db, transaction, { source_fund_id, target_fund_id, amount, description, note }={}) {
    if ( transaction.allocation )
        throw new Error("Allocation transactions are managed via Allocation.set(...)");
    if ( transaction.eom_cleanup_id != null )
        throw new Error("EOM cleanup transactions cannot be edited");

    // The transaction's month must be unfinalized (date is the group's date).
    if ( this.get_stmt(db, "month_is_finalized").get({ date: ydate2stmt(transaction.date) }) )
        throw new ConflictError("Cannot modify transactions in a finalized month");

    // Merge changes over current values, then validate the FULL result against the
    // (unchanged) date -- a partial fund change still has to satisfy every invariant.
    const next = {
        source_fund_id: source_fund_id ?? transaction.source_fund_id,
        target_fund_id: target_fund_id ?? transaction.target_fund_id,
        amount:         amount ?? transaction.amount,
        description:    description ?? transaction.description,
        note:           note !== undefined ? note : transaction.note,
    };
    this._assert_transaction_valid(db, { ...next, date: transaction.date });

    this.get_stmt(db, "update").run({
        id: transaction.id,
        source_fund_id: next.source_fund_id,
        target_fund_id: next.target_fund_id,
        amount: currency2stmt(next.amount),
        description: next.description,
        note: next.note ?? null,
    });
    return this.for_id(db, transaction.id);
}

update(db, changes={}) {
    const transaction = this.constructor.build_transaction(
        db, "update", this.constructor._update.bind(this.constructor));
    return transaction(db, this, changes);
}
```

Notes:
- `split` is untouched (line count unchanged), so the parent group needs no bookkeeping — this is
  why a single-line edit does not have to route through the group.
- The `amount >= 0` model floor stays; the strict `> 0` user rule is an API-layer concern.
- `_update` is also called by the group line-editor (1.5) for its `update` entries; its guards
  are idempotent, so calling it inside the batch is safe.

### 1.4 `TransactionGroup#update` (group scalar fields)

Replace the throwing TODO. Handles group-level fields only; when `date` changes it re-validates
every child transaction against the new date and cascades the denormalized copy. **Does not add
or remove lines** (that is 1.5).

```js
static _update(db, group, { description, note, date }={}) {
    if ( group.allocation )
        throw new Error("Allocation groups are managed via Allocation.set(...)");
    if ( group.eom_cleanup )
        throw new Error("EOM cleanup groups cannot be edited");

    this.assert_month_unfinalized(db, group.date);            // current month unfinalized...

    const next_date = date ?? group.date;
    const date_changed = ydate2stmt(next_date) !== ydate2stmt(group.date);
    if ( date_changed ) {
        this.assert_month_unfinalized(db, next_date);         // ...and cannot move INTO a finalized month
        for ( const t of group.transactions ) {               // re-check each line's start-date invariant vs the new date
            Transaction._assert_transaction_valid(db, {
                source_fund_id: t.source_fund_id,
                target_fund_id: t.target_fund_id,
                amount: t.amount,
                description: t.description,
                date: next_date,
            });
        }
    }

    this.get_stmt(db, "update").run({
        id: group.id,
        date: ydate2stmt(next_date),
        description: description ?? group.description,
        note: note !== undefined ? note : group.note,
    });
    if ( date_changed ) Transaction._set_date_for_group(db, group.id, ydate2stmt(next_date));

    return this.for_id(db, group.id);
}

update(db, changes={}) { /* build_transaction wrap, as elsewhere */ }
```

New prepared statement on `TransactionGroup`:

```js
update: `UPDATE transaction_groups SET date = @date, description = @description, note = @note WHERE id = @id`,
```

Statement links (`bank_statement_items.group_id`) are never touched, so reconciliation survives —
the whole point.

### 1.5 `TransactionGroup.edit_transactions` (the line editor — add/update/remove)

New method composing the existing primitives; the entire batch is one transaction.

```js
static _edit_transactions(db, group, { add = [], update = [], remove = [] }={}) {
    if ( group.allocation ) throw new Error("Allocation groups are managed via Allocation.set(...)");
    if ( group.eom_cleanup ) throw new Error("EOM cleanup groups cannot be edited");
    this.assert_month_unfinalized(db, group.date);

    // Every referenced id must belong to THIS group; no id in both remove and update.
    const own = new Set(group.transactions.map(t => t.id));
    const touched = new Set();
    for ( const id of remove ) {
        if ( !own.has(id) ) throw new ForeignKeyError("Transaction not in group: " + id);
        if ( touched.has(id) ) throw new Error("Transaction referenced twice: " + id);
        touched.add(id);
    }
    for ( const u of update ) {
        if ( !own.has(u.id) ) throw new ForeignKeyError("Transaction not in group: " + u.id);
        if ( touched.has(u.id) ) throw new Error("Transaction referenced twice: " + u.id);
        touched.add(u.id);
    }

    // A group must keep >= 1 line (delete the whole group instead of emptying it).
    if ( group.transactions.length - remove.length + add.length < 1 )
        throw new Error("A transaction group must keep at least one transaction; delete the group instead");

    for ( const id of remove ) Transaction._delete(db, id);
    for ( const u of update )  Transaction._update(db, Transaction.for_id(db, u.id), u);   // validates fields vs the line's date
    for ( const a of add )     this._add_transaction(db, group, a);                        // _create_with_group validates + start-date/FK checks

    this.get_stmt(db, "sync_split").run({ group_id: group.id });   // one resync after the batch
    return this.for_id(db, group.id);
}

static edit_transactions(db, group, ops={}) { /* build_transaction wrap */ }
```

Notes:
- `add` entries flow through `_add_transaction` → `_create_with_group`, which (post-1.1) runs the
  shared validator, so adds get the same FK / start-date / self-transfer checks as create. They
  inherit the group's `date` and `allocation` flag.
- `remove`/`update`/`add` are applied in that order; `sync_split` runs once at the end (cheaper
  than the per-op resync `_add_transaction`/`_remove_transaction` do individually — calling
  `Transaction._delete` directly for removes skips the redundant intermediate resyncs).
- Emptying is refused; deleting the last line is the group-delete operation, which already exists.

### 1.6 Replace the stale model comments

Remove the "delete and re-create ... to prevent db desync" NOTE blocks above both `update`
methods; replace with short docs describing the editable-field sets and the delegation to the
shared validator / primitives.

### 1.7 Model tests

`test/models/test-transaction.js`:
- update `amount` → row updated; `net_transfer` / `fund.calculate_balance_on` reflect it (proves
  derived balances follow with no extra work).
- update `source_fund_id`/`target_fund_id` → balances of old and new funds both move.
- `source == target` → `ConflictError`; unknown fund → `ForeignKeyError`; negative amount →
  plain `Error`.
- fund change that makes the line predate the new fund's `start_date` → `ConflictError`.
- update in a finalized month → `ConflictError`; refuse allocation / eom_cleanup lines.
- **atomicity**: a change whose validation throws leaves the original row byte-for-byte intact.

`test/models/test-transaction-group.js`:
- scalar update (`description`/`note`) → group updated, lines untouched.
- `date` update → group date and *every* child line's denormalized date move together; move into
  a finalized month → `ConflictError`; move before a child fund's `start_date` → `ConflictError`.
- `edit_transactions`: add a line (`split` flips to true), remove a line (`split` flips back),
  update a line's amount, and a mixed batch — all in one call; assert final membership + `split`.
- emptying a group (remove all, no adds) → `Error`.
- id not belonging to the group in `remove`/`update` → `ForeignKeyError`; id referenced twice →
  `Error`.
- refuse allocation / eom_cleanup groups; finalized-month refusal.
- reconciled group keeps its `statements` (id stable, links intact) after both scalar and line
  edits — the regression guard for the original bug.
- **atomicity**: a batch whose last op throws rolls back the earlier ops.

---

## Phase 2 — API layer (`collections/Transactions.js`)

Reuse the file's existing helpers: `get_group`, `parse_body_fields`, `translate_model_error`,
`parse_transaction_specs` (array-element validation with `transactions[i]:` prefixing),
`money_moved`, `QK`, `invalidate`, `remove`.

### 2.1 `PATCH /transaction-group/:group_id` (group scalars)

- Role `editor`; `get_group(req)` (404 on bad/absent id).
- Body (all optional): `description` (`only_non_empty_string`), `note` (`nullable(only_string)`),
  `date` (`only_ydate`).
- `group.update(db, data)` via `translate_model_error` (ConflictError→409 finalized/start-date;
  plain Error→400 allocation/eom_cleanup refusal).
- **Invalidations:** `date` present → `money_moved()` + `invalidate(QK.transaction_group(id))`
  (+ `invalidate(QK.statements)` if `group.statements.length`); scalar-only →
  `invalidate(QK.transaction_groups)` + `invalidate(QK.transaction_group(id))` (no `fund-balance`).

### 2.2 `PATCH /transaction-group/:group_id/transactions` (line editor)

- Role `editor`; `get_group(req)`.
- Body (all optional, at least one non-empty):
  - `add`: array of specs validated by `parse_transaction_specs` (strict `> 0` amount).
  - `update`: array of `{ id (only_id, required), amount? (only_positive_number),
    source_fund_id? (only_id), target_fund_id? (only_id), description? (only_non_empty_string),
    note? (nullable) }` — per-element via `parse_body_fields`, `update[i]:` context prefix.
  - `remove`: array of `only_id`.
- `TransactionGroup.edit_transactions(db, group, { add, update, remove })` via
  `translate_model_error` (ForeignKeyError→400 unknown/foreign id; ConflictError→409;
  plain Error→400 empty-group / double-reference).
- **Invalidations:** `money_moved()` + `invalidate(QK.transaction_group(id))` (structure/amounts
  always move money).
- OpenAPI: describe the three sub-arrays, the "cannot empty the group" rule, and the
  finalized/allocation refusals.

### 2.3 `PATCH /transaction/:transaction_id` (single-line in-place edit)

- Adds the **only** write to the `/transaction` sub-resource; still no `POST`/`DELETE` there.
- New `get_transaction(req)` helper (mirrors `get_group`: `to_int`→404→
  `assert_found(Transaction.for_id(...))`).
- Role `editor`. Body (all optional): `amount` (`only_positive_number`, strict `> 0`),
  `source_fund_id` (`only_id`), `target_fund_id` (`only_id`), `description`
  (`only_non_empty_string`), `note` (`nullable(only_string)`). No `date`.
- `transaction.update(db, data)` via `translate_model_error`.
- **Invalidations:** money field changed → `money_moved()` + `invalidate(QK.transaction(id))` +
  `invalidate(QK.transaction_group(transaction.group_id))` (the group embeds its lines in
  `to_api()`); cosmetic-only → `invalidate(QK.transactions)` + `invalidate(QK.transaction(id))` +
  `invalidate(QK.transaction_group(transaction.group_id))`.
- Update the file's `/api/transactions is read-only` comment to "reads + in-place line edits;
  create/delete of lines go through the group".

### 2.4 API tests (`test/api/test-transactions.js`)

- Group scalar PATCH: 200 description/note (assert no `fund-balance` action), 200 date (assert
  `money_moved` present), 400 bad params, 404, 409 finalized, 409 allocation, 401/403, invalidations.
- Line editor PATCH: 200 add / remove / update / mixed batch; 400 empty-group; 400 foreign or
  duplicate id; 409 finalized/allocation; 404 unknown group; 403 reader; invalidation arrays.
- Single-line PATCH: 200 amount; 400 `amount <= 0`; 400 unknown fund; 409 `source == target`;
  409 finalized; 404; 403 reader; invalidations include the parent group key.
- **Reconciliation-survival end-to-end**: reconcile a statement → PATCH the group's date and
  edit a line → group id unchanged and statement still linked (regression test for the original
  bug).

---

## Phase 3 — Docs

1. `CLAUDE.md`:
   - **Transaction Groups** / **Transactions** sections: replace the "delete + recreate is the
     documented workflow / update is a TODO" language with the real editable-field sets, the
     date-cascade, the line-editor (add/update/remove, cannot-empty rule), and the "whole-group
     create/delete still via POST/DELETE" caveat.
   - **CRUD API Conventions**: add the three PATCH routes; note the `/transaction` resource now
     takes in-place field edits (create/delete of lines still via the group).
   - **Model Pattern**: `update` (+ `edit_transactions`) is now implemented for these models.
2. `API_Implementation_Plan.md`: move the `PATCH .../transaction-group/:group_id` item out of
   *Outstanding — blocked on model-layer TODOs* into the as-built record; add the line editor and
   the single-line PATCH. (`Fund#descendants` stays outstanding.)
3. `/api-docs` sanity pass: all three new routes render, no `$ref` typos.

---

## Suggested commit sequence

1. Model: shared validator extraction + `Transaction#update` + tests.
2. Model: `TransactionGroup#update` (scalars + date cascade) + tests.
3. Model: `TransactionGroup.edit_transactions` (line editor) + tests.
4. API: all three PATCH endpoints + tests.
5. Docs (CLAUDE.md, API_Implementation_Plan.md) + `/api-docs` pass.

## Settled decisions

- **Three endpoints**, not a single mega-PATCH: group scalars, the line-set editor (under the
  group scope), and a direct single-line edit. The `/transaction` resource gains in-place field
  edits but **not** create/delete (those stay group-scoped).
- **Line editor is declarative-by-operation** (`add`/`update`/`remove` arrays), not a positional
  "replace the whole array" — avoids the omit-means-delete footgun and maps onto the existing
  model primitives.
- **A group is never auto-emptied**: removing the last line is refused; use group delete.
- **Editing amounts on reconciled groups is allowed** (amounts are intentionally never checked
  against bank item amounts — the model's existing stance).
- **Prefix**: keeping everything under the existing `/api/transactions` (one collection file). If
  the group routes should move to their own `/api/transaction-groups` collection, that is a
  separate refactor of already-shipped routes — not included here.
