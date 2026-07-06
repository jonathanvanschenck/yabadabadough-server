const { expect } = require("chai");

const {
    create_connection,
    initialize_db,
    ConflictError,
} = require("../../lib/db.js");

const YDate = require("../../lib/YDate.js");
const Fund = require("../../models/Fund.js");
const FundFinalization = require("../../models/FundFinalization.js");
const MonthFinalization = require("../../models/MonthFinalization.js");
const TransactionGroup = require("../../models/TransactionGroup.js");

describe("models/MonthFinalization.js", () => {

    let db;
    let checking, groceries, gas, external;
    beforeEach(() => {
        db = create_connection({ path: ":memory:" });
        initialize_db(db);

        checking = Fund.create(db, {
            name: "Checking",
            tracked: true,
            pool: true,
            start_date: YDate.parse("2026-01-01"),
            start_balance: 1000,
        });
        groceries = Fund.create(db, {
            name: "Groceries",
            tracked: true,
            monthly: true,
            parent_id: checking.id,
            start_date: YDate.parse("2026-01-01"),
            start_balance: 0,
        });
        gas = Fund.create(db, {
            name: "Gas",
            tracked: true,
            monthly: true,
            parent_id: checking.id,
            start_date: YDate.parse("2026-01-01"),
            start_balance: 0,
        });
        external = Fund.create(db, {
            name: "External",
            tracked: false,
        });
    });

    afterEach(() => {
        db.close();
    });

    const transfer = (date, source, target, amount) => {
        return TransactionGroup.create_single(db, {
            date: YDate.parse(date),
            description: "test transfer",
            source_fund_id: source.id,
            target_fund_id: target.id,
            amount,
        });
    };

    describe(".create()", () => {
        it("finalizes a single month", () => {
            transfer("2026-01-05", checking, groceries, 200);
            transfer("2026-01-10", groceries, external, 150);

            const month = MonthFinalization.create(db, {
                month: YDate.parse("2026-01-15"),
            });

            expect(month.som_date.toString()).to.equal("2026-01-01");
            expect(month.eom_date.toString()).to.equal("2026-01-31");
            expect(month.sonm_date.toString()).to.equal("2026-02-01");

            // Fund finalizations: eom excludes cleanups, sonm includes them
            const ffs = FundFinalization.from_db(db, { month_id: month.id });
            expect(ffs).to.have.length(3);

            const by_fund = new Map(ffs.map(ff => [ff.fund_id, ff]));
            expect(by_fund.get(checking.id).eom_balance).to.equal(800);
            expect(by_fund.get(checking.id).sonm_balance).to.equal(850);
            expect(by_fund.get(groceries.id).eom_balance).to.equal(50);
            expect(by_fund.get(groceries.id).sonm_balance).to.equal(0);
            expect(by_fund.get(gas.id).eom_balance).to.equal(0);
            expect(by_fund.get(gas.id).sonm_balance).to.equal(0);

            // Every fund points at its new finalization, and the cache
            // reflects the sonm values
            const reloaded = Fund.for_id(db, checking.id);
            expect(reloaded.finalization_id).to.equal(by_fund.get(checking.id).id);
            expect(reloaded.cached_date.toString()).to.equal("2026-02-01");
            expect(reloaded.cached_balance).to.equal(850);
        });

        it("bundles all cleanups into a single eom_cleanup group (zero amounts included)", () => {
            transfer("2026-01-05", checking, groceries, 200);
            transfer("2026-01-10", groceries, external, 150);

            const month = MonthFinalization.create(db, {
                month: YDate.parse("2026-01-15"),
            });

            const groups = TransactionGroup.from_db(db, { eom_cleanup: true });
            expect(groups).to.have.length(1);

            const group = groups[0];
            expect(group.date.toString()).to.equal("2026-01-31");
            expect(group.eom_cleanup).to.equal(true);
            // One cleanup per monthly fund, even at zero balance
            expect(group.transactions).to.have.length(2);

            const by_source = new Map(group.transactions.map(t => [t.source_fund_id, t]));
            const g_txn = by_source.get(groceries.id);
            expect(g_txn.target_fund_id).to.equal(checking.id);
            expect(g_txn.amount).to.equal(50);
            expect(g_txn.eom_cleanup_id).to.not.equal(null);

            const gas_txn = by_source.get(gas.id);
            expect(gas_txn.target_fund_id).to.equal(checking.id);
            expect(gas_txn.amount).to.equal(0);

            // Backrefs point at this month's fund finalizations
            const ffs = FundFinalization.from_db(db, { month_id: month.id });
            const ff_ids = ffs.map(ff => ff.id);
            expect(ff_ids).to.include(g_txn.eom_cleanup_id);
            expect(ff_ids).to.include(gas_txn.eom_cleanup_id);
        });

        it("handles a monthly deficit (cleanup flows parent -> fund)", () => {
            transfer("2026-01-05", checking, groceries, 200);
            transfer("2026-01-10", groceries, external, 250);

            MonthFinalization.create(db, { month: YDate.parse("2026-01-15") });

            const group = TransactionGroup.from_db(db, { eom_cleanup: true })[0];
            const deficit_txn = group.transactions
                .find(t => t.source_fund_id === checking.id);
            expect(deficit_txn.target_fund_id).to.equal(groceries.id);
            expect(deficit_txn.amount).to.equal(50);

            const reloaded = Fund.for_id(db, groceries.id);
            expect(reloaded.cached_balance).to.equal(0);
        });

        it("does not create a cleanup group when no monthly funds exist", () => {
            db = create_connection({ path: ":memory:" });
            initialize_db(db);
            const solo = Fund.create(db, {
                name: "Solo",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                start_balance: 500,
            });

            MonthFinalization.create(db, { month: YDate.parse("2026-01-15") });

            expect(TransactionGroup.from_db(db, { eom_cleanup: true })).to.have.length(0);

            const reloaded = Fund.for_id(db, solo.id);
            expect(reloaded.cached_balance).to.equal(500);
            expect(reloaded.cached_date.toString()).to.equal("2026-02-01");
        });

        it("nested monthly funds each clean up directly to the pool", () => {
            // budget (monthly, child of checking) <- subbudget (monthly, child of budget)
            const budget = Fund.create(db, {
                name: "Budget",
                tracked: true,
                monthly: true,
                parent_id: checking.id,
                start_date: YDate.parse("2026-01-01"),
                start_balance: 0,
            });
            const subbudget = Fund.create(db, {
                name: "Subbudget",
                tracked: true,
                monthly: true,
                parent_id: budget.id,
                start_date: YDate.parse("2026-01-01"),
                start_balance: 0,
            });

            transfer("2026-01-05", checking, budget, 20);
            transfer("2026-01-05", checking, subbudget, 30);

            const month = MonthFinalization.create(db, {
                month: YDate.parse("2026-01-15"),
            });

            const ffs = FundFinalization.from_db(db, { month_id: month.id });
            const by_fund = new Map(ffs.map(ff => [ff.fund_id, ff]));

            // No relaying: each monthly fund returns exactly its own eom
            // balance straight to the pool (checking), skipping intermediate
            // monthly parents -- and every monthly fund still zeroes out
            expect(by_fund.get(subbudget.id).eom_balance).to.equal(30);
            expect(by_fund.get(subbudget.id).sonm_balance).to.equal(0);
            expect(by_fund.get(budget.id).eom_balance).to.equal(20);
            expect(by_fund.get(budget.id).sonm_balance).to.equal(0);
            expect(by_fund.get(checking.id).eom_balance).to.equal(950);
            expect(by_fund.get(checking.id).sonm_balance).to.equal(1000);

            const group = TransactionGroup.from_db(db, { eom_cleanup: true })[0];
            const budget_txn = group.transactions.find(t => t.source_fund_id === budget.id);
            expect(budget_txn.amount).to.equal(20);
            expect(budget_txn.target_fund_id).to.equal(checking.id);

            const subbudget_txn = group.transactions.find(t => t.source_fund_id === subbudget.id);
            expect(subbudget_txn.amount).to.equal(30);
            expect(subbudget_txn.target_fund_id).to.equal(checking.id);
        });

        it("monthly funds under an untracked organizational fund clean up to the pool", () => {
            // checking (pool) <- category (untracked) <- fun (monthly)
            const category = Fund.create(db, {
                name: "Category",
                tracked: false,
                parent_id: checking.id,
            });
            const fun = Fund.create(db, {
                name: "Fun",
                tracked: true,
                monthly: true,
                parent_id: category.id,
                start_date: YDate.parse("2026-01-01"),
                start_balance: 0,
            });

            transfer("2026-01-05", checking, fun, 75);

            MonthFinalization.create(db, { month: YDate.parse("2026-01-15") });

            const group = TransactionGroup.from_db(db, { eom_cleanup: true })[0];
            const fun_txn = group.transactions.find(t => t.source_fund_id === fun.id);
            expect(fun_txn.amount).to.equal(75);
            expect(fun_txn.target_fund_id).to.equal(checking.id);

            expect(Fund.for_id(db, fun.id).cached_balance).to.equal(0);
            expect(Fund.for_id(db, checking.id).cached_balance).to.equal(1000);
        });

        it("skips tracked funds that have not started yet", () => {
            const late = Fund.create(db, {
                name: "Late",
                tracked: true,
                start_date: YDate.parse("2026-02-10"),
                start_balance: 0,
            });

            const month = MonthFinalization.create(db, {
                month: YDate.parse("2026-01-15"),
            });

            const ffs = FundFinalization.from_db(db, { month_id: month.id });
            expect(ffs.map(ff => ff.fund_id)).to.not.include(late.id);

            const reloaded = Fund.for_id(db, late.id);
            expect(reloaded.finalization_id).to.equal(null);
        });

        it("includes funds started mid-month", () => {
            const mid = Fund.create(db, {
                name: "Mid",
                tracked: true,
                start_date: YDate.parse("2026-01-15"),
                start_balance: 100,
            });
            transfer("2026-01-20", mid, checking, 40);

            const month = MonthFinalization.create(db, {
                month: YDate.parse("2026-01-15"),
            });

            const ff = FundFinalization.from_db(db, { month_id: month.id })
                .find(ff => ff.fund_id === mid.id);
            expect(ff.eom_balance).to.equal(60);
            expect(ff.sonm_balance).to.equal(60);
        });

        it("errors on an already finalized month", () => {
            MonthFinalization.create(db, { month: YDate.parse("2026-01-15") });
            expect(() => MonthFinalization.create(db, { month: YDate.parse("2026-01-20") }))
                .to.throw(ConflictError, "already been finalized");
        });

        it("errors when the previous month is not finalized", () => {
            MonthFinalization.create(db, { month: YDate.parse("2026-01-15") });
            expect(() => MonthFinalization.create(db, { month: YDate.parse("2026-03-15") }))
                .to.throw(ConflictError, "Previous month has not been finalized");
        });

        it("errors when nothing is finalized and the month is not the earliest fund month", () => {
            expect(() => MonthFinalization.create(db, { month: YDate.parse("2026-02-15") }))
                .to.throw(ConflictError, "Previous month has not been finalized");
        });

        it("errors when finalizing before any tracked fund starts", () => {
            expect(() => MonthFinalization.create(db, { month: YDate.parse("2025-12-15") }))
                .to.throw(ConflictError, "before any tracked fund starts");
        });

        it("errors when no tracked funds exist", () => {
            db = create_connection({ path: ":memory:" });
            initialize_db(db);
            expect(() => MonthFinalization.create(db, { month: YDate.parse("2026-01-15") }))
                .to.throw(ConflictError, "before any tracked fund exists");
        });

        it("recursively finalizes intervening months", () => {
            transfer("2026-01-05", checking, groceries, 200);
            transfer("2026-02-05", checking, groceries, 200);
            transfer("2026-02-10", groceries, external, 150);

            const month = MonthFinalization.create(db, {
                month: YDate.parse("2026-03-15"),
                recursive: true,
            });
            expect(month.som_date.toString()).to.equal("2026-03-01");

            const months = MonthFinalization.from_db(db, { order_direction: "ASC" });
            expect(months.map(m => m.som_date.toString())).to.deep.equal([
                "2026-01-01", "2026-02-01", "2026-03-01",
            ]);

            // Each month has its own cleanup group; Jan's groceries cleanup
            // (200) flows back to checking, Feb's is 50
            const groups = TransactionGroup.from_db(db, {
                eom_cleanup: true,
                order_direction: "ASC",
            });
            expect(groups).to.have.length(3);

            // Balances survive the chain: checking ends where it started
            const reloaded = Fund.for_id(db, checking.id);
            expect(reloaded.cached_date.toString()).to.equal("2026-04-01");
            expect(reloaded.cached_balance).to.equal(850);
        });

        it("eom_cleanup groups cannot be deleted directly (only via unfinalize)", () => {
            transfer("2026-01-05", checking, groceries, 200);
            MonthFinalization.create(db, { month: YDate.parse("2026-01-15") });

            // The finalized-month guard inherently covers cleanup groups,
            // which only ever exist inside finalized months
            const group = TransactionGroup.from_db(db, { eom_cleanup: true })[0];
            expect(() => group.delete(db))
                .to.throw(ConflictError, "finalized month");
        });

        it("blocks new transaction groups in finalized months", () => {
            MonthFinalization.create(db, { month: YDate.parse("2026-01-15") });

            expect(() => transfer("2026-01-20", checking, groceries, 10))
                .to.throw(ConflictError, "finalized month");

            // But the month after is fine
            expect(transfer("2026-02-01", checking, groceries, 10)).to.not.be.null;
        });

        it("cached balance calculation matches from-scratch calculation", () => {
            transfer("2026-01-05", checking, groceries, 200);
            transfer("2026-01-10", groceries, external, 150);
            MonthFinalization.create(db, { month: YDate.parse("2026-01-15") });
            transfer("2026-02-05", checking, external, 100);

            // From scratch: 1000 - 200 + 50 (cleanup) - 100 = 750
            const reloaded = Fund.for_id(db, checking.id);
            expect(reloaded.calculate_balance(db)).to.equal(750);
            expect(reloaded.calculate_balance_on(db, YDate.parse("2026-02-28"))).to.equal(750);

            // The pre-finalization balance is still reachable through history
            expect(reloaded.calculate_balance_on(db, YDate.parse("2026-01-30"))).to.equal(800);
        });
    });

    describe(".unfinalize()", () => {
        it("is strictly LIFO", () => {
            const jan = MonthFinalization.create(db, { month: YDate.parse("2026-01-15") });
            MonthFinalization.create(db, { month: YDate.parse("2026-02-15") });

            expect(() => jan.unfinalize(db))
                .to.throw(ConflictError, "Only the most recent finalized month may be unfinalized");
        });

        it("removes the cleanup group and repoints funds at the previous finalization", () => {
            transfer("2026-01-05", checking, groceries, 200);
            transfer("2026-01-10", groceries, external, 150);
            const jan = MonthFinalization.create(db, { month: YDate.parse("2026-01-15") });
            const feb = MonthFinalization.create(db, { month: YDate.parse("2026-02-15") });

            const jan_ffs = FundFinalization.from_db(db, { month_id: jan.id });

            feb.unfinalize(db);

            // Feb's rows and cleanup group are gone
            expect(MonthFinalization.for_month(db, YDate.parse("2026-02-15"))).to.equal(null);
            expect(FundFinalization.from_db(db, { month_id: feb.id })).to.have.length(0);
            expect(TransactionGroup.from_db(db, { eom_cleanup: true })).to.have.length(1);

            // Funds point back at Jan's finalizations
            const reloaded = Fund.for_id(db, checking.id);
            const jan_checking = jan_ffs.find(ff => ff.fund_id === checking.id);
            expect(reloaded.finalization_id).to.equal(jan_checking.id);
            expect(reloaded.cached_date.toString()).to.equal("2026-02-01");
            expect(reloaded.cached_balance).to.equal(850);
        });

        it("fully unfinalizing restores the start-values fallback", () => {
            transfer("2026-01-05", checking, groceries, 200);
            const jan = MonthFinalization.create(db, { month: YDate.parse("2026-01-15") });

            jan.unfinalize(db);

            expect(MonthFinalization.latest(db)).to.equal(null);
            expect(TransactionGroup.from_db(db, { eom_cleanup: true })).to.have.length(0);

            const reloaded = Fund.for_id(db, checking.id);
            expect(reloaded.finalization_id).to.equal(null);
            expect(reloaded.cached_date.toString()).to.equal("2026-01-01");
            expect(reloaded.cached_balance).to.equal(1000);

            // And the month is open for business again
            expect(transfer("2026-01-20", checking, groceries, 10)).to.not.be.null;
        });

        it("unfinalize then re-finalize round-trips", () => {
            transfer("2026-01-05", checking, groceries, 200);
            transfer("2026-01-10", groceries, external, 150);

            const first = MonthFinalization.create(db, { month: YDate.parse("2026-01-15") });
            const first_ffs = FundFinalization.from_db(db, { month_id: first.id });

            first.unfinalize(db);
            const second = MonthFinalization.create(db, { month: YDate.parse("2026-01-15") });
            const second_ffs = FundFinalization.from_db(db, { month_id: second.id });

            expect(second_ffs).to.have.length(first_ffs.length);
            for ( const ff of first_ffs ) {
                const match = second_ffs.find(s => s.fund_id === ff.fund_id);
                expect(match.eom_balance).to.equal(ff.eom_balance);
                expect(match.sonm_balance).to.equal(ff.sonm_balance);
            }
        });
    });

    describe("query methods", () => {
        it(".latest() / .for_month() / .for_id()", () => {
            expect(MonthFinalization.latest(db)).to.equal(null);

            const jan = MonthFinalization.create(db, { month: YDate.parse("2026-01-15") });
            const feb = MonthFinalization.create(db, { month: YDate.parse("2026-02-15") });

            expect(MonthFinalization.latest(db).id).to.equal(feb.id);
            expect(MonthFinalization.for_month(db, YDate.parse("2026-01-20")).id).to.equal(jan.id);
            expect(MonthFinalization.for_id(db, jan.id).som_date.toString()).to.equal("2026-01-01");
        });

        it(".to_api() serializes dates", () => {
            const jan = MonthFinalization.create(db, { month: YDate.parse("2026-01-15") });
            const api = jan.to_api();
            expect(api.som_date).to.equal("2026-01-01");
            expect(api.eom_date).to.equal("2026-01-31");
            expect(api.sonm_date).to.equal("2026-02-01");
        });
    });
});
