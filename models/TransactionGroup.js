
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

/**
 * Normalize a free-form instrument reference: trimmed, with blank normalized
 * to NULL. "" and "   " must never masquerade as a real reference -- they
 * would match nothing on lookup while reading as "set" in the UI.
 */
const normalize_reference = (reference) => {
    if ( reference == null ) return null;
    const trimmed = String(reference).trim();
    return trimmed.length ? trimmed : null;
};


// The SQL twin of the `outstanding` getter below: a group that declared a
// bank line is coming and has none linked yet. Two expressions of one rule,
// in two languages -- change them together.
const OUTSTANDING_SQL = `(
    transaction_groups.expects_statement = 1
    AND NOT EXISTS (
        SELECT 1 FROM bank_statement_items
        WHERE bank_statement_items.group_id = transaction_groups.id
    )
)`;


const GROUP_COLUMNS = [
    "id",
    "date",
    "description",
    "note",
    "expects_statement",
    "reference",
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
            expects_statement,
            reference,
            split,
            allocation,
            eom_cleanup
        ) VALUES (
            @date,
            @description,
            @note,
            @expects_statement,
            @reference,
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
        update: `
            UPDATE transaction_groups
            SET date = @date,
                description = @description,
                note = @note,
                expects_statement = @expects_statement,
                reference = @reference
            WHERE id = @id
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
        expects_statement,
        reference,
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
        this.expects_statement = expects_statement;
        this.reference = reference;
        this.split = split;
        this.allocation = allocation;
        this.eom_cleanup = eom_cleanup;
        this.transactions = transactions;
        this.statements = statements;
        this.created_at = created_at;
    }

    /**
     * The canonical derived state (never stored -- always derivable from
     * `expects_statement` and the hydrated statements; `OUTSTANDING_SQL` is
     * the query-side twin): the group declared that a bank line is coming and
     * none has been linked yet. A written cheque that has not cleared, a
     * pending ACH, a promised refund.
     *
     * Because it is derived, linking a statement item clears it and
     * unlinking one restores it, both without writing to the group -- there
     * is no flag to forget to reset. `expects_statement` stays put as the
     * standing statement of intent.
     */
    get outstanding() {
        return !!this.expects_statement && this.statements.length === 0;
    }

    static openapi_TransactionGroupSchema = {
        description: "A container for one or more related transactions, plus any bank statement items reconciled to it.",
        type: 'object',
        properties: {
            id: { type: 'integer', minimum: 1 },
            description: { type: 'string' },
            date: { type: 'string', format: 'date', example: '2026-01-15' },
            note: { type: 'string', nullable: true },
            reference: {
                type: 'string',
                nullable: true,
                description: "Free-form instrument reference -- a cheque number, a wire confirmation, an invoice id. Stored trimmed (blank becomes null) and deliberately NOT unique: it is a matching hint for reconciliation, never an identity.",
                example: '1247'
            },
            status: {
                type: 'object',
                properties: {
                    split: { type: 'boolean', description: "true iff the group holds more than one transaction" },
                    allocation: { type: 'boolean', description: "Reserved for the internal Allocation path: the month's start-of-month allocation group" },
                    eom_cleanup: { type: 'boolean', description: "Reserved for the internal MonthFinalization path: an end-of-month cleanup group" },
                    expects_statement: { type: 'boolean', description: "A bank line is expected for this group but may not have arrived yet. Never set on allocation/eom_cleanup groups (db CHECK)" },
                    outstanding: { type: 'boolean', description: "DERIVED, never stored: expects_statement is set and no bank statement item is linked yet. Linking an item clears it; unlinking restores it" }
                },
                required: [ 'split', 'allocation', 'eom_cleanup', 'expects_statement', 'outstanding' ]
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
        required: [ 'id', 'description', 'date', 'note', 'reference', 'status', 'transactions', 'statements', 'created_at' ]
    };

    to_api() {
        return {
            id: this.id,
            description: this.description,
            date: this.date.toJSON(),
            note: this.note,
            reference: this.reference,
            status: {
                split: this.split,
                allocation: this.allocation,
                eom_cleanup: this.eom_cleanup,
                expects_statement: this.expects_statement,
                outstanding: this.outstanding,
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
            expects_statement: stmt2boolean(row.expects_statement),
            reference: row.reference,
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
        expects_statement,
        reference,
        outstanding,
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
        if ( expects_statement !== undefined ) {
            wheres.push("transaction_groups.expects_statement = @expects_statement");
            params.expects_statement = boolean2stmt(expects_statement);
            keys.push("expects_statement");
        }
        if ( reference !== undefined ) {
            // A blank reference normalizes to NULL, which `= @reference` can
            // never match -- so it means "unreferenced", not "no filter"
            const _reference = normalize_reference(reference);
            if ( _reference === null ) {
                wheres.push("transaction_groups.reference IS NULL");
                keys.push("reference_null");
            } else {
                // NOCASE so an alphanumeric reference ("AB-99x") matches
                // however it was typed -- and so this agrees with the webapp's
                // case-insensitive `statementNamesReference`. The partial
                // index is declared NOCASE to match, so it still applies.
                wheres.push("transaction_groups.reference = @reference COLLATE NOCASE");
                params.reference = _reference;
                keys.push("reference");
            }
        }
        if ( outstanding !== undefined ) {
            // The SQL twin of the `outstanding` getter (expects_statement set,
            // nothing linked yet). Kept as a filter of its own rather than
            // leaving callers to compose expects_statement + has_statements,
            // so the rule has one definition -- and so the negation, which is
            // a disjunction that does NOT decompose into those two filters,
            // stays expressible.
            wheres.push((outstanding ? "" : "NOT ") + OUTSTANDING_SQL);
            keys.push("outstanding_" + boolean2stmt(outstanding));
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
     * (has_statements and outstanding are both EXISTS subqueries).
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
        // Default for the internal callers (Allocation, MonthFinalization),
        // which construct pure-bookkeeping groups: no bank event corresponds
        // to them, and the db CHECK refuses expects_statement on one anyway
        expects_statement = false,
        reference = null,
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
            expects_statement: boolean2stmt(expects_statement),
            reference: normalize_reference(reference),
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
        expects_statement = false,
        reference = null,
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
            expects_statement,
            reference,
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
        expects_statement,
        reference,
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
            expects_statement,
            reference,
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
     * defaults to the items' notes (falling back to their keys). `reference`
     * is worth setting when the cleared item IS a cheque you never pre-entered
     * -- it records the instrument number the bank reported.
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
        expects_statement = false,
        reference = null,
        transactions = []
    }={}) {
        if ( statement_ids.length < 1 ) throw new Error("Must provide at least one statement id");
        if ( new Set(statement_ids).size !== statement_ids.length ) throw new Error("Duplicate statement ids");
        if ( transactions.length < 1 ) throw new Error("Must provide at least transaction");

        const transaction = this.build_transaction(
            db, "create_from_statements", this._create_from_statements.bind(this));
        return transaction(db, {
            statement_ids, date, description, note,
            expects_statement, reference, transactions
        });
    }

    static _link_statements(db, group, statement_ids) {
        // The internal Allocation/MonthFinalization groups are pure
        // bookkeeping -- no bank event ever corresponds to them
        if ( group.allocation ) {
            throw new ConflictError("Allocation groups cannot reconcile bank statement items");
        }
        if ( group.eom_cleanup ) {
            throw new ConflictError("EOM cleanup groups cannot reconcile bank statement items");
        }

        BankStatementItem._assert_linkable(db, statement_ids);
        BankStatementItem._link(db, statement_ids, group.id);

        // Refresh so the hydrated `statements` array is populated
        return this.for_id(db, group.id);
    }

    /**
     * Reconcile one or more PENDING bank statement items against an EXISTING
     * transaction group -- the "the transaction already exists" arm of
     * reconciliation (a pre-entered expense, or the second side of a transfer
     * whose first side already created the group via
     * `create_from_statements`). No transactions are created or modified, and
     * (as everywhere) item amounts are never checked against the group's.
     *
     * This is the far end of the cheque story: a group written months ago
     * with `expects_statement` set stops reading as `outstanding` the moment
     * its item lands here, with no write to the group itself.
     *
     * Unlike `create_from_statements`, the group may live in a FINALIZED
     * month: linking moves no money, and statement imports routinely lag
     * finalization. The asymmetry to know about: a mislink into a finalized
     * month cannot be undone by deleting the group (finalized-month guard) --
     * only by deleting the ITEM without the group and re-importing it.
     */
    static link_statements(db, group, statement_ids = []) {
        if ( statement_ids.length < 1 ) throw new Error("Must provide at least one statement id");
        if ( new Set(statement_ids).size !== statement_ids.length ) throw new Error("Duplicate statement ids");

        const transaction = this.build_transaction(
            db, "link_statements", this._link_statements.bind(this));
        return transaction(db, group, statement_ids);
    }

    static create_single(db, {
        date,
        description,
        note = null,
        expects_statement = false,
        reference = null,
        source_fund_id,
        target_fund_id,
        amount,
    }={}) {
        return this.create(db, {
            date,
            description,
            note,
            expects_statement,
            reference,
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

        // Deprecated funds are frozen: destroying their history would move
        // balances that deprecation promised are final (un-deprecate first)
        if ( Transaction._group_involves_deprecated_fund(db, group.id) ) {
            throw new ConflictError("Cannot delete a transaction group involving a deprecated fund");
        }

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

    static _edit_transactions(db, group, {
        add = [],
        update = [],
        remove = [],
    }={}) {
        if ( group.allocation ) {
            throw new Error("Allocation groups are managed via Allocation.set(...)");
        }
        if ( group.eom_cleanup ) {
            throw new Error("EOM cleanup groups cannot be edited");
        }
        this.assert_month_unfinalized(db, group.date);

        // Every referenced id must belong to THIS group, and no id may be
        // referenced twice (removed and updated, or twice in either list)
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

        // A group always holds at least one transaction; deleting the last
        // one is the group-delete operation, not a line edit
        if ( group.transactions.length - remove.length + add.length < 1 ) {
            throw new Error("A transaction group must keep at least one transaction; delete the group instead");
        }

        for ( const id of remove ) {
            Transaction._delete(db, id);
        }
        for ( const { id, ...changes } of update ) {
            // _update re-runs the shared field validation; its allocation/
            // eom_cleanup/finalized-month guards are redundant here but
            // harmless (already checked at the group level above)
            Transaction._update(db, Transaction.for_id(db, id), changes);
        }
        for ( const spec of add ) {
            // Adds inherit the group's date and allocation flag, and get the
            // same validation as creation (_create_with_group)
            Transaction._create_with_group(db, {
                source_fund_id: spec.source_fund_id,
                target_fund_id: spec.target_fund_id,
                group_id: group.id,
                date: group.date,

                amount: spec.amount,
                description: spec.description,
                note: spec.note,

                allocation: group.allocation,
            });
        }

        // One resync after the whole batch keeps `split` consistent
        this.get_stmt(db, "sync_split").run({ group_id: group.id });
        return this.for_id(db, group.id);
    }

    /**
     * Edit the group's transaction MEMBERSHIP in one atomic batch:
     *
     *   edit_transactions(db, group, {
     *       add:    [ { source_fund_id, target_fund_id, amount, description, note? }, ... ],
     *       update: [ { id, amount?, source_fund_id?, target_fund_id?, description?, note? }, ... ],
     *       remove: [ transaction_id, ... ],
     *   })
     *
     * Removes, then updates, then adds -- all inside one sqlite transaction,
     * so any failed consistency check rolls the entire batch back. Added
     * transactions take the group's date; every referenced id must belong to
     * this group (ForeignKeyError otherwise) and may be referenced only once.
     * The group must keep >= 1 transaction (delete the group instead of
     * emptying it); `split` is resynced once at the end. Allocation and
     * eom_cleanup groups are refused, as are groups in finalized months.
     * The group id -- and any bank statement reconciliation -- is stable.
     */
    static edit_transactions(db, group, ops={}) {
        const transaction = this.build_transaction(
            db, "edit_transactions", this._edit_transactions.bind(this));
        return transaction(db, group, ops);
    }

    static _update(db, group, {
        description,
        note,
        date,
        expects_statement,
        reference,
    }={}) {
        if ( group.allocation ) {
            throw new Error("Allocation groups are managed via Allocation.set(...)");
        }
        if ( group.eom_cleanup ) {
            throw new Error("EOM cleanup groups cannot be edited");
        }

        // The group's current month must be unfinalized...
        this.assert_month_unfinalized(db, group.date);

        const next_date = date ?? group.date;
        const date_changed = ydate2stmt(next_date) !== ydate2stmt(group.date);
        if ( date_changed ) {
            // ...and it may not MOVE into a finalized month either
            this.assert_month_unfinalized(db, next_date);

            // Re-run each transaction's start-date invariant against the new
            // date (the other field checks cannot be affected by a date move)
            for ( const t of group.transactions ) {
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
            expects_statement: boolean2stmt(
                expects_statement !== undefined ? expects_statement : group.expects_statement),
            reference: normalize_reference(
                reference !== undefined ? reference : group.reference),
        });
        // Cascade to the denormalized date copy on every transaction
        if ( date_changed ) Transaction._set_date_for_group(db, group.id, next_date);

        return this.for_id(db, group.id);
    }

    /**
     * Edit this group's scalar fields IN PLACE -- `description`, `note`,
     * `date`, `expects_statement`, `reference`. A date change cascades to the
     * denormalized date on every child transaction and re-checks each one's
     * start-date invariant against the new date. Runs in one sqlite
     * transaction: a failed check leaves everything untouched.
     *
     * Clearing `expects_statement` is how you retire a cheque you have given
     * up on; there is no separate "outstanding" field to reset, since that
     * state is derived from this flag plus whether anything is linked.
     *
     * The group's id -- and therefore any bank statement reconciliation
     * pointing at it -- is stable across updates (this is the reason updates
     * exist instead of delete-and-recreate). Structural changes (adding or
     * removing transactions) go through `edit_transactions`; allocation and
     * eom_cleanup groups are refused (managed by Allocation /
     * MonthFinalization).
     */
    update(db, changes={}) {
        const transaction = this.constructor.build_transaction(
            db, "update", this.constructor._update.bind(this.constructor));
        return transaction(db, this, changes);
    }
}
