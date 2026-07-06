
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

const SELECT_COLUMNS = [
    "funds.id AS id",
    "funds.name AS name",
    "funds.parent_id AS parent_id",
    "funds.start_date AS start_date",
    "funds.start_balance AS start_balance",
    "funds.tracked AS tracked",
    "funds.balance AS balance",
    "funds.monthly AS monthly",
    "funds.color AS color",
    "funds.created_at AS created_at",
    "funds.finalization_id AS finalization_id",
    "fund_finalizations.eom_balance AS cached_balance",
    "fund_finalizations.eom_date AS cached_date",
];


module.exports = class Fund extends Base {
    static PREPARED_STMTS = {
        for_id: `
            SELECT ${SELECT_COLUMNS.join(", ")}
            FROM funds
            LEFT JOIN fund_finalizations
                ON funds.finalization_id = fund_finalizations.id
            WHERE funds.id = @id
        `,
        id_exists: `
            SELECT 1
            FROM funds
            WHERE id = @id
        `,
        name_exists: `
            SELECT 1
            FROM funds
            WHERE name = @name
        `,
        proposed_parent_is_descendant: `
            WITH RECURSIVE ancestors(id) AS (
                SELECT parent_id FROM funds WHERE id = @new_parent_id
                UNION ALL
                SELECT f.parent_id FROM funds f
                JOIN ancestors a ON f.id = a.id
            )
            SELECT EXISTS(
                SELECT 1 FROM ancestors WHERE id = @id
            ) AS is_descendant
        `,
        create: `
            INSERT INTO funds (
                name,
                parent_id,
                start_date,
                start_balance,
                tracked,
                balance,
                monthly,
                color
            ) VALUES (
                @name,
                @parent_id,
                @start_date,
                @start_balance,
                @tracked,
                @balance,
                @monthly,
                @color
            )
        `
    };

    static PREPARED_TRANSACTIONS = {}

    static ORDER_BY_MAP = {
        "id": "id",
    }

    constructor({
        id,
        name,
        parent_id,
        start_date,
        start_balance,
        tracked,
        balance,
        monthly,
        color,
        finalization_id,
        cached_balance,
        cached_date,
        created_at,
    }={}) {
        super();

        this.id = id;
        this.name = name;
        this.parent_id = parent_id;
        this.tracked = tracked;
        this.start_date = start_date;
        this.start_balance = start_balance;
        this.balance = balance;
        this.monthly = monthly;
        this.color = color;
        this.finalization_id = finalization_id;
        this.calculate_balance = cached_balance;
        this.calculate_date = cached_date;
        this.created_at = created_at;
    }

    to_api() {
        return {
            id: this.id,
            name: this.name,
            parent_id: this.parent_id,

            balance: this.balance,

            start: {
                date: this.start_date.toJSON(),
                balance: this.start_balance,
            },
            cache: {
                date: this.cached_date.toJSON(),
                balance: this.cached_balance,
            },

            status: {
                tracked: this.tracked,
                monthly: this.monthly,
                root: !!this.parent_id
            },

            color: this.color,
            created_at: this.created_at,
        };
    }


    static from_row(row) {
        if ( row === null ) return null;

        return new this({
            id: row.id,
            name: row.name,
            parent_id: row.parent_id,
            start_date: stmt2ydate(row.start_date),
            start_balance: stmt2currency(row.start_balance),
            tracked: stmt2boolean(row.tracked),
            balance: stmt2currency(row.balance),
            monthly: stmt2boolean(row.monthly),
            color: row.color,
            finalization_id: row.finalization_id,
            created_at: stmt2datetime(row.created_at),
        });
    }

    static for_id(db, id) {
        const stmt = this.get_stmt(db, "for_id");
        return this.from_row(stmt.get({ id }) ?? null);
    }

    static from_db(db, {
        id,
        ids,
        name,
        name_like,
        started_since, // YDate or null
        started_until, // YDate or null
        tracked,
        monthly,
        root,
        order_by = "id",
        order_direction = "ASC",
        limit = 100,
        offset =  0
    }={}) {
        const wheres = [];
        const params = {};
        const keys = [];

        if ( id !== undefined ) {
            wheres.push("funds.id = @id");
            params.id = id;
            keys.push("id")
        }
        if ( Array.isArray(ids) ) {
            if ( ids.length == 0 ) return [];
            wheres.push("funds.id IN (SELECT value FROM json_each(@ids))");
            params.ids = JSON.stringify(ids);
            keys.push("ids")
        }
        if ( name !== undefined ) {
            wheres.push("funds.name = @name");
            params.name = name;
            keys.push("name")
        }
        if ( name_like !== undefined ) {
            wheres.push("funds.name LIKE @name_like");
            params.name_like = "%" + name_like + "%";
            keys.push("name_like")
        }
        if ( started_since !== undefined ) {
            wheres.push("funds.start_date >= @started_since");
            params.started_since = ydate2stmt(started_since);
            keys.push("started_since")
        }
        if ( started_until !== undefined ) {
            wheres.push("funds.start_date <= @started_until");
            params.started_until = ydate2stmt(started_until);
            keys.push("started_until")
        }
        if ( tracked !== undefined ) {
            wheres.push("funds.tracked = @tracked");
            params.tracked = boolean2stmt(tracked);
            keys.push("tracked");
        }
        if ( monthly !== undefined ) {
            wheres.push("funds.monthly = @monthly");
            params.monthly = boolean2stmt(monthly);
            keys.push("monthly");
        }
        if ( root !== undefined ) {
            if ( root ) {
                wheres.push("funds.parent_id IS NULL");
                keys.push("root");
            } else {
                wheres.push("funds.parent_id IS NOT NULL");
                keys.push("not_root");
            }
        }


        let sql = `SELECT ${SELECT_COLUMNS.join(", ")}\n`
                + `FROM funds\n`
                + `LEFT JOIN fund_finalizations\n`
                + `  ON funds.finalization_id = fund_finalizations.id\n`;

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

    static _create(db, {
        name,
        parent_id,
        start_date,
        start_balance,
        tracked,
        monthly,
        color
    }={}) {
        if ( this.get_stmt(db, "name_exists").get({ name }) ) {
            throw new ConflictError("Name already exists: "+name);
        }
        if ( parent_id && !this.get_stmt(db, "id_exists").get({ id:parent_id }) ) {
            throw new ForeignKeyError("Parent fund does not exist: "+parent_id);
        }

        const stmt = this.get_stmt(db, "create");
        const result = stmt.run({
            name,
            parent_id,
            start_date: ydate2stmt(start_date),
            start_balance: currency2stmt(start_balance),
            tracked: boolean2stmt(tracked),
            balance: currency2stmt(tracked ? start_balance : null),
            monthly: boolean2stmt(monthly),
            color
        });

        const id = result.lastInsertRowid;

        // TODO: check what the current finalized month is, and finalize
        //       the fund up to that month

        return this.for_id(db, id);
    }

    static create(db, {
        name,
        parent_id = null,
        tracked,
        start_date = null, // YDate or null
        start_balance = 0,
        monthly = false,
        color = null
    }={}) {

        // Check for track consistency check
        if ( tracked && start_date == null ) {
            throw new Error("Cannot set tracked without also providing start_date");
        }
        if ( tracked && start_balance == null ) {
            throw new Error("Cannot set tracked without also providing (non-null) start_balance");
        }

        // Check for monthly requires parent
        if ( monthly && !parent_id ) {
            throw new Error("Cannot create a monthly fund without a parent")
        }

        // Check that monthlys are also tracked
        if ( monthly && !tracked ) {
            throw new Error("Cannot create a monthly fund unless it is also tracked");
        }

        const transaction =  this.build_transaction(db, "create", this._create.bind(this));
        return transaction(db, {
            name,
            parent_id,
            start_date: tracked ? start_date : null,
            start_balance: tracked ? start_balance : null,
            tracked,
            monthly,
            color
        })
    }

    // TODO : make this use cached values for better query efficieny
    calculate_balance_on(db, date) {
        if ( !this.tracked ) return 0;

        const net = Transaction.net_transfer(db, this.id, {
            since: this.start_date,
            until: date,
        });

        return this.start_balance + net;
    }

    static finalize_month(db, month, { recursive=false }={}) {
        const som = month.start_of_next_month();
        const eom = month.end_of_month();


        // TODO : check that last month was finalized for all
        //        funds that had been started by then,
        //        otherwise error -- unless recursive is true,
        //        then recurse back and finalize that month first

        // TODO
    }

    // For use in transaction
    _finalize(db, month) {}

    // For use in transaction
    _unfinalize(db, month) {}

    update(db, {
        name,
        parent_id,
        start_date,
        start_balance,
        tracked,
        // balance, // <- must use `.calculate_balance`
        monthly,
        color,
    }={}) {
        throw new Error("TODO");
    }

    delete(db) {
        throw new Error("TODO");
    }

    descendants(db) {
        throw new Error("TODO");
    }

    calculate_balance(db) {
        throw new Error("TODO");
    }
}
