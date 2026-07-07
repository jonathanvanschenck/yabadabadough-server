
const Base = require("./Base.js");

const {
    currency2stmt,
    stmt2currency,
    stmt2datetime,
    stmt2ydate,
    ydate2stmt
} = require("../lib/db.js").helpers;

const SELECT_COLUMNS = [
    "id",
    "month_id",
    "fund_id",
    "eom_balance",
    "sonm_balance",
    "sonm_date",
    "created_at",
];

/**
 * The per-fund historical record for a finalized month.
 *
 * Users never create/delete these directly -- they are managed by
 * MonthFinalization (and by Fund creation backfill). This model exists for
 * querying: reconciliation cache points and surplus/loss history for
 * monthly-type funds (via eom_balance).
 */
module.exports = class FundFinalization extends Base {
    static PREPARED_STMTS = {
        for_id: `
            SELECT ${SELECT_COLUMNS.join(", ")}
            FROM fund_finalizations
            WHERE id = @id
        `,
        create: `
            INSERT INTO fund_finalizations (
                month_id,
                fund_id,
                eom_balance,
                sonm_balance,
                sonm_date
            ) VALUES (
                @month_id,
                @fund_id,
                @eom_balance,
                @sonm_balance,
                @sonm_date
            )
        `,
    }

    static PREPARED_TRANSACTIONS = {}

    static ORDER_BY_MAP = {
        "id": "id",
        "sonm_date": "sonm_date",
    }

    constructor({
        id,
        month_id,
        fund_id,
        eom_balance,
        sonm_balance,
        sonm_date,
        created_at,
    }={}) {
        super();
        this.id = id;
        this.month_id = month_id;
        this.fund_id = fund_id;
        this.eom_balance = eom_balance;
        this.sonm_balance = sonm_balance;
        this.sonm_date = sonm_date;
        this.created_at = created_at;
    }

    static openapi_FundFinalizationSchema = {
        description: "One fund's historical record for one finalized month.",
        type: 'object',
        properties: {
            id: { type: 'integer', minimum: 1 },
            month_id: { type: 'integer', minimum: 1, description: "The parent month finalization" },
            fund_id: { type: 'integer', minimum: 1 },
            eom_balance: { type: 'number', description: "Currency as a float dollar amount: the balance ON eom_date EXCLUDING eom_cleanup transactions -- a surplus/loss history snapshot, NOT a reconciliation point" },
            sonm: {
                description: "The reconciliation cache point: the forward balance entering sonm_date, INCLUDING eom_cleanup transactions",
                allOf: [ { '$ref': '#/components/schemas/ForwardBalanceSchema' } ]
            },
            created_at: { type: 'string', format: 'date-time' }
        },
        required: [ 'id', 'month_id', 'fund_id', 'eom_balance', 'sonm', 'created_at' ]
    };

    to_api() {
        return {
            id: this.id,
            month_id: this.month_id,
            fund_id: this.fund_id,

            // Pre-cleanup snapshot: the balance ON eom_date EXCLUDING any
            // eom_cleanup transactions. Exists for surplus/loss history of
            // monthly-type funds; NOT a reconciliation point.
            eom_balance: this.eom_balance,

            // The reconciliation cache point, as a { date, forward_balance }
            // pair: the balance entering sonm_date, including eom_cleanup
            // transactions
            sonm: {
                date: this.sonm_date.toJSON(),
                forward_balance: this.sonm_balance,
            },

            created_at: this.created_at.toISOString(),
        };
    }

    static from_row(row) {
        if ( row == null ) return null;

        return new this({
            id: row.id,
            month_id: row.month_id,
            fund_id: row.fund_id,
            eom_balance: stmt2currency(row.eom_balance),
            sonm_balance: stmt2currency(row.sonm_balance),
            sonm_date: stmt2ydate(row.sonm_date),
            created_at: stmt2datetime(row.created_at),
        });
    }

    static for_id(db, id) {
        const stmt = this.get_stmt(db, "for_id");
        return this.from_row(stmt.get({ id }) ?? null);
    }

    static _from_db_wheres({
        fund_id,
        month_id,
        since,  // YDate or null, filters on sonm_date
        until,  // YDate or null, filters on sonm_date
    }={}) {
        const wheres = [];
        const params = {};
        const keys = [];

        if ( fund_id !== undefined ) {
            wheres.push("fund_id = @fund_id");
            params.fund_id = fund_id;
            keys.push("fund_id");
        }
        if ( month_id !== undefined ) {
            wheres.push("month_id = @month_id");
            params.month_id = month_id;
            keys.push("month_id");
        }
        if ( since !== undefined ) {
            wheres.push("sonm_date >= @since");
            params.since = ydate2stmt(since);
            keys.push("since");
        }
        if ( until !== undefined ) {
            wheres.push("sonm_date <= @until");
            params.until = ydate2stmt(until);
            keys.push("until");
        }

        return { wheres, params, keys };
    }

    static from_db(db, {
        order_by = "sonm_date",
        order_direction = "DESC",
        limit = 100,
        offset = 0,
        ...filters
    }={}) {
        const { wheres, params, keys } = this._from_db_wheres(filters);

        let sql = `SELECT ${SELECT_COLUMNS.join(", ")}\n`
                + `FROM fund_finalizations\n`;
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
                + `FROM fund_finalizations\n`;
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
     * Only for use by MonthFinalization (and Fund creation backfill), inside
     * their sqlite transactions. Assumes inputs are consistent -- callers own
     * the balance math.
     */
    static _create(db, {
        month_id,
        fund_id,
        eom_balance,
        sonm_balance,
        sonm_date,
    }={}) {
        const stmt = this.get_stmt(db, "create");
        const result = stmt.run({
            month_id,
            fund_id,
            eom_balance: currency2stmt(eom_balance),
            sonm_balance: currency2stmt(sonm_balance),
            sonm_date: ydate2stmt(sonm_date),
        });

        return this.for_id(db, result.lastInsertRowid);
    }

    static create() { throw new Error("You cannot directly finalize a fund, please finalize via MonthFinalization.create(...)"); }
}
