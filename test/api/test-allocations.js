const { expect } = require("chai");

const { start_harness } = require("./harness.js");
const YDate = require("../../lib/YDate.js");
const Fund = require("../../models/Fund.js");
const Allocation = require("../../models/Allocation.js");
const TransactionGroup = require("../../models/TransactionGroup.js");
const MonthFinalization = require("../../models/MonthFinalization.js");

describe("Allocations API", () => {
    let h;
    let checking, groceries, gas, wishlist;

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
        gas = Fund.create(h.db, {
            name: "Gas",
            tracked: true,
            monthly: true,
            parent_id: checking.id,
            start_date: YDate.parse("2026-01-01"),
            start_balance: 0.00,
        });
        wishlist = Fund.create(h.db, { name: "Wishlist", tracked: false });
    });

    afterEach(() => h.stop());

    describe("GET /api/allocations/allocations", () => {
        beforeEach(() => {
            Allocation.set(h.db, { month: YDate.parse("2026-05-01"), fund_id: groceries.id, amount: 400 });
            Allocation.set(h.db, { month: YDate.parse("2026-06-01"), fund_id: groceries.id, amount: 450 });
            Allocation.set(h.db, { month: YDate.parse("2026-06-01"), fund_id: gas.id, amount: 150 });
        });

        it("requires authentication", async () => {
            expect((await h.request("/api/allocations/allocations?month=2026-06-15")).status).to.equal(401);
        });

        it("month mode returns the month's allocations", async () => {
            const { status, body } = await h.request("/api/allocations/allocations?month=2026-06-15", { token: h.tokens.reader });
            expect(status).to.equal(200);
            expect(body).to.have.lengthOf(2);
            expect(body.map((a) => a.fund_id)).to.include.members([ groceries.id, gas.id ]);
            expect(body[0].month).to.equal("2026-06-01");
            expect(body[0].source_fund_id).to.equal(checking.id);
        });

        it("fund mode returns the fund's history, newest first", async () => {
            const { body } = await h.request(`/api/allocations/allocations?fund_id=${groceries.id}`, { token: h.tokens.reader });
            expect(body.map((a) => a.month)).to.deep.equal([ "2026-06-01", "2026-05-01" ]);
            expect(body.map((a) => a.amount)).to.deep.equal([ 450, 400 ]);
        });

        it("400s unless exactly one mode is given", async () => {
            expect((await h.request("/api/allocations/allocations", { token: h.tokens.reader })).status).to.equal(400);
            expect((await h.request(`/api/allocations/allocations?month=2026-06-01&fund_id=${gas.id}`, { token: h.tokens.reader })).status).to.equal(400);
        });
    });

    describe("PUT /api/allocations/allocations", () => {
        it("requires the editor role", async () => {
            const { status } = await h.request("/api/allocations/allocations", { method: "PUT", token: h.tokens.reader, body: { month: "2026-06-01", fund_id: groceries.id, amount: 400 } });
            expect(status).to.equal(403);
        });

        it("creates an allocation from the nearest pool", async () => {
            const { status, body } = await h.request("/api/allocations/allocations", { method: "PUT", token: h.tokens.editor, body: { month: "2026-06-15", fund_id: groceries.id, amount: 400 } });
            expect(status).to.equal(200);
            expect(body.data.fund_id).to.equal(groceries.id);
            expect(body.data.source_fund_id).to.equal(checking.id);
            expect(body.data.month).to.equal("2026-06-01");
            expect(body.data.date).to.equal("2026-06-01");
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["allocations"] });
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["fund-balance"] });
        });

        it("replaces an existing allocation (upsert)", async () => {
            await h.request("/api/allocations/allocations", { method: "PUT", token: h.tokens.editor, body: { month: "2026-06-01", fund_id: groceries.id, amount: 400 } });
            const { body } = await h.request("/api/allocations/allocations", { method: "PUT", token: h.tokens.editor, body: { month: "2026-06-01", fund_id: groceries.id, amount: 425 } });
            expect(body.data.amount).to.equal(425);

            expect(Allocation.for_month(h.db, YDate.parse("2026-06-01"))).to.have.lengthOf(1);
        });

        it("400s on a non-positive amount", async () => {
            const { status } = await h.request("/api/allocations/allocations", { method: "PUT", token: h.tokens.editor, body: { month: "2026-06-01", fund_id: groceries.id, amount: 0 } });
            expect(status).to.equal(400);
        });

        it("409s on an untracked fund", async () => {
            const { status, body } = await h.request("/api/allocations/allocations", { method: "PUT", token: h.tokens.editor, body: { month: "2026-06-01", fund_id: wishlist.id, amount: 50 } });
            expect(status).to.equal(409);
            expect(body.message).to.include("untracked");
        });

        it("409s in a finalized month", async () => {
            MonthFinalization.create(h.db, { month: YDate.parse("2026-01-01") });
            const { status } = await h.request("/api/allocations/allocations", { method: "PUT", token: h.tokens.editor, body: { month: "2026-01-01", fund_id: groceries.id, amount: 100 } });
            expect(status).to.equal(409);
        });
    });

    describe("DELETE /api/allocations/allocations", () => {
        beforeEach(() => {
            Allocation.set(h.db, { month: YDate.parse("2026-06-01"), fund_id: groceries.id, amount: 400 });
            Allocation.set(h.db, { month: YDate.parse("2026-06-01"), fund_id: gas.id, amount: 150 });
        });

        it("removes one fund's allocation, keeping the group for the rest", async () => {
            const { status, body } = await h.request(`/api/allocations/allocations?month=2026-06-01&fund_id=${gas.id}`, { method: "DELETE", token: h.tokens.editor });
            expect(status).to.equal(200);
            expect(body.data).to.be.null;
            expect(Allocation.for_month(h.db, YDate.parse("2026-06-01")).map((a) => a.fund_id)).to.deep.equal([ groceries.id ]);
        });

        it("removing the last allocation removes the month's group", async () => {
            await h.request(`/api/allocations/allocations?month=2026-06-01&fund_id=${gas.id}`, { method: "DELETE", token: h.tokens.editor });
            await h.request(`/api/allocations/allocations?month=2026-06-01&fund_id=${groceries.id}`, { method: "DELETE", token: h.tokens.editor });

            expect(TransactionGroup.from_db(h.db, { allocation: true })).to.have.lengthOf(0);
        });

        it("404s when no allocation exists", async () => {
            const { status, body } = await h.request(`/api/allocations/allocations?month=2026-03-01&fund_id=${gas.id}`, { method: "DELETE", token: h.tokens.editor });
            expect(status).to.equal(404);
            expect(body.message).to.include("No allocation exists");
        });

        it("400s on missing params", async () => {
            expect((await h.request("/api/allocations/allocations?month=2026-06-01", { method: "DELETE", token: h.tokens.editor })).status).to.equal(400);
        });
    });

    describe("POST /api/allocations/allocations/copy", () => {
        beforeEach(() => {
            Allocation.set(h.db, { month: YDate.parse("2026-05-01"), fund_id: groceries.id, amount: 400 });
            Allocation.set(h.db, { month: YDate.parse("2026-05-01"), fund_id: gas.id, amount: 150 });
        });

        it("copies a month's allocations", async () => {
            const { status, body } = await h.request("/api/allocations/allocations/copy", { method: "POST", token: h.tokens.editor, body: { from: "2026-05-01", to: "2026-06-01" } });
            expect(status).to.equal(200);
            expect(body.data).to.have.lengthOf(2);
            expect(body.data.every((a) => a.month === "2026-06-01")).to.be.true;
        });

        it("409s on conflicts by default, listing the funds", async () => {
            Allocation.set(h.db, { month: YDate.parse("2026-06-01"), fund_id: gas.id, amount: 175 });
            const { status, body } = await h.request("/api/allocations/allocations/copy", { method: "POST", token: h.tokens.editor, body: { from: "2026-05-01", to: "2026-06-01" } });
            expect(status).to.equal(409);
            expect(body.message).to.include("Gas");
        });

        it("merge keeps the target's amounts; overwrite takes the source's", async () => {
            Allocation.set(h.db, { month: YDate.parse("2026-06-01"), fund_id: gas.id, amount: 175 });

            await h.request("/api/allocations/allocations/copy", { method: "POST", token: h.tokens.editor, body: { from: "2026-05-01", to: "2026-06-01", on_conflict: "merge" } });
            let gas_alloc = Allocation.for_month(h.db, YDate.parse("2026-06-01")).find((a) => a.fund_id === gas.id);
            expect(gas_alloc.amount).to.equal(175);

            await h.request("/api/allocations/allocations/copy", { method: "POST", token: h.tokens.editor, body: { from: "2026-05-01", to: "2026-06-01", on_conflict: "overwrite" } });
            gas_alloc = Allocation.for_month(h.db, YDate.parse("2026-06-01")).find((a) => a.fund_id === gas.id);
            expect(gas_alloc.amount).to.equal(150);
        });

        it("400s copying a month onto itself or on a bad on_conflict", async () => {
            expect((await h.request("/api/allocations/allocations/copy", { method: "POST", token: h.tokens.editor, body: { from: "2026-05-01", to: "2026-05-20" } })).status).to.equal(400);
            expect((await h.request("/api/allocations/allocations/copy", { method: "POST", token: h.tokens.editor, body: { from: "2026-05-01", to: "2026-06-01", on_conflict: "panic" } })).status).to.equal(400);
        });
    });
});
