# Bank Statement Items — Implementation Plan

## Goal

Make `bank_statement_items` (BSI) a first-class model: import statement entries
idempotently, let the user either **ignore** an item or **reconcile** it into a
transaction group (possibly split across funds), support **transfer-type**
items (two BSIs from two different bank imports that are the same real-world
event) linking to a single group, and provide good querying in both directions
(BSI → group, group → BSI).

## Core data-model change: reverse the link

Today `transaction_groups.statement_id → bank_statement_items` tacitly assumes
every bank line involves exactly one group and vice versa. But a
checking→savings transfer shows up as TWO BSI rows (one per bank import:
`-500` on checking's statement, `+500` on savings') that are ONE logical event
— one transaction group with one `checking → savings` transaction.

So the FK moves to the many side:

- **Drop** `transaction_groups.statement_id` (and its index).
- **Add** `bank_statement_items.group_id` — nullable
  `REFERENCES transaction_groups(id) ON DELETE SET NULL ON UPDATE CASCADE`.

What this buys:

1. **Transfers work**: both BSIs set `group_id` to the same group. No extra
   table, no "transfer pair" concept — the shared group IS the link. (A join
   table was considered and rejected: with one-group-per-item it has the same
   expressiveness as the reversed FK, just with more moving parts.)
2. **One-group-per-item is structural** — it's a single column, no partial
   unique index needed.
3. **The ignored/linked invariant becomes a plain single-row CHECK** — the two
   columns now live on the same row, so no cross-table triggers are needed:
   `CHECK (NOT (ignored = 1 AND group_id IS NOT NULL))`. Model layer still
   checks first to throw typed `ConflictError`s with good messages.
4. **Deleting a group naturally releases its items** back to pending via
   `ON DELETE SET NULL`.

An item is in exactly one of three states, all derivable:
- *pending*: `ignored = 0 AND group_id IS NULL`
- *ignored*: `ignored = 1` (CHECK guarantees no group)
- *reconciled*: `group_id IS NOT NULL`

## Other design decisions (and why)

1. **No amount reconciliation enforcement.** The sum of a group's transaction
   amounts is NOT checked against the linked items' amounts. Transfers make
   any simple rule ambiguous (the two items net to zero while the transaction
   amount matches each side's magnitude), and the user may have legitimate
   partial/asymmetric reconciliations. A UI can surface discrepancies later;
   the model stays permissive. `item.amount` stays **signed** (negative =
   money leaving that bank account); transaction direction is entirely
   user-specified via source/target — no sign inference in v1 ("source/dest
   clues" remain future work).

2. **Group creation from items lives on `TransactionGroup`**:
   `TransactionGroup.create_from_statements(db, { statement_ids, ... })`
   (plural — one id for the normal case, two for a transfer). Rationale:
   - Require direction stays acyclic: `TransactionGroup → BankStatementItem`,
     mirroring how TG composes `Transaction` and Allocation composes TG.
   - Linking SQL (`UPDATE bank_statement_items SET group_id`) belongs to the
     BSI model; TG calls an internal `BankStatementItem._link` inside its
     sqlite transaction — same pattern as `TransactionGroup._add_transaction`
     being called by Allocation.
   - TG's existing inline `statement_exists` guard is deleted along with the
     `statement_id` column; public `TransactionGroup.create` no longer has any
     statement parameter at all.

3. **Linking is managed, not freeform.** v1 links only at group creation
   (`create_from_statements`) and unlinks only via group deletion or BSI
   deletion. No public `item.link(group)` / `unlink` — fewer states to reason
   about. Attaching items to a pre-existing manual group is future work.

4. **Group date defaults to the latest linked item's date**, overridable.
   Transfer sides often post on different days; the latest posting date is the
   day the money movement completed. The finalized-month guard applies to the
   chosen date as usual (an item posting into a finalized month can still be
   reconciled by overriding with a later date).

5. **Immutability of bank facts.** `source`, `key`, `amount`, `date` are facts
   from the bank and are not updatable — delete and re-import instead. Only
   `ignored` and `note` are mutable.

6. **Deleting a BSI is allowed, including reconciled ones — with documented
   risks.** `item.delete(db, { with_group = true })`:
   - unlinked/ignored item: plain row delete.
   - reconciled item, `with_group: true` (default): also deletes the linked
     transaction group (through the normal `TransactionGroup` delete path, so
     the finalized-month guard applies — a group in a finalized month blocks
     the whole delete). If the group was a transfer, the peer item is
     released to pending by `ON DELETE SET NULL`.
   - reconciled item, `with_group: false`: deletes only the row; the group
     survives with one fewer (possibly zero) linked items.

   **Documented risks** (goes in CLAUDE.md and the method doc comment):
   deleting a reconciled item with `with_group: true` destroys real
   transactions; and in ALL cases, if the bank statement is ever re-synced,
   the deleted item **reappears as pending** (the `(source, key)` dedupe row
   is gone) — reconciling it again would then double-count. Deleting a BSI is
   for undoing bad imports, not for hiding items (that's what `ignored` is
   for).

7. **Schema is edited in place** (`_schema.sql`, `user_version` stays 1).
   No migration.

## Schema changes (`db/migrations/_schema.sql`)

`bank_statement_items` (note: `transaction_groups` is created later in the
file, so the FK is added via the same deferred-`ALTER TABLE` trick already
used for `funds.finalization_id`):

```sql
    -- User has chosen to NOT create a transaction group for this item
    ignored             INTEGER NOT NULL DEFAULT 0 CHECK (ignored IN (0,1)),

    -- An ignored item must not be linked to a group
    CHECK (NOT (ignored = 1 AND group_id IS NOT NULL))
```

```sql
-- After transaction_groups is created:
-- Which group reconciles this item. Lives on THIS side (not on
-- transaction_groups) so that transfer-type events -- two items from two
-- bank imports -- can share one group.
ALTER TABLE bank_statement_items
    ADD COLUMN group_id INTEGER REFERENCES transaction_groups(id)
        ON DELETE SET NULL
        ON UPDATE CASCADE;
CREATE INDEX idx_bank_statement_items_group_id ON bank_statement_items(group_id);
CREATE INDEX idx_bank_statement_items_ignored ON bank_statement_items(ignored);
```

Wait — the `ignored`/`group_id` cross-column CHECK can't live in the table
definition if `group_id` arrives via ALTER TABLE. Two options:
  (a) reorder the file so `transaction_groups` is created before
      `bank_statement_items` (nothing in `transaction_groups` references BSI
      anymore, so the dependency is now one-way — **preferred**, no ALTER
      trick needed and the CHECK sits in the table definition); or
  (b) keep the ALTER and enforce ignored-vs-linked with two small triggers.
Plan assumes (a): move `bank_statement_items` after `transaction_groups`,
define `group_id` and both CHECKs inline.

On `transaction_groups`: remove `statement_id`, its FK clause, and
`idx_transaction_groups_statement_id`.

## New model: `models/BankStatementItem.js`

Follows the Base pattern. Owns ALL SQL against `bank_statement_items`,
including the linking UPDATEs (TransactionGroup's inline `statement_exists`
stmt is deleted). Requires nothing but Base — no circular-require risk.

Fields: `id, source, key, ignored, group_id (nullable), amount (signed float
via stmt2currency), date (YDate), note, created_at`.

### API surface

- `static create(db, { source, key, amount, date, note = null })` —
  consistency checks (non-empty source/key, `amount !== 0`, valid date), then
  insert; `ConflictError` on duplicate `(source, key)`.
- `static import_many(db, items)` — idempotent bulk import (the "re-sync"
  path), one sqlite transaction. Per item:
  `INSERT ... ON CONFLICT(source, key) DO NOTHING`. Returns
  `{ created: [BankStatementItem], skipped: [{ source, key }] }`. Existing
  rows are NOT updated — bank facts are immutable (decision 5), and
  `ignored`/`group_id` state must survive re-syncs.
- `static for_id(db, id)` / `static for_key(db, { source, key })`.
- `static from_db(db, { source, since, until, ignored, has_group, group_id,
  order_by = "date", order_direction = "DESC", limit, offset })` — same
  dynamic-WHERE + cached-stmt-key pattern as the other models. All filters are
  own-table columns now (`has_group` → `group_id IS [NOT] NULL`); *pending* =
  `{ ignored: false, has_group: false }`; `group_id` filter answers "which
  items back this group" from the BSI side.
- `instance.update(db, { ignored, note })` — only these two fields. Setting
  `ignored: true` on a reconciled item throws `ConflictError` (model check;
  db CHECK backstops).
- `instance.delete()` — **stub that always throws**, pointing the caller at
  `TransactionGroup.delete_statement_item(...)` (same pattern as
  `Transaction.create()` throwing "please create via TransactionGroup").
  The comment on the stub explains WHY deletion lives over there: the
  `with_group` arm must delete a transaction group inside the same sqlite
  transaction, which needs the TransactionGroup model — and BSI must not
  require TransactionGroup (the require direction is TG → BSI), so the
  composer owns the operation.
- `instance.to_api()` — standard shape; includes `ignored` and `group_id`.
- Internal, for TransactionGroup's sqlite transactions:
  - `static _assert_linkable(db, ids)` — every id exists (`ForeignKeyError`),
    none ignored, none already linked (`ConflictError`). Returns the items
    (caller uses their dates for the default group date).
  - `static _link(db, ids, group_id)` / `static _unlink_group(db, group_id)`.
  - `static SELECT_COLUMNS` — exported for TG's hydration subquery, mirroring
    `Transaction.SELECT_COLUMNS`.

## Changes to `models/TransactionGroup.js`

1. **`static create_from_statements(db, { statement_ids = [], date = null,
   description = null, note = null, transactions = [] })`**
   - `statement_ids` non-empty, deduped (dup ids → error); at least one
     transaction (same rule as `create`)
   - `BankStatementItem._assert_linkable(db, statement_ids)` → items
   - `date = date ?? latest(items[].date)`; `assert_month_unfinalized`
   - `description` defaults to the items' notes joined (fallback: their keys)
   - one sqlite transaction: `_create` (plain group — no flags), then
     `BankStatementItem._link(db, statement_ids, group.id)`
   - returns the hydrated group
2. **Remove `statement_id`** everywhere: `GROUP_COLUMNS`, constructor,
   `to_api`, `from_db` filter, `_create` params, and the `statement_exists`
   prepared stmt. Public `create` has no statement-related surface at all.
3. **BSI hydration on reads.** `for_id`/`from_db` gain a `_statements` column
   built as a **correlated subquery** (NOT a third join — a second one-to-many
   LEFT JOIN would cross-product against the transactions join and corrupt
   both `json_group_array`s):
   ```sql
   (SELECT COALESCE(json_group_array(json_object(...BankStatementItem.SELECT_COLUMNS...)), json('[]'))
    FROM bank_statement_items
    WHERE bank_statement_items.group_id = transaction_groups.id) AS _statements
   ```
   `from_row` hydrates `group.statements = [BankStatementItem]`; `to_api()`
   replaces the old `statement_id` field with
   `statements: this.statements.map(s => s.to_api())`.
4. **`from_db` filter `has_statements`** (boolean → `EXISTS`/`NOT EXISTS`
   subquery on `bank_statement_items.group_id`).
5. **`static delete_statement_item(db, item, { with_group = true })`** — the
   public entry point for decision 6. One sqlite transaction: if `with_group`
   and `item.group_id` is set, run the existing `_delete` path on the group
   (finalized-month guard included; `ON DELETE SET NULL` releases any transfer
   peer), then `BankStatementItem._delete_row`. Carries a doc comment
   explaining why BSI deletion lives on TransactionGroup: the `with_group`
   arm deletes a group inside the same sqlite transaction, which requires the
   TransactionGroup model, and the require direction is strictly TG → BSI —
   so the composer owns the operation. `BankStatementItem#delete()` is a
   throwing stub that points here (see BSI section); BSI keeps only the
   internal `_delete_row` stmt.
6. **`_delete` / `delete`**: no changes needed — the FK releases linked items
   automatically. Add a test asserting it.

No changes to `Transaction.js`, `Fund.js`, `Allocation.js`, or the
finalization models.

## Tests

New `test/models/test-bank-statement-item.js` (standard in-memory pattern):

- **create**: happy path; round-trips signed amount/date/note; duplicate
  `(source, key)` → `ConflictError`; same `key` under different `source` OK;
  rejects zero amount; `group_id` starts null.
- **import_many**: all-new; full re-import (all skipped); partial overlap;
  re-import does NOT clobber `ignored`/`note`/`group_id` on existing rows;
  atomicity (a bad item rolls back the batch).
- **for_id / for_key / from_db**: filters `source`, `since`/`until`,
  `ignored`, `has_group`, `group_id` (each and combined — notably pending =
  `ignored:false, has_group:false`); ordering + limit/offset.
- **update**: toggle `ignored` both ways; update `note`; ignoring a
  reconciled item → `ConflictError`; ignore → unignore → reconcile succeeds.
- **db CHECK backstop**: raw `db.prepare(...).run(...)` around the model layer
  confirms `ignored=1 AND group_id NOT NULL` is rejected by SQLite itself.
- **delete stub**: `item.delete()` always throws, and the message names
  `TransactionGroup.delete_statement_item` (mirrors the existing
  `Transaction.create()` redirect test style).

Extend `test/models/test-transaction-group.js`:

- **create_from_statements**:
  - single item happy path: group created, item's `group_id` set, group
    hydrates `statements`, default date = item date
  - **transfer case**: two items (opposite-signed amounts, different dates,
    different sources) → ONE group with one checking→savings transaction;
    both items reconciled; default date = later item's date
  - split across two source funds against one item (no sum requirement —
    assert amounts that do NOT match item.amount still succeed)
  - missing item → `ForeignKeyError`; ignored item → `ConflictError`;
    already-reconciled item → `ConflictError` (including "one side of a
    transfer already linked"); duplicate ids in the list → error
  - empty `statement_ids` / empty `transactions` → error
  - date override (incl. item dated in a finalized month: default date
    throws, later override succeeds)
- **hydration/querying**: `for_id`/`from_db` return `statements` correctly
  (empty array when unlinked, two entries for a transfer); groups with BOTH
  multiple transactions AND multiple statements hydrate both arrays
  un-duplicated (guards the subquery-not-join choice); `to_api()` shape;
  `has_statements` filter both ways.
- **group delete**: deleting a reconciled group returns its item(s) to
  pending (`group_id` null — covers the transfer pair), and items can be
  re-reconciled after.
- **delete_statement_item**:
  - pending item: row gone
  - reconciled, default (`with_group: true`): item AND group AND its
    transactions gone; transfer peer released to pending, not deleted
  - reconciled, `with_group: false`: row gone, group + transactions survive
    with `statements` shrunk
  - reconciled with group in a finalized month: default → `ConflictError`;
    `with_group: false` succeeds
  - deleted item re-imports as pending (the documented "reappear" behavior)

## Documentation updates

`CLAUDE.md`:

- New **Bank Statement Items** block in *Schema Hierarchy* (between
  Transactions and Allocations):
  - three states (pending / ignored / reconciled), all derivable
  - the FK lives on `bank_statement_items.group_id` (NOT on the group) so
    transfer-type events — two items from two bank imports — share one group;
    ignored-vs-linked is a single-row db CHECK plus model-layer checks
  - signed `amount`; NO amount-sum enforcement against the group (by design)
  - bank facts (`source`, `key`, `amount`, `date`) immutable; idempotent
    re-sync via `import_many` keyed on `(source, key)` never updates existing
    rows
  - linking only via `TransactionGroup.create_from_statements`; unlinking via
    group deletion (FK SET NULL) or `TransactionGroup.delete_statement_item`
  - **deletion warning**: deleting a BSI is for undoing bad imports, not
    hiding items (use `ignored`); `with_group: true` (default) destroys the
    linked group's real transactions, and any deleted item will REAPPEAR as
    pending on the next re-sync — re-reconciling it double-counts
- Update the **Transaction Groups** block: `statement_id` is gone; groups
  hydrate a `statements` array; `create_from_statements` and
  `delete_statement_item` join the reserved-path conventions.

Schema comments in `_schema.sql` (the file doubles as documentation) for the
new columns, CHECKs, and the reordering of `bank_statement_items` after
`transaction_groups`.

## Suggested implementation order

1. Schema: reorder tables, move the FK, add `ignored` + CHECKs + indexes
2. `models/BankStatementItem.js` + its test file
3. `TransactionGroup` changes + test extensions
4. CLAUDE.md updates

## Future work (explicitly out of scope)

- **Source/dest clues**: per-item (or per-source pattern) hints that pre-fill
  the reconciliation split.
- **Attach/detach items on an existing group** (`link`/`unlink` as public
  operations) for reworking a reconciliation without deleting the group.
- **Amount-discrepancy surfacing**: with no hard sum check, a UI/API layer
  could flag groups whose transactions don't plausibly match their items.
- **Import batches**: grouping items by statement/upload for review UX.
- **API layer**: user-facing endpoints (positive-amount enforcement etc.)
  once the HTTP layer exists.
