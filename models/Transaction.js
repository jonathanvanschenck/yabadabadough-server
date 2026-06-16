
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
    "allocation_id",
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
        group_exists: `
            SELECT 1
            FROM transaction_groups
            WHERE id = @id
        `,
        eom_cleanup_exists: `
            SELECT 1
            FROM fund_eom_finalizations
            WHERE id = @id
        `,
        allocation_exists: `
            SELECT 1
            FROM allocations
            WHERE id = @id
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
                allocation_id
            ) VALUES (
                @source_fund_id,
                @target_fund_id,
                @group_id,
                @amount,
                @date,
                @description,
                @note,
                @eom_cleanup_id,
                @allocation_id
            )
        `,
    }

    static PREPARED_TRANSACTIONS = {}

    static ORDER_BY_MAP = {
        "id": "id"
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
        allocation_id,
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
        this.allocation_id = allocation_id;
        this.created_at = created_at;
    }

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
            allocation_id: this.allocation_id,
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
            allocation_id: row.allocation_id,
            created_at: stmt2datetime(row.created_at),
        });
    }

    static for_id(db, id) {
        const stmt = this.get_stmt(db, "for_id");
        return this.from_row(stmt.get({ id }) ?? null);
    }

    static from_db(db, {
        order_by = "id",
        order_direction = "ASC",
        limit = 100,
        offset =  0
    }={}) {
        const wheres = [];
        const params = {};
        const keys = [];

        // TODO

        let sql = `SELECT ${SELECT_COLUMNS.join(", ")}\n`
                + `FROM transactions\n`;
        if ( wheres.length ) {
            sql = sql + `WHERE\n\t${wheres.join("\n\tAND ")}\n`
        }
        if ( order_by !== null ) {
            // Throws on back values
            const _order_by = this.get_order_by_column_name(order_by);
            const _order_direction = this.get_order_direction(order_direction);

            sql = sql + `ORDER BY ${_order_by} ${_order_direction}\n`

            keys.push("order_by_"+order_by);
            keys.push(_order_direction);
        }
        if ( limit !== null ) {
            sql = sql + `LIMIT @limit OFFSET @offset\n`
            params.limit = limit;
            params.offset = offset;
            keys.push("limit")
        }

        const stmt = this.build_stmt(
            db, 
            "from_db$" + keys.join(":"),
            sql
        );

        return stmt.all(params).map(row => this.from_row(row))
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
        allocation_id = null,
    }={}) {
        if ( !source_fund_id ) throw new Error("Missing source fund id");
        if ( !target_fund_id ) throw new Error("Missing target fund id");
        if ( !group_id ) throw new Error("Missing group id");
        if ( !date ) throw new Error("Missing date");
        if ( source_fund_id == target_fund_id ) throw new ConflictError("Source and target funds cannot be the same")
        if ( amount <= 0 ) throw new Error("Transaction amount must be positive");
        if ( !description ) throw new Error("Missing description");

        // Check foreign key constraints
        if ( !this.get_stmt(db, "fund_exists").get({ id: source_fund_id }) ) {
            throw new ForeignKeyError("Source fund does not exist: " + source_fund_id);
        }
        if ( !this.get_stmt(db, "fund_exists").get({ id: target_fund_id }) ) {
            throw new ForeignKeyError("Target fund does not exist: " + target_fund_id);
        }

        // These checks are almost certainly unnecessary, since the caller will have
        // created these things
        /*
        if ( !this.get_stmt(db, "group_exists").get({ id: group_id }) ) {
            throw new ForeignKeyError("Transaction group does not exist: " + group_id);
        }
        if ( eom_cleanup_id && !this.get_stmt(db, "eom_cleanup_exists").get({ id: eom_cleanup_id }) ) {
            throw new ForeignKeyError("EOM cleanup/finalization does not exist: " + eom_cleanup_id);
        }
        if ( allocation_id && !this.get_stmt(db, "allocation_exists").get({ id: allocation_id }) ) {
            throw new ForeignKeyError("Allocation does not exist: " + allocation_id);
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
            allocation_id: allocation_id ?? null,
        });
    }

    static create() { throw new Error("You cannot directly create a transaction, please create via TransactionGroup.create(...)"); }


    /**
     * NOTE : we explicitly restrict the update-able fields to prevent db desycn
     *        you should just delete and re-create a transaction if you need to
     *        change anything, since that will gaurentee all side-effects take place
     */
    update(db, {
        description,
        note,
    }={}) { throw new Error("TODO") }

    delete() { throw new Error("TODO") }
}
