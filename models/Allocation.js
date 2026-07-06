
const Base = require("./Base.js");

const Fund = require("./Fund.js");
const Transaction = require("./Transaction.js");
const TransactionGroup = require("./TransactionGroup.js");

const {
    ConflictError,
    ForeignKeyError
} = require("../lib/db.js");

const {
    ydate2stmt
} = require("../lib/db.js").helpers;

/**
 * The user-facing object for start-of-month allocations.
 *
 * There is NO allocations table: an allocation is a transaction inside the
 * month's single allocation transaction group (allocation = 1, dated the
 * first of the month, at most one per month, created lazily and deleted when
 * it empties). Instances of this class are read-model wrappers around those
 * transactions.
 *
 * The allocated money always comes from the target fund's nearest POOL
 * ancestor. The recorded source_fund_id is DERIVED, never snapshotted: when
 * the hierarchy changes, allocations in unfinalized months are repointed to
 * match (see Fund._rederive_allocation_sources). Allocations in finalized
 * months are immutable, like all other history.
 *
 * NOTE : this model owns no table SQL at all -- every read goes through
 *        TransactionGroup/Transaction query methods and every write goes
 *        through TransactionGroup's (internal) group-editing methods. It
 *        sits at the top of the model dependency graph next to
 *        MonthFinalization; nothing may require it back.
 */
module.exports = class Allocation extends Base {
    static PREPARED_STMTS = {}

    static PREPARED_TRANSACTIONS = {}

    static ORDER_BY_MAP = {}

    constructor({
        fund_id,
        source_fund_id,
        amount,
        month,
        date,
        group_id,
        transaction_id,
        created_at,
    }={}) {
        super();
        this.fund_id = fund_id;
        this.source_fund_id = source_fund_id;
        this.amount = amount;
        this.month = month; // YDate, first of the month
        this.date = date;
        this.group_id = group_id;
        this.transaction_id = transaction_id;
        this.created_at = created_at;
    }

    to_api() {
        return {
            fund_id: this.fund_id,
            source_fund_id: this.source_fund_id,
            amount: this.amount,
            month: this.month.toJSON(),
            date: this.date.toJSON(),
            group_id: this.group_id,
            transaction_id: this.transaction_id,
            created_at: this.created_at.toISOString(),
        };
    }

    static _from_transaction(transaction) {
        return new this({
            fund_id: transaction.target_fund_id,
            source_fund_id: transaction.source_fund_id,
            amount: transaction.amount,
            month: transaction.date.start_of_month(),
            date: transaction.date,
            group_id: transaction.group_id,
            transaction_id: transaction.id,
            created_at: transaction.created_at,
        });
    }

    /**
     * The month's allocation group (or null). At most one exists per month
     * by construction.
     */
    static _group_for_month(db, month) {
        const groups = TransactionGroup.from_db(db, {
            allocation: true,
            since: month.start_of_month(),
            until: month.end_of_month(),
            limit: null,
            order_by: null,
        });
        return groups[0] ?? null;
    }

    /**
     * Every allocation for the month containing `month` (any YDate within
     * the month).
     */
    static for_month(db, month) {
        const group = this._group_for_month(db, month);
        if ( !group ) return [];
        return group.transactions.map(t => this._from_transaction(t));
    }

    /**
     * The fund's allocation history (newest first by default).
     */
    static for_fund(db, fund_id, {
        since,  // YDate or null
        until,  // YDate or null
        order_direction = "DESC",
        limit = 100,
        offset = 0,
    }={}) {
        return Transaction.from_db(db, {
            allocation: true,
            target_fund_id: fund_id,
            since,
            until,
            order_by: "date",
            order_direction,
            limit,
            offset,
        }).map(t => this._from_transaction(t));
    }

    static _set(db, {
        month,
        fund_id,
        amount,
    }={}) {
        const som = month.start_of_month();

        // Allocations in finalized months are immutable history
        TransactionGroup.assert_month_unfinalized(db, som);

        const fund = Fund.for_id(db, fund_id);
        if ( !fund ) {
            throw new ForeignKeyError("Fund does not exist: " + fund_id);
        }
        if ( !fund.tracked ) {
            throw new ConflictError("Cannot allocate to an untracked fund: " + fund.name);
        }
        // The month's allocations all live in one group dated som, and
        // transactions may not predate a fund's start_date -- so a fund
        // starting mid-month cannot receive an allocation in its start month
        // (manage an ordinary transaction group for the partial month, or
        // backdate the fund's start_date to the first of the month)
        if ( ydate2stmt(fund.start_date) > ydate2stmt(som) ) {
            throw new ConflictError("Fund has not started by the start of the month: " + fund.name);
        }

        const pool = fund.nearest_pool(db);
        if ( !pool ) {
            throw new ConflictError("Fund has no pool ancestor to allocate from: " + fund.name);
        }
        if ( ydate2stmt(pool.start_date) > ydate2stmt(som) ) {
            throw new ConflictError("Pool has not started by the start of the month: " + pool.name);
        }

        let group = this._group_for_month(db, som);

        // First allocation of the month creates the group
        if ( !group ) {
            group = TransactionGroup._create(db, {
                date: som,
                description: "Allocations for " + som,
                note: null,
                statement_id: null,
                split: false,
                eom_cleanup: false,
                allocation: true,
                transactions: [{
                    source_fund_id: pool.id,
                    target_fund_id: fund.id,
                    amount,
                    description: "Allocation: " + fund.name,
                    note: null,
                }],
            });
            return this._from_transaction(group.transactions[0]);
        }

        // Otherwise edit the existing group in place: replace the fund's
        // allocation if present, then add the new one
        const existing = group.transactions.find(t => t.target_fund_id === fund.id);
        if ( existing ) {
            group = TransactionGroup._remove_transaction(db, group, existing.id);
        }
        group = TransactionGroup._add_transaction(db, group, {
            source_fund_id: pool.id,
            target_fund_id: fund.id,
            amount,
            description: "Allocation: " + fund.name,
            note: null,
        });

        return this._from_transaction(
            group.transactions.find(t => t.target_fund_id === fund.id)
        );
    }

    /**
     * Create-or-replace the fund's allocation for the month containing
     * `month`: a transfer of `amount` from the fund's nearest pool ancestor,
     * dated the first of the month.
     */
    static set(db, {
        month,   // YDate, any date within the target month
        fund_id,
        amount,
    }={}) {
        if ( !month ) throw new Error("Missing month");
        if ( !fund_id ) throw new Error("Missing fund_id");
        // Allocations are USER transactions: strictly positive (the
        // zero-amount carve-out is for eom_cleanup transactions only)
        if ( !(amount > 0) ) throw new Error("Allocation amount must be positive");

        const transaction = this.build_transaction(db, "set", this._set.bind(this));
        return transaction(db, { month, fund_id, amount });
    }

    static _remove(db, {
        month,
        fund_id,
    }={}) {
        const som = month.start_of_month();

        TransactionGroup.assert_month_unfinalized(db, som);

        const group = this._group_for_month(db, som);
        const existing = group?.transactions.find(t => t.target_fund_id === fund_id);
        if ( !existing ) {
            throw new ConflictError("No allocation exists for fund " + fund_id + " in month " + som);
        }

        // The group holds at least one transaction: removing the last
        // allocation removes the whole group
        if ( group.transactions.length === 1 ) {
            TransactionGroup._delete(db, group);
        } else {
            TransactionGroup._remove_transaction(db, group, existing.id);
        }
    }

    /**
     * Remove the fund's allocation for the month containing `month`.
     */
    static remove(db, {
        month,   // YDate, any date within the target month
        fund_id,
    }={}) {
        if ( !month ) throw new Error("Missing month");
        if ( !fund_id ) throw new Error("Missing fund_id");

        const transaction = this.build_transaction(db, "remove", this._remove.bind(this));
        return transaction(db, { month, fund_id });
    }

    static _copy_month(db, {
        from,
        to,
        on_conflict,
    }={}) {
        // Fail fast (and with the right error) before any conflict handling
        TransactionGroup.assert_month_unfinalized(db, to.start_of_month());

        const from_allocations = this.for_month(db, from);
        const existing = new Set(this.for_month(db, to).map(a => a.fund_id));

        if ( on_conflict === "error" ) {
            const conflicts = from_allocations.filter(a => existing.has(a.fund_id));
            if ( conflicts.length ) {
                const names = conflicts
                    .map(a => Fund.for_id(db, a.fund_id)?.name ?? a.fund_id);
                throw new ConflictError("Funds already have allocations in the target month: " + names.join(", "));
            }
        }

        for ( const allocation of from_allocations ) {
            if ( existing.has(allocation.fund_id) && on_conflict === "merge" ) continue;
            // "overwrite" (and the conflict-free cases): _set replaces any
            // existing allocation. Sources are re-resolved against the
            // CURRENT hierarchy, not copied
            this._set(db, {
                month: to,
                fund_id: allocation.fund_id,
                amount: allocation.amount,
            });
        }

        return this.for_month(db, to);
    }

    /**
     * Copy every allocation in `from`'s month into `to`'s month, atomically.
     * Returns the resulting allocations for `to`.
     *
     * `on_conflict` controls funds that already have an allocation in `to`:
     *  - "error"     (default) throw, listing the conflicting funds
     *  - "merge"     keep the destination's existing allocations
     *  - "overwrite" replace them with the source month's amounts
     * Destination allocations for funds not present in `from` are always
     * kept.
     */
    static copy_month(db, {
        from,    // YDate, any date within the source month
        to,      // YDate, any date within the target month
        on_conflict = "error",
    }={}) {
        if ( !from ) throw new Error("Missing from");
        if ( !to ) throw new Error("Missing to");
        if ( !["error", "merge", "overwrite"].includes(on_conflict) ) {
            throw new Error("Unsupported on_conflict mode: " + on_conflict);
        }
        if ( ydate2stmt(from.start_of_month()) === ydate2stmt(to.start_of_month()) ) {
            throw new Error("Cannot copy a month onto itself");
        }

        const transaction = this.build_transaction(db, "copy_month", this._copy_month.bind(this));
        return transaction(db, { from, to, on_conflict });
    }

    static create() { throw new Error("You cannot directly create an allocation, please use Allocation.set(...)"); }
}
