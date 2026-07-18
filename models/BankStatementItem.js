
const Base = require("./Base.js");

const {
    ConflictError,
    ForeignKeyError
} = require("../lib/db.js");

const {
    currency2stmt,
    stmt2currency,
    boolean2stmt,
    stmt2boolean,
    stmt2datetime,
    stmt2ydate,
    ydate2stmt
} = require("../lib/db.js").helpers;

const SELECT_COLUMNS = [
    "id",
    "source",
    "key",
    "ignored",
    "group_id",
    "amount",
    "date",
    "note",
    "created_at",
];

/**
 * One imported bank statement line.
 *
 * Items are deduped on (source, key) -- `key` is an externally-derived
 * identifier, so re-syncing a statement (`import_many`) never duplicates
 * rows and never touches existing ones. The bank facts (source, key, amount,
 * date) are immutable; only `ignored` and `note` may change.
 *
 * An item is always in exactly one of three derivable states:
 *  - pending:    ignored = 0 and group_id IS NULL
 *  - ignored:    ignored = 1 (a db CHECK guarantees no group)
 *  - reconciled: group_id points at the transaction group for this item
 *
 * group_id lives on THIS table (not on transaction_groups) so that
 * transfer-type events -- two items from two different bank imports, e.g.
 * checking -> savings -- can share a single group. Linking happens via
 * TransactionGroup.create_from_statements / .link_statements; an item is
 * released back to pending by `item.unlink(db)` (group survives untouched),
 * by group deletion (ON DELETE SET NULL), or by
 * TransactionGroup.delete_statement_item. Re-pointing a reconciled item at a
 * different group is unlink-then-relink (two steps, deliberate).
 *
 * `amount` is signed: negative means money leaving that bank account. It is
 * intentionally never checked against the linked group's transactions.
 */
module.exports = class BankStatementItem extends Base {
    // Copied here for use by TransactionGroup's hydration subquery
    static SELECT_COLUMNS = SELECT_COLUMNS;

    static PREPARED_STMTS = {
        for_id: `
            SELECT ${SELECT_COLUMNS.join(", ")}
            FROM bank_statement_items
            WHERE id = @id
        `,
        for_key: `
            SELECT ${SELECT_COLUMNS.join(", ")}
            FROM bank_statement_items
            WHERE source = @source AND key = @key
        `,
        create: `
            INSERT INTO bank_statement_items (
                source,
                key,
                amount,
                date,
                note
            ) VALUES (
                @source,
                @key,
                @amount,
                @date,
                @note
            )
        `,
        import_one: `
            INSERT INTO bank_statement_items (
                source,
                key,
                amount,
                date,
                note
            ) VALUES (
                @source,
                @key,
                @amount,
                @date,
                @note
            )
            ON CONFLICT (source, key) DO NOTHING
        `,
        // Covered by idx_bank_statement_items_source: a pure index scan, so
        // no sources table/denormalization is needed
        sources: `
            SELECT DISTINCT source
            FROM bank_statement_items
            ORDER BY source
        `,
        update: `
            UPDATE bank_statement_items
            SET ignored = @ignored,
                note = @note
            WHERE id = @id
        `,
        link: `
            UPDATE bank_statement_items
            SET group_id = @group_id
            WHERE id = @id
        `,
        unlink: `
            UPDATE bank_statement_items
            SET group_id = NULL
            WHERE id = @id
        `,
        delete: `
            DELETE FROM bank_statement_items
            WHERE id = @id
        `,
    }

    static PREPARED_TRANSACTIONS = {}

    static ORDER_BY_MAP = {
        "id": "id",
        "date": "date",
        "source": "source",
        "amount": "amount",
        "note": "note",
        // Derived state is not a column: order by a CASE that matches how the
        // state reads alphabetically (ignored < pending < reconciled) so it
        // groups the way the UI badge does.
        "state": "CASE WHEN group_id IS NOT NULL THEN 2 WHEN ignored = 1 THEN 0 ELSE 1 END",
    }


    constructor({
        id,
        source,
        key,
        ignored,
        group_id,
        amount,
        date,
        note,
        created_at,
    }={}) {
        super();
        this.id = id;
        this.source = source;
        this.key = key;
        this.ignored = ignored;
        this.group_id = group_id;
        this.amount = amount;
        this.date = date;
        this.note = note;
        this.created_at = created_at;
    }

    /**
     * The canonical derived state (never stored -- always derivable from
     * ignored/group_id, which a db CHECK keeps mutually exclusive).
     */
    get state() {
        if ( this.group_id != null ) return "reconciled";
        if ( this.ignored ) return "ignored";
        return "pending";
    }

    static openapi_BankStatementItemSchema = {
        description: "One imported bank statement line. Always in exactly one of three derivable states: pending (ignored=false, group_id=null), ignored (ignored=true), or reconciled (group_id set) -- canonicalized as `state`. Bank facts (source, key, amount, date) are immutable.",
        type: 'object',
        properties: {
            id: { type: 'integer', minimum: 1 },
            source: { type: 'string', description: "Which bank this line was imported from" },
            key: { type: 'string', description: "Bank-scoped dedupe key; (source, key) is unique" },
            state: { type: 'string', enum: [ 'pending', 'ignored', 'reconciled' ], description: "The canonical derived state (from ignored/group_id, which are mutually exclusive)" },
            ignored: { type: 'boolean' },
            group_id: { type: 'integer', minimum: 1, nullable: true, description: "The transaction group this item is reconciled to; null while pending/ignored" },
            amount: { type: 'number', description: "Signed currency as a float dollar amount: negative = money leaving the bank account" },
            date: { type: 'string', format: 'date', example: '2026-01-15' },
            note: { type: 'string', nullable: true },
            created_at: { type: 'string', format: 'date-time' }
        },
        required: [ 'id', 'source', 'key', 'state', 'ignored', 'group_id', 'amount', 'date', 'note', 'created_at' ]
    };

    to_api() {
        return {
            id: this.id,
            source: this.source,
            key: this.key,
            state: this.state,
            ignored: this.ignored,
            group_id: this.group_id,
            amount: this.amount,
            date: this.date.toJSON(),
            note: this.note,
            created_at: this.created_at.toISOString(),
        };
    }

    static from_row(row) {
        if ( row == null ) return null;

        return new this({
            id: row.id,
            source: row.source,
            key: row.key,
            ignored: stmt2boolean(row.ignored),
            group_id: row.group_id,
            amount: stmt2currency(row.amount),
            date: stmt2ydate(row.date),
            note: row.note,
            created_at: stmt2datetime(row.created_at),
        });
    }

    static for_id(db, id) {
        const stmt = this.get_stmt(db, "for_id");
        return this.from_row(stmt.get({ id }) ?? null);
    }

    static for_key(db, { source, key }={}) {
        const stmt = this.get_stmt(db, "for_key");
        return this.from_row(stmt.get({ source, key }) ?? null);
    }

    static _from_db_wheres({
        source,
        since,  // YDate or null
        until,  // YDate or null
        ignored,
        has_group,
        group_id,
        search,  // free-text substring across source/key/note
    }={}) {
        const wheres = [];
        const params = {};
        const keys = [];

        if ( source !== undefined ) {
            wheres.push("source = @source");
            params.source = source;
            keys.push("source");
        }
        if ( search !== undefined ) {
            // Case-insensitive substring across the human-readable fields --
            // the server-side equal of the old client search box. LIKE is
            // ASCII-case-insensitive in sqlite; escape the user's own
            // wildcards so `%`/`_` are matched literally.
            wheres.push("(source LIKE @search ESCAPE '\\' OR key LIKE @search ESCAPE '\\' OR note LIKE @search ESCAPE '\\')");
            params.search = "%" + search.replace(/[\\%_]/g, "\\$&") + "%";
            keys.push("search");
        }
        if ( since !== undefined ) {
            wheres.push("date >= @since");
            params.since = ydate2stmt(since);
            keys.push("since");
        }
        if ( until !== undefined ) {
            wheres.push("date <= @until");
            params.until = ydate2stmt(until);
            keys.push("until");
        }
        if ( ignored !== undefined ) {
            wheres.push("ignored = @ignored");
            params.ignored = boolean2stmt(ignored);
            keys.push("ignored");
        }
        if ( has_group !== undefined ) {
            wheres.push(has_group ? "group_id IS NOT NULL" : "group_id IS NULL");
            keys.push("has_group_" + boolean2stmt(has_group));
        }
        if ( group_id !== undefined ) {
            wheres.push("group_id = @group_id");
            params.group_id = group_id;
            keys.push("group_id");
        }

        return { wheres, params, keys };
    }

    static from_db(db, {
        order_by = "date",
        order_direction = "DESC",
        limit = 100,
        offset = 0,
        ...filters
    }={}) {
        const { wheres, params, keys } = this._from_db_wheres(filters);

        let sql = `SELECT ${SELECT_COLUMNS.join(", ")}\n`
                + `FROM bank_statement_items\n`;
        if ( wheres.length ) {
            sql = sql + `WHERE\n    ${wheres.join("\n    AND ")}\n`;
        }
        if ( order_by !== null ) {
            const _order_by = this.get_order_by_column_name(order_by);
            const _order_direction = this.get_order_direction(order_direction);

            // Break ties on id (a stable, unique key) so a paginated sort on a
            // non-unique column doesn't shuffle rows between adjacent pages.
            sql = sql + (order_by === "id"
                ? `ORDER BY id ${_order_direction}\n`
                : `ORDER BY ${_order_by} ${_order_direction}, id ${_order_direction}\n`);

            keys.push("order_by_"+order_by);
            keys.push(_order_direction);
        }
        if ( limit !== null ) {
            sql = sql + `LIMIT @limit OFFSET @offset\n`;
            params.limit = limit;
            params.offset = offset;
            keys.push("limit");
        }

        const stmt = this.build_stmt(
            db,
            "from_db$" + keys.join(":"),
            sql
        );

        return stmt.all(params).map(row => this.from_row(row));
    }

    /**
     * Total rows matching the same filters as from_db (order/limit/offset
     * are accepted and ignored, so the API layer can pass one filter object
     * to both).
     */
    static count(db, { order_by, order_direction, limit, offset, ...filters }={}) {
        const { wheres, params, keys } = this._from_db_wheres(filters);

        let sql = `SELECT COUNT(*) AS count\n`
                + `FROM bank_statement_items\n`;
        if ( wheres.length ) {
            sql = sql + `WHERE\n    ${wheres.join("\n    AND ")}\n`;
        }

        const stmt = this.build_stmt(
            db,
            "count$" + keys.join(":"),
            sql
        );

        return stmt.get(params).count;
    }

    /**
     * Every distinct source across all imported items, sorted -- the
     * suggestion list for import UIs (sources are free-form labels; a
     * consistent name per bank account is what makes dedupe work).
     */
    static sources(db) {
        const stmt = this.get_stmt(db, "sources");
        return stmt.all().map(row => row.source);
    }

    // Bank facts must be well-formed before they hit the db
    static _assert_valid_facts({ source, key, amount, date }={}) {
        if ( !source ) throw new Error("Missing source");
        if ( !key ) throw new Error("Missing key");
        if ( !date ) throw new Error("Missing date");
        const _amount = currency2stmt(amount);
        if ( _amount == null ) throw new Error("Missing amount");
        // A zero-amount bank line carries no information worth reconciling
        if ( _amount === 0 ) throw new Error("Bank statement item amount cannot be zero");
    }

    static _create(db, {
        source,
        key,
        amount,
        date,
        note,
    }={}) {
        if ( this.get_stmt(db, "for_key").get({ source, key }) ) {
            throw new ConflictError("Bank statement item already exists: " + source + "/" + key);
        }

        const result = this.get_stmt(db, "create").run({
            source,
            key,
            amount: currency2stmt(amount),
            date: ydate2stmt(date),
            note: note ?? null,
        });

        return this.for_id(db, result.lastInsertRowid);
    }

    static create(db, {
        source,
        key,
        amount,  // signed float; negative = money leaving the bank account
        date,
        note = null,
    }={}) {
        this._assert_valid_facts({ source, key, amount, date });

        const transaction = this.build_transaction(db, "create", this._create.bind(this));
        return transaction(db, { source, key, amount, date, note });
    }

    static _import_many(db, items) {
        const created = [];
        const skipped = [];

        for ( const item of items ) {
            const result = this.get_stmt(db, "import_one").run({
                source: item.source,
                key: item.key,
                amount: currency2stmt(item.amount),
                date: ydate2stmt(item.date),
                note: item.note ?? null,
            });

            // ON CONFLICT DO NOTHING: an existing (source, key) row is left
            // untouched -- bank facts are immutable, and its ignored/group_id
            // state must survive re-syncs
            if ( result.changes === 0 ) {
                skipped.push({ source: item.source, key: item.key });
            } else {
                created.push(this.for_id(db, result.lastInsertRowid));
            }
        }

        return { created, skipped };
    }

    /**
     * Idempotent bulk import (the statement re-sync path), atomically.
     * Existing (source, key) rows are skipped, never updated. Returns
     * { created: [BankStatementItem], skipped: [{ source, key }] }.
     */
    static import_many(db, items=[]) {
        for ( const item of items ) this._assert_valid_facts(item);

        const transaction = this.build_transaction(db, "import_many", this._import_many.bind(this));
        return transaction(db, items);
    }

    static _update(db, item, changes={}) {
        const fresh = this.for_id(db, item.id);
        if ( !fresh ) {
            throw new ForeignKeyError("Bank statement item does not exist: " + item.id);
        }

        const next = {
            ignored: changes.ignored !== undefined ? changes.ignored : fresh.ignored,
            note: changes.note !== undefined ? changes.note : fresh.note,
        };

        // An ignored item must not be linked to a group (db CHECK backstops)
        if ( next.ignored && fresh.group_id != null ) {
            throw new ConflictError("Cannot ignore a bank statement item that is reconciled to a transaction group");
        }

        this.get_stmt(db, "update").run({
            id: fresh.id,
            ignored: boolean2stmt(next.ignored),
            note: next.note ?? null,
        });

        return this.for_id(db, fresh.id);
    }

    /**
     * Only `ignored` and `note` are mutable -- the bank facts (source, key,
     * amount, date) are what the bank said; delete and re-import instead.
     */
    update(db, {
        ignored,
        note,
    }={}) {
        const transaction = this.constructor.build_transaction(
            db, "update", this.constructor._update.bind(this.constructor));
        return transaction(db, this, { ignored, note });
    }

    static _unlink(db, item) {
        const fresh = this.for_id(db, item.id);
        if ( !fresh ) {
            throw new ForeignKeyError("Bank statement item does not exist: " + item.id);
        }
        if ( fresh.group_id == null ) {
            throw new ConflictError("Bank statement item is not reconciled to a transaction group: " + item.id);
        }

        this.get_stmt(db, "unlink").run({ id: fresh.id });

        return this.for_id(db, fresh.id);
    }

    /**
     * Release a RECONCILED item back to pending: clears group_id while the
     * linked transaction group and its transactions survive untouched. No
     * money moves, so (like TransactionGroup.link_statements) there is NO
     * finalized-month guard. Errors unless the item is currently reconciled.
     *
     * This is the "not actually explained by that group" undo -- distinct from
     * deleting the group (which destroys its transactions). It is also the two-
     * step re-point path: unlink, then link to the correct group.
     */
    unlink(db) {
        const transaction = this.constructor.build_transaction(
            db, "unlink", this.constructor._unlink.bind(this.constructor));
        return transaction(db, this);
    }

    /**
     * BSI deletion lives on TransactionGroup, NOT here: deleting a reconciled
     * item defaults to also deleting its linked transaction group inside the
     * same sqlite transaction, which needs the TransactionGroup model -- and
     * the model require direction is strictly
     * TransactionGroup -> BankStatementItem, so the composer owns the
     * operation.
     */
    delete() { throw new Error("You cannot directly delete a bank statement item, please delete via TransactionGroup.delete_statement_item(...)"); }

    /**
     * Only for use by TransactionGroup (inside its sqlite transactions):
     * assert every id can be reconciled (exists, not ignored, not already
     * linked) and return the items.
     */
    static _assert_linkable(db, ids=[]) {
        return ids.map(id => {
            const item = this.for_id(db, id);
            if ( !item ) {
                throw new ForeignKeyError("Bank statement item does not exist: " + id);
            }
            if ( item.ignored ) {
                throw new ConflictError("Bank statement item is ignored: " + id);
            }
            if ( item.group_id != null ) {
                throw new ConflictError("Bank statement item is already reconciled to a transaction group: " + id);
            }
            return item;
        });
    }

    /**
     * Only for use by TransactionGroup (inside its sqlite transactions),
     * after _assert_linkable.
     */
    static _link(db, ids=[], group_id) {
        for ( const id of ids ) {
            this.get_stmt(db, "link").run({ id, group_id });
        }
    }

    /**
     * Only for use by TransactionGroup.delete_statement_item.
     */
    static _delete_row(db, id) {
        this.get_stmt(db, "delete").run({ id });
    }
}
