
const Base = require("./Base.js");

const Transaction = require("./Transaction.js");

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
    "statement_id",
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

const SELECT_COLUMNS = [
    ...GROUP_COLUMNS.map(c => `transaction_groups.${c} AS ${c}`),
    TRANSACTIONS_COLUMN
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
        statement_exists: `
            SELECT 1
            FROM bank_statement_items
            WHERE id = @id
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
            eom_cleanup,
            statement_id
        ) VALUES (
            @date,
            @description,
            @note,
            @split,
            @allocation,
            @eom_cleanup,
            @statement_id
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
        statement_id,
        transactions = [],
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
        this.statement_id = statement_id;
        this.transactions = transactions;
        this.created_at = created_at;
    }

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
            statement_id: this.statement_id,
            transactions: this.transactions.map(t => t.to_api()),
            created_at: this.created_at.toISOString(),
        };
    }

    static from_row(row) {
        if ( row == null ) return null;

        const transactions = JSON.parse(row._transactions);
        return new this({
            id: row.id,
            date: stmt2ydate(row.date),
            description: row.description,
            note: row.note,
            split: stmt2boolean(row.split),
            allocation: stmt2boolean(row.allocation),
            eom_cleanup: stmt2boolean(row.eom_cleanup),
            statement_id: row.statement_id,
            transactions: transactions.map(r => Transaction.from_row(r)),
            created_at: stmt2datetime(row.created_at),
        });
    }

    static for_id(db, id) {
        const stmt = this.get_stmt(db, "for_id");
        return this.from_row(stmt.get({ id }) ?? null);
    }

    static from_db(db, {
        since,  // YDate or null
        until,  // YDate or null
        split,
        allocation,
        eom_cleanup,
        statement_id,
        description_like,
        order_by = "date",
        order_direction = "DESC",
        limit = 100,
        offset = 0
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
        if ( statement_id !== undefined ) {
            wheres.push("transaction_groups.statement_id = @statement_id");
            params.statement_id = statement_id;
            keys.push("statement_id");
        }
        if ( description_like !== undefined ) {
            wheres.push("transaction_groups.description LIKE @description_like");
            params.description_like = "%" + description_like + "%";
            keys.push("description_like");
        }

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


    static _create(db, {
        date,
        description,
        note,
        statement_id,
        split,
        eom_cleanup,
        allocation,
        transactions
    }={}) {

        // Check foreign key constraints
        if ( statement_id && !this.get_stmt(db, "statement_exists").get({ id: statement_id }) ) {
            throw new ForeignKeyError("Bank statement item does not exist: " + statement_id);
        }

        const stmt = this.get_stmt(db, "create");
        const result = stmt.run({
            date: ydate2stmt(date),
            description,
            note,
            statement_id,
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
        statement_id = null,
        eom_cleanup = false,
        allocation = false,
        transactions = []
    }={}) {
        if ( transactions.length < 1 ) throw new Error("Must provide at least transaction");

        // The eom_cleanup/allocation flags are reserved for the internal
        // `_create` paths; USER groups are always plain
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
            statement_id,
            split: transactions.length > 1,
            eom_cleanup: false,
            allocation: false,
            transactions
        })
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
