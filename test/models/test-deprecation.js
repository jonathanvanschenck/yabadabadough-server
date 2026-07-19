const { expect } = require("chai");

const {
    create_connection,
    initialize_db,
    ConflictError,
} = require("../../lib/db.js");

const YDate = require("../../lib/YDate.js");
const Fund = require("../../models/Fund.js");
const MonthFinalization = require("../../models/MonthFinalization.js");
const Transaction = require("../../models/Transaction.js");
const TransactionGroup = require("../../models/TransactionGroup.js");
const Allocation = require("../../models/Allocation.js");

const D = (s) => YDate.parse(s);

// Cross-model behavior of fund deprecation: the fund-level rules for SETTING
// a deprecation date, and the freeze it imposes on transactions, allocations
// and finalizations everywhere else.
describe("fund deprecation", () => {

    let db, pool, savings, groceries;
    beforeEach(() => {
        db = create_connection({ path: ":memory:" });
        initialize_db(db);

        pool = Fund.create(db, {
            name: "pool", tracked: true, pool: true,
            start_date: D("2026-01-01"), start_balance: 1000,
        });
        savings = Fund.create(db, {
            name: "savings", tracked: true, parent_id: pool.id,
            start_date: D("2026-01-01"), start_balance: 0,
        });
        groceries = Fund.create(db, {
            name: "groceries", tracked: true, monthly: true, parent_id: pool.id,
            start_date: D("2026-01-01"), start_balance: 0,
        });
    });

    const transfer = (source, target, amount, date) => TransactionGroup.create_single(db, {
        date: D(date),
        description: "transfer",
        source_fund_id: source.id,
        target_fund_id: target.id,
        amount,
    });

    describe("setting the deprecation date", () => {
        it("rejects deprecating an untracked fund", () => {
            const folder = Fund.create(db, { name: "folder", tracked: false });
            expect(() => folder.update(db, { deprecated: D("2026-01-31") }))
                .to.throw(Error, "untracked");
        });

        it("rejects a date before the fund's start_date", () => {
            expect(() => savings.update(db, { deprecated: D("2025-12-31") }))
                .to.throw(ConflictError, "before its start_date");
        });

        it("rejects a nonzero balance on the deprecation date", () => {
            transfer(pool, savings, 100, "2026-01-05");
            expect(() => savings.update(db, { deprecated: D("2026-01-31") }))
                .to.throw(ConflictError, "not zero");
        });

        it("deprecates on the last active day (transactions ON the date count)", () => {
            transfer(pool, savings, 100, "2026-01-05");
            transfer(savings, pool, 100, "2026-01-20");

            const updated = savings.update(db, { deprecated: D("2026-01-20") });
            expect(updated.deprecated.toString()).to.equal("2026-01-20");
            expect(updated.to_api().deprecated).to.equal("2026-01-20");
            expect(Fund.for_id(db, savings.id).deprecated.toString()).to.equal("2026-01-20");
        });

        it("reports null for active funds", () => {
            expect(savings.deprecated).to.equal(null);
            expect(savings.to_api().deprecated).to.equal(null);
        });

        it("rejects when transactions exist after the date", () => {
            transfer(pool, savings, 100, "2026-01-05");
            transfer(savings, pool, 100, "2026-01-20");
            expect(() => savings.update(db, { deprecated: D("2026-01-10") }))
                .to.throw(ConflictError, "transactions after the deprecation date");
        });

        it("can be cleared to re-activate the fund", () => {
            savings.update(db, { deprecated: D("2026-01-31") });
            const updated = Fund.for_id(db, savings.id).update(db, { deprecated: null });
            expect(updated.deprecated).to.equal(null);
        });
    });

    describe("hierarchy rules", () => {
        it("rejects deprecating before tracked descendants", () => {
            // savings and groceries are still active
            expect(() => pool.update(db, { deprecated: D("2026-03-31") }))
                .to.throw(ConflictError, "before its tracked descendants");
        });

        it("rejects a date before a descendant's deprecation date", () => {
            savings.update(db, { deprecated: D("2026-01-31") });
            groceries.update(db, { deprecated: D("2026-01-31") });
            expect(() => pool.update(db, { deprecated: D("2026-01-15") }))
                .to.throw(ConflictError, "before its tracked descendants");
        });

        it("deprecates once the whole subtree is deprecated at-or-before the date", () => {
            savings.update(db, { deprecated: D("2026-01-31") });
            groceries.update(db, { deprecated: D("2026-01-31") });

            // The pool holds 1000 -- a nonzero balance still blocks it
            expect(() => Fund.for_id(db, pool.id).update(db, { deprecated: D("2026-01-31") }))
                .to.throw(ConflictError, "not zero");

            // Draining it (on the last active day) unblocks deprecation
            const drain = Fund.create(db, {
                name: "drain", tracked: true,
                start_date: D("2026-01-01"), start_balance: 0,
            });
            transfer(pool, drain, 1000, "2026-01-31");
            const updated = Fund.for_id(db, pool.id).update(db, { deprecated: D("2026-01-31") });
            expect(updated.deprecated.toString()).to.equal("2026-01-31");
        });

        it("ignores untracked descendants", () => {
            const parent = Fund.create(db, {
                name: "parent", tracked: true,
                start_date: D("2026-01-01"), start_balance: 0,
            });
            Fund.create(db, { name: "folder", tracked: false, parent_id: parent.id });

            const updated = parent.update(db, { deprecated: D("2026-01-31") });
            expect(updated.deprecated.toString()).to.equal("2026-01-31");
        });

        describe("with a deprecated branch", () => {
            let branch, leaf;
            beforeEach(() => {
                branch = Fund.create(db, {
                    name: "branch", tracked: true,
                    start_date: D("2026-01-01"), start_balance: 0,
                });
                leaf = Fund.create(db, {
                    name: "leaf", tracked: true, parent_id: branch.id,
                    start_date: D("2026-01-01"), start_balance: 0,
                });
                leaf = leaf.update(db, { deprecated: D("2026-01-15") });
                branch = Fund.for_id(db, branch.id).update(db, { deprecated: D("2026-01-31") });
            });

            it("rejects un-deprecating under a deprecated ancestor", () => {
                expect(() => leaf.update(db, { deprecated: null }))
                    .to.throw(ConflictError, "sits under a deprecated fund");
            });

            it("rejects moving a descendant's date past a deprecated ancestor's", () => {
                expect(() => leaf.update(db, { deprecated: D("2026-02-15") }))
                    .to.throw(ConflictError, "sits under a deprecated fund");
            });

            it("rejects reparenting an active fund into the branch", () => {
                expect(() => savings.update(db, { parent_id: branch.id }))
                    .to.throw(ConflictError, "sits under a deprecated fund");
            });

            it("rejects creating a fund anywhere under the branch", () => {
                expect(() => Fund.create(db, { name: "late", tracked: false, parent_id: leaf.id }))
                    .to.throw(ConflictError, "under a deprecated fund");
            });

            it("un-deprecates top-down", () => {
                branch = branch.update(db, { deprecated: null });
                expect(branch.deprecated).to.equal(null);
                leaf = Fund.for_id(db, leaf.id).update(db, { deprecated: null });
                expect(leaf.deprecated).to.equal(null);
            });
        });
    });

    describe("the freeze", () => {
        let inflow; // pool -> savings, before the deprecation date
        beforeEach(() => {
            inflow = transfer(pool, savings, 50, "2026-01-05");
            transfer(savings, pool, 50, "2026-01-20");
            savings = savings.update(db, { deprecated: D("2026-01-31") });
        });

        it("rejects new transactions involving the fund, even before the date", () => {
            expect(() => transfer(pool, savings, 10, "2026-01-10"))
                .to.throw(ConflictError, "target fund is deprecated");
            expect(() => transfer(savings, pool, 10, "2026-01-10"))
                .to.throw(ConflictError, "source fund is deprecated");
        });

        it("rejects repointing an existing transaction at the fund", () => {
            const other = transfer(pool, groceries, 10, "2026-01-10");
            expect(() => other.transactions[0].update(db, { target_fund_id: savings.id }))
                .to.throw(ConflictError, "target fund is deprecated");
        });

        it("rejects editing lines that involve the fund", () => {
            expect(() => inflow.transactions[0].update(db, { amount: 60 }))
                .to.throw(ConflictError, "deprecated");
        });

        it("rejects date moves of groups involving the fund, but allows cosmetic edits", () => {
            expect(() => inflow.update(db, { date: D("2026-01-06") }))
                .to.throw(ConflictError, "deprecated");

            const updated = inflow.update(db, { description: "renamed" });
            expect(updated.description).to.equal("renamed");
        });

        it("rejects deleting groups involving the fund", () => {
            expect(() => inflow.delete(db))
                .to.throw(ConflictError, "involving a deprecated fund");
        });

        it("rejects removing lines that involve the fund", () => {
            expect(() => TransactionGroup.edit_transactions(db, inflow, {
                remove: [ inflow.transactions[0].id ],
                add: [{
                    source_fund_id: pool.id, target_fund_id: groceries.id,
                    amount: 10, description: "replacement",
                }],
            })).to.throw(ConflictError, "involving a deprecated fund");
        });

        it("rejects edits that would break the frozen-at-zero promise", () => {
            // The fund is unfinalized, so the history guard alone would allow
            // this -- the deprecation recheck must catch it
            expect(() => Fund.for_id(db, savings.id).update(db, { start_balance: 100 }))
                .to.throw(ConflictError, "not zero");
        });
    });

    describe("allocations", () => {
        it("rejects allocating to a deprecated fund", () => {
            savings.update(db, { deprecated: D("2026-01-31") });
            expect(() => Allocation.set(db, { month: D("2026-02-01"), fund_id: savings.id, amount: 10 }))
                .to.throw(ConflictError, "deprecated fund");
        });

        it("rejects removing a deprecated fund's allocation", () => {
            Allocation.set(db, { month: D("2026-01-01"), fund_id: groceries.id, amount: 100 });
            transfer(groceries, pool, 100, "2026-01-20");
            groceries.update(db, { deprecated: D("2026-01-31") });

            expect(() => Allocation.remove(db, { month: D("2026-01-01"), fund_id: groceries.id }))
                .to.throw(ConflictError, "deprecated fund");
        });

        it("copy_month silently skips deprecated funds", () => {
            Allocation.set(db, { month: D("2026-01-01"), fund_id: groceries.id, amount: 100 });
            Allocation.set(db, { month: D("2026-01-01"), fund_id: savings.id, amount: 50 });
            transfer(groceries, pool, 100, "2026-01-20");
            groceries.update(db, { deprecated: D("2026-01-31") });

            const copied = Allocation.copy_month(db, { from: D("2026-01-01"), to: D("2026-02-01") });
            expect(copied.map(a => a.fund_id)).to.deep.equal([ savings.id ]);
        });
    });

    describe("finalization", () => {
        it("finalizes the deprecation month, then drops the fund from later months", () => {
            savings.update(db, { deprecated: D("2026-01-31") });

            MonthFinalization.create(db, { month: D("2026-01-15") });
            MonthFinalization.create(db, { month: D("2026-02-15") });

            const history = Fund.for_id(db, savings.id).finalization_history(db);
            expect(history.length).to.equal(1);
            expect(history[0].sonm_date.toString()).to.equal("2026-02-01");

            // Active funds keep finalizing
            expect(Fund.for_id(db, pool.id).finalization_history(db).length).to.equal(2);
        });

        it("skips the eom cleanup for a deprecated monthly fund", () => {
            Allocation.set(db, { month: D("2026-01-01"), fund_id: groceries.id, amount: 100 });
            transfer(groceries, pool, 100, "2026-01-20");
            groceries.update(db, { deprecated: D("2026-01-31") });

            MonthFinalization.create(db, { month: D("2026-01-15") });

            const cleanup_lines = Transaction.from_db(db, { involving_fund_id: groceries.id, limit: null })
                .filter(t => t.eom_cleanup_id != null);
            expect(cleanup_lines.length).to.equal(0);

            // The finalization row itself still exists (settled at zero)
            const history = Fund.for_id(db, groceries.id).finalization_history(db);
            expect(history.length).to.equal(1);
            expect(history[0].eom_balance).to.equal(0);
            expect(history[0].sonm_balance).to.equal(0);
        });

        it("rejects deprecating a monthly fund while earlier months are unfinalized", () => {
            // Its January EOM cleanup does not exist yet: finalizing January
            // later would inject a transaction and un-zero the fund
            expect(() => groceries.update(db, { deprecated: D("2026-02-28") }))
                .to.throw(ConflictError, "every month before its deprecation month is finalized");

            MonthFinalization.create(db, { month: D("2026-01-15") });
            const updated = Fund.for_id(db, groceries.id).update(db, { deprecated: D("2026-02-28") });
            expect(updated.deprecated.toString()).to.equal("2026-02-28");
        });

        it("freezes the deprecation once later months are finalized", () => {
            savings.update(db, { deprecated: D("2026-01-31") });
            MonthFinalization.create(db, { month: D("2026-02-15"), recursive: true });

            expect(() => Fund.for_id(db, savings.id).update(db, { deprecated: null }))
                .to.throw(ConflictError, "unfinalize back before changing its deprecation");
            expect(() => Fund.for_id(db, savings.id).update(db, { deprecated: D("2026-02-28") }))
                .to.throw(ConflictError, "unfinalize back before changing its deprecation");
        });

        it("blocks unfinalizing back into a fund's deprecated range", () => {
            savings.update(db, { deprecated: D("2026-01-31") });
            MonthFinalization.create(db, { month: D("2026-01-15") });
            const feb = MonthFinalization.create(db, { month: D("2026-02-15") });

            // February is after the deprecation date: the fund is absent from
            // it, so reopening it is fine...
            feb.unfinalize(db);

            // ...but January holds the deprecation itself
            const jan = MonthFinalization.latest(db);
            expect(() => jan.unfinalize(db))
                .to.throw(ConflictError, "un-deprecate the fund first");

            // Un-deprecate (now allowed: no finalized month after the date),
            // then the month opens
            Fund.for_id(db, savings.id).update(db, { deprecated: null });
            jan.unfinalize(db);
            expect(MonthFinalization.latest(db)).to.equal(null);
        });
    });

    describe("querying", () => {
        beforeEach(() => {
            savings.update(db, { deprecated: D("2026-01-31") });
        });

        it("filters by deprecated status", () => {
            expect(Fund.from_db(db, { deprecated: true }).map(f => f.name))
                .to.deep.equal([ "savings" ]);
            expect(Fund.from_db(db, { deprecated: false }).map(f => f.name))
                .to.deep.equal([ "pool", "groceries" ]);
            expect(Fund.count(db, { deprecated: true })).to.equal(1);
        });

        it("filters by active_as_of (funds deprecated ON the date were still active)", () => {
            expect(Fund.from_db(db, { active_as_of: D("2026-01-31") }).map(f => f.name))
                .to.deep.equal([ "pool", "savings", "groceries" ]);
            expect(Fund.from_db(db, { active_as_of: D("2026-02-01") }).map(f => f.name))
                .to.deep.equal([ "pool", "groceries" ]);
        });

        it("filters by deprecated_since", () => {
            expect(Fund.from_db(db, { deprecated_since: D("2026-01-01") }).map(f => f.name))
                .to.deep.equal([ "savings" ]);
            expect(Fund.from_db(db, { deprecated_since: D("2026-02-01") })).to.deep.equal([]);
        });
    });
});
