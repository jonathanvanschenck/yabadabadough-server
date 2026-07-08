
const Base = require("./Base.js");

const Transaction = require("./Transaction.js");
const FundFinalization = require("./FundFinalization.js");

const {
    ConflictError,
    ForeignKeyError
} = require("../lib/db.js");

const { FUND_COLORS } = require("../lib/fund_colors.mjs");

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
    "funds.pool AS pool",
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
                pool,
                color
            ) VALUES (
                @name,
                @parent_id,
                @start_date,
                @start_balance,
                @tracked,
                @monthly,
                @pool,
                @color
            )
        `,
        // The nearest pool at-or-above the given fund. To find a fund's
        // nearest pool ANCESTOR, start from its parent_id
        nearest_pool_from: `
            WITH RECURSIVE chain(id, depth) AS (
                SELECT @id, 0
                UNION ALL
                SELECT f.parent_id, c.depth + 1
                FROM funds f
                JOIN chain c ON f.id = c.id
                WHERE f.parent_id IS NOT NULL
                  AND c.depth < 50 -- Safety limit
            )
            SELECT funds.id AS id, funds.start_date AS start_date
            FROM chain
            JOIN funds ON funds.id = chain.id
            WHERE funds.pool = 1
            ORDER BY chain.depth ASC
            LIMIT 1
        `,
        // Global invariant check: every monthly fund must have a pool
        // ancestor. `pooled` is the set of funds at-or-below a pool; monthly
        // funds cannot themselves be pools, so membership means "has a pool
        // ancestor"
        monthly_without_pool: `
            WITH RECURSIVE pooled(id) AS (
                SELECT id FROM funds WHERE pool = 1
                UNION
                SELECT f.id FROM funds f JOIN pooled ON f.parent_id = pooled.id
            )
            SELECT funds.id AS id, funds.name AS name
            FROM funds
            WHERE funds.monthly = 1
              AND funds.id NOT IN (SELECT id FROM pooled)
            LIMIT 1
        `,
        // Whether the fund or any fund below it is monthly (used to decide
        // if a parent change affects cleanup-routing history)
        has_monthly_descendant: `
            WITH RECURSIVE subtree(id) AS (
                SELECT @id
                UNION
                SELECT f.id FROM funds f JOIN subtree ON f.parent_id = subtree.id
            )
            SELECT 1
            FROM funds
            WHERE funds.monthly = 1
              AND funds.id IN (SELECT id FROM subtree)
            LIMIT 1
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
                pool = @pool,
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
        pool,
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
        this.pool = pool;
        this.color = color;
        this.finalization_id = finalization_id;
        this.cached_balance = cached_balance;
        this.cached_date = cached_date;
        this.created_at = created_at;
    }

    static openapi_ForwardBalanceSchema = {
        description: "A balance cache point: the forward balance entering `date` -- includes every transaction BEFORE `date`, but NOT transactions on `date` itself.",
        type: 'object',
        properties: {
            date: { type: 'string', format: 'date', example: '2026-01-01' },
            forward_balance: { type: 'number', description: "Currency as a float dollar amount" }
        },
        required: [ 'date', 'forward_balance' ]
    };

    static openapi_FundSchema = {
        type: 'object',
        properties: {
            id: { type: 'integer', minimum: 1 },
            name: { type: 'string' },
            parent_id: { type: 'integer', minimum: 1, nullable: true, description: "null for root funds" },
            start: {
                description: "Where tracking began; null for untracked funds",
                oneOf: [
                    { '$ref': '#/components/schemas/ForwardBalanceSchema' },
                    { '$ref': '#/components/schemas/NullSchema' }
                ]
            },
            cache: {
                description: "The most recent reconciliation point (latest finalization, falling back to the start values); null for untracked funds",
                oneOf: [
                    { '$ref': '#/components/schemas/ForwardBalanceSchema' },
                    { '$ref': '#/components/schemas/NullSchema' }
                ]
            },
            status: {
                type: 'object',
                properties: {
                    tracked: { type: 'boolean' },
                    monthly: { type: 'boolean', description: "Resets into its nearest pool ancestor at end of month" },
                    pool: { type: 'boolean', description: "Source/sink of money for its descendants" },
                    root: { type: 'boolean', description: "true iff parent_id is null" }
                },
                required: [ 'tracked', 'monthly', 'pool', 'root' ]
            },
            color: { type: 'string', nullable: true, enum: [ ...FUND_COLORS, null ], description: "Palette color slug (see lib/fund_colors.mjs)" },
            created_at: { type: 'string', format: 'date-time' }
        },
        required: [ 'id', 'name', 'parent_id', 'start', 'cache', 'status', 'color', 'created_at' ]
    };

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
                pool: this.pool,
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
            pool: stmt2boolean(row.pool),
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

    static _from_db_wheres({
        id,
        ids,
        name,
        name_like,
        started_since, // YDate or null
        started_until, // YDate or null
        tracked,
        monthly,
        pool,
        root,
        descendant_of, // fund id; self-inclusive subtree
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
            // An empty array matches nothing (json_each('[]') yields no rows)
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
        if ( pool !== undefined ) {
            wheres.push("funds.pool = @pool");
            params.pool = boolean2stmt(pool);
            keys.push("pool");
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
        if ( descendant_of !== undefined ) {
            // Self-inclusive subtree: the fund itself plus everything below
            // it. An unknown id matches nothing (empty result)
            wheres.push(
                "funds.id IN (\n" +
                "\t\tWITH RECURSIVE subtree(id) AS (\n" +
                "\t\t\tSELECT @descendant_of\n" +
                "\t\t\tUNION\n" +
                "\t\t\tSELECT f.id FROM funds f JOIN subtree ON f.parent_id = subtree.id\n" +
                "\t\t)\n" +
                "\t\tSELECT id FROM subtree\n" +
                "\t)"
            );
            params.descendant_of = descendant_of;
            keys.push("descendant_of");
        }

        return { wheres, params, keys };
    }

    static from_db(db, {
        order_by = "id",
        order_direction = "ASC",
        limit = 100,
        offset =  0,
        ...filters
    }={}) {
        const { wheres, params, keys } = this._from_db_wheres(filters);

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

    /**
     * Total rows matching the same filters as from_db (order/limit/offset
     * are accepted and ignored, so the API layer can pass one filter object
     * to both).
     */
    static count(db, { order_by, order_direction, limit, offset, ...filters }={}) {
        const { wheres, params, keys } = this._from_db_wheres(filters);

        let sql = `SELECT COUNT(*) AS count\n`
                + `FROM funds\n`;
        if ( wheres.length ) {
            sql = sql + `WHERE\n\t${wheres.join("\n\tAND ")}\n`
        }

        const stmt = this.build_stmt(
            db,
            "count$" + keys.join(":"),
            sql
        );

        return stmt.get(params).count;
    }

    static _create(db, {
        name,
        parent_id,
        start_date,
        start_balance,
        tracked,
        monthly,
        pool,
        color
    }={}) {
        if ( this.get_stmt(db, "name_exists").get({ name }) ) {
            throw new ConflictError("Name already exists: "+name);
        }
        if ( parent_id && !this.get_stmt(db, "id_exists").get({ id:parent_id }) ) {
            throw new ForeignKeyError("Parent fund does not exist: "+parent_id);
        }

        // Monthly funds return their EOM balances to (and draw allocations
        // from) their nearest pool ancestor, so one must exist and must have
        // started by the time the monthly fund starts
        if ( monthly ) {
            const pool_row = parent_id
                ? this.get_stmt(db, "nearest_pool_from").get({ id: parent_id })
                : null;
            if ( !pool_row ) {
                throw new ConflictError("Monthly funds require a pool ancestor");
            }
            if ( pool_row.start_date > ydate2stmt(start_date) ) {
                throw new ConflictError("A monthly fund cannot start before its pool ancestor");
            }
        }

        const stmt = this.get_stmt(db, "create");
        const result = stmt.run({
            name,
            parent_id,
            start_date: ydate2stmt(start_date),
            start_balance: currency2stmt(start_balance),
            tracked: boolean2stmt(tracked),
            monthly: boolean2stmt(monthly),
            pool: boolean2stmt(pool),
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
        pool = false,
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

        // Pools hold real money (tracked) and are never monthly
        if ( pool && !tracked ) {
            throw new Error("Cannot create a pool fund unless it is also tracked");
        }
        if ( pool && monthly ) {
            throw new Error("Cannot create a fund that is both pool and monthly");
        }

        // Colors are palette slugs from the shared registry (db CHECK backstops)
        if ( color != null && !FUND_COLORS.includes(color) ) {
            throw new Error("Unknown fund color: "+color);
        }

        const transaction =  this.build_transaction(db, "create", this._create.bind(this));
        return transaction(db, {
            name,
            parent_id,
            start_date: tracked ? start_date : null,
            start_balance: tracked ? start_balance : null,
            tracked,
            monthly,
            pool,
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
     * The fund's nearest pool ancestor (the source/sink for its allocations
     * and, if monthly, its EOM cleanups), or null if none exists.
     */
    nearest_pool(db) {
        if ( this.parent_id == null ) return null;
        const row = this.constructor.get_stmt(db, "nearest_pool_from")
            .get({ id: this.parent_id });
        return row ? this.constructor.for_id(db, row.id) : null;
    }

    /**
     * The safeguard for "rewinding history": throws if any fund_finalizations
     * exist for this fund. Changes that would invalidate cached history
     * (start_date, start_balance, tracked, monthly, pool, the parent of a
     * fund that is or contains a monthly fund, or deletion) must first
     * unfinalize every month back to the fund's start, make the change, then
     * re-finalize back up to the present.
     */
    assert_unfinalized(db) {
        if ( this.get_stmt(db, "has_finalizations").get({ fund_id: this.id }) ) {
            throw new ConflictError("Fund has finalized months; unfinalize back to the fund's start before rewriting its history");
        }
    }

    /**
     * Allocation sources are DERIVED, not snapshotted: an allocation
     * transaction's source_fund_id always means "the target's nearest pool
     * ancestor". After any hierarchy change that can affect pool resolution,
     * every allocation in an unfinalized month is repointed to match (throws
     * if one would be orphaned). Finalized months are immutable and keep the
     * routing that was in effect when they were written.
     */
    static _rederive_allocation_sources(db) {
        for ( const row of Transaction._unfinalized_allocations(db) ) {
            const target = this.for_id(db, row.target_fund_id);
            const pool = target.nearest_pool(db);
            if ( !pool ) {
                throw new ConflictError("Change would orphan an allocation for fund: " + target.name);
            }
            if ( ydate2stmt(pool.start_date) > row.date ) {
                throw new ConflictError("Change would route the allocation for fund " + target.name + " from a pool that starts after the allocation date: " + pool.name);
            }
            if ( pool.id !== row.source_fund_id ) {
                Transaction._set_source(db, { id: row.id, source_fund_id: pool.id });
            }
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
            pool: changes.pool !== undefined ? changes.pool : fund.pool,
            color: changes.color !== undefined ? changes.color : fund.color,
        };

        // Untracked funds carry no start values
        if ( !next.tracked ) {
            next.start_date = null;
            next.start_balance = null;
        }

        // Same consistency rules as create
        if ( next.color != null && !FUND_COLORS.includes(next.color) ) {
            throw new Error("Unknown fund color: "+next.color);
        }
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
        if ( next.pool && !next.tracked ) {
            throw new Error("Cannot make a fund a pool unless it is also tracked");
        }
        if ( next.pool && next.monthly ) {
            throw new Error("Cannot make a fund both pool and monthly");
        }

        const parent_changed = next.parent_id !== fund.parent_id;

        // History-affecting changes require the fund to be fully unfinalized
        const history_affected =
            next.tracked !== fund.tracked
            || next.monthly !== fund.monthly
            // Past cleanups/allocations were routed through pools, so the
            // pool flag is part of history
            || next.pool !== fund.pool
            || ydate2stmt(next.start_date) !== ydate2stmt(fund.start_date)
            || next.start_balance !== fund.start_balance
            // Past cleanups flowed through the old ancestry, so the parent of
            // a monthly fund -- or of any fund with a monthly descendant --
            // is part of history
            || (parent_changed && (
                fund.monthly || next.monthly
                || !!this.get_stmt(db, "has_monthly_descendant").get({ id: fund.id })
            ));
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
            pool: boolean2stmt(next.pool),
            color: next.color,
        });

        // Changes that can affect pool resolution must not orphan any
        // monthly fund (global invariant -- a reparent can strand monthly
        // funds much deeper in the subtree), and must keep the derived
        // allocation sources in sync
        if ( parent_changed || next.pool !== fund.pool || next.monthly !== fund.monthly ) {
            const orphan = this.get_stmt(db, "monthly_without_pool").get();
            if ( orphan ) {
                throw new ConflictError("Change would leave a monthly fund without a pool ancestor: " + orphan.name);
            }
            this._rederive_allocation_sources(db);
        }

        // A fund that is (now) monthly must not start before its pool
        // ancestor (same rule as create)
        if ( next.monthly && (parent_changed || !fund.monthly) ) {
            const pool_row = this.get_stmt(db, "nearest_pool_from").get({ id: next.parent_id });
            if ( !pool_row ) {
                throw new ConflictError("Monthly funds require a pool ancestor");
            }
            if ( pool_row.start_date > ydate2stmt(next.start_date) ) {
                throw new ConflictError("A monthly fund cannot start before its pool ancestor");
            }
        }

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
        pool,
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
            pool,
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
}
