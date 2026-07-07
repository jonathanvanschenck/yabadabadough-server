
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
 * checking -> savings -- can share a single group. Linking happens only via
 * TransactionGroup.create_from_statements; unlinking only via group deletion
 * (ON DELETE SET NULL) or TransactionGroup.delete_statement_item.
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
        delete: `
            DELETE FROM bank_statement_items
            WHERE id = @id
        `,
    }

    static PREPARED_TRANSACTIONS = {}

    static ORDER_BY_MAP = {
        "id": "id",
        "date": "date"
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

    static openapi_BankStatementItemSchema = {
        description: "One imported bank statement line. Always in exactly one of three derivable states: pending (ignored=false, group_id=null), ignored (ignored=true), or reconciled (group_id set). Bank facts (source, key, amount, date) are immutable.",
        type: 'object',
        properties: {
            id: { type: 'integer', minimum: 1 },
            source: { type: 'string', description: "Which bank this line was imported from" },
            key: { type: 'string', description: "Bank-scoped dedupe key; (source, key) is unique" },
            ignored: { type: 'boolean' },
            group_id: { type: 'integer', minimum: 1, nullable: true, description: "The transaction group this item is reconciled to; null while pending/ignored" },
            amount: { type: 'number', description: "Signed currency as a float dollar amount: negative = money leaving the bank account" },
            date: { type: 'string', format: 'date', example: '2026-01-15' },
            note: { type: 'string', nullable: true },
            created_at: { type: 'string', format: 'date-time' }
        },
        required: [ 'id', 'source', 'key', 'ignored', 'group_id', 'amount', 'date', 'note', 'created_at' ]
    };

    to_api() {
        return {
            id: this.id,
            source: this.source,
            key: this.key,
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

    static from_db(db, {
        source,
        since,  // YDate or null
        until,  // YDate or null
        ignored,
        has_group,
        group_id,
        order_by = "date",
        order_direction = "DESC",
        limit = 100,
        offset = 0
    }={}) {
        const wheres = [];
        const params = {};
        const keys = [];

        if ( source !== undefined ) {
            wheres.push("source = @source");
            params.source = source;
            keys.push("source");
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

        let sql = `SELECT ${SELECT_COLUMNS.join(", ")}\n`
                + `FROM bank_statement_items\n`;
        if ( wheres.length ) {
            sql = sql + `WHERE\n    ${wheres.join("\n    AND ")}\n`;
        }
        if ( order_by !== null ) {
            const _order_by = this.get_order_by_column_name(order_by);
            const _order_direction = this.get_order_direction(order_direction);

            sql = sql + `ORDER BY ${_order_by} ${_order_direction}\n`;

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
