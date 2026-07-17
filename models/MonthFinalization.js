
const Base = require("./Base.js");

const Fund = require("./Fund.js");
const FundFinalization = require("./FundFinalization.js");
const Transaction = require("./Transaction.js");
const TransactionGroup = require("./TransactionGroup.js");

const {
    ConflictError,
} = require("../lib/db.js");

const {
    stmt2datetime,
    stmt2ydate,
    ydate2stmt
} = require("../lib/db.js").helpers;

const SELECT_COLUMNS = [
    "id",
    "som_date",
    "eom_date",
    "sonm_date",
    "created_at",
];

/**
 * The orchestrator for finalizing/unfinalizing months. Users always work on
 * months as a whole -- individual fund finalizations are managed internally
 * (see FundFinalization).
 *
 * NOTE : MonthFinalization sits at the top of the model dependency graph
 *        (it requires Fund/FundFinalization/Transaction/TransactionGroup);
 *        nothing may require it back. Lower models that need to know about
 *        finalizations (e.g. the TransactionGroup finalized-month guard) use
 *        inline SQL against the finalization tables instead.
 */
module.exports = class MonthFinalization extends Base {
    static PREPARED_STMTS = {
        for_id: `
            SELECT ${SELECT_COLUMNS.join(", ")}
            FROM month_finalizations
            WHERE id = @id
        `,
        for_som_date: `
            SELECT ${SELECT_COLUMNS.join(", ")}
            FROM month_finalizations
            WHERE som_date = @som_date
        `,
        latest: `
            SELECT ${SELECT_COLUMNS.join(", ")}
            FROM month_finalizations
            ORDER BY som_date DESC
            LIMIT 1
        `,
        later_exists: `
            SELECT 1
            FROM month_finalizations
            WHERE som_date > @som_date
            LIMIT 1
        `,
        earliest_tracked_start: `
            SELECT MIN(start_date) AS start_date
            FROM funds
            WHERE tracked = 1
        `,
        create: `
            INSERT INTO month_finalizations (
                som_date,
                eom_date,
                sonm_date
            ) VALUES (
                @som_date,
                @eom_date,
                @sonm_date
            )
        `,
        finalized_fund_ids: `
            SELECT fund_id
            FROM fund_finalizations
            WHERE month_id = @month_id
        `,
        cleanup_group_ids: `
            SELECT DISTINCT group_id
            FROM transactions
            WHERE eom_cleanup_id IN (
                SELECT id FROM fund_finalizations WHERE month_id = @month_id
            )
        `,
        delete_cleanup_transactions: `
            DELETE FROM transactions
            WHERE eom_cleanup_id IN (
                SELECT id FROM fund_finalizations WHERE month_id = @month_id
            )
        `,
        delete_groups: `
            DELETE FROM transaction_groups
            WHERE id IN (SELECT value FROM json_each(@group_ids))
        `,
        delete_month: `
            DELETE FROM month_finalizations
            WHERE id = @id
        `,
        set_fund_finalization_id: `
            UPDATE funds
            SET finalization_id = @finalization_id
            WHERE id = @id
        `,
        repoint_fund_finalization_ids: `
            UPDATE funds
            SET finalization_id = (
                SELECT ff.id
                FROM fund_finalizations ff
                WHERE ff.fund_id = funds.id
                ORDER BY ff.sonm_date DESC
                LIMIT 1
            )
            WHERE id IN (SELECT value FROM json_each(@fund_ids))
        `,
    }

    static PREPARED_TRANSACTIONS = {}

    static ORDER_BY_MAP = {
        "id": "id",
        "som_date": "som_date",
    }

    constructor({
        id,
        som_date,
        eom_date,
        sonm_date,
        created_at,
    }={}) {
        super();
        this.id = id;
        this.som_date = som_date;
        this.eom_date = eom_date;
        this.sonm_date = sonm_date;
        this.created_at = created_at;
    }

    static openapi_MonthFinalizationSchema = {
        description: "A finalized month: transaction groups may no longer be added in (or before) it. Parent of that month's fund finalizations.",
        type: 'object',
        properties: {
            id: { type: 'integer', minimum: 1 },
            som_date: { type: 'string', format: 'date', example: '2026-01-01', description: "First day of the month" },
            eom_date: { type: 'string', format: 'date', example: '2026-01-31', description: "Last day of the month" },
            sonm_date: { type: 'string', format: 'date', example: '2026-02-01', description: "First day of the next month" },
            created_at: { type: 'string', format: 'date-time' }
        },
        required: [ 'id', 'som_date', 'eom_date', 'sonm_date', 'created_at' ]
    };

    to_api() {
        return {
            id: this.id,
            som_date: this.som_date.toJSON(),
            eom_date: this.eom_date.toJSON(),
            sonm_date: this.sonm_date.toJSON(),
            created_at: this.created_at.toISOString(),
        };
    }

    static from_row(row) {
        if ( row == null ) return null;

        return new this({
            id: row.id,
            som_date: stmt2ydate(row.som_date),
            eom_date: stmt2ydate(row.eom_date),
            sonm_date: stmt2ydate(row.sonm_date),
            created_at: stmt2datetime(row.created_at),
        });
    }

    static for_id(db, id) {
        const stmt = this.get_stmt(db, "for_id");
        return this.from_row(stmt.get({ id }) ?? null);
    }

    static for_month(db, month) {
        const stmt = this.get_stmt(db, "for_som_date");
        return this.from_row(stmt.get({
            som_date: ydate2stmt(month.start_of_month())
        }) ?? null);
    }

    static latest(db) {
        const stmt = this.get_stmt(db, "latest");
        return this.from_row(stmt.get() ?? null);
    }

    static _from_db_wheres({
        since,  // YDate or null, filters on som_date
        until,  // YDate or null, filters on som_date
    }={}) {
        const wheres = [];
        const params = {};
        const keys = [];

        if ( since !== undefined ) {
            wheres.push("som_date >= @since");
            params.since = ydate2stmt(since);
            keys.push("since");
        }
        if ( until !== undefined ) {
            wheres.push("som_date <= @until");
            params.until = ydate2stmt(until);
            keys.push("until");
        }

        return { wheres, params, keys };
    }

    static from_db(db, {
        order_by = "som_date",
        order_direction = "DESC",
        limit = 100,
        offset = 0,
        ...filters
    }={}) {
        const { wheres, params, keys } = this._from_db_wheres(filters);

        let sql = `SELECT ${SELECT_COLUMNS.join(", ")}\n`
                + `FROM month_finalizations\n`;
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
                + `FROM month_finalizations\n`;
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
        month,
        recursive,
    }={}) {
        const som = month.start_of_month();
        const eom = month.end_of_month();
        const sonm = month.start_of_next_month();

        // ------------------------------------------------------------------
        // Contiguity check: this month must immediately follow the latest
        // finalized month (or be the earliest month any tracked fund starts
        // in, when nothing has been finalized yet)
        // ------------------------------------------------------------------
        const latest = this.latest(db);

        let required_som;
        if ( latest ) {
            if ( ydate2stmt(som) <= ydate2stmt(latest.som_date) ) {
                throw new ConflictError("Month has already been finalized: " + som);
            }
            required_som = latest.sonm_date;
        } else {
            const row = this.get_stmt(db, "earliest_tracked_start").get();
            const earliest = stmt2ydate(row?.start_date ?? null);
            if ( !earliest ) {
                throw new ConflictError("Cannot finalize a month before any tracked fund exists");
            }
            required_som = earliest.start_of_month();
            if ( ydate2stmt(som) < ydate2stmt(required_som) ) {
                throw new ConflictError("Cannot finalize a month before any tracked fund starts");
            }
        }

        if ( ydate2stmt(som) != ydate2stmt(required_som) ) {
            if ( !recursive ) {
                throw new ConflictError("Previous month has not been finalized: " + required_som);
            }
            // Recursively finalize the previous month first (som - 1 day is
            // the eom of the previous month, i.e. any date in that month).
            // We call _create directly: we are already inside the sqlite
            // transaction, so the whole recursive chain lands atomically.
            this._create(db, { month: som.offset_days(-1), recursive });
        }

        // ------------------------------------------------------------------
        // Collect the funds to finalize: tracked funds that have started by
        // the end of this month
        // ------------------------------------------------------------------
        const funds = Fund.from_db(db, {
            tracked: true,
            started_until: eom,
            limit: null,
            order_by: null,
        });

        // ------------------------------------------------------------------
        // Compute each fund's balance ON eom_date (excluding cleanups -- none
        // exist yet for this month). Each fund's cache point is a forward
        // balance entering cached_date, and net_transfer's bounds are
        // inclusive, so nothing is double counted.
        // ------------------------------------------------------------------
        const eom_balances = new Map();
        for ( const fund of funds ) {
            const net = Transaction.net_transfer(db, fund.id, {
                since: fund.cached_date,
                until: eom,
            });
            eom_balances.set(fund.id, fund.cached_balance + net);
        }

        // ------------------------------------------------------------------
        // Compute cleanup flows: every monthly fund returns exactly its own
        // eom balance directly to its nearest POOL ancestor (no ordering, no
        // relaying through intermediate monthly parents), which guarantees
        // sonm_balance = 0 for every monthly fund, even when nested.
        // ------------------------------------------------------------------
        const monthly_funds = funds.filter(f => f.monthly);

        const cleanup_flows = new Map(); // fund_id -> net cleanup flow (in - out)
        const cleanups = []; // { fund, pool, amount } where amount is signed (fund -> pool)
        for ( const fund of monthly_funds ) {
            // Defensive: the Fund-layer invariant (monthly funds require a
            // pool ancestor) should make this unreachable
            const pool = fund.nearest_pool(db);
            if ( !pool ) {
                throw new ConflictError("Monthly fund has no pool ancestor: " + fund.name);
            }

            const amount = eom_balances.get(fund.id);

            cleanup_flows.set(fund.id, (cleanup_flows.get(fund.id) ?? 0) - amount);
            cleanup_flows.set(pool.id, (cleanup_flows.get(pool.id) ?? 0) + amount);
            cleanups.push({ fund, pool, amount });
        }

        // ------------------------------------------------------------------
        // Insert the finalization rows.
        //
        // ORDER IS LOAD-BEARING: sonm_balance is computed analytically ABOVE
        // (eom balance + net cleanup flow) because the fund_finalizations
        // rows must exist before the cleanup transactions that reference them
        // (transactions.eom_cleanup_id). This is only safe because everything
        // here runs in one sqlite transaction -- do not reorder, and do not
        // move any of these steps out of the transaction.
        // ------------------------------------------------------------------
        const result = this.get_stmt(db, "create").run({
            som_date: ydate2stmt(som),
            eom_date: ydate2stmt(eom),
            sonm_date: ydate2stmt(sonm),
        });
        const month_id = result.lastInsertRowid;

        const finalization_ids = new Map(); // fund_id -> fund_finalizations.id
        for ( const fund of funds ) {
            const eom_balance = eom_balances.get(fund.id);
            const finalization = FundFinalization._create(db, {
                month_id,
                fund_id: fund.id,
                eom_balance,
                sonm_balance: eom_balance + (cleanup_flows.get(fund.id) ?? 0),
                sonm_date: sonm,
            });
            finalization_ids.set(fund.id, finalization.id);
        }

        // ------------------------------------------------------------------
        // Insert the single eom_cleanup transaction group for the month (if
        // any monthly funds were finalized). Every monthly fund gets exactly
        // one cleanup transaction, even at zero amount, so the record always
        // exists. Direction depends on sign: surplus flows fund -> pool,
        // deficit flows pool -> fund.
        //
        // NOTE : we intentionally call TransactionGroup._create (not .create)
        //        to bypass the finalized-month guard: this group is dated
        //        inside the month we are finalizing, and it lands atomically
        //        in the same sqlite transaction as the finalization rows.
        // ------------------------------------------------------------------
        if ( cleanups.length ) {
            TransactionGroup._create(db, {
                date: eom,
                description: "EOM cleanup for " + som,
                note: null,
                split: cleanups.length > 1,
                eom_cleanup: true,
                allocation: false,
                transactions: cleanups.map(({ fund, pool, amount }) => ({
                    source_fund_id: amount >= 0 ? fund.id : pool.id,
                    target_fund_id: amount >= 0 ? pool.id : fund.id,
                    amount: Math.abs(amount),
                    description: "EOM cleanup: " + fund.name,
                    note: null,
                    eom_cleanup_id: finalization_ids.get(fund.id),
                })),
            });
        }

        // Finally, point each fund at its new (most recent) finalization
        for ( const fund of funds ) {
            this.get_stmt(db, "set_fund_finalization_id").run({
                id: fund.id,
                finalization_id: finalization_ids.get(fund.id),
            });
        }

        return this.for_id(db, month_id);
    }

    /**
     * Finalize a month. `month` may be any YDate within the target month.
     *
     * By default this errors if the previous month has not been finalized;
     * pass `recursive: true` to automatically finalize intervening months
     * (oldest first) back to the last finalized month (or the first month
     * any tracked fund starts in).
     */
    static create(db, {
        month,
        recursive = false,
    }={}) {
        if ( !month ) throw new Error("Missing month");

        const transaction = this.build_transaction(db, "create", this._create.bind(this));
        return transaction(db, { month, recursive });
    }

    static _delete(db, month, { recursive = false }={}) {
        // Unfinalization is strictly LIFO: only the most recent finalized
        // month may be removed, otherwise the contiguous chain of cache
        // points would have gaps. With `recursive`, the later months are
        // unfinalized first (newest-first), so `month` becomes the latest
        // before we reverse it -- and the whole cascade lands atomically in
        // the one sqlite transaction wrapping this call.
        if ( this.get_stmt(db, "later_exists").get({ som_date: ydate2stmt(month.som_date) }) ) {
            if ( !recursive ) {
                throw new ConflictError("Only the most recent finalized month may be unfinalized");
            }
            let latest = this.latest(db);
            while ( latest && ydate2stmt(latest.som_date) > ydate2stmt(month.som_date) ) {
                this._unfinalize_one(db, latest);
                latest = this.latest(db);
            }
        }

        this._unfinalize_one(db, month);
    }

    /**
     * Raw single-month reversal. The caller MUST ensure `month` is the latest
     * finalized month (no LIFO check here) -- `_delete` enforces that.
     */
    static _unfinalize_one(db, month) {
        const fund_ids = this.get_stmt(db, "finalized_fund_ids")
            .all({ month_id: month.id })
            .map(row => row.fund_id);

        // Collect the eom_cleanup group(s) BEFORE deleting their transactions,
        // then delete transactions first: transactions.eom_cleanup_id is
        // ON DELETE RESTRICT against fund_finalizations, so the transactions
        // must go before the finalization rows do
        const group_ids = this.get_stmt(db, "cleanup_group_ids")
            .all({ month_id: month.id })
            .map(row => row.group_id);
        this.get_stmt(db, "delete_cleanup_transactions").run({ month_id: month.id });
        this.get_stmt(db, "delete_groups").run({ group_ids: JSON.stringify(group_ids) });

        // Deleting the month cascades to fund_finalizations, which nulls
        // funds.finalization_id via ON DELETE SET NULL...
        this.get_stmt(db, "delete_month").run({ id: month.id });

        // ...so repoint each affected fund at its previous finalization (or
        // leave NULL if none remains, restoring the start-values fallback)
        this.get_stmt(db, "repoint_fund_finalization_ids").run({
            fund_ids: JSON.stringify(fund_ids),
        });
    }

    /**
     * Unfinalize this month, removing the fund finalizations and the month's
     * eom_cleanup transactions, and repointing funds at their previous
     * finalizations. Strictly LIFO by default (only the latest finalized
     * month); pass `recursive: true` to cascade -- unfinalize every later
     * month first (newest-first) so this month can be reversed too. The whole
     * cascade is one atomic sqlite transaction.
     */
    delete(db, { recursive = false }={}) {
        const transaction = this.constructor.build_transaction(
            db, "delete", this.constructor._delete.bind(this.constructor));
        return transaction(db, this, { recursive });
    }

    unfinalize(db, opts={}) {
        return this.delete(db, opts);
    }
}
