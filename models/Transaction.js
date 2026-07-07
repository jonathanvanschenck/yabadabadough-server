
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
    datetime2stmt,
    stmt2datetime,
    stmt2ydate,
    ydate2stmt
} = require("../lib/db.js").helpers;

const SELECT_COLUMNS = [
    "id",
    "source_fund_id",
    "target_fund_id",
    "group_id",
    "amount",
    "date",
    "description",
    "note",
    "eom_cleanup_id",
    "allocation",
    "created_at",
];

module.exports = class Transaction extends Base {
    // Copied here for use by group
    static SELECT_COLUMNS = SELECT_COLUMNS;

    static PREPARED_STMTS = {
        for_id: `
            SELECT ${SELECT_COLUMNS.join(", ")}
            FROM transactions
            WHERE id = @id
        `,
        fund_exists: `
            SELECT 1
            FROM funds
            WHERE id = @id
        `,
        fund_starts_after: `
            SELECT 1
            FROM funds
            WHERE id = @id
              AND tracked = 1
              AND start_date > @date
        `,
        group_exists: `
            SELECT 1
            FROM transaction_groups
            WHERE id = @id
        `,
        eom_cleanup_exists: `
            SELECT 1
            FROM fund_finalizations
            WHERE id = @id
        `,
        net_transfer: `
            SELECT
                SUM(CASE WHEN target_fund_id = @fund_id THEN amount ELSE 0 END) -
                SUM(CASE WHEN source_fund_id = @fund_id THEN amount ELSE 0 END)
                AS net
            FROM transactions
            WHERE (target_fund_id = @fund_id OR source_fund_id = @fund_id)
              AND EXISTS (SELECT 1 FROM funds WHERE id = @fund_id AND tracked = 1)
              AND (@until IS NULL OR date <= @until)
              AND (@since IS NULL OR date >= @since)
        `,
        net_transfers: `
            SELECT
                ids.value AS fund_id,
                COALESCE(SUM(CASE WHEN target_fund_id = ids.value THEN amount ELSE 0 END), 0) -
                COALESCE(SUM(CASE WHEN source_fund_id = ids.value THEN amount ELSE 0 END), 0) AS net
            FROM json_each(@fund_ids) AS ids
            LEFT JOIN funds ON funds.id = ids.value AND funds.tracked = 1
            LEFT JOIN transactions
                ON funds.id IS NOT NULL
                AND (target_fund_id = ids.value OR source_fund_id = ids.value)
                AND (@until IS NULL OR date <= @until)
                AND (@since IS NULL OR date >= @since)
            GROUP BY ids.value
        `,
        // Inline (rather than requiring MonthFinalization) to avoid a circular
        // require -- mirrors TransactionGroup's guard
        month_is_finalized: `
            SELECT 1
            FROM month_finalizations
            WHERE eom_date >= @date
            LIMIT 1
        `,
        create: `
            INSERT INTO transactions (
                source_fund_id,
                target_fund_id,
                group_id,
                amount,
                date,
                description,
                note,
                eom_cleanup_id,
                allocation
            ) VALUES (
                @source_fund_id,
                @target_fund_id,
                @group_id,
                @amount,
                @date,
                @description,
                @note,
                @eom_cleanup_id,
                @allocation
            )
        `,
        // Money-bearing/cosmetic fields only; date/allocation/group_id/
        // eom_cleanup_id are group-derived or structural and never change here
        update: `
            UPDATE transactions
            SET source_fund_id = @source_fund_id,
                target_fund_id = @target_fund_id,
                amount         = @amount,
                description    = @description,
                note           = @note
            WHERE id = @id
        `,
        // Used by TransactionGroup#update's date cascade (keeps the
        // denormalized date copy in sync with the group)
        set_date_for_group: `
            UPDATE transactions
            SET date = @date
            WHERE group_id = @group_id
        `,
        delete: `
            DELETE FROM transactions
            WHERE id = @id
        `,
        delete_for_group: `
            DELETE FROM transactions
            WHERE group_id = @group_id
        `,
        // Allocation transactions in months that have NOT been finalized (the
        // month_finalizations subquery is inlined -- rather than requiring
        // MonthFinalization -- to avoid a circular require). Used by the Fund
        // re-derivation hook: allocation sources are DERIVED from the current
        // hierarchy, so unfinalized allocations get repointed when it changes.
        unfinalized_allocations: `
            SELECT id, source_fund_id, target_fund_id, date
            FROM transactions
            WHERE allocation = 1
              AND NOT EXISTS (
                SELECT 1 FROM month_finalizations
                WHERE eom_date >= transactions.date
              )
        `,
        set_source: `
            UPDATE transactions
            SET source_fund_id = @source_fund_id
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
        source_fund_id,
        target_fund_id,
        group_id,
        amount,
        date,
        description,
        note,
        eom_cleanup_id,
        allocation,
        created_at,
    }={}) {
        super();
        this.id = id;
        this.source_fund_id = source_fund_id;
        this.target_fund_id = target_fund_id;
        this.group_id = group_id;
        this.amount = amount;
        this.date = date;
        this.description = description;
        this.note = note;
        this.eom_cleanup_id = eom_cleanup_id;
        this.allocation = allocation;
        this.created_at = created_at;
    }

    static openapi_TransactionSchema = {
        description: "Moves `amount` from the source fund to the target fund on `date`. `date` and `allocation` are denormalized from the parent group.",
        type: 'object',
        properties: {
            id: { type: 'integer', minimum: 1 },
            source_fund_id: { type: 'integer', minimum: 1 },
            target_fund_id: { type: 'integer', minimum: 1 },
            group_id: { type: 'integer', minimum: 1 },
            amount: { type: 'number', minimum: 0, description: "Currency as a float dollar amount; zero only occurs on internal eom_cleanup transactions" },
            date: { type: 'string', format: 'date', example: '2026-01-15' },
            description: { type: 'string' },
            note: { type: 'string', nullable: true },
            eom_cleanup_id: { type: 'integer', minimum: 1, nullable: true, description: "The fund finalization this end-of-month cleanup transaction belongs to; null for ordinary transactions" },
            allocation: { type: 'boolean', description: "true iff this transaction is a start-of-month allocation" },
            created_at: { type: 'string', format: 'date-time' }
        },
        required: [ 'id', 'source_fund_id', 'target_fund_id', 'group_id', 'amount', 'date', 'description', 'note', 'eom_cleanup_id', 'allocation', 'created_at' ]
    };

    to_api() {
        return {
            id: this.id,
            source_fund_id: this.source_fund_id,
            target_fund_id: this.target_fund_id,
            group_id: this.group_id,
            amount: this.amount,
            date: this.date.toJSON(),
            description: this.description,
            note: this.note,
            eom_cleanup_id: this.eom_cleanup_id,
            allocation: this.allocation,
            created_at: this.created_at.toISOString(),
        };
    }

    static from_row(row) {
        if ( row == null ) return null;

        return new this({
            id: row.id,
            source_fund_id: row.source_fund_id,
            target_fund_id: row.target_fund_id,
            group_id: row.group_id,
            amount: stmt2currency(row.amount),
            date: stmt2ydate(row.date),
            description: row.description,
            note: row.note,
            eom_cleanup_id: row.eom_cleanup_id,
            allocation: stmt2boolean(row.allocation),
            created_at: stmt2datetime(row.created_at),
        });
    }

    static for_id(db, id) {
        const stmt = this.get_stmt(db, "for_id");
        return this.from_row(stmt.get({ id }) ?? null);
    }

    static _from_db_wheres({
        source_fund_id,
        target_fund_id,
        involving_fund_id,
        group_id,
        since,  // YDate or null
        until,  // YDate or null
        allocation,
        description_like,
    }={}) {
        const wheres = [];
        const params = {};
        const keys = [];

        if ( source_fund_id !== undefined ) {
            wheres.push("source_fund_id = @source_fund_id");
            params.source_fund_id = source_fund_id;
            keys.push("source_fund_id");
        }
        if ( target_fund_id !== undefined ) {
            wheres.push("target_fund_id = @target_fund_id");
            params.target_fund_id = target_fund_id;
            keys.push("target_fund_id");
        }
        if ( involving_fund_id !== undefined ) {
            wheres.push("(source_fund_id = @involving_fund_id OR target_fund_id = @involving_fund_id)");
            params.involving_fund_id = involving_fund_id;
            keys.push("involving_fund_id");
        }
        if ( group_id !== undefined ) {
            wheres.push("group_id = @group_id");
            params.group_id = group_id;
            keys.push("group_id");
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
        if ( allocation !== undefined ) {
            wheres.push("allocation = @allocation");
            params.allocation = boolean2stmt(allocation);
            keys.push("allocation");
        }
        if ( description_like !== undefined ) {
            wheres.push("description LIKE @description_like");
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

        let sql = `SELECT ${SELECT_COLUMNS.join(", ")}\n`
                + `FROM transactions\n`;
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

    /**
     * Total rows matching the same filters as from_db (order/limit/offset
     * are accepted and ignored, so the API layer can pass one filter object
     * to both).
     */
    static count(db, { order_by, order_direction, limit, offset, ...filters }={}) {
        const { wheres, params, keys } = this._from_db_wheres(filters);

        let sql = `SELECT COUNT(*) AS count\n`
                + `FROM transactions\n`;
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
     * Model-level consistency + FK + start-date checks for a transaction's
     * money-bearing fields against a given date. Shared by _create_with_group
     * and _update so that creates and edits enforce exactly the same rules.
     */
    static _assert_transaction_valid(db, {
        source_fund_id,
        target_fund_id,
        amount,
        date,
        description,
    }={}) {
        if ( !source_fund_id ) throw new Error("Missing source fund id");
        if ( !target_fund_id ) throw new Error("Missing target fund id");
        if ( source_fund_id == target_fund_id ) throw new ConflictError("Source and target funds cannot be the same")
        // NOTE : zero amounts are allowed here so that eom_cleanup transactions
        //        always exist for monthly funds (even at zero balance). USER
        //        transactions must be positive; that is enforced at the API layer.
        if ( amount < 0 ) throw new Error("Transaction amount cannot be negative");
        if ( !description ) throw new Error("Missing description");

        // Check foreign key constraints
        if ( !this.get_stmt(db, "fund_exists").get({ id: source_fund_id }) ) {
            throw new ForeignKeyError("Source fund does not exist: " + source_fund_id);
        }
        if ( !this.get_stmt(db, "fund_exists").get({ id: target_fund_id }) ) {
            throw new ForeignKeyError("Target fund does not exist: " + target_fund_id);
        }

        // Transactions may not predate a tracked fund's start_date. This is what
        // makes start_balance semantics (and the backdated fallback cache date on
        // Fund) safe.
        const _date = ydate2stmt(date);
        if ( this.get_stmt(db, "fund_starts_after").get({ id: source_fund_id, date: _date }) ) {
            throw new ConflictError("Transaction predates the source fund's start_date");
        }
        if ( this.get_stmt(db, "fund_starts_after").get({ id: target_fund_id, date: _date }) ) {
            throw new ConflictError("Transaction predates the target fund's start_date");
        }
    }

    /**
     * Only for use by the transaction group
     */
    static _create_with_group(db, {
        source_fund_id,
        target_fund_id,
        group_id,
        date,

        amount,
        description,
        note = null,

        eom_cleanup_id = null,
        allocation = false,
    }={}) {
        if ( !group_id ) throw new Error("Missing group id");
        if ( !date ) throw new Error("Missing date");
        this._assert_transaction_valid(db, {
            source_fund_id,
            target_fund_id,
            amount,
            date,
            description,
        });

        // These checks are almost certainly unnecessary, since the caller will have
        // created these things
        /*
        if ( !this.get_stmt(db, "group_exists").get({ id: group_id }) ) {
            throw new ForeignKeyError("Transaction group does not exist: " + group_id);
        }
        if ( eom_cleanup_id && !this.get_stmt(db, "eom_cleanup_exists").get({ id: eom_cleanup_id }) ) {
            throw new ForeignKeyError("EOM cleanup/finalization does not exist: " + eom_cleanup_id);
        }
        */

        const stmt = this.get_stmt(db, "create");
        stmt.run({
            source_fund_id: source_fund_id,
            target_fund_id: target_fund_id,
            group_id: group_id,
            amount: currency2stmt(amount),
            date: ydate2stmt(date),
            description: description,
            note: note ?? null,
            eom_cleanup_id: eom_cleanup_id ?? null,
            allocation: boolean2stmt(allocation),
        });
    }

    static create() { throw new Error("You cannot directly create a transaction, please create via TransactionGroup.create(...)"); }

    /**
     * Only for use by TransactionGroup (inside its sqlite transactions);
     * callers own the group-level bookkeeping (split, group deletion).
     */
    static _delete(db, id) {
        this.get_stmt(db, "delete").run({ id });
    }

    /**
     * Only for use by TransactionGroup._delete.
     */
    static _delete_for_group(db, group_id) {
        this.get_stmt(db, "delete_for_group").run({ group_id });
    }

    /**
     * Allocation transactions in unfinalized months, as raw rows
     * ({ id, source_fund_id, target_fund_id, date }). Allocation sources are
     * DERIVED from the current hierarchy: Fund._update uses this (with
     * `_set_source`) to repoint them when the hierarchy changes. Finalized
     * months are immutable and are never touched.
     */
    static _unfinalized_allocations(db) {
        return this.get_stmt(db, "unfinalized_allocations").all();
    }

    static _set_source(db, { id, source_fund_id }={}) {
        this.get_stmt(db, "set_source").run({ id, source_fund_id });
    }

    /**
     * Only for use by TransactionGroup#update's date cascade: rewrite the
     * denormalized date on every transaction in a group.
     */
    static _set_date_for_group(db, group_id, date) {
        this.get_stmt(db, "set_date_for_group").run({
            group_id,
            date: ydate2stmt(date),
        });
    }


    /**
     * Edit this transaction's money-bearing/cosmetic fields IN PLACE --
     * `amount`, `source_fund_id`, `target_fund_id`, `description`, `note`.
     * Runs the same consistency checks as creation (via
     * `_assert_transaction_valid`) inside one sqlite transaction, so a failed
     * check leaves the row untouched.
     *
     * NOT editable here: `date` and `allocation` are group-level facts
     * (denormalized onto this table) and only change via the group;
     * `group_id`/`eom_cleanup_id` are structural. Allocation and eom_cleanup
     * transactions are refused entirely (managed by Allocation /
     * MonthFinalization). Adding/removing transactions goes through
     * `TransactionGroup.edit_transactions`.
     */
    static _update(db, transaction, {
        source_fund_id,
        target_fund_id,
        amount,
        description,
        note,
    }={}) {
        if ( transaction.allocation ) {
            throw new Error("Allocation transactions are managed via Allocation.set(...)");
        }
        if ( transaction.eom_cleanup_id != null ) {
            throw new Error("EOM cleanup transactions cannot be edited");
        }

        // The transaction's month (its date is the group's date) must be
        // unfinalized -- this is what keeps stored finalization cache points
        // (sonm_balance) valid.
        if ( this.get_stmt(db, "month_is_finalized").get({ date: ydate2stmt(transaction.date) }) ) {
            throw new ConflictError("Cannot modify transactions in a finalized month");
        }

        // Merge changes over current values, then validate the FULL result
        // against the (unchanged) date -- a partial fund change still has to
        // satisfy every invariant.
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

    delete() { throw new Error("Transactions are deleted via their group: TransactionGroup#delete or TransactionGroup.edit_transactions"); }


    static net_transfer(db, fund_id, { until, since }={}) {
        return stmt2currency(this.get_stmt(db, "net_transfer").get({
            fund_id,
            until: ydate2stmt(until),
            since: ydate2stmt(since)
        })?.net ?? 0);
    }

    static net_transfers(db, fund_ids=[], { until, since }={}) {
        return this.get_stmt(db, "net_transfers").all({
            fund_ids: JSON.stringify(fund_ids),
            until: ydate2stmt(until),
            since: ydate2stmt(since)
        }).map(row => {
            return {
                fund_id: row.fund_id,
                net: stmt2currency(row.net)
            };
        })
    }
}
