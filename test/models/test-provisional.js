const { expect } = require("chai");

const {
    create_connection,
    initialize_db,
} = require("../../lib/db.js");

const YDate = require("../../lib/YDate.js");
const Fund = require("../../models/Fund.js");
const MonthFinalization = require("../../models/MonthFinalization.js");

const {
    first_unfinalized_som,
    provisional_frontier,
    balance_on_is_provisional,
    forward_balance_is_provisional,
} = require("../../lib/provisional.mjs");

const D = (s) => YDate.parse(s);

// The "dubious balance" rule: a balance is PROVISIONAL when an earlier month
// is still unfinalized, because finalizing it writes eom_cleanup transactions
// dated that month's last day. See lib/provisional.mjs.
describe("provisional balances", () => {

    // ------------------------------------------------------------------
    // The pure predicates (lib/provisional.mjs) -- shared verbatim with the
    // webapp, so they are pinned independently of the db
    // ------------------------------------------------------------------
    describe("lib/provisional.mjs", () => {

        describe("first_unfinalized_som", () => {
            it("follows the latest finalization", () => {
                expect(first_unfinalized_som({
                    latest_sonm_date: "2026-03-01",
                    earliest_tracked_start: "2026-01-15",
                })).to.equal("2026-03-01");
            });

            it("falls back to the earliest tracked start's MONTH", () => {
                expect(first_unfinalized_som({
                    latest_sonm_date: null,
                    earliest_tracked_start: "2026-01-15",
                })).to.equal("2026-01-01");
            });

            it("is null with no finalization and no tracked fund", () => {
                expect(first_unfinalized_som({})).to.equal(null);
            });
        });

        describe("provisional_frontier", () => {
            it("is the eom of the first unfinalized month", () => {
                expect(provisional_frontier({
                    latest_sonm_date: "2026-03-01",
                    has_monthly_fund: true,
                })).to.equal("2026-03-31");
            });

            it("handles short and leap-year months", () => {
                expect(provisional_frontier({
                    latest_sonm_date: "2026-04-01", has_monthly_fund: true,
                })).to.equal("2026-04-30");
                expect(provisional_frontier({
                    latest_sonm_date: "2027-02-01", has_monthly_fund: true,
                })).to.equal("2027-02-28");
                expect(provisional_frontier({
                    latest_sonm_date: "2028-02-01", has_monthly_fund: true,
                })).to.equal("2028-02-29");
            });

            it("is null without a monthly fund (no cleanup can ever be written)", () => {
                expect(provisional_frontier({
                    latest_sonm_date: "2026-03-01",
                    has_monthly_fund: false,
                })).to.equal(null);
            });

            it("is null with nothing to finalize", () => {
                expect(provisional_frontier({ has_monthly_fund: true })).to.equal(null);
            });
        });

        // The off-by-one that motivates two predicates rather than one: the
        // cleanup lands ON the frontier day, so a balance *on* that day is
        // already provisional while the balance *entering* it is not
        describe("the frontier-day boundary", () => {
            const frontier = "2026-03-31";

            it("balance ON the frontier day is provisional", () => {
                expect(balance_on_is_provisional(frontier, "2026-03-31")).to.equal(true);
            });

            it("forward balance ENTERING the frontier day is not", () => {
                expect(forward_balance_is_provisional(frontier, "2026-03-31")).to.equal(false);
            });

            it("both are provisional after the frontier day", () => {
                expect(balance_on_is_provisional(frontier, "2026-04-01")).to.equal(true);
                expect(forward_balance_is_provisional(frontier, "2026-04-01")).to.equal(true);
            });

            it("neither is provisional before the frontier day", () => {
                expect(balance_on_is_provisional(frontier, "2026-03-30")).to.equal(false);
                expect(forward_balance_is_provisional(frontier, "2026-03-30")).to.equal(false);
            });

            it("a null date means 'now', which is after every pending cleanup", () => {
                expect(balance_on_is_provisional(frontier, null)).to.equal(true);
                expect(forward_balance_is_provisional(frontier, null)).to.equal(true);
            });

            it("a null frontier is never provisional, whatever the date", () => {
                expect(balance_on_is_provisional(null, "2099-12-31")).to.equal(false);
                expect(forward_balance_is_provisional(null, null)).to.equal(false);
            });
        });
    });

    // ------------------------------------------------------------------
    // The db-backed frontier
    // ------------------------------------------------------------------
    describe("MonthFinalization.provisional_frontier", () => {

        let db, pool;
        beforeEach(() => {
            db = create_connection({ path: ":memory:" });
            initialize_db(db);

            pool = Fund.create(db, {
                name: "pool", tracked: true, pool: true,
                start_date: D("2026-01-01"), start_balance: 1000,
            });
        });

        const add_monthly = () => Fund.create(db, {
            name: "groceries", tracked: true, monthly: true, parent_id: pool.id,
            start_date: D("2026-01-01"), start_balance: 0,
        });

        it("is null while no monthly fund exists", () => {
            expect(MonthFinalization.provisional_frontier(db)).to.equal(null);

            // ...even with plain tracked funds and no finalizations at all
            Fund.create(db, {
                name: "savings", tracked: true, parent_id: pool.id,
                start_date: D("2026-01-01"), start_balance: 0,
            });
            expect(MonthFinalization.provisional_frontier(db)).to.equal(null);
        });

        it("opens at the earliest tracked start's month when nothing is finalized", () => {
            add_monthly();
            expect(MonthFinalization.provisional_frontier(db)).to.equal("2026-01-31");
        });

        it("advances one month per finalization", () => {
            add_monthly();

            MonthFinalization.create(db, { month: D("2026-01-15") });
            expect(MonthFinalization.provisional_frontier(db)).to.equal("2026-02-28");

            MonthFinalization.create(db, { month: D("2026-02-15") });
            expect(MonthFinalization.provisional_frontier(db)).to.equal("2026-03-31");
        });

        it("retreats when a month is unfinalized", () => {
            add_monthly();
            const jan = MonthFinalization.create(db, { month: D("2026-01-15") });
            expect(MonthFinalization.provisional_frontier(db)).to.equal("2026-02-28");

            jan.unfinalize(db);
            expect(MonthFinalization.provisional_frontier(db)).to.equal("2026-01-31");
        });

        it("appears the moment the first monthly fund is created", () => {
            MonthFinalization.create(db, { month: D("2026-01-15") });
            expect(MonthFinalization.provisional_frontier(db)).to.equal(null);

            Fund.create(db, {
                name: "groceries", tracked: true, monthly: true, parent_id: pool.id,
                start_date: D("2026-02-01"), start_balance: 0,
            });
            expect(MonthFinalization.provisional_frontier(db)).to.equal("2026-02-28");
        });
    });

    // ------------------------------------------------------------------
    // first_unfinalized_som is shared with the contiguity check in _create:
    // whatever it names is exactly the month that may be finalized next
    // ------------------------------------------------------------------
    describe("MonthFinalization.first_unfinalized_som", () => {

        let db;
        beforeEach(() => {
            db = create_connection({ path: ":memory:" });
            initialize_db(db);
        });

        it("is null before any tracked fund exists", () => {
            expect(MonthFinalization.first_unfinalized_som(db)).to.equal(null);
        });

        it("names the month create() accepts next", () => {
            Fund.create(db, {
                name: "pool", tracked: true, pool: true,
                start_date: D("2026-01-10"), start_balance: 100,
            });

            expect(MonthFinalization.first_unfinalized_som(db).toJSON()).to.equal("2026-01-01");

            MonthFinalization.create(db, { month: D("2026-01-15") });
            expect(MonthFinalization.first_unfinalized_som(db).toJSON()).to.equal("2026-02-01");

            // and it is genuinely the next acceptable month: finalizing it
            // needs no `recursive`
            MonthFinalization.create(db, { month: D("2026-02-01") });
            expect(MonthFinalization.first_unfinalized_som(db).toJSON()).to.equal("2026-03-01");
        });
    });
});
