const { expect } = require("chai");

const { start_harness } = require("./harness.js");
const YDate = require("../../lib/YDate.js");
const Fund = require("../../models/Fund.js");
const TransactionGroup = require("../../models/TransactionGroup.js");
const MonthFinalization = require("../../models/MonthFinalization.js");

describe("Funds API", () => {
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
        Fund.create(h.db, { name: "Wishlist", tracked: false });
    });

    afterEach(() => h.stop());

    describe("GET /api/funds/funds", () => {
        it("requires authentication", async () => {
            const { status } = await h.request("/api/funds/funds");
            expect(status).to.equal(401);
        });

        it("lists all funds with X-Total-Count", async () => {
            const { status, body, headers } = await h.request("/api/funds/funds", { token: h.tokens.reader });
            expect(status).to.equal(200);
            expect(headers.get("x-total-count")).to.equal("3");
            expect(body).to.have.lengthOf(3);
            expect(body.map((f) => f.name)).to.include.members([ "Checking", "Groceries", "Wishlist" ]);
        });

        it("filters (tracked, monthly, root, name_like, ids)", async () => {
            let res = await h.request("/api/funds/funds?tracked=true", { token: h.tokens.reader });
            expect(res.body).to.have.lengthOf(2);

            res = await h.request("/api/funds/funds?monthly=true", { token: h.tokens.reader });
            expect(res.body.map((f) => f.name)).to.deep.equal([ "Groceries" ]);

            res = await h.request("/api/funds/funds?root=true", { token: h.tokens.reader });
            expect(res.body.map((f) => f.name)).to.include.members([ "Checking", "Wishlist" ]);

            res = await h.request("/api/funds/funds?name_like=heck", { token: h.tokens.reader });
            expect(res.body.map((f) => f.name)).to.deep.equal([ "Checking" ]);

            res = await h.request(`/api/funds/funds?ids=${checking.id},${groceries.id}`, { token: h.tokens.reader });
            expect(res.body).to.have.lengthOf(2);
        });

        it("filters by descendant_of (self-inclusive, composes with other filters)", async () => {
            let res = await h.request(`/api/funds/funds?descendant_of=${checking.id}`, { token: h.tokens.reader });
            expect(res.status).to.equal(200);
            expect(res.body.map((f) => f.name).sort()).to.deep.equal([ "Checking", "Groceries" ]);

            res = await h.request(`/api/funds/funds?descendant_of=${checking.id}&monthly=true`, { token: h.tokens.reader });
            expect(res.body.map((f) => f.name)).to.deep.equal([ "Groceries" ]);
        });

        it("descendant_of an unknown id returns an empty array", async () => {
            const { status, body } = await h.request("/api/funds/funds?descendant_of=999", { token: h.tokens.reader });
            expect(status).to.equal(200);
            expect(body).to.deep.equal([]);
        });

        it("400s on a malformed descendant_of (never silently returns all funds)", async () => {
            let res = await h.request("/api/funds/funds?descendant_of=bogus", { token: h.tokens.reader });
            expect(res.status).to.equal(400);
            expect(res.body.message).to.match(/descendant_of/);

            res = await h.request("/api/funds/funds?descendant_of=0", { token: h.tokens.reader });
            expect(res.status).to.equal(400);
        });

        it("supports ordering and pagination (X-Total-Count ignores limit, respects filters)", async () => {
            const { body, headers } = await h.request("/api/funds/funds?order_by=id&order_direction=desc&limit=1&offset=1", { token: h.tokens.reader });
            expect(headers.get("x-total-count")).to.equal("3");
            expect(body).to.have.lengthOf(1);
            expect(body[0].name).to.equal("Groceries");

            const res = await h.request("/api/funds/funds?tracked=true&limit=1", { token: h.tokens.reader });
            expect(res.headers.get("x-total-count")).to.equal("2");
            expect(res.body).to.have.lengthOf(1);
        });
    });

    describe("GET /api/funds/fund/:fund_id", () => {
        it("returns a fund with start/cache/status shape", async () => {
            const { status, body } = await h.request(`/api/funds/fund/${checking.id}`, { token: h.tokens.reader });
            expect(status).to.equal(200);
            expect(body.name).to.equal("Checking");
            expect(body.start).to.deep.equal({ date: "2026-01-01", forward_balance: 1000 });
            expect(body.cache).to.deep.equal({ date: "2026-01-01", forward_balance: 1000 });
            expect(body.status).to.deep.equal({ tracked: true, monthly: false, pool: true, root: true });
        });

        it("404s on a missing or garbage id", async () => {
            expect((await h.request("/api/funds/fund/9999", { token: h.tokens.reader })).status).to.equal(404);
            expect((await h.request("/api/funds/fund/garbage", { token: h.tokens.reader })).status).to.equal(404);
        });
    });

    describe("GET /api/funds/fund/:fund_id/balance", () => {
        beforeEach(() => {
            TransactionGroup.create_single(h.db, {
                date: YDate.parse("2026-01-10"),
                description: "Grocery run",
                source_fund_id: checking.id,
                target_fund_id: groceries.id,
                amount: 100.00,
            });
        });

        it("reports the current balance", async () => {
            const { status, body } = await h.request(`/api/funds/fund/${checking.id}/balance`, { token: h.tokens.reader });
            expect(status).to.equal(200);
            expect(body).to.deep.equal({ fund_id: checking.id, on: null, balance: 900 });
        });

        it("reports the balance on a date (inclusive)", async () => {
            let res = await h.request(`/api/funds/fund/${checking.id}/balance?on=2026-01-09`, { token: h.tokens.reader });
            expect(res.body.balance).to.equal(1000);

            res = await h.request(`/api/funds/fund/${checking.id}/balance?on=2026-01-10`, { token: h.tokens.reader });
            expect(res.body).to.deep.equal({ fund_id: checking.id, on: "2026-01-10", balance: 900 });
        });

        it("400s on a malformed date (never a silently-wrong balance)", async () => {
            const { status, body } = await h.request(`/api/funds/fund/${checking.id}/balance?on=not-a-date`, { token: h.tokens.reader });
            expect(status).to.equal(400);
            expect(body.message).to.include("Bad parameter: on");
        });

        it("400s on a date before the fund's start_date", async () => {
            const { status } = await h.request(`/api/funds/fund/${checking.id}/balance?on=2025-12-31`, { token: h.tokens.reader });
            expect(status).to.equal(400);
        });
    });

    describe("POST /api/funds/funds", () => {
        const good_body = {
            name: "Savings",
            tracked: true,
            start_date: "2026-01-01",
            start_balance: 500.00,
        };

        it("requires the editor role", async () => {
            const { status } = await h.request("/api/funds/funds", { method: "POST", token: h.tokens.reader, body: good_body });
            expect(status).to.equal(403);
        });

        it("creates a fund and reports invalidations", async () => {
            const { status, body } = await h.request("/api/funds/funds", { method: "POST", token: h.tokens.editor, body: good_body });
            expect(status).to.equal(200);
            expect(body.data.name).to.equal("Savings");
            expect(body.data.start).to.deep.equal({ date: "2026-01-01", forward_balance: 500 });
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["funds"] });

            expect(Fund.for_id(h.db, body.data.id)).to.not.be.null;
        });

        it("400s on a missing required field", async () => {
            const { status, body } = await h.request("/api/funds/funds", { method: "POST", token: h.tokens.editor, body: { tracked: false } });
            expect(status).to.equal(400);
            expect(body.message).to.include("Missing parameter: name");
        });

        it("400s on a bad parameter type", async () => {
            const { status, body } = await h.request("/api/funds/funds", { method: "POST", token: h.tokens.editor, body: { ...good_body, start_date: "01/01/2026" } });
            expect(status).to.equal(400);
            expect(body.message).to.include("Bad parameter: start_date");
        });

        it("400s on a model consistency failure (tracked without start_date)", async () => {
            const { status, body } = await h.request("/api/funds/funds", { method: "POST", token: h.tokens.editor, body: { name: "Broken", tracked: true } });
            expect(status).to.equal(400);
            expect(body.message).to.include("start_date");
        });

        it("409s on a duplicate name", async () => {
            const { status, body } = await h.request("/api/funds/funds", { method: "POST", token: h.tokens.editor, body: { ...good_body, name: "Checking" } });
            expect(status).to.equal(409);
            expect(body.message).to.include("Name already exists");
        });
    });

    describe("PATCH /api/funds/fund/:fund_id", () => {
        it("requires the editor role", async () => {
            const { status } = await h.request(`/api/funds/fund/${checking.id}`, { method: "PATCH", token: h.tokens.reader, body: { name: "Renamed" } });
            expect(status).to.equal(403);
        });

        it("updates only the provided fields", async () => {
            const { status, body } = await h.request(`/api/funds/fund/${checking.id}`, { method: "PATCH", token: h.tokens.editor, body: { name: "Main Checking", color: "#00ff00" } });
            expect(status).to.equal(200);
            expect(body.data.name).to.equal("Main Checking");
            expect(body.data.color).to.equal("#00ff00");
            expect(body.data.start).to.deep.equal({ date: "2026-01-01", forward_balance: 1000 });
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["fund", checking.id.toString()] });
        });

        it("400s on a bad parameter", async () => {
            const { status } = await h.request(`/api/funds/fund/${checking.id}`, { method: "PATCH", token: h.tokens.editor, body: { name: 5 } });
            expect(status).to.equal(400);
        });

        it("409s on history-affecting changes once finalized", async () => {
            MonthFinalization.create(h.db, { month: YDate.parse("2026-01-01") });
            const { status, body } = await h.request(`/api/funds/fund/${checking.id}`, { method: "PATCH", token: h.tokens.editor, body: { start_balance: 2000 } });
            expect(status).to.equal(409);
            expect(body.message).to.include("unfinalize");
        });
    });

    describe("DELETE /api/funds/fund/:fund_id", () => {
        it("requires the editor role", async () => {
            const { status } = await h.request(`/api/funds/fund/${groceries.id}`, { method: "DELETE", token: h.tokens.reader });
            expect(status).to.equal(403);
        });

        it("deletes a fund and reports a remove action", async () => {
            const { status, body } = await h.request(`/api/funds/fund/${groceries.id}`, { method: "DELETE", token: h.tokens.editor });
            expect(status).to.equal(200);
            expect(body.data).to.be.null;
            expect(body.invalidations).to.deep.include({ type: "remove", key: ["fund", groceries.id.toString()] });

            expect(Fund.for_id(h.db, groceries.id)).to.be.null;
        });

        it("409s while finalizations exist", async () => {
            MonthFinalization.create(h.db, { month: YDate.parse("2026-01-01") });
            const { status } = await h.request(`/api/funds/fund/${groceries.id}`, { method: "DELETE", token: h.tokens.editor });
            expect(status).to.equal(409);
        });
    });
});
