const { expect } = require("chai");

const { start_harness } = require("./harness.js");
const YDate = require("../../lib/YDate.js");
const Fund = require("../../models/Fund.js");
const TransactionGroup = require("../../models/TransactionGroup.js");
const BankStatementItem = require("../../models/BankStatementItem.js");
const MonthFinalization = require("../../models/MonthFinalization.js");
const Allocation = require("../../models/Allocation.js");

describe("Transactions API", () => {
    let h;
    let checking, groceries, gas;

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
    });

    afterEach(() => h.stop());

    function create_group(date="2026-06-01", description="Grocery run", amount=100) {
        return TransactionGroup.create_single(h.db, {
            date: YDate.parse(date),
            description,
            source_fund_id: checking.id,
            target_fund_id: groceries.id,
            amount,
        });
    }

    describe("GET /api/transactions/transaction-groups", () => {
        beforeEach(() => {
            create_group("2026-06-01", "Grocery run");
            TransactionGroup.create(h.db, {
                date: YDate.parse("2026-06-05"),
                description: "Split spend",
                transactions: [
                    { source_fund_id: checking.id, target_fund_id: groceries.id, amount: 60, description: "Groceries" },
                    { source_fund_id: checking.id, target_fund_id: gas.id, amount: 40, description: "Gas" },
                ]
            });
        });

        it("requires authentication", async () => {
            expect((await h.request("/api/transactions/transaction-groups")).status).to.equal(401);
        });

        it("lists groups (date DESC) with X-Total-Count and hydrated transactions", async () => {
            const { status, body, headers } = await h.request("/api/transactions/transaction-groups", { token: h.tokens.reader });
            expect(status).to.equal(200);
            expect(headers.get("x-total-count")).to.equal("2");
            expect(body).to.have.lengthOf(2);
            expect(body[0].description).to.equal("Split spend");
            expect(body[0].transactions).to.have.lengthOf(2);
            expect(body[0].status.split).to.be.true;
        });

        it("filters and paginates", async () => {
            let res = await h.request("/api/transactions/transaction-groups?split=true", { token: h.tokens.reader });
            expect(res.body.map((g) => g.description)).to.deep.equal([ "Split spend" ]);

            res = await h.request("/api/transactions/transaction-groups?until=2026-06-02", { token: h.tokens.reader });
            expect(res.body.map((g) => g.description)).to.deep.equal([ "Grocery run" ]);

            res = await h.request("/api/transactions/transaction-groups?limit=1&offset=1", { token: h.tokens.reader });
            expect(res.headers.get("x-total-count")).to.equal("2");
            expect(res.body).to.have.lengthOf(1);
        });
    });

    describe("GET /api/transactions/transaction-group/:group_id", () => {
        it("returns a group, 404s on missing", async () => {
            const group = create_group();
            const { status, body } = await h.request(`/api/transactions/transaction-group/${group.id}`, { token: h.tokens.reader });
            expect(status).to.equal(200);
            expect(body.id).to.equal(group.id);
            expect(body.transactions).to.have.lengthOf(1);

            expect((await h.request("/api/transactions/transaction-group/9999", { token: h.tokens.reader })).status).to.equal(404);
        });
    });

    describe("POST /api/transactions/transaction-groups", () => {
        const good_body = () => ({
            date: "2026-06-01",
            description: "Dinner",
            transactions: [
                { source_fund_id: 1, target_fund_id: 2, amount: 45.50, description: "Dinner" },
            ]
        });

        it("requires the editor role", async () => {
            const body = good_body();
            body.transactions[0].source_fund_id = checking.id;
            body.transactions[0].target_fund_id = groceries.id;
            expect((await h.request("/api/transactions/transaction-groups", { method: "POST", token: h.tokens.reader, body })).status).to.equal(403);
        });

        it("creates a group and reports money-moved invalidations", async () => {
            const body_in = good_body();
            body_in.transactions[0].source_fund_id = checking.id;
            body_in.transactions[0].target_fund_id = groceries.id;

            const { status, body } = await h.request("/api/transactions/transaction-groups", { method: "POST", token: h.tokens.editor, body: body_in });
            expect(status).to.equal(200);
            expect(body.data.description).to.equal("Dinner");
            expect(body.data.transactions).to.have.lengthOf(1);
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["transaction-groups"] });
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["fund-balance"] });
        });

        it("400s on an empty transactions array", async () => {
            const { status, body } = await h.request("/api/transactions/transaction-groups", { method: "POST", token: h.tokens.editor, body: { date: "2026-06-01", description: "x", transactions: [] } });
            expect(status).to.equal(400);
            expect(body.message).to.include("transactions");
        });

        it("400s on a non-positive amount (zero is internal-only)", async () => {
            const body_in = good_body();
            body_in.transactions[0].source_fund_id = checking.id;
            body_in.transactions[0].target_fund_id = groceries.id;
            body_in.transactions[0].amount = 0;

            const { status, body } = await h.request("/api/transactions/transaction-groups", { method: "POST", token: h.tokens.editor, body: body_in });
            expect(status).to.equal(400);
            expect(body.message).to.include("transactions[0]");
            expect(body.message).to.include("amount");
        });

        it("400s on an unknown fund reference", async () => {
            const body_in = good_body();
            body_in.transactions[0].source_fund_id = 9999;
            body_in.transactions[0].target_fund_id = groceries.id;
            const res = await h.request("/api/transactions/transaction-groups", { method: "POST", token: h.tokens.editor, body: body_in });
            expect(res.status).to.equal(400);
        });

        it("409s in a finalized month", async () => {
            MonthFinalization.create(h.db, { month: YDate.parse("2026-01-01") });
            const body_in = {
                date: "2026-01-15",
                description: "Backdated",
                transactions: [
                    { source_fund_id: checking.id, target_fund_id: groceries.id, amount: 10, description: "Backdated" },
                ]
            };
            const { status, body } = await h.request("/api/transactions/transaction-groups", { method: "POST", token: h.tokens.editor, body: body_in });
            expect(status).to.equal(409);
            expect(body.message).to.include("finalized");
        });
    });

    describe("POST /api/transactions/transaction-groups/from-statements", () => {
        let item;

        beforeEach(() => {
            item = BankStatementItem.create(h.db, {
                source: "big-bank",
                key: "stmt-1",
                amount: -52.30,
                date: YDate.parse("2026-06-02"),
                note: "WALMART #1234",
            });
        });

        function good_body() {
            return {
                statement_ids: [ item.id ],
                transactions: [
                    { source_fund_id: checking.id, target_fund_id: groceries.id, amount: 52.30, description: "Walmart" },
                ]
            };
        }

        it("reconciles a pending item into a new group", async () => {
            const { status, body } = await h.request("/api/transactions/transaction-groups/from-statements", { method: "POST", token: h.tokens.editor, body: good_body() });
            expect(status).to.equal(200);
            expect(body.data.date).to.equal("2026-06-02"); // derived from the item
            expect(body.data.statements).to.have.lengthOf(1);
            expect(body.data.statements[0].group_id).to.equal(body.data.id);
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["statements"] });
        });

        it("400s on bad statement_ids", async () => {
            const body_in = good_body();
            body_in.statement_ids = [];
            expect((await h.request("/api/transactions/transaction-groups/from-statements", { method: "POST", token: h.tokens.editor, body: body_in })).status).to.equal(400);

            body_in.statement_ids = [ 9999 ];
            expect((await h.request("/api/transactions/transaction-groups/from-statements", { method: "POST", token: h.tokens.editor, body: body_in })).status).to.equal(400);
        });

        it("409s on an already-reconciled item", async () => {
            await h.request("/api/transactions/transaction-groups/from-statements", { method: "POST", token: h.tokens.editor, body: good_body() });
            const { status, body } = await h.request("/api/transactions/transaction-groups/from-statements", { method: "POST", token: h.tokens.editor, body: good_body() });
            expect(status).to.equal(409);
            expect(body.message).to.include("already reconciled");
        });
    });

    describe("DELETE /api/transactions/transaction-group/:group_id", () => {
        it("deletes a group and its transactions", async () => {
            const group = create_group();
            const { status, body } = await h.request(`/api/transactions/transaction-group/${group.id}`, { method: "DELETE", token: h.tokens.editor });
            expect(status).to.equal(200);
            expect(body.data).to.be.null;
            expect(body.invalidations).to.deep.include({ type: "remove", key: ["transaction-group", group.id.toString()] });
            expect(TransactionGroup.for_id(h.db, group.id)).to.be.null;
        });

        it("releases reconciled statement items back to pending, and says so", async () => {
            const item = BankStatementItem.create(h.db, {
                source: "big-bank", key: "stmt-2", amount: -10, date: YDate.parse("2026-06-03"),
            });
            const group = TransactionGroup.create_from_statements(h.db, {
                statement_ids: [ item.id ],
                transactions: [
                    { source_fund_id: checking.id, target_fund_id: groceries.id, amount: 10, description: "x" },
                ]
            });

            const { body } = await h.request(`/api/transactions/transaction-group/${group.id}`, { method: "DELETE", token: h.tokens.editor });
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["statements"] });
            expect(BankStatementItem.for_id(h.db, item.id).group_id).to.be.null;
        });

        it("409s on allocation groups (managed via the allocations API)", async () => {
            Allocation.set(h.db, { month: YDate.parse("2026-06-01"), fund_id: groceries.id, amount: 100 });
            const group = TransactionGroup.from_db(h.db, { allocation: true })[0];

            const { status, body } = await h.request(`/api/transactions/transaction-group/${group.id}`, { method: "DELETE", token: h.tokens.editor });
            expect(status).to.equal(409);
            expect(body.message).to.include("allocations API");
        });

        it("409s in a finalized month", async () => {
            const group = create_group("2026-01-15");
            MonthFinalization.create(h.db, { month: YDate.parse("2026-01-01") });

            const { status } = await h.request(`/api/transactions/transaction-group/${group.id}`, { method: "DELETE", token: h.tokens.editor });
            expect(status).to.equal(409);
        });
    });

    describe("GET /api/transactions/transactions", () => {
        beforeEach(() => {
            create_group("2026-06-01", "Grocery run", 100);
            TransactionGroup.create_single(h.db, {
                date: YDate.parse("2026-06-05"),
                description: "Gas station",
                source_fund_id: checking.id,
                target_fund_id: gas.id,
                amount: 50,
            });
        });

        it("lists transactions flat with X-Total-Count", async () => {
            const { status, body, headers } = await h.request("/api/transactions/transactions", { token: h.tokens.reader });
            expect(status).to.equal(200);
            expect(headers.get("x-total-count")).to.equal("2");
            expect(body).to.have.lengthOf(2);
        });

        it("filters by fund involvement", async () => {
            let res = await h.request(`/api/transactions/transactions?target_fund_id=${gas.id}`, { token: h.tokens.reader });
            expect(res.body.map((t) => t.description)).to.deep.equal([ "Gas station" ]);

            res = await h.request(`/api/transactions/transactions?involving_fund_id=${checking.id}`, { token: h.tokens.reader });
            expect(res.body).to.have.lengthOf(2);
        });
    });

    describe("GET /api/transactions/transaction/:transaction_id", () => {
        it("returns a transaction, 404s on missing", async () => {
            const group = create_group();
            const txn = group.transactions[0];

            const { status, body } = await h.request(`/api/transactions/transaction/${txn.id}`, { token: h.tokens.reader });
            expect(status).to.equal(200);
            expect(body.id).to.equal(txn.id);
            expect(body.group_id).to.equal(group.id);

            expect((await h.request("/api/transactions/transaction/9999", { token: h.tokens.reader })).status).to.equal(404);
        });
    });
});
