const { expect } = require("chai");

const {
    create_connection,
    initialize_db,
} = require("../../lib/db.js");

const YDate = require("../../lib/YDate.js");
const Fund = require("../../models/Fund.js");
const FundFinalization = require("../../models/FundFinalization.js");

describe("models/FundFinalization.js", () => {

    let db;
    let fund;
    let month_id;
    beforeEach(() => {
        db = create_connection({ path: ":memory:" });
        initialize_db(db);

        fund = Fund.create(db, {
            name: "test",
            tracked: true,
            start_date: YDate.parse("2026-01-01"),
            start_balance: 100,
        });

        month_id = db.prepare(`
            INSERT INTO month_finalizations (som_date, eom_date, sonm_date)
            VALUES ('2026-01-01', '2026-01-31', '2026-02-01')
        `).run().lastInsertRowid;
    });

    afterEach(() => {
        db.close();
    });

    it("cannot be created directly", () => {
        expect(() => FundFinalization.create(db, {}))
            .to.throw("You cannot directly finalize a fund");
    });

    it("._create() round-trips values", () => {
        const finalization = FundFinalization._create(db, {
            month_id,
            fund_id: fund.id,
            eom_balance: 125.5,
            sonm_balance: 100,
            sonm_date: YDate.parse("2026-02-01"),
        });

        expect(finalization.month_id).to.equal(month_id);
        expect(finalization.fund_id).to.equal(fund.id);
        expect(finalization.eom_balance).to.equal(125.5);
        expect(finalization.sonm_balance).to.equal(100);
        expect(finalization.sonm_date.toString()).to.equal("2026-02-01");
    });

    it("enforces one finalization per fund per month", () => {
        FundFinalization._create(db, {
            month_id,
            fund_id: fund.id,
            eom_balance: 0,
            sonm_balance: 0,
            sonm_date: YDate.parse("2026-02-01"),
        });
        expect(() => FundFinalization._create(db, {
            month_id,
            fund_id: fund.id,
            eom_balance: 0,
            sonm_balance: 0,
            sonm_date: YDate.parse("2026-02-01"),
        })).to.throw(/UNIQUE/);
    });

    it(".to_api() exposes eom_balance and the sonm cache pair", () => {
        const finalization = FundFinalization._create(db, {
            month_id,
            fund_id: fund.id,
            eom_balance: 125.5,
            sonm_balance: 100,
            sonm_date: YDate.parse("2026-02-01"),
        });

        const api = finalization.to_api();
        expect(api.eom_balance).to.equal(125.5);
        expect(api.sonm).to.deep.equal({
            date: "2026-02-01",
            forward_balance: 100,
        });
    });

    describe(".from_db()", () => {
        beforeEach(() => {
            const month2_id = db.prepare(`
                INSERT INTO month_finalizations (som_date, eom_date, sonm_date)
                VALUES ('2026-02-01', '2026-02-28', '2026-03-01')
            `).run().lastInsertRowid;

            // Untracked so Fund.create does not backfill rows for the
            // month_finalizations inserted above (this suite drives
            // FundFinalization._create manually)
            const other = Fund.create(db, {
                name: "other",
                tracked: false,
            });

            FundFinalization._create(db, {
                month_id, fund_id: fund.id,
                eom_balance: 10, sonm_balance: 10,
                sonm_date: YDate.parse("2026-02-01"),
            });
            FundFinalization._create(db, {
                month_id: month2_id, fund_id: fund.id,
                eom_balance: 20, sonm_balance: 20,
                sonm_date: YDate.parse("2026-03-01"),
            });
            FundFinalization._create(db, {
                month_id, fund_id: other.id,
                eom_balance: 30, sonm_balance: 30,
                sonm_date: YDate.parse("2026-02-01"),
            });
        });

        it("filters by fund_id, newest first by default", () => {
            const results = FundFinalization.from_db(db, { fund_id: fund.id });
            expect(results).to.have.length(2);
            expect(results[0].sonm_date.toString()).to.equal("2026-03-01");
            expect(results[1].sonm_date.toString()).to.equal("2026-02-01");
        });

        it("filters by month_id", () => {
            const results = FundFinalization.from_db(db, { month_id });
            expect(results).to.have.length(2);
        });

        it("filters by since/until on sonm_date", () => {
            const results = FundFinalization.from_db(db, {
                fund_id: fund.id,
                until: YDate.parse("2026-02-01"),
            });
            expect(results).to.have.length(1);
            expect(results[0].eom_balance).to.equal(10);
        });
    });

    describe("count()", () => {
        let other_fund;
        beforeEach(() => {
            // Untracked so Fund.create does not backfill a row for the
            // already-finalized month (this suite drives _create manually)
            other_fund = Fund.create(db, {
                name: "other",
                tracked: false,
            });
            FundFinalization._create(db, {
                month_id,
                fund_id: fund.id,
                eom_balance: 10,
                sonm_balance: 10,
                sonm_date: YDate.parse("2026-02-01"),
            });
            FundFinalization._create(db, {
                month_id,
                fund_id: other_fund.id,
                eom_balance: 20,
                sonm_balance: 20,
                sonm_date: YDate.parse("2026-02-01"),
            });
        });

        it("counts all finalizations with no filters", () => {
            expect(FundFinalization.count(db)).to.equal(2);
        });

        it("counts with the same filters as from_db", () => {
            expect(FundFinalization.count(db, { fund_id: fund.id })).to.equal(1);
            expect(FundFinalization.count(db, { month_id })).to.equal(2);
            expect(FundFinalization.count(db, { since: YDate.parse("2026-03-01") })).to.equal(0);
        });

        it("ignores order/limit/offset so it can share the from_db filter object", () => {
            const filter = { order_by: "sonm_date", order_direction: "DESC", limit: 1, offset: 0 };
            expect(FundFinalization.count(db, filter)).to.equal(2);
            expect(FundFinalization.from_db(db, filter)).to.have.lengthOf(1);
        });
    });

});
