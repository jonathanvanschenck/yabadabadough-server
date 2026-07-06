const { expect } = require("chai");

const {
    create_connection,
    initialize_db,
    ConflictError,
    ForeignKeyError,
} = require("../../lib/db.js");

const YDate = require("../../lib/YDate.js");
const Allocation = require("../../models/Allocation.js");
const Fund = require("../../models/Fund.js");
const FundFinalization = require("../../models/FundFinalization.js");
const MonthFinalization = require("../../models/MonthFinalization.js");
const Transaction = require("../../models/Transaction.js");
const TransactionGroup = require("../../models/TransactionGroup.js");

describe("models/Allocation.js", () => {

    let db;
    let checking, groceries, gas, category, fun, savings, external;
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
        // Untracked organizational fund between a budget and the pool
        category = Fund.create(db, {
            name: "Category",
            tracked: false,
            parent_id: checking.id,
        });
        fun = Fund.create(db, {
            name: "Fun",
            tracked: true,
            monthly: true,
            parent_id: category.id,
            start_date: YDate.parse("2026-01-01"),
            start_balance: 0,
        });
        // Progressive-saving target: tracked, NOT monthly
        savings = Fund.create(db, {
            name: "Savings",
            tracked: true,
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

    const JAN = YDate.parse("2026-01-15");
    const FEB = YDate.parse("2026-02-15");

    describe(".set()", () => {
        it("first allocation creates the month's single group, dated som", () => {
            const allocation = Allocation.set(db, {
                month: JAN,
                fund_id: groceries.id,
                amount: 200,
            });

            expect(allocation.fund_id).to.equal(groceries.id);
            expect(allocation.source_fund_id).to.equal(checking.id);
            expect(allocation.amount).to.equal(200);
            expect(allocation.month.toString()).to.equal("2026-01-01");
            expect(allocation.date.toString()).to.equal("2026-01-01");

            const groups = TransactionGroup.from_db(db, { allocation: true });
            expect(groups).to.have.length(1);
            expect(groups[0].id).to.equal(allocation.group_id);
            expect(groups[0].date.toString()).to.equal("2026-01-01");
            expect(groups[0].allocation).to.equal(true);
            expect(groups[0].eom_cleanup).to.equal(false);
            expect(groups[0].split).to.equal(false);
            expect(groups[0].transactions).to.have.length(1);
            expect(groups[0].transactions[0].allocation).to.equal(true);
        });

        it("subsequent allocations land in the same group and flip split", () => {
            const first = Allocation.set(db, { month: JAN, fund_id: groceries.id, amount: 200 });
            const second = Allocation.set(db, { month: JAN, fund_id: gas.id, amount: 50 });

            expect(second.group_id).to.equal(first.group_id);

            const groups = TransactionGroup.from_db(db, { allocation: true });
            expect(groups).to.have.length(1);
            expect(groups[0].split).to.equal(true);
            expect(groups[0].transactions).to.have.length(2);
        });

        it("re-setting a fund's allocation replaces it (no duplicates)", () => {
            Allocation.set(db, { month: JAN, fund_id: groceries.id, amount: 200 });
            Allocation.set(db, { month: JAN, fund_id: gas.id, amount: 50 });
            const updated = Allocation.set(db, { month: JAN, fund_id: groceries.id, amount: 250 });

            expect(updated.amount).to.equal(250);

            const allocations = Allocation.for_month(db, JAN);
            expect(allocations).to.have.length(2);
            const for_groceries = allocations.filter(a => a.fund_id === groceries.id);
            expect(for_groceries).to.have.length(1);
            expect(for_groceries[0].amount).to.equal(250);
        });

        it("allocations move real money immediately", () => {
            Allocation.set(db, { month: JAN, fund_id: groceries.id, amount: 200 });

            expect(Fund.for_id(db, groceries.id).calculate_balance(db)).to.equal(200);
            expect(Fund.for_id(db, checking.id).calculate_balance(db)).to.equal(800);
        });

        it("supports progressive saving into non-monthly funds", () => {
            const allocation = Allocation.set(db, { month: JAN, fund_id: savings.id, amount: 75 });
            expect(allocation.source_fund_id).to.equal(checking.id);
            expect(Fund.for_id(db, savings.id).calculate_balance(db)).to.equal(75);
        });

        it("draws from the nearest pool, skipping organizational funds", () => {
            const allocation = Allocation.set(db, { month: JAN, fund_id: fun.id, amount: 40 });
            expect(allocation.source_fund_id).to.equal(checking.id);
        });

        it("a pool that is a child of a pool can receive allocations", () => {
            const wallet = Fund.create(db, {
                name: "Wallet",
                tracked: true,
                pool: true,
                parent_id: checking.id,
                start_date: YDate.parse("2026-01-01"),
            });

            const allocation = Allocation.set(db, { month: JAN, fund_id: wallet.id, amount: 300 });
            expect(allocation.source_fund_id).to.equal(checking.id);
        });

        it("rejects non-positive amounts", () => {
            expect(() => Allocation.set(db, { month: JAN, fund_id: groceries.id, amount: 0 }))
                .to.throw("Allocation amount must be positive");
            expect(() => Allocation.set(db, { month: JAN, fund_id: groceries.id, amount: -10 }))
                .to.throw("Allocation amount must be positive");
        });

        it("rejects missing funds", () => {
            expect(() => Allocation.set(db, { month: JAN, fund_id: 99999, amount: 10 }))
                .to.throw(ForeignKeyError, "Fund does not exist");
        });

        it("rejects untracked funds", () => {
            expect(() => Allocation.set(db, { month: JAN, fund_id: external.id, amount: 10 }))
                .to.throw(ConflictError, "untracked fund");
        });

        it("rejects funds with no pool ancestor", () => {
            const rootless = Fund.create(db, {
                name: "Rootless",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
            });
            const child = Fund.create(db, {
                name: "Child of rootless",
                tracked: true,
                parent_id: rootless.id,
                start_date: YDate.parse("2026-01-01"),
            });

            expect(() => Allocation.set(db, { month: JAN, fund_id: child.id, amount: 10 }))
                .to.throw(ConflictError, "no pool ancestor");
        });

        it("rejects funds that start mid-month (hard error, by design)", () => {
            const late = Fund.create(db, {
                name: "Late",
                tracked: true,
                parent_id: checking.id,
                start_date: YDate.parse("2026-01-15"),
            });

            // Workarounds: an ordinary transaction group for the partial
            // month, or backdating start_date to the 1st
            expect(() => Allocation.set(db, { month: JAN, fund_id: late.id, amount: 10 }))
                .to.throw(ConflictError, "has not started by the start of the month");

            // The first full month is fine
            const allocation = Allocation.set(db, { month: FEB, fund_id: late.id, amount: 10 });
            expect(allocation.date.toString()).to.equal("2026-02-01");
        });

        it("rejects months before the fund starts", () => {
            const late = Fund.create(db, {
                name: "Late",
                tracked: true,
                parent_id: checking.id,
                start_date: YDate.parse("2026-03-01"),
            });
            expect(() => Allocation.set(db, { month: FEB, fund_id: late.id, amount: 10 }))
                .to.throw(ConflictError, "has not started by the start of the month");
        });

        it("rejects pools that have not started by the month", () => {
            const late_pool = Fund.create(db, {
                name: "Late pool",
                tracked: true,
                pool: true,
                start_date: YDate.parse("2026-02-01"),
            });
            const early_child = Fund.create(db, {
                name: "Early child",
                tracked: true,
                parent_id: late_pool.id,
                start_date: YDate.parse("2026-01-01"),
            });

            expect(() => Allocation.set(db, { month: JAN, fund_id: early_child.id, amount: 10 }))
                .to.throw(ConflictError, "Pool has not started");
        });

        it("rejects finalized months", () => {
            MonthFinalization.create(db, { month: JAN });

            expect(() => Allocation.set(db, { month: JAN, fund_id: groceries.id, amount: 10 }))
                .to.throw(ConflictError, "finalized month");
        });
    });

    describe(".remove()", () => {
        it("removes one allocation and re-syncs split", () => {
            Allocation.set(db, { month: JAN, fund_id: groceries.id, amount: 200 });
            Allocation.set(db, { month: JAN, fund_id: gas.id, amount: 50 });

            Allocation.remove(db, { month: JAN, fund_id: gas.id });

            const allocations = Allocation.for_month(db, JAN);
            expect(allocations).to.have.length(1);
            expect(allocations[0].fund_id).to.equal(groceries.id);

            const group = TransactionGroup.from_db(db, { allocation: true })[0];
            expect(group.split).to.equal(false);
            expect(group.transactions).to.have.length(1);
        });

        it("removing the last allocation deletes the group", () => {
            Allocation.set(db, { month: JAN, fund_id: groceries.id, amount: 200 });
            Allocation.remove(db, { month: JAN, fund_id: groceries.id });

            expect(Allocation.for_month(db, JAN)).to.have.length(0);
            expect(TransactionGroup.from_db(db, { allocation: true })).to.have.length(0);
        });

        it("errors when no allocation exists", () => {
            expect(() => Allocation.remove(db, { month: JAN, fund_id: groceries.id }))
                .to.throw(ConflictError, "No allocation exists");
        });

        it("rejects finalized months", () => {
            Allocation.set(db, { month: JAN, fund_id: groceries.id, amount: 200 });
            MonthFinalization.create(db, { month: JAN });

            expect(() => Allocation.remove(db, { month: JAN, fund_id: groceries.id }))
                .to.throw(ConflictError, "finalized month");
        });
    });

    describe(".for_month() and .for_fund()", () => {
        beforeEach(() => {
            Allocation.set(db, { month: JAN, fund_id: groceries.id, amount: 200 });
            Allocation.set(db, { month: JAN, fund_id: gas.id, amount: 50 });
            Allocation.set(db, { month: FEB, fund_id: groceries.id, amount: 250 });
        });

        it(".for_month() returns only the month's allocations", () => {
            const jan = Allocation.for_month(db, JAN);
            expect(jan).to.have.length(2);
            for ( const allocation of jan ) {
                expect(allocation.month.toString()).to.equal("2026-01-01");
            }

            const feb = Allocation.for_month(db, FEB);
            expect(feb).to.have.length(1);
            expect(feb[0].amount).to.equal(250);

            expect(Allocation.for_month(db, YDate.parse("2026-03-15"))).to.have.length(0);
        });

        it(".for_fund() returns the fund's history, newest first", () => {
            const history = Allocation.for_fund(db, groceries.id);
            expect(history).to.have.length(2);
            expect(history[0].month.toString()).to.equal("2026-02-01");
            expect(history[0].amount).to.equal(250);
            expect(history[1].month.toString()).to.equal("2026-01-01");
            expect(history[1].amount).to.equal(200);
        });

        it(".for_fund() respects since/until", () => {
            const history = Allocation.for_fund(db, groceries.id, {
                until: YDate.parse("2026-01-31"),
            });
            expect(history).to.have.length(1);
            expect(history[0].amount).to.equal(200);
        });

        it("allocation transactions are directly queryable", () => {
            const transactions = Transaction.from_db(db, {
                allocation: true,
                target_fund_id: groceries.id,
            });
            expect(transactions).to.have.length(2);
            for ( const txn of transactions ) {
                expect(txn.allocation).to.equal(true);
            }
        });
    });

    describe(".copy_month()", () => {
        beforeEach(() => {
            Allocation.set(db, { month: JAN, fund_id: groceries.id, amount: 200 });
            Allocation.set(db, { month: JAN, fund_id: gas.id, amount: 50 });
        });

        it("copies all allocations into the target month", () => {
            const copied = Allocation.copy_month(db, { from: JAN, to: FEB });

            expect(copied).to.have.length(2);
            const by_fund = new Map(copied.map(a => [a.fund_id, a]));
            expect(by_fund.get(groceries.id).amount).to.equal(200);
            expect(by_fund.get(gas.id).amount).to.equal(50);
            for ( const allocation of copied ) {
                expect(allocation.date.toString()).to.equal("2026-02-01");
                expect(allocation.source_fund_id).to.equal(checking.id);
            }

            // Jan is untouched
            expect(Allocation.for_month(db, JAN)).to.have.length(2);
        });

        it("on_conflict=error throws and copies nothing", () => {
            Allocation.set(db, { month: FEB, fund_id: groceries.id, amount: 999 });

            expect(() => Allocation.copy_month(db, { from: JAN, to: FEB }))
                .to.throw(ConflictError, "Groceries");

            // Atomic: nothing else was copied either
            const feb = Allocation.for_month(db, FEB);
            expect(feb).to.have.length(1);
            expect(feb[0].fund_id).to.equal(groceries.id);
            expect(feb[0].amount).to.equal(999);
        });

        it("on_conflict=merge keeps the destination's existing allocations", () => {
            Allocation.set(db, { month: FEB, fund_id: groceries.id, amount: 999 });

            const result = Allocation.copy_month(db, { from: JAN, to: FEB, on_conflict: "merge" });

            const by_fund = new Map(result.map(a => [a.fund_id, a]));
            expect(by_fund.get(groceries.id).amount).to.equal(999); // kept
            expect(by_fund.get(gas.id).amount).to.equal(50);        // copied
        });

        it("on_conflict=overwrite replaces conflicting allocations", () => {
            Allocation.set(db, { month: FEB, fund_id: groceries.id, amount: 999 });

            const result = Allocation.copy_month(db, { from: JAN, to: FEB, on_conflict: "overwrite" });

            const by_fund = new Map(result.map(a => [a.fund_id, a]));
            expect(by_fund.get(groceries.id).amount).to.equal(200); // overwritten
            expect(by_fund.get(gas.id).amount).to.equal(50);        // copied
        });

        it("destination allocations for funds not in the source month survive every mode", () => {
            Allocation.set(db, { month: FEB, fund_id: savings.id, amount: 10 });

            const result = Allocation.copy_month(db, { from: JAN, to: FEB, on_conflict: "overwrite" });

            expect(result).to.have.length(3);
            const by_fund = new Map(result.map(a => [a.fund_id, a]));
            expect(by_fund.get(savings.id).amount).to.equal(10);
        });

        it("rejects unsupported on_conflict modes and self-copies", () => {
            expect(() => Allocation.copy_month(db, { from: JAN, to: FEB, on_conflict: "clobber" }))
                .to.throw("Unsupported on_conflict mode");
            expect(() => Allocation.copy_month(db, { from: JAN, to: YDate.parse("2026-01-20") }))
                .to.throw("Cannot copy a month onto itself");
        });

        it("rejects finalized destination months", () => {
            // Feb has allocations while Jan gets finalized; copying Feb back
            // into (finalized) Jan must fail
            Allocation.copy_month(db, { from: JAN, to: FEB });
            MonthFinalization.create(db, { month: JAN });

            expect(() => Allocation.copy_month(db, { from: FEB, to: JAN }))
                .to.throw(ConflictError, "finalized month");
        });
    });

    describe("derived sources", () => {
        it("re-parenting under a different pool repoints unfinalized allocations", () => {
            Allocation.set(db, { month: JAN, fund_id: savings.id, amount: 75 });

            const wallet = Fund.create(db, {
                name: "Wallet",
                tracked: true,
                pool: true,
                parent_id: checking.id,
                start_date: YDate.parse("2026-01-01"),
            });
            Fund.for_id(db, savings.id).update(db, { parent_id: wallet.id });

            const allocation = Allocation.for_month(db, JAN)
                .find(a => a.fund_id === savings.id);
            expect(allocation.source_fund_id).to.equal(wallet.id);
        });

        it("changes that would orphan an allocation are rejected", () => {
            const pool2 = Fund.create(db, {
                name: "Pool2",
                tracked: true,
                pool: true,
                start_date: YDate.parse("2026-01-01"),
            });
            const fund2 = Fund.create(db, {
                name: "Fund2",
                tracked: true,
                parent_id: pool2.id,
                start_date: YDate.parse("2026-01-01"),
            });
            Allocation.set(db, { month: JAN, fund_id: fund2.id, amount: 25 });

            // No monthly funds depend on pool2, but fund2's allocation does
            expect(() => Fund.for_id(db, pool2.id).update(db, { pool: false }))
                .to.throw(ConflictError, "would orphan an allocation");
            expect(Allocation.for_month(db, JAN)
                .find(a => a.fund_id === fund2.id).source_fund_id).to.equal(pool2.id);
        });

        it("finalized allocations keep their historical routing", () => {
            const pool2 = Fund.create(db, {
                name: "Pool2",
                tracked: true,
                pool: true,
                start_date: YDate.parse("2026-01-01"),
            });
            const fund2 = Fund.create(db, {
                name: "Fund2",
                tracked: true,
                parent_id: pool2.id,
                start_date: YDate.parse("2026-01-01"),
            });
            Allocation.set(db, { month: JAN, fund_id: fund2.id, amount: 25 });
            Allocation.set(db, { month: FEB, fund_id: fund2.id, amount: 30 });

            MonthFinalization.create(db, { month: JAN });

            // Re-parenting fund2 (no monthly descendants) is allowed while
            // finalized; only the UNFINALIZED allocation is repointed
            Fund.for_id(db, fund2.id).update(db, { parent_id: checking.id });

            const jan = Allocation.for_month(db, JAN).find(a => a.fund_id === fund2.id);
            const feb = Allocation.for_month(db, FEB).find(a => a.fund_id === fund2.id);
            expect(jan.source_fund_id).to.equal(pool2.id);   // immutable history
            expect(feb.source_fund_id).to.equal(checking.id); // re-derived
        });
    });

    describe("finalization integration", () => {
        it("allocations participate in eom balances and the monthly surplus math", () => {
            Allocation.set(db, { month: JAN, fund_id: groceries.id, amount: 200 });
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-01-10"),
                description: "spending",
                source_fund_id: groceries.id,
                target_fund_id: external.id,
                amount: 150,
            });
            // A future-month allocation, dated sonm: must NOT count in Jan
            Allocation.set(db, { month: FEB, fund_id: groceries.id, amount: 300 });

            const month = MonthFinalization.create(db, { month: JAN });

            const ffs = FundFinalization.from_db(db, { month_id: month.id });
            const by_fund = new Map(ffs.map(ff => [ff.fund_id, ff]));

            // Groceries: 200 allocated in, 150 spent -> 50 surplus, zeroed out
            expect(by_fund.get(groceries.id).eom_balance).to.equal(50);
            expect(by_fund.get(groceries.id).sonm_balance).to.equal(0);

            // Checking: 1000 - 200 out, + 50 surplus back; Feb's 300 excluded
            // from the forward balance entering 2026-02-01
            expect(by_fund.get(checking.id).eom_balance).to.equal(800);
            expect(by_fund.get(checking.id).sonm_balance).to.equal(850);

            // On Feb 1st the new allocation kicks in
            expect(Fund.for_id(db, groceries.id)
                .calculate_balance_on(db, YDate.parse("2026-02-01"))).to.equal(300);
            expect(Fund.for_id(db, checking.id).calculate_balance(db)).to.equal(550);
        });

        it("a finalized month's allocations are immutable", () => {
            Allocation.set(db, { month: JAN, fund_id: groceries.id, amount: 200 });
            Allocation.set(db, { month: FEB, fund_id: groceries.id, amount: 300 });
            MonthFinalization.create(db, { month: JAN });

            expect(() => Allocation.set(db, { month: JAN, fund_id: gas.id, amount: 10 }))
                .to.throw(ConflictError, "finalized month");
            expect(() => Allocation.remove(db, { month: JAN, fund_id: groceries.id }))
                .to.throw(ConflictError, "finalized month");
            expect(() => Allocation.copy_month(db, { from: FEB, to: JAN, on_conflict: "overwrite" }))
                .to.throw(ConflictError, "finalized month");

            expect(Allocation.for_month(db, JAN)).to.have.length(1);
        });

        it("unfinalizing reopens the month's allocations", () => {
            Allocation.set(db, { month: JAN, fund_id: groceries.id, amount: 200 });
            const month = MonthFinalization.create(db, { month: JAN });

            month.unfinalize(db);

            const updated = Allocation.set(db, { month: JAN, fund_id: groceries.id, amount: 250 });
            expect(updated.amount).to.equal(250);
        });
    });

    describe(".create()", () => {
        it("cannot be created directly", () => {
            expect(() => Allocation.create(db, {}))
                .to.throw("You cannot directly create an allocation");
        });
    });
});
