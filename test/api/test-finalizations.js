const { expect } = require("chai");

const { start_harness } = require("./harness.js");
const YDate = require("../../lib/YDate.js");
const Fund = require("../../models/Fund.js");
const TransactionGroup = require("../../models/TransactionGroup.js");
const MonthFinalization = require("../../models/MonthFinalization.js");

describe("Finalizations API", () => {
    let h;
    let checking, groceries;

    beforeEach(async () => {
        h = await start_harness();

        checking = Fund.create(h.db, {
            name: "Checking",
            tracked: true,
            pool: true,
            start_date: YDate.parse("2026-01-01"),
            start_balance: 1000.00,
        });
        groceries = Fund.create(h.db, {
            name: "Groceries",
            tracked: true,
            monthly: true,
            parent_id: checking.id,
            start_date: YDate.parse("2026-01-01"),
            start_balance: 0.00,
        });
    });

    afterEach(() => h.stop());

    describe("GET /api/finalizations/month-finalizations", () => {
        it("requires authentication", async () => {
            expect((await h.request("/api/finalizations/month-finalizations")).status).to.equal(401);
        });

        it("lists finalized months, newest first, with X-Total-Count", async () => {
            MonthFinalization.create(h.db, { month: YDate.parse("2026-02-15"), recursive: true });

            const { status, body, headers } = await h.request("/api/finalizations/month-finalizations", { token: h.tokens.reader });
            expect(status).to.equal(200);
            expect(headers.get("x-total-count")).to.equal("2");
            expect(body.map((m) => m.som_date)).to.deep.equal([ "2026-02-01", "2026-01-01" ]);
            expect(body[0].eom_date).to.equal("2026-02-28");
            expect(body[0].sonm_date).to.equal("2026-03-01");
        });

        it("filters by since/until on som_date", async () => {
            MonthFinalization.create(h.db, { month: YDate.parse("2026-02-15"), recursive: true });
            const { body } = await h.request("/api/finalizations/month-finalizations?until=2026-01-31", { token: h.tokens.reader });
            expect(body.map((m) => m.som_date)).to.deep.equal([ "2026-01-01" ]);
        });
    });

    describe("GET /api/finalizations/month-finalizations/latest", () => {
        it("returns null when nothing is finalized (200, not 404)", async () => {
            const { status, body } = await h.request("/api/finalizations/month-finalizations/latest", { token: h.tokens.reader });
            expect(status).to.equal(200);
            expect(body).to.be.null;
        });

        it("returns the latest finalized month", async () => {
            MonthFinalization.create(h.db, { month: YDate.parse("2026-02-15"), recursive: true });
            const { body } = await h.request("/api/finalizations/month-finalizations/latest", { token: h.tokens.reader });
            expect(body.som_date).to.equal("2026-02-01");
        });
    });

    describe("GET /api/finalizations/month-finalization/:id", () => {
        it("returns a month, 404s on missing", async () => {
            const month = MonthFinalization.create(h.db, { month: YDate.parse("2026-01-15") });
            const { status, body } = await h.request(`/api/finalizations/month-finalization/${month.id}`, { token: h.tokens.reader });
            expect(status).to.equal(200);
            expect(body.som_date).to.equal("2026-01-01");

            expect((await h.request("/api/finalizations/month-finalization/9999", { token: h.tokens.reader })).status).to.equal(404);
        });
    });

    describe("POST /api/finalizations/month-finalizations", () => {
        it("requires the editor role", async () => {
            expect((await h.request("/api/finalizations/month-finalizations", { method: "POST", token: h.tokens.reader, body: { month: "2026-01-15" } })).status).to.equal(403);
        });

        it("finalizes a month, zeroing monthly funds into their pool", async () => {
            TransactionGroup.create_single(h.db, {
                date: YDate.parse("2026-01-05"),
                description: "Fill groceries",
                source_fund_id: checking.id,
                target_fund_id: groceries.id,
                amount: 100,
            });

            const { status, body } = await h.request("/api/finalizations/month-finalizations", { method: "POST", token: h.tokens.editor, body: { month: "2026-01-15" } });
            expect(status).to.equal(200);
            expect(body.data.som_date).to.equal("2026-01-01");
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["month-finalizations"] });
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["funds"] });
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["fund-balance"] });

            // The eom cleanup returned the groceries balance to the pool
            expect(Fund.for_id(h.db, groceries.id).calculate_balance(h.db)).to.equal(0);
            expect(Fund.for_id(h.db, checking.id).calculate_balance(h.db)).to.equal(1000);
        });

        it("409s without recursive when months are skipped, then succeeds with it", async () => {
            let res = await h.request("/api/finalizations/month-finalizations", { method: "POST", token: h.tokens.editor, body: { month: "2026-02-15" } });
            expect(res.status).to.equal(409);
            expect(res.body.message).to.include("Previous month");

            res = await h.request("/api/finalizations/month-finalizations", { method: "POST", token: h.tokens.editor, body: { month: "2026-02-15", recursive: true } });
            expect(res.status).to.equal(200);
        });

        it("409s on an already-finalized month", async () => {
            MonthFinalization.create(h.db, { month: YDate.parse("2026-01-15") });
            const { status } = await h.request("/api/finalizations/month-finalizations", { method: "POST", token: h.tokens.editor, body: { month: "2026-01-20" } });
            expect(status).to.equal(409);
        });

        it("400s on a malformed month", async () => {
            expect((await h.request("/api/finalizations/month-finalizations", { method: "POST", token: h.tokens.editor, body: { month: "January" } })).status).to.equal(400);
        });
    });

    describe("DELETE /api/finalizations/month-finalization/:id", () => {
        it("unfinalizes the latest month only (LIFO)", async () => {
            const jan = MonthFinalization.create(h.db, { month: YDate.parse("2026-01-15") });
            const feb = MonthFinalization.create(h.db, { month: YDate.parse("2026-02-15") });

            let res = await h.request(`/api/finalizations/month-finalization/${jan.id}`, { method: "DELETE", token: h.tokens.editor });
            expect(res.status).to.equal(409);
            expect(res.body.message).to.include("most recent");

            res = await h.request(`/api/finalizations/month-finalization/${feb.id}`, { method: "DELETE", token: h.tokens.editor });
            expect(res.status).to.equal(200);
            expect(res.body.data).to.be.null;
            expect(res.body.invalidations).to.deep.include({ type: "remove", key: ["month-finalization", feb.id.toString()] });
            expect(MonthFinalization.latest(h.db).id).to.equal(jan.id);
        });

        it("cascades with ?recursive=true, unfinalizing later months too", async () => {
            const jan = MonthFinalization.create(h.db, { month: YDate.parse("2026-01-15") });
            MonthFinalization.create(h.db, { month: YDate.parse("2026-02-15") });
            MonthFinalization.create(h.db, { month: YDate.parse("2026-03-15") });

            // Without recursive an earlier month is refused
            let res = await h.request(`/api/finalizations/month-finalization/${jan.id}`, { method: "DELETE", token: h.tokens.editor });
            expect(res.status).to.equal(409);

            // With recursive the whole run back to Jan is removed
            res = await h.request(`/api/finalizations/month-finalization/${jan.id}?recursive=true`, { method: "DELETE", token: h.tokens.editor });
            expect(res.status).to.equal(200);
            expect(MonthFinalization.latest(h.db)).to.equal(null);
        });
    });

    describe("GET /api/finalizations/fund-finalizations", () => {
        beforeEach(() => {
            MonthFinalization.create(h.db, { month: YDate.parse("2026-02-15"), recursive: true });
        });

        it("lists fund finalizations with X-Total-Count", async () => {
            const { status, body, headers } = await h.request("/api/finalizations/fund-finalizations", { token: h.tokens.reader });
            expect(status).to.equal(200);
            expect(headers.get("x-total-count")).to.equal("4"); // 2 funds x 2 months
            expect(body).to.have.lengthOf(4);
            expect(body[0].sonm).to.have.keys([ "date", "forward_balance" ]);
        });

        it("filters by fund_id (a fund's history)", async () => {
            const { body } = await h.request(`/api/finalizations/fund-finalizations?fund_id=${groceries.id}`, { token: h.tokens.reader });
            expect(body).to.have.lengthOf(2);
            expect(body.every((f) => f.fund_id === groceries.id)).to.be.true;
            expect(body.map((f) => f.sonm.date)).to.deep.equal([ "2026-03-01", "2026-02-01" ]);
        });
    });

    describe("GET /api/finalizations/fund-finalization/:id", () => {
        it("returns one finalization, 404s on missing", async () => {
            MonthFinalization.create(h.db, { month: YDate.parse("2026-01-15") });
            const { body: list } = await h.request("/api/finalizations/fund-finalizations", { token: h.tokens.reader });

            const { status, body } = await h.request(`/api/finalizations/fund-finalization/${list[0].id}`, { token: h.tokens.reader });
            expect(status).to.equal(200);
            expect(body.id).to.equal(list[0].id);

            expect((await h.request("/api/finalizations/fund-finalization/9999", { token: h.tokens.reader })).status).to.equal(404);
        });
    });
});
