
const Base = require("./Base.js");

const {
    to_positive_int,
} = require("../lib/parsers.js");

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
];


module.exports = class Fund extends Base {
    static PREPARED_STMTS = {
        for_id: `
            SELECT ${SELECT_COLUMNS.join(", ")}
            FROM funds
            WHERE id = @id
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
        "id": "funds.id",
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
        last_som_cache_id,
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
        this.last_som_cache_id = last_som_cache_id;
        this.created_at = created_at;
    }

    to_api() {
        return {
            id: this.id,
            name: this.name,
            parent_id: this.parent_id,

            balance: this.balance,
            start_date: this.start_date.toJSON(),
            start_balance: this.start_balance,

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
            last_som_cache_id: row.last_som_cache_id,
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
        started_after, // YDate or null
        started_before, // YDate or null
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
        if ( started_after !== undefined ) {
            wheres.push("funds.start_date > @started_after");
            params.started_after = ydate2stmt(started_after);
            keys.push("started_after")
        }
        if ( started_before !== undefined ) {
            wheres.push("funds.start_date < @started_before");
            params.started_before = ydate2stmt(started_before);
            keys.push("started_before")
        }
        if ( tracked !== undefined ) {
            wheres.push("tracked = @tracked");
            params.tracked = boolean2stmt(tracked);
            keys.push("tracked");
        }
        if ( monthly !== undefined ) {
            wheres.push("monthly = @monthly");
            params.monthly = boolean2stmt(monthly);
            keys.push("monthly");
        }
        if ( root !== undefined ) {
            if ( root ) {
                wheres.push("parent_id IS NULL");
                keys.push("root");
            } else {
                wheres.push("parent_id IS NOT NULL");
                keys.push("not_root");
            }
        }


        let sql = `SELECT ${SELECT_COLUMNS.join(", ")}\n`
                + `FROM funds\n`;
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

        // TODO: create initial SOM cache for tracked funds

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
