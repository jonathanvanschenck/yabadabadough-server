
const Base = require("./Base.js");

const Transaction = require("./Transaction.js");
const BankStatementItem = require("./BankStatementItem.js");

const {
    ConflictError,
    ForeignKeyError
} = require("../lib/db.js");

const {
    currency2stmt,
    stmt2currency,
    boolean2stmt,
    stmt2boolean,
    datetime2stmt,
    stmt2datetime,
    stmt2ydate,
    ydate2stmt
} = require("../lib/db.js").helpers;

const GROUP_COLUMNS = [
    "id",
    "date",
    "description",
    "note",
    "split",
    "allocation",
    "eom_cleanup",
    "created_at",
];


const TRANSACTIONS_COLUMN = `COALESCE(
    json_group_array(
        json_object(
            ${Transaction.SELECT_COLUMNS.map(c => `'${c}', transactions.${c}`).join(",\n            ")}
        ) ORDER BY transactions.created_at
    ) FILTER (WHERE transactions.id IS NOT NULL),
    json('[]')
) AS _transactions`;

// Correlated subquery, NOT a third join: a second one-to-many LEFT JOIN
// would cross-product against the transactions join and duplicate the rows
// feeding both json_group_arrays
const STATEMENTS_COLUMN = `(
    SELECT COALESCE(
        json_group_array(
            json_object(
                ${BankStatementItem.SELECT_COLUMNS.map(c => `'${c}', bank_statement_items.${c}`).join(",\n                ")}
            ) ORDER BY bank_statement_items.id
        ),
        json('[]')
    )
    FROM bank_statement_items
    WHERE bank_statement_items.group_id = transaction_groups.id
) AS _statements`;

const SELECT_COLUMNS = [
    ...GROUP_COLUMNS.map(c => `transaction_groups.${c} AS ${c}`),
    TRANSACTIONS_COLUMN,
    STATEMENTS_COLUMN
];


module.exports = class TransactionGroup extends Base {
    static PREPARED_STMTS = {
        for_id: `SELECT
            ${SELECT_COLUMNS.join(",\n    ")}
        FROM transaction_groups
        LEFT JOIN transactions
            ON transactions.group_id = transaction_groups.id
        WHERE
            transaction_groups.id = @id
        GROUP BY ${GROUP_COLUMNS.map(c => "transaction_groups."+c).join(", ")}
        `,
        // Inline (rather than requiring MonthFinalization) to avoid a circular require
        month_is_finalized: `
            SELECT 1
            FROM month_finalizations
            WHERE eom_date >= @date
            LIMIT 1
        `,
        create: `INSERT INTO transaction_groups (
            date,
            description,
            note,
            split,
            allocation,
            eom_cleanup
        ) VALUES (
            @date,
            @description,
            @note,
            @split,
            @allocation,
            @eom_cleanup
        )
        `,
        sync_split: `
            UPDATE transaction_groups
            SET split = (
                SELECT COUNT(*) FROM transactions
                WHERE group_id = @group_id
            ) > 1
            WHERE id = @group_id
        `,
        delete: `
            DELETE FROM transaction_groups
            WHERE id = @id
        `
    }

    static PREPARED_TRANSACTIONS = {}

    static ORDER_BY_MAP = {
        "id": "transaction_groups.id",
        "date": "transaction_groups.date"
    }


    constructor({
        id,
        description,
        date,
        note,
        split,
        allocation,
        eom_cleanup,
        transactions = [],
        statements = [],
        created_at
    }={}) {
        super();
        this.id = id;
        this.description = description;
        this.date = date;
        this.note = note;
        this.split = split;
        this.allocation = allocation;
        this.eom_cleanup = eom_cleanup;
        this.transactions = transactions;
        this.statements = statements;
        this.created_at = created_at;
    }

    static openapi_TransactionGroupSchema = {
        description: "A container for one or more related transactions, plus any bank statement items reconciled to it.",
        type: 'object',
        properties: {
            id: { type: 'integer', minimum: 1 },
            description: { type: 'string' },
            date: { type: 'string', format: 'date', example: '2026-01-15' },
            note: { type: 'string', nullable: true },
            status: {
                type: 'object',
                properties: {
                    split: { type: 'boolean', description: "true iff the group holds more than one transaction" },
                    allocation: { type: 'boolean', description: "Reserved for the internal Allocation path: the month's start-of-month allocation group" },
                    eom_cleanup: { type: 'boolean', description: "Reserved for the internal MonthFinalization path: an end-of-month cleanup group" }
                },
                required: [ 'split', 'allocation', 'eom_cleanup' ]
            },
            transactions: {
                type: 'array',
                items: { '$ref': '#/components/schemas/TransactionSchema' }
            },
            statements: {
                description: "Bank statement items reconciled to this group",
                type: 'array',
                items: { '$ref': '#/components/schemas/BankStatementItemSchema' }
            },
            created_at: { type: 'string', format: 'date-time' }
        },
        required: [ 'id', 'description', 'date', 'note', 'status', 'transactions', 'statements', 'created_at' ]
    };

    to_api() {
        return {
            id: this.id,
            description: this.description,
            date: this.date.toJSON(),
            note: this.note,
            status: {
                split: this.split,
                allocation: this.allocation,
                eom_cleanup: this.eom_cleanup,
            },
            transactions: this.transactions.map(t => t.to_api()),
            statements: this.statements.map(s => s.to_api()),
            created_at: this.created_at.toISOString(),
        };
    }

    static from_row(row) {
        if ( row == null ) return null;

        const transactions = JSON.parse(row._transactions);
        const statements = JSON.parse(row._statements);
        return new this({
            id: row.id,
            date: stmt2ydate(row.date),
            description: row.description,
            note: row.note,
            split: stmt2boolean(row.split),
            allocation: stmt2boolean(row.allocation),
            eom_cleanup: stmt2boolean(row.eom_cleanup),
            transactions: transactions.map(r => Transaction.from_row(r)),
            statements: statements.map(r => BankStatementItem.from_row(r)),
            created_at: stmt2datetime(row.created_at),
        });
    }

    static for_id(db, id) {
        const stmt = this.get_stmt(db, "for_id");
        return this.from_row(stmt.get({ id }) ?? null);
    }

    static _from_db_wheres({
        since,  // YDate or null
        until,  // YDate or null
        split,
        allocation,
        eom_cleanup,
        has_statements,
        description_like,
    }={}) {
        const wheres = [];
        const params = {};
        const keys = [];

        if ( since !== undefined ) {
            wheres.push("transaction_groups.date >= @since");
            params.since = ydate2stmt(since);
            keys.push("since");
        }
        if ( until !== undefined ) {
            wheres.push("transaction_groups.date <= @until");
            params.until = ydate2stmt(until);
            keys.push("until");
        }
        if ( split !== undefined ) {
            wheres.push("transaction_groups.split = @split");
            params.split = boolean2stmt(split);
            keys.push("split");
        }
        if ( allocation !== undefined ) {
            wheres.push("transaction_groups.allocation = @allocation");
            params.allocation = boolean2stmt(allocation);
            keys.push("allocation");
        }
        if ( eom_cleanup !== undefined ) {
            wheres.push("transaction_groups.eom_cleanup = @eom_cleanup");
            params.eom_cleanup = boolean2stmt(eom_cleanup);
            keys.push("eom_cleanup");
        }
        if ( has_statements !== undefined ) {
            wheres.push((has_statements ? "" : "NOT ")
                + "EXISTS (SELECT 1 FROM bank_statement_items WHERE bank_statement_items.group_id = transaction_groups.id)");
            keys.push("has_statements_" + boolean2stmt(has_statements));
        }
        if ( description_like !== undefined ) {
            wheres.push("transaction_groups.description LIKE @description_like");
            params.description_like = "%" + description_like + "%";
            keys.push("description_like");
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

        let sql = `SELECT ${SELECT_COLUMNS.join(",\n    ")}\n`
                + `FROM transaction_groups\n`
                + `LEFT JOIN transactions ON transactions.group_id = transaction_groups.id\n`;

        if ( wheres.length ) {
            sql = sql + `WHERE\n    ${wheres.join("\n    AND ")}\n`;
        }

        sql = sql + `GROUP BY ${GROUP_COLUMNS.map(c => "transaction_groups."+c).join(", ")}\n`;

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

    /**
     * Total rows matching the same filters as from_db (order/limit/offset
     * are accepted and ignored, so the API layer can pass one filter object
     * to both). No JOIN needed: the wheres only touch transaction_groups
     * (has_statements is an EXISTS subquery).
     */
    static count(db, { order_by, order_direction, limit, offset, ...filters }={}) {
        const { wheres, params, keys } = this._from_db_wheres(filters);

        let sql = `SELECT COUNT(*) AS count\n`
                + `FROM transaction_groups\n`;
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


    static _create(db, {
        date,
        description,
        note,
        split,
        eom_cleanup,
        allocation,
        transactions
    }={}) {
        const stmt = this.get_stmt(db, "create");
        const result = stmt.run({
            date: ydate2stmt(date),
            description,
            note,
            split: boolean2stmt(split),
            eom_cleanup: boolean2stmt(eom_cleanup),
            allocation: boolean2stmt(allocation),
        });
        const group_id = result.lastInsertRowid;

        for ( const transaction of transactions ) {
            Transaction._create_with_group(db,{
                source_fund_id: transaction.source_fund_id,
                target_fund_id: transaction.target_fund_id,
                group_id,
                date,

                amount: transaction.amount,
                description: transaction.description,
                note: transaction.note,

                eom_cleanup_id: transaction.eom_cleanup_id,
                // Denormalized from the group so allocation transactions are
                // directly queryable
                allocation,
            })
        }

        // TODO : trigger fund balance re-calculation

        return this.for_id(db, group_id);
    }

    /**
     * Throws unless the month containing `date` (and every month before it)
     * is unfinalized. Used by create/delete here, and by Allocation for its
     * in-group edits.
     */
    static assert_month_unfinalized(db, date) {
        if ( this.get_stmt(db, "month_is_finalized").get({ date: ydate2stmt(date) }) ) {
            throw new ConflictError("Cannot modify transaction groups in a finalized month");
        }
    }

    static create(db, {
        date,
        description,
        note = null,
        eom_cleanup = false,
        allocation = false,
        transactions = []
    }={}) {
        if ( transactions.length < 1 ) throw new Error("Must provide at least transaction");

        // The eom_cleanup/allocation flags are reserved for the internal
        // `_create` paths; USER groups are always plain. (Reconciling bank
        // statement items goes through `create_from_statements`, which owns
        // the linking.)
        if ( allocation ) throw new Error("Allocation groups may only be created via Allocation.set(...)");
        if ( eom_cleanup ) throw new Error("EOM cleanup groups may only be created via MonthFinalization.create(...)");

        // Guard: no transaction groups may be added in (or before) a finalized
        // month -- the month must be unfinalized first.
        // NOTE : MonthFinalization and Allocation intentionally bypass this
        //        guard by calling `_create` directly (MonthFinalization's
        //        eom_cleanup group is dated inside the month being finalized;
        //        Allocation applies the guard itself before editing).
        this.assert_month_unfinalized(db, date);

        // TODO : more error checking?

        const transaction = this.build_transaction(db, "create", this._create.bind(this));
        return transaction(db, {
            date,
            description,
            note,
            split: transactions.length > 1,
            eom_cleanup: false,
            allocation: false,
            transactions
        })
    }

    static _create_from_statements(db, {
        statement_ids,
        date,
        description,
        note,
        transactions
    }={}) {
        const items = BankStatementItem._assert_linkable(db, statement_ids);

        // Transfer sides can post on different days; default to the day the
        // money movement completed
        const _date = date ?? items
            .map(i => i.date)
            .reduce((a, b) => ydate2stmt(a) >= ydate2stmt(b) ? a : b);

        this.assert_month_unfinalized(db, _date);

        const _description = description ?? (
            items.map(i => i.note).filter(Boolean).join(" / ")
            || items.map(i => i.key).join(" / ")
        );

        const group = this._create(db, {
            date: _date,
            description: _description,
            note,
            split: transactions.length > 1,
            eom_cleanup: false,
            allocation: false,
            transactions
        });

        BankStatementItem._link(db, statement_ids, group.id);

        // Refresh so the hydrated `statements` array is populated
        return this.for_id(db, group.id);
    }

    /**
     * Create a transaction group that reconciles one or more bank statement
     * items. Pass ONE statement id for the ordinary case; pass BOTH sides'
     * ids for a transfer-type event (e.g. checking -> savings), which shows
     * up as two items from two different bank imports but is a single group
     * here.
     *
     * `date` defaults to the latest linked item's date; `description`
     * defaults to the items' notes (falling back to their keys).
     *
     * NOTE : the sum of the transaction amounts is intentionally NOT checked
     *        against the item amounts (transfers make any simple rule
     *        ambiguous); reconciliation quality is the caller's concern.
     */
    static create_from_statements(db, {
        statement_ids = [],
        date = null,
        description = null,
        note = null,
        transactions = []
    }={}) {
        if ( statement_ids.length < 1 ) throw new Error("Must provide at least one statement id");
        if ( new Set(statement_ids).size !== statement_ids.length ) throw new Error("Duplicate statement ids");
        if ( transactions.length < 1 ) throw new Error("Must provide at least transaction");

        const transaction = this.build_transaction(
            db, "create_from_statements", this._create_from_statements.bind(this));
        return transaction(db, { statement_ids, date, description, note, transactions });
    }

    static create_single(db, {
        date,
        description,
        note = null,
        source_fund_id,
        target_fund_id,
        amount,
    }={}) {
        return this.create(db, {
            date,
            description,
            note,
            transactions: [{
                source_fund_id,
                target_fund_id,
                amount,
                description,
                note,
            }]
        });
    }

    /**
     * Only for use by Allocation (inside its sqlite transactions): insert a
     * transaction into an existing group, keeping the denormalized `split`
     * flag in sync. The transaction takes the group's date and allocation
     * flag. Returns the refreshed group.
     */
    static _add_transaction(db, group, {
        source_fund_id,
        target_fund_id,
        amount,
        description,
        note = null,
        eom_cleanup_id = null,
    }={}) {
        Transaction._create_with_group(db, {
            source_fund_id,
            target_fund_id,
            group_id: group.id,
            date: group.date,

            amount,
            description,
            note,

            eom_cleanup_id,
            allocation: group.allocation,
        });
        this.get_stmt(db, "sync_split").run({ group_id: group.id });
        return this.for_id(db, group.id);
    }

    /**
     * Only for use by Allocation (inside its sqlite transactions): remove one
     * transaction from an existing group, keeping `split` in sync. Callers
     * are responsible for deleting the group when it empties (groups hold at
     * least one transaction). Returns the refreshed group.
     */
    static _remove_transaction(db, group, transaction_id) {
        Transaction._delete(db, transaction_id);
        this.get_stmt(db, "sync_split").run({ group_id: group.id });
        return this.for_id(db, group.id);
    }

    static _delete(db, group) {
        // NOTE : this guard inherently protects eom_cleanup groups, which only
        //        ever exist inside finalized months (unfinalize removes them
        //        via its own internal path)
        this.assert_month_unfinalized(db, group.date);

        Transaction._delete_for_group(db, group.id);
        this.get_stmt(db, "delete").run({ id: group.id });
    }

    delete(db) {
        const transaction = this.constructor.build_transaction(
            db, "delete", this.constructor._delete.bind(this.constructor));
        return transaction(db, this);
    }

    static _delete_statement_item(db, item, { with_group }={}) {
        const fresh = BankStatementItem.for_id(db, item.id);
        if ( !fresh ) {
            throw new ForeignKeyError("Bank statement item does not exist: " + item.id);
        }

        if ( with_group && fresh.group_id != null ) {
            // The finalized-month guard inside _delete applies; ON DELETE
            // SET NULL releases any transfer peer item back to pending
            this._delete(db, this.for_id(db, fresh.group_id));
        }

        BankStatementItem._delete_row(db, fresh.id);
    }

    /**
     * Delete a bank statement item -- and, with `with_group` (the default),
     * the transaction group that reconciles it.
     *
     * This lives HERE (not on BankStatementItem) because the with_group arm
     * deletes a group inside the same sqlite transaction, which needs this
     * model -- and the model require direction is strictly
     * TransactionGroup -> BankStatementItem, so the composer owns the
     * operation. BankStatementItem#delete() is a throwing stub pointing here.
     *
     * WARNING : deletion is for undoing bad imports, NOT for hiding items
     *           (that is what `ignored` is for). With with_group the group's
     *           real transactions are destroyed (a transfer peer item is
     *           released back to pending, not deleted). And in ALL cases,
     *           re-syncing the bank statement will re-import the deleted item
     *           as pending -- its (source, key) dedupe row is gone -- so
     *           reconciling it again would double-count.
     */
    static delete_statement_item(db, item, { with_group = true }={}) {
        const transaction = this.build_transaction(
            db, "delete_statement_item", this._delete_statement_item.bind(this));
        return transaction(db, item, { with_group });
    }

    /**
     * NOTE : we explicitly restrict the update-able fields to prevent db desycn
     *        you should just delete and re-create a transaction if you need to
     *        change anything, since that will gaurentee all side-effects take place
     */
    update(db, {
        description,
        note
    }={}) { throw new Error("TODO") }
}
