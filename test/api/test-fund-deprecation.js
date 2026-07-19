const { expect } = require("chai");

const { start_harness } = require("./harness.js");

const YDate = require("../../lib/YDate.js");
const Fund = require("../../models/Fund.js");
const TransactionGroup = require("../../models/TransactionGroup.js");

const D = (s) => YDate.parse(s);

describe("api fund deprecation", () => {

    let h, pool, savings;
    beforeEach(async () => {
        h = await start_harness();
        pool = Fund.create(h.db, {
            name: "pool", tracked: true, pool: true,
            start_date: D("2026-01-01"), start_balance: 1000,
        });
        savings = Fund.create(h.db, {
            name: "savings", tracked: true, parent_id: pool.id,
            start_date: D("2026-01-01"), start_balance: 0,
        });
    });
    afterEach(() => h.stop());

    describe("PATCH /api/funds/fund/:fund_id", () => {
        it("sets and clears the deprecation date", async () => {
            let res = await h.request(`/api/funds/fund/${savings.id}`, {
                method: "PATCH", token: h.tokens.editor,
                body: { deprecated: "2026-01-31" },
            });
            expect(res.status).to.equal(200);
            expect(res.body.data.deprecated).to.equal("2026-01-31");
            expect(res.body.invalidations).to.deep.include({
                type: "invalidate", key: [ "funds" ],
            });

            res = await h.request(`/api/funds/fund/${savings.id}`, {
                method: "PATCH", token: h.tokens.editor,
                body: { deprecated: null },
            });
            expect(res.status).to.equal(200);
            expect(res.body.data.deprecated).to.equal(null);
        });

        it("400s on a malformed date", async () => {
            const { status, body } = await h.request(`/api/funds/fund/${savings.id}`, {
                method: "PATCH", token: h.tokens.editor,
                body: { deprecated: "January 31st" },
            });
            expect(status).to.equal(400);
            expect(body.message).to.include("Bad parameter: deprecated");
        });

        it("409s when the balance on the date is not zero", async () => {
            const cash = Fund.create(h.db, {
                name: "cash", tracked: true,
                start_date: D("2026-01-01"), start_balance: 100,
            });
            const { status, body } = await h.request(`/api/funds/fund/${cash.id}`, {
                method: "PATCH", token: h.tokens.editor,
                body: { deprecated: "2026-01-31" },
            });
            expect(status).to.equal(409);
            expect(body.message).to.include("not zero");
        });

        it("400s deprecating an untracked fund", async () => {
            const folder = Fund.create(h.db, { name: "folder", tracked: false });
            const { status } = await h.request(`/api/funds/fund/${folder.id}`, {
                method: "PATCH", token: h.tokens.editor,
                body: { deprecated: "2026-01-31" },
            });
            expect(status).to.equal(400);
        });
    });

    describe("GET /api/funds/funds", () => {
        beforeEach(() => {
            Fund.for_id(h.db, savings.id).update(h.db, { deprecated: D("2026-01-31") });
        });

        it("reports deprecated on every fund", async () => {
            const { status, body } = await h.request("/api/funds/funds", { token: h.tokens.reader });
            expect(status).to.equal(200);
            const by_name = Object.fromEntries(body.map(f => [ f.name, f.deprecated ]));
            expect(by_name).to.deep.equal({ pool: null, savings: "2026-01-31" });
        });

        it("filters by deprecated", async () => {
            const { body, headers } = await h.request("/api/funds/funds?deprecated=true", {
                token: h.tokens.reader,
            });
            expect(body.map(f => f.name)).to.deep.equal([ "savings" ]);
            expect(headers.get("x-total-count")).to.equal("1");
        });

        it("filters by active_as_of", async () => {
            let res = await h.request("/api/funds/funds?active_as_of=2026-01-31", {
                token: h.tokens.reader,
            });
            expect(res.body.map(f => f.name)).to.deep.equal([ "pool", "savings" ]);

            res = await h.request("/api/funds/funds?active_as_of=2026-02-01", {
                token: h.tokens.reader,
            });
            expect(res.body.map(f => f.name)).to.deep.equal([ "pool" ]);
        });
    });

    describe("the freeze at the API layer", () => {
        beforeEach(() => {
            Fund.for_id(h.db, savings.id).update(h.db, { deprecated: D("2026-01-31") });
        });

        it("409s creating a transaction group involving a deprecated fund", async () => {
            const { status, body } = await h.request("/api/transactions/transaction-groups", {
                method: "POST", token: h.tokens.editor,
                body: {
                    date: "2026-01-10",
                    description: "late arrival",
                    transactions: [{
                        source_fund_id: pool.id, target_fund_id: savings.id,
                        amount: 10, description: "late arrival",
                    }],
                },
            });
            expect(status).to.equal(409);
            expect(body.message).to.include("deprecated");
        });

        it("409s deleting a group involving a deprecated fund", async () => {
            // Built before deprecation: re-create the fund's history directly
            Fund.for_id(h.db, savings.id).update(h.db, { deprecated: null });
            const group = TransactionGroup.create_single(h.db, {
                date: D("2026-01-05"), description: "history",
                source_fund_id: pool.id, target_fund_id: savings.id, amount: 10,
            });
            TransactionGroup.create_single(h.db, {
                date: D("2026-01-20"), description: "history",
                source_fund_id: savings.id, target_fund_id: pool.id, amount: 10,
            });
            Fund.for_id(h.db, savings.id).update(h.db, { deprecated: D("2026-01-31") });

            const { status, body } = await h.request(`/api/transactions/transaction-group/${group.id}`, {
                method: "DELETE", token: h.tokens.editor,
            });
            expect(status).to.equal(409);
            expect(body.message).to.include("deprecated");
        });

        it("409s allocating to a deprecated fund", async () => {
            const { status, body } = await h.request("/api/allocations/allocations", {
                method: "PUT", token: h.tokens.editor,
                body: { fund_id: savings.id, month: "2026-02-01", amount: 10 },
            });
            expect(status).to.equal(409);
            expect(body.message).to.include("deprecated");
        });
    });
});
