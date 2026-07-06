const { expect } = require("chai");

const {
    create_connection,
    initialize_db,
    ConflictError,
    ForeignKeyError,
} = require("../../lib/db.js");

const YDate = require("../../lib/YDate.js");
const Fund = require("../../models/Fund.js");
const FundFinalization = require("../../models/FundFinalization.js");
const MonthFinalization = require("../../models/MonthFinalization.js");
const TransactionGroup = require("../../models/TransactionGroup.js");

describe("models/Fund.js", () => {

    let db;
    beforeEach(() => {
        db = create_connection({ path: ":memory:" });
        initialize_db(db)
    });

    describe(".create()", () => {
        it("can create untracked", () => {
            const fund = Fund.create(db, {
                name: "test",
                tracked: false,
            });

            expect(fund.name).to.equal("test");
            expect(fund.tracked).to.equal(false);
            expect(fund.start_date).to.equal(null);
            expect(fund.start_balance).to.equal(null);
            expect(fund.monthly).to.equal(false);
        });

        it("can create tracked non-monthly", () => {
            const fund = Fund.create(db, {
                name: "test",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
            });

            expect(fund.name).to.equal("test");
            expect(fund.tracked).to.equal(true);
            expect(fund.start_date).to.not.equal(null);
            expect(fund.start_date.toString()).to.equal("2026-01-01");
            expect(fund.start_balance).to.equal(0);
            expect(fund.monthly).to.equal(false);
        });

        it("can create with parent", () => {
            const pfund = Fund.create(db, {
                name: "parent",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                monthly: false,
            });

            const fund = Fund.create(db, {
                name: "test",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                parent_id: pfund.id
            });

            expect(fund.name).to.equal("test");
            expect(fund.tracked).to.equal(true);
            expect(fund.start_date).to.not.equal(null);
            expect(fund.start_date.toString()).to.equal("2026-01-01");
            expect(fund.start_balance).to.equal(0);
            expect(fund.monthly).to.equal(false);
            expect(fund.parent_id).to.equal(pfund.id);
        });


        it("can create tracked monthly", () => {
            const pfund = Fund.create(db, {
                name: "parent",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
            });
            const fund = Fund.create(db, {
                name: "test",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                monthly: true,
                parent_id: pfund.id
            });

            expect(fund.name).to.equal("test");
            expect(fund.tracked).to.equal(true);
            expect(fund.start_date).to.not.equal(null);
            expect(fund.start_date.toString()).to.equal("2026-01-01");
            expect(fund.start_balance).to.equal(0);
            expect(fund.monthly).to.equal(true);
            expect(fund.parent_id).to.equal(pfund.id);
        });

        it("can create with initial balance", () => {
            const fund = Fund.create(db, {
                name: "test",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                start_balance: 100,
            });

            expect(fund.name).to.equal("test");
            expect(fund.tracked).to.equal(true);
            expect(fund.start_date).to.not.equal(null);
            expect(fund.start_date.toString()).to.equal("2026-01-01");
            expect(fund.start_balance).to.equal(100);
            expect(fund.monthly).to.equal(false);
        });

        it("untracked rejects balance and date", () => {
            const fund = Fund.create(db, {
                name: "test",
                tracked: false,
                start_date: YDate.parse("2026-01-01"), // ignored
                start_balance: 100, // ignored
            });

            expect(fund.name).to.equal("test");
            expect(fund.tracked).to.equal(false);
            expect(fund.start_date).to.equal(null);
            expect(fund.start_balance).to.equal(null);
            expect(fund.monthly).to.equal(false);
        });


        it("Consistency: tracked requires a start date", () => {
            expect(() => Fund.create(db, {
                name: "test",
                tracked: true,
                start_date: null, // Error!
            })).to.throw("Cannot set tracked without also providing start_date")
        });

        it("Consistency: tracked requires a start balance", () => {
            expect(() => Fund.create(db, {
                name: "test",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                start_balance: null,
            })).to.throw("Cannot set tracked without also providing (non-null) start_balance")
        });

        it("Consistency: monthly requires a parent", () => {
            expect(() => Fund.create(db, {
                name: "test",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                monthly: true,
                parent_id: null, // Error!
            })).to.throw("Cannot create a monthly fund without a parent")
        });

        it("Consistency: monthly requires tracking", () => {
            const pfund = Fund.create(db, {
                name: "parent",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                monthly: false,
            });
            expect(() => Fund.create(db, {
                name: "test",
                tracked: false, // Error!
                monthly: true,
                parent_id: pfund.id
            })).to.throw("Cannot create a monthly fund unless it is also tracked")
        });

        it("Conflict: repeated name", () => {
            const pfund = Fund.create(db, {
                name: "test",
                tracked: false,
            });
            expect(() => Fund.create(db, {
                name: "test", // Error
                tracked: false,
            })).to.throw(ConflictError, "Name already exists")
        });

        it("ForeignKeyError: bad parent id", () => {
            expect(() => Fund.create(db, {
                name: "test",
                tracked: false,
                parent_id: 10 // Error
            })).to.throw(ForeignKeyError, "Parent fund does not exist")
        });

    });


    describe("cache fallback", () => {
        it("never-finalized tracked fund falls back to start values", () => {
            const fund = Fund.create(db, {
                name: "test",
                tracked: true,
                start_date: YDate.parse("2026-01-15"),
                start_balance: 100,
            });

            expect(fund.finalization_id).to.equal(null);
            expect(fund.cached_balance).to.equal(100);
            // Backdated to the first of the month
            expect(fund.cached_date.toString()).to.equal("2026-01-01");
        });

        it("untracked fund has null cache", () => {
            const fund = Fund.create(db, {
                name: "test",
                tracked: false,
            });

            expect(fund.cached_balance).to.equal(null);
            expect(fund.cached_date).to.equal(null);
        });

        it("to_api exposes { date, forward_balance } pairs", () => {
            const fund = Fund.create(db, {
                name: "test",
                tracked: true,
                start_date: YDate.parse("2026-01-15"),
                start_balance: 100,
            });

            const api = fund.to_api();
            expect(api.start).to.deep.equal({
                date: "2026-01-15",
                forward_balance: 100,
            });
            expect(api.cache).to.deep.equal({
                date: "2026-01-01",
                forward_balance: 100,
            });
            expect(api).to.not.have.property("balance");
        });

        it("to_api exposes null start/cache for untracked funds", () => {
            const fund = Fund.create(db, {
                name: "test",
                tracked: false,
            });

            const api = fund.to_api();
            expect(api.start).to.equal(null);
            expect(api.cache).to.equal(null);
        });
    });

    describe("balance calculation", () => {
        let fund, other;
        beforeEach(() => {
            fund = Fund.create(db, {
                name: "test",
                tracked: true,
                start_date: YDate.parse("2026-01-15"),
                start_balance: 100,
            });
            other = Fund.create(db, {
                name: "other",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                start_balance: 0,
            });

            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-01-15"),
                description: "on start date",
                source_fund_id: other.id,
                target_fund_id: fund.id,
                amount: 10,
            });
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-01-20"),
                description: "mid month",
                source_fund_id: fund.id,
                target_fund_id: other.id,
                amount: 25,
            });
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-02-03"),
                description: "next month",
                source_fund_id: other.id,
                target_fund_id: fund.id,
                amount: 5,
            });
        });

        it(".calculate_balance_on() includes transactions on the date", () => {
            expect(fund.calculate_balance_on(db, YDate.parse("2026-01-15"))).to.equal(110);
            expect(fund.calculate_balance_on(db, YDate.parse("2026-01-19"))).to.equal(110);
            expect(fund.calculate_balance_on(db, YDate.parse("2026-01-20"))).to.equal(85);
            expect(fund.calculate_balance_on(db, YDate.parse("2026-01-31"))).to.equal(85);
            expect(fund.calculate_balance_on(db, YDate.parse("2026-02-03"))).to.equal(90);
        });

        it(".calculate_balance_on() errors before start_date", () => {
            expect(() => fund.calculate_balance_on(db, YDate.parse("2026-01-14")))
                .to.throw("Cannot calculate a balance before the fund's start_date");
        });

        it(".calculate_balance_on() returns 0 for untracked funds", () => {
            const untracked = Fund.create(db, { name: "untracked", tracked: false });
            expect(untracked.calculate_balance_on(db, YDate.parse("2026-01-15"))).to.equal(0);
        });

        it(".calculate_balance() returns the current balance", () => {
            expect(fund.calculate_balance(db)).to.equal(90);
            expect(other.calculate_balance(db)).to.equal(10);
        });

        it(".cached_forward_balance_before() falls back to backdated start values", () => {
            const cache = fund.cached_forward_balance_before(db, YDate.parse("2026-03-01"));
            expect(cache.date.toString()).to.equal("2026-01-01");
            expect(cache.forward_balance).to.equal(100);
        });

        it(".cached_forward_balance_before() returns null for untracked funds", () => {
            const untracked = Fund.create(db, { name: "untracked", tracked: false });
            expect(untracked.cached_forward_balance_before(db, YDate.parse("2026-03-01"))).to.equal(null);
        });
    });

    describe("creation backfill", () => {
        let checking;
        beforeEach(() => {
            checking = Fund.create(db, {
                name: "Checking",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                start_balance: 1000,
            });
            MonthFinalization.create(db, { month: YDate.parse("2026-01-15") });
            MonthFinalization.create(db, { month: YDate.parse("2026-02-15") });
        });

        it("backfills finalizations for backdated tracked funds", () => {
            const fund = Fund.create(db, {
                name: "Backdated",
                tracked: true,
                start_date: YDate.parse("2026-01-10"),
                start_balance: 250,
            });

            const history = fund.finalization_history(db, { order_direction: "ASC" });
            expect(history).to.have.length(2);
            expect(history[0].sonm_date.toString()).to.equal("2026-02-01");
            expect(history[1].sonm_date.toString()).to.equal("2026-03-01");
            for ( const ff of history ) {
                expect(ff.eom_balance).to.equal(250);
                expect(ff.sonm_balance).to.equal(250);
            }

            // The fund points at the latest backfilled finalization
            expect(fund.finalization_id).to.equal(history[1].id);
            expect(fund.cached_date.toString()).to.equal("2026-03-01");
            expect(fund.cached_balance).to.equal(250);
        });

        it("only backfills months at-or-after the fund's start month", () => {
            const fund = Fund.create(db, {
                name: "Backdated",
                tracked: true,
                start_date: YDate.parse("2026-02-10"),
                start_balance: 250,
            });

            const history = fund.finalization_history(db);
            expect(history).to.have.length(1);
            expect(history[0].sonm_date.toString()).to.equal("2026-03-01");
        });

        it("does not backfill funds starting after the latest finalized month", () => {
            const fund = Fund.create(db, {
                name: "Future",
                tracked: true,
                start_date: YDate.parse("2026-03-10"),
                start_balance: 250,
            });

            expect(fund.finalization_history(db)).to.have.length(0);
            expect(fund.finalization_id).to.equal(null);
        });

        it("requires backdated monthly funds to start at 0", () => {
            expect(() => Fund.create(db, {
                name: "Backdated monthly",
                tracked: true,
                monthly: true,
                parent_id: checking.id,
                start_date: YDate.parse("2026-01-10"),
                start_balance: 100, // Error!
            })).to.throw(ConflictError, "must have a start_balance of 0");

            const fund = Fund.create(db, {
                name: "Backdated monthly",
                tracked: true,
                monthly: true,
                parent_id: checking.id,
                start_date: YDate.parse("2026-01-10"),
                start_balance: 0,
            });
            expect(fund.finalization_history(db)).to.have.length(2);
        });
    });

    describe(".update() and the history guard", () => {
        let fund;
        beforeEach(() => {
            fund = Fund.create(db, {
                name: "test",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                start_balance: 100,
            });
        });

        it("updates safe fields (name, color) freely", () => {
            MonthFinalization.create(db, { month: YDate.parse("2026-01-15") });

            const updated = Fund.for_id(db, fund.id).update(db, {
                name: "renamed",
                color: "#ff0000",
            });
            expect(updated.name).to.equal("renamed");
            expect(updated.color).to.equal("#ff0000");
        });

        it("rejects history-affecting changes on finalized funds", () => {
            MonthFinalization.create(db, { month: YDate.parse("2026-01-15") });
            const reloaded = Fund.for_id(db, fund.id);

            expect(() => reloaded.update(db, { start_balance: 200 }))
                .to.throw(ConflictError, "unfinalize back to the fund's start");
            expect(() => reloaded.update(db, { start_date: YDate.parse("2026-01-02") }))
                .to.throw(ConflictError, "unfinalize back to the fund's start");
            expect(() => reloaded.update(db, { tracked: false }))
                .to.throw(ConflictError, "unfinalize back to the fund's start");
        });

        it("rejects monthly conversion on finalized funds, allows it after unfinalizing", () => {
            const parent = Fund.create(db, {
                name: "parent",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                start_balance: 0,
            });
            const month = MonthFinalization.create(db, { month: YDate.parse("2026-01-15") });
            const reloaded = Fund.for_id(db, fund.id);

            expect(() => reloaded.update(db, { monthly: true, parent_id: parent.id }))
                .to.throw(ConflictError, "unfinalize back to the fund's start");

            month.unfinalize(db);
            const updated = Fund.for_id(db, fund.id)
                .update(db, { monthly: true, parent_id: parent.id });
            expect(updated.monthly).to.equal(true);
        });

        it("allows history changes on never-finalized funds", () => {
            const updated = fund.update(db, { start_balance: 500 });
            expect(updated.start_balance).to.equal(500);
            expect(updated.cached_balance).to.equal(500);
        });

        it("untracking clears start values", () => {
            const updated = fund.update(db, { tracked: false });
            expect(updated.tracked).to.equal(false);
            expect(updated.start_date).to.equal(null);
            expect(updated.start_balance).to.equal(null);
        });

        it("rejects moving start_date past existing transactions", () => {
            const other = Fund.create(db, {
                name: "other",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                start_balance: 0,
            });
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-01-10"),
                description: "early",
                source_fund_id: fund.id,
                target_fund_id: other.id,
                amount: 10,
            });

            expect(() => fund.update(db, { start_date: YDate.parse("2026-01-11") }))
                .to.throw(ConflictError, "Cannot move start_date past existing transactions");
        });

        it("rejects renaming to an existing name", () => {
            Fund.create(db, { name: "taken", tracked: false });
            expect(() => fund.update(db, { name: "taken" }))
                .to.throw(ConflictError, "Name already exists");
        });
    });

    describe(".delete()", () => {
        it("deletes an unfinalized fund", () => {
            const fund = Fund.create(db, { name: "test", tracked: false });
            fund.delete(db);
            expect(Fund.for_id(db, fund.id)).to.equal(null);
        });

        it("rejects deleting a finalized fund", () => {
            const fund = Fund.create(db, {
                name: "test",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                start_balance: 100,
            });
            MonthFinalization.create(db, { month: YDate.parse("2026-01-15") });

            expect(() => Fund.for_id(db, fund.id).delete(db))
                .to.throw(ConflictError, "unfinalize back to the fund's start");
        });
    });

    describe(".from_db()", () => {
        beforeEach(() => {
            Fund.create(db, { // id = 1
                name: "fund1",
                tracked: false
            });
            Fund.create(db, { // id = 2
                name: "child1",
                tracked: false,
                parent_id: 1,
            });
            Fund.create(db, { // id = 3
                name: "fund2",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
            });
            Fund.create(db, { // id = 4
                name: "fund3",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
            });
            Fund.create(db, { // id = 5
                name: "child2",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                parent_id: 4
            });
            Fund.create(db, { // id = 6
                name: "child3",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                parent_id: 4
            });
            Fund.create(db, { // id = 7
                name: "grandchild1",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                parent_id: 6
            });
        });


        it("Can get all", () => {
            const results = Fund.from_db(db, {});
            expect(results).to.have.length(7);
        })
        it("Can get by name", () => {
            const results = Fund.from_db(db, { name:"child2" });
            expect(results).to.have.length(1);
            expect(results[0].name).to.equal("child2");
        })
        it("Can get by names like", () => {
            const results = Fund.from_db(db, { name_like:"hild" });
            expect(results).to.have.length(4);
        })
        it("Can get by tracked", () => {
            const results = Fund.from_db(db, { tracked:true });
            expect(results).to.have.length(5);
        })
        it("Can get by roots", () => {
            const results = Fund.from_db(db, { root:true });
            expect(results).to.have.length(3);
        })

    });

});
