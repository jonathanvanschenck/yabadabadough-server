
const Base = require("./Base.js");

const Transaction = require("./Transaction.js");
const FundFinalization = require("./FundFinalization.js");

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
    "funds.monthly AS monthly",
    "funds.color AS color",
    "funds.created_at AS created_at",
    "funds.finalization_id AS finalization_id",
    // The cache point is the *sonm* values: sonm_balance is the forward balance
    // entering sonm_date (it includes eom_cleanup transactions), so it is the
    // valid reconciliation point. (eom_balance excludes cleanups and exists only
    // for surplus/loss history.)
    "fund_finalizations.sonm_balance AS cached_balance",
    "fund_finalizations.sonm_date AS cached_date",
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
                monthly,
                color
            ) VALUES (
                @name,
                @parent_id,
                @start_date,
                @start_balance,
                @tracked,
                @monthly,
                @color
            )
        `,
        cache_before: `
            SELECT sonm_balance, sonm_date
            FROM fund_finalizations
            WHERE fund_id = @fund_id
              AND sonm_date <= @date
            ORDER BY sonm_date DESC
            LIMIT 1
        `,
        // Inline (rather than requiring MonthFinalization) to avoid a circular require
        finalized_months_since: `
            SELECT id, sonm_date
            FROM month_finalizations
            WHERE som_date >= @som_date
            ORDER BY som_date ASC
        `,
        set_finalization_id: `
            UPDATE funds
            SET finalization_id = @finalization_id
            WHERE id = @id
        `,
        has_finalizations: `
            SELECT 1
            FROM fund_finalizations
            WHERE fund_id = @fund_id
            LIMIT 1
        `,
        has_transactions_before: `
            SELECT 1
            FROM transactions
            WHERE (source_fund_id = @fund_id OR target_fund_id = @fund_id)
              AND date < @date
            LIMIT 1
        `,
        update: `
            UPDATE funds
            SET name = @name,
                parent_id = @parent_id,
                start_date = @start_date,
                start_balance = @start_balance,
                tracked = @tracked,
                monthly = @monthly,
                color = @color
            WHERE id = @id
        `,
        delete: `
            DELETE FROM funds
            WHERE id = @id
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
        this.monthly = monthly;
        this.color = color;
        this.finalization_id = finalization_id;
        this.cached_balance = cached_balance;
        this.cached_date = cached_date;
        this.created_at = created_at;
    }

    to_api() {
        return {
            id: this.id,
            name: this.name,
            parent_id: this.parent_id,

            // All cached values are { date, forward_balance } pairs: the balance
            // entering `date`, NOT including any transactions on `date` itself
            start: !this.tracked ? null : {
                date: this.start_date.toJSON(),
                forward_balance: this.start_balance,
            },
            cache: !this.tracked ? null : {
                date: this.cached_date.toJSON(),
                forward_balance: this.cached_balance,
            },

            status: {
                tracked: this.tracked,
                monthly: this.monthly,
                root: !this.parent_id
            },

            color: this.color,
            created_at: this.created_at.toISOString(),
        };
    }


    static from_row(row) {
        if ( row === null ) return null;

        const tracked = stmt2boolean(row.tracked);
        const start_date = stmt2ydate(row.start_date);
        const start_balance = stmt2currency(row.start_balance);

        let cached_balance = stmt2currency(row.cached_balance);
        let cached_date = stmt2ydate(row.cached_date);
        if ( tracked && row.finalization_id == null ) {
            // Fallback: a never-finalized fund uses its start values as the
            // cache point, backdated to the first of the month so that cache
            // dates are ALWAYS a first-of-month. This is valid only because
            // transactions cannot predate a fund's start_date (enforced at
            // transaction creation).
            cached_balance = start_balance;
            cached_date = start_date.start_of_month();
        }

        return new this({
            id: row.id,
            name: row.name,
            parent_id: row.parent_id,
            start_date,
            start_balance,
            tracked,
            monthly: stmt2boolean(row.monthly),
            color: row.color,
            finalization_id: row.finalization_id,
            cached_balance,
            cached_date,
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
            monthly: boolean2stmt(monthly),
            color
        });

        const id = result.lastInsertRowid;

        // Backfill: if this (tracked) fund starts in or before an already
        // finalized month, add fund_finalizations for every finalized month
        // from its start month forward so the fund's finalization point
        // matches every other fund. The fund is brand new -- transactions
        // cannot predate start_date and cannot be added to finalized months
        // at all -- so every backfilled row is simply eom = sonm = start_balance,
        // and no cleanup transactions are needed (finalized months' transaction
        // groups are immutable).
        if ( tracked ) {
            const months = this.get_stmt(db, "finalized_months_since").all({
                som_date: ydate2stmt(start_date.start_of_month()),
            });

            if ( months.length ) {
                // GOTCHA : a backdated *monthly* fund must start at 0. Its
                //          backfilled sonm_balance must be 0 (monthly funds
                //          zero out each month), but we cannot retroactively
                //          insert cleanup transactions into finalized months,
                //          so the only consistent start_balance is 0.
                if ( monthly && start_balance != 0 ) {
                    throw new ConflictError("A monthly fund backdated past a finalized month must have a start_balance of 0");
                }

                let finalization_id = null;
                for ( const month of months ) {
                    const finalization = FundFinalization._create(db, {
                        month_id: month.id,
                        fund_id: id,
                        eom_balance: start_balance,
                        sonm_balance: start_balance,
                        sonm_date: stmt2ydate(month.sonm_date),
                    });
                    finalization_id = finalization.id;
                }

                this.get_stmt(db, "set_finalization_id").run({ id, finalization_id });
            }
        }

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

    /**
     * The { date, forward_balance } cache point immediately at-or-before the
     * provided date (equivalently, the "forward balance for the month" that
     * contains `date`). Falls back to the (backdated) start values when no
     * finalization exists at-or-before `date`.
     *
     * Returns null for untracked funds.
     */
    cached_forward_balance_before(db, date) {
        if ( !this.tracked ) return null;

        const row = this.get_stmt(db, "cache_before").get({
            fund_id: this.id,
            date: ydate2stmt(date)
        });

        if ( row ) return {
            date: stmt2ydate(row.sonm_date),
            forward_balance: stmt2currency(row.sonm_balance),
        };

        // Fallback to (backdated) start values -- see from_row for why the
        // backdating is safe
        return {
            date: this.start_date.start_of_month(),
            forward_balance: this.start_balance,
        };
    }

    /**
     * The balance ON `date`, i.e. including every transaction up to and on
     * that date. Computed from the best cache point at-or-before `date`:
     * both bounds of net_transfer are inclusive, and the cache is a forward
     * balance entering cache.date, so nothing is double counted.
     */
    calculate_balance_on(db, date) {
        if ( !this.tracked ) return 0;

        if ( ydate2stmt(date) < ydate2stmt(this.start_date) ) {
            throw new Error("Cannot calculate a balance before the fund's start_date");
        }

        const cache = this.cached_forward_balance_before(db, date);

        const net = Transaction.net_transfer(db, this.id, {
            since: cache.date,
            until: date,
        });

        return cache.forward_balance + net;
    }

    /**
     * The current balance, including every transaction: latest cache point
     * plus all net transfers since.
     */
    calculate_balance(db) {
        if ( !this.tracked ) return 0;

        const net = Transaction.net_transfer(db, this.id, {
            since: this.cached_date,
            until: null,
        });

        return this.cached_balance + net;
    }

    /**
     * The safeguard for "rewinding history": throws if any fund_finalizations
     * exist for this fund. Changes that would invalidate cached history
     * (start_date, start_balance, tracked, monthly, the parent of a monthly
     * fund, or deletion) must first unfinalize every month back to the fund's
     * start, make the change, then re-finalize back up to the present.
     */
    assert_unfinalized(db) {
        if ( this.get_stmt(db, "has_finalizations").get({ fund_id: this.id }) ) {
            throw new ConflictError("Fund has finalized months; unfinalize back to the fund's start before rewriting its history");
        }
    }

    static _update(db, fund, changes={}) {
        // Resolve the final values (undefined means "unchanged")
        const next = {
            name: changes.name !== undefined ? changes.name : fund.name,
            parent_id: changes.parent_id !== undefined ? changes.parent_id : fund.parent_id,
            start_date: changes.start_date !== undefined ? changes.start_date : fund.start_date,
            start_balance: changes.start_balance !== undefined ? changes.start_balance : fund.start_balance,
            tracked: changes.tracked !== undefined ? changes.tracked : fund.tracked,
            monthly: changes.monthly !== undefined ? changes.monthly : fund.monthly,
            color: changes.color !== undefined ? changes.color : fund.color,
        };

        // Untracked funds carry no start values
        if ( !next.tracked ) {
            next.start_date = null;
            next.start_balance = null;
        }

        // Same consistency rules as create
        if ( next.tracked && next.start_date == null ) {
            throw new Error("Cannot set tracked without also providing start_date");
        }
        if ( next.tracked && next.start_balance == null ) {
            throw new Error("Cannot set tracked without also providing (non-null) start_balance");
        }
        if ( next.monthly && !next.parent_id ) {
            throw new Error("Cannot make a fund monthly without a parent");
        }
        if ( next.monthly && !next.tracked ) {
            throw new Error("Cannot make a fund monthly unless it is also tracked");
        }

        // History-affecting changes require the fund to be fully unfinalized
        const history_affected =
            next.tracked !== fund.tracked
            || next.monthly !== fund.monthly
            || ydate2stmt(next.start_date) !== ydate2stmt(fund.start_date)
            || next.start_balance !== fund.start_balance
            // Past cleanups flowed to the old parent, so a monthly fund's
            // parent is part of its history
            || ((fund.monthly || next.monthly) && next.parent_id !== fund.parent_id);
        if ( history_affected ) {
            fund.assert_unfinalized(db);
        }

        // Transactions may not predate a tracked fund's start_date, so the
        // start_date cannot be moved past existing transactions
        if ( next.tracked && this.get_stmt(db, "has_transactions_before").get({
            fund_id: fund.id,
            date: ydate2stmt(next.start_date),
        }) ) {
            throw new ConflictError("Cannot move start_date past existing transactions");
        }

        if ( next.name !== fund.name && this.get_stmt(db, "name_exists").get({ name: next.name }) ) {
            throw new ConflictError("Name already exists: " + next.name);
        }
        if ( next.parent_id !== fund.parent_id && next.parent_id != null
            && !this.get_stmt(db, "id_exists").get({ id: next.parent_id }) ) {
            throw new ForeignKeyError("Parent fund does not exist: " + next.parent_id);
        }

        this.get_stmt(db, "update").run({
            id: fund.id,
            name: next.name,
            parent_id: next.parent_id,
            start_date: ydate2stmt(next.start_date),
            start_balance: currency2stmt(next.start_balance),
            tracked: boolean2stmt(next.tracked),
            monthly: boolean2stmt(next.monthly),
            color: next.color,
        });

        return this.for_id(db, fund.id);
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
        const transaction = this.constructor.build_transaction(
            db, "update", this.constructor._update.bind(this.constructor));
        return transaction(db, this, {
            name,
            parent_id,
            start_date,
            start_balance,
            tracked,
            monthly,
            color,
        });
    }

    delete(db) {
        // Deleting a finalized fund would destroy cached history
        this.assert_unfinalized(db);
        this.get_stmt(db, "delete").run({ id: this.id });
    }

    /**
     * This fund's fund_finalizations (newest first by default). For
     * monthly-type funds, `eom_balance` on each row is the historical
     * surplus/loss for that month (the balance before it was zeroed out).
     */
    finalization_history(db, opts={}) {
        return FundFinalization.from_db(db, { ...opts, fund_id: this.id });
    }

    descendants(db) {
        throw new Error("TODO");
    }
}
