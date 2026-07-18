const { expect } = require("chai");

const { start_harness } = require("./harness.js");
const YDate = require("../../lib/YDate.js");
const Fund = require("../../models/Fund.js");
const TransactionGroup = require("../../models/TransactionGroup.js");
const BankStatementItem = require("../../models/BankStatementItem.js");
const Allocation = require("../../models/Allocation.js");

describe("Statements API", () => {
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

    function import_items() {
        return BankStatementItem.import_many(h.db, [
            { source: "big-bank", key: "k-1", amount: -10.00, date: YDate.parse("2026-06-01") },
            { source: "big-bank", key: "k-2", amount: -20.00, date: YDate.parse("2026-06-05"), note: "WALMART" },
            { source: "other-bank", key: "k-3", amount: 30.00, date: YDate.parse("2026-06-10") },
        ]).created;
    }

    function reconcile(item) {
        return TransactionGroup.create_from_statements(h.db, {
            statement_ids: [ item.id ],
            transactions: [{
                source_fund_id: checking.id,
                target_fund_id: groceries.id,
                amount: Math.abs(item.amount),
                description: "Reconciled",
            }]
        });
    }

    describe("GET /api/statements/statements", () => {
        it("requires authentication", async () => {
            expect((await h.request("/api/statements/statements")).status).to.equal(401);
        });

        it("lists items (date DESC) with X-Total-Count", async () => {
            import_items();
            const { status, body, headers } = await h.request("/api/statements/statements", { token: h.tokens.reader });
            expect(status).to.equal(200);
            expect(headers.get("x-total-count")).to.equal("3");
            expect(body.map((s) => s.key)).to.deep.equal([ "k-3", "k-2", "k-1" ]);
        });

        it("filters by source and dates", async () => {
            import_items();
            let res = await h.request("/api/statements/statements?source=big-bank", { token: h.tokens.reader });
            expect(res.body).to.have.lengthOf(2);

            res = await h.request("/api/statements/statements?since=2026-06-05&until=2026-06-09", { token: h.tokens.reader });
            expect(res.body.map((s) => s.key)).to.deep.equal([ "k-2" ]);
        });

        it("supports the state shorthand", async () => {
            const [ first, second ] = import_items();
            reconcile(first);
            BankStatementItem.for_id(h.db, second.id).update(h.db, { ignored: true });

            let res = await h.request("/api/statements/statements?state=pending", { token: h.tokens.reader });
            expect(res.body.map((s) => s.key)).to.deep.equal([ "k-3" ]);
            expect(res.body[0].state).to.equal("pending");

            res = await h.request("/api/statements/statements?state=ignored", { token: h.tokens.reader });
            expect(res.body.map((s) => s.key)).to.deep.equal([ "k-2" ]);
            expect(res.body[0].state).to.equal("ignored");

            res = await h.request("/api/statements/statements?state=reconciled", { token: h.tokens.reader });
            expect(res.body.map((s) => s.key)).to.deep.equal([ "k-1" ]);
            expect(res.body[0].state).to.equal("reconciled");
        });

        it("searches across source, key, and note", async () => {
            import_items();
            // note match (case-insensitive), and X-Total-Count reflects the search
            let res = await h.request("/api/statements/statements?search=walmart", { token: h.tokens.reader });
            expect(res.headers.get("x-total-count")).to.equal("1");
            expect(res.body.map((s) => s.key)).to.deep.equal([ "k-2" ]);

            // source match spans multiple rows
            res = await h.request("/api/statements/statements?search=other", { token: h.tokens.reader });
            expect(res.body.map((s) => s.key)).to.deep.equal([ "k-3" ]);
        });

        it("orders by the new sortable columns and paginates with X-Total-Count", async () => {
            import_items();
            // amount ascending: -20, -10, 30
            let res = await h.request("/api/statements/statements?order_by=amount&order_direction=asc", { token: h.tokens.reader });
            expect(res.body.map((s) => s.key)).to.deep.equal([ "k-2", "k-1", "k-3" ]);

            // one page at a time; total still reports the full match count
            res = await h.request("/api/statements/statements?order_by=amount&order_direction=asc&limit=2&offset=2", { token: h.tokens.reader });
            expect(res.headers.get("x-total-count")).to.equal("3");
            expect(res.body.map((s) => s.key)).to.deep.equal([ "k-3" ]);
        });

        it("rejects an unsupported order_by via the shared list params (falls back, not 500)", async () => {
            import_items();
            // A bad order_by is coerced away (string_to_enum -> undefined), so the
            // endpoint falls back to its default ordering rather than erroring.
            const res = await h.request("/api/statements/statements?order_by=amount%27); DROP", { token: h.tokens.reader });
            expect(res.status).to.equal(200);
        });
    });

    describe("GET /api/statements/statements/sources", () => {
        it("requires authentication", async () => {
            expect((await h.request("/api/statements/statements/sources")).status).to.equal(401);
        });

        it("lists the distinct sources, sorted, with X-Total-Count", async () => {
            import_items();
            const { status, body, headers } = await h.request("/api/statements/statements/sources", { token: h.tokens.reader });
            expect(status).to.equal(200);
            expect(headers.get("x-total-count")).to.equal("2");
            expect(body).to.deep.equal([ "big-bank", "other-bank" ]);
        });
    });

    describe("GET /api/statements/statement/:statement_id", () => {
        it("returns an item, 404s on missing", async () => {
            const [ item ] = import_items();
            const { status, body } = await h.request(`/api/statements/statement/${item.id}`, { token: h.tokens.reader });
            expect(status).to.equal(200);
            expect(body.key).to.equal("k-1");
            expect(body.amount).to.equal(-10);

            expect((await h.request("/api/statements/statement/9999", { token: h.tokens.reader })).status).to.equal(404);
        });
    });

    describe("POST /api/statements/statements/import", () => {
        const good_body = {
            items: [
                { source: "big-bank", key: "n-1", amount: -5.25, date: "2026-06-11" },
                { source: "big-bank", key: "n-2", amount: 12.00, date: "2026-06-12", note: "PAYCHECK" },
            ]
        };

        it("requires the editor role", async () => {
            expect((await h.request("/api/statements/statements/import", { method: "POST", token: h.tokens.reader, body: good_body })).status).to.equal(403);
        });

        it("imports items and reports them", async () => {
            const { status, body } = await h.request("/api/statements/statements/import", { method: "POST", token: h.tokens.editor, body: good_body });
            expect(status).to.equal(200);
            expect(body.data.created).to.have.lengthOf(2);
            expect(body.data.skipped).to.have.lengthOf(0);
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["statements"] });
        });

        it("skips existing (source, key) rows on re-sync, preserving their state", async () => {
            const first = await h.request("/api/statements/statements/import", { method: "POST", token: h.tokens.editor, body: good_body });
            const imported = first.body.data.created[0];
            BankStatementItem.for_id(h.db, imported.id).update(h.db, { ignored: true });

            const { body } = await h.request("/api/statements/statements/import", { method: "POST", token: h.tokens.editor, body: good_body });
            expect(body.data.created).to.have.lengthOf(0);
            expect(body.data.skipped).to.deep.include({ source: "big-bank", key: "n-1" });

            expect(BankStatementItem.for_id(h.db, imported.id).ignored).to.be.true;
        });

        it("400s on malformed items", async () => {
            let res = await h.request("/api/statements/statements/import", { method: "POST", token: h.tokens.editor, body: { items: [] } });
            expect(res.status).to.equal(400);

            res = await h.request("/api/statements/statements/import", { method: "POST", token: h.tokens.editor, body: { items: [ { source: "x", key: "y", amount: "ten", date: "2026-06-11" } ] } });
            expect(res.status).to.equal(400);
            expect(res.body.message).to.include("items[0]");
        });

        it("400s on a zero amount (model rule)", async () => {
            const res = await h.request("/api/statements/statements/import", { method: "POST", token: h.tokens.editor, body: { items: [ { source: "x", key: "y", amount: 0, date: "2026-06-11" } ] } });
            expect(res.status).to.equal(400);
            expect(res.body.message).to.include("zero");
        });
    });

    describe("PATCH /api/statements/statement/:statement_id", () => {
        it("updates ignored and note", async () => {
            const [ item ] = import_items();
            const { status, body } = await h.request(`/api/statements/statement/${item.id}`, { method: "PATCH", token: h.tokens.editor, body: { ignored: true, note: "junk" } });
            expect(status).to.equal(200);
            expect(body.data.ignored).to.be.true;
            expect(body.data.note).to.equal("junk");
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["statement", item.id.toString()] });
        });

        it("409s when ignoring a reconciled item", async () => {
            const [ item ] = import_items();
            reconcile(item);
            const { status, body } = await h.request(`/api/statements/statement/${item.id}`, { method: "PATCH", token: h.tokens.editor, body: { ignored: true } });
            expect(status).to.equal(409);
            expect(body.message).to.include("reconciled");
        });

        it("leaves the immutable bank facts untouched", async () => {
            const [ item ] = import_items();
            // amount is not in the accepted field spec, so it is never applied
            const { status, body } = await h.request(`/api/statements/statement/${item.id}`, { method: "PATCH", token: h.tokens.editor, body: { note: "kept", amount: 999 } });
            expect(status).to.equal(200);
            expect(body.data.amount).to.equal(-10);
        });
    });

    describe("POST /api/statements/statement/:statement_id/link", () => {
        function make_plain_group() {
            return TransactionGroup.create_single(h.db, {
                date: YDate.parse("2026-06-02"),
                description: "Pre-entered",
                source_fund_id: checking.id,
                target_fund_id: groceries.id,
                amount: 10.00,
            });
        }

        it("requires the editor role", async () => {
            const [ item ] = import_items();
            const group = make_plain_group();
            expect((await h.request(`/api/statements/statement/${item.id}/link`, { method: "POST", token: h.tokens.reader, body: { group_id: group.id } })).status).to.equal(403);
        });

        it("links a pending item to an existing group without touching its transactions", async () => {
            const [ item ] = import_items();
            const group = make_plain_group();

            const { status, body } = await h.request(`/api/statements/statement/${item.id}/link`, { method: "POST", token: h.tokens.editor, body: { group_id: group.id } });
            expect(status).to.equal(200);
            expect(body.data.id).to.equal(group.id);
            expect(body.data.transactions).to.have.lengthOf(1);
            expect(body.data.statements.map((s) => s.id)).to.deep.equal([ item.id ]);
            expect(body.data.statements[0].state).to.equal("reconciled");
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["statement", item.id.toString()] });
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["transaction-group", group.id.toString()] });

            expect(BankStatementItem.for_id(h.db, item.id).group_id).to.equal(group.id);
        });

        it("404s on a missing item, 400s on an unknown group_id", async () => {
            const group = make_plain_group();
            expect((await h.request(`/api/statements/statement/9999/link`, { method: "POST", token: h.tokens.editor, body: { group_id: group.id } })).status).to.equal(404);

            const [ item ] = import_items();
            let res = await h.request(`/api/statements/statement/${item.id}/link`, { method: "POST", token: h.tokens.editor, body: { group_id: 9999 } });
            expect(res.status).to.equal(400);
            expect(res.body.message).to.include("group_id");

            res = await h.request(`/api/statements/statement/${item.id}/link`, { method: "POST", token: h.tokens.editor, body: {} });
            expect(res.status).to.equal(400);
        });

        it("409s on ignored and already-reconciled items", async () => {
            const [ first, second ] = import_items();
            const group = make_plain_group();

            BankStatementItem.for_id(h.db, first.id).update(h.db, { ignored: true });
            expect((await h.request(`/api/statements/statement/${first.id}/link`, { method: "POST", token: h.tokens.editor, body: { group_id: group.id } })).status).to.equal(409);

            reconcile(second);
            expect((await h.request(`/api/statements/statement/${second.id}/link`, { method: "POST", token: h.tokens.editor, body: { group_id: group.id } })).status).to.equal(409);
        });

        it("409s on allocation groups", async () => {
            const [ item ] = import_items();
            Allocation.set(h.db, {
                month: YDate.parse("2026-06-01"),
                fund_id: groceries.id,
                amount: 200.00,
            });
            const alloc_group = TransactionGroup.from_db(h.db, { allocation: true })[0];

            const { status, body } = await h.request(`/api/statements/statement/${item.id}/link`, { method: "POST", token: h.tokens.editor, body: { group_id: alloc_group.id } });
            expect(status).to.equal(409);
            expect(body.message).to.include("Allocation");
        });
    });

    describe("POST /api/statements/statement/:statement_id/unlink", () => {
        it("requires the editor role", async () => {
            const [ item ] = import_items();
            reconcile(item);
            expect((await h.request(`/api/statements/statement/${item.id}/unlink`, { method: "POST", token: h.tokens.reader })).status).to.equal(403);
        });

        it("releases a reconciled item to pending while the group survives", async () => {
            const [ item ] = import_items();
            const group = reconcile(item);

            const { status, body } = await h.request(`/api/statements/statement/${item.id}/unlink`, { method: "POST", token: h.tokens.editor });
            expect(status).to.equal(200);
            expect(body.data.id).to.equal(item.id);
            expect(body.data.state).to.equal("pending");
            expect(body.data.group_id).to.be.null;
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["statement", item.id.toString()] });
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["transaction-group", group.id.toString()] });
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["transaction-groups"] });

            // Item back to pending; group and its transactions untouched
            expect(BankStatementItem.for_id(h.db, item.id).group_id).to.be.null;
            const surviving = TransactionGroup.for_id(h.db, group.id);
            expect(surviving).to.not.be.null;
            expect(surviving.transactions).to.have.lengthOf(1);
            expect(surviving.statements).to.deep.equal([]);
        });

        it("404s on a missing item", async () => {
            expect((await h.request(`/api/statements/statement/9999/unlink`, { method: "POST", token: h.tokens.editor })).status).to.equal(404);
        });

        it("409s on pending and ignored items", async () => {
            const [ pending, toIgnore ] = import_items();

            expect((await h.request(`/api/statements/statement/${pending.id}/unlink`, { method: "POST", token: h.tokens.editor })).status).to.equal(409);

            BankStatementItem.for_id(h.db, toIgnore.id).update(h.db, { ignored: true });
            expect((await h.request(`/api/statements/statement/${toIgnore.id}/unlink`, { method: "POST", token: h.tokens.editor })).status).to.equal(409);
        });

        it("409s on a double unlink", async () => {
            const [ item ] = import_items();
            reconcile(item);

            expect((await h.request(`/api/statements/statement/${item.id}/unlink`, { method: "POST", token: h.tokens.editor })).status).to.equal(200);
            expect((await h.request(`/api/statements/statement/${item.id}/unlink`, { method: "POST", token: h.tokens.editor })).status).to.equal(409);
        });

        it("supports re-pointing an item to a new group (unlink then link)", async () => {
            const [ item ] = import_items();
            reconcile(item);

            await h.request(`/api/statements/statement/${item.id}/unlink`, { method: "POST", token: h.tokens.editor });

            const target = TransactionGroup.create_single(h.db, {
                date: YDate.parse("2026-06-02"),
                description: "Correct group",
                source_fund_id: checking.id,
                target_fund_id: groceries.id,
                amount: 10.00,
            });
            const { status, body } = await h.request(`/api/statements/statement/${item.id}/link`, { method: "POST", token: h.tokens.editor, body: { group_id: target.id } });
            expect(status).to.equal(200);
            expect(body.data.statements.map((s) => s.id)).to.deep.equal([ item.id ]);
            expect(BankStatementItem.for_id(h.db, item.id).group_id).to.equal(target.id);
        });
    });

    describe("DELETE /api/statements/statement/:statement_id", () => {
        it("deletes a pending item", async () => {
            const [ item ] = import_items();
            const { status, body } = await h.request(`/api/statements/statement/${item.id}`, { method: "DELETE", token: h.tokens.editor });
            expect(status).to.equal(200);
            expect(body.data).to.be.null;
            expect(body.invalidations).to.deep.include({ type: "remove", key: ["statement", item.id.toString()] });
            expect(BankStatementItem.for_id(h.db, item.id)).to.be.null;
        });

        it("with_group (default) destroys the reconciling group too", async () => {
            const [ item ] = import_items();
            const group = reconcile(item);

            const { body } = await h.request(`/api/statements/statement/${item.id}`, { method: "DELETE", token: h.tokens.editor });
            expect(body.invalidations).to.deep.include({ type: "remove", key: ["transaction-group", group.id.toString()] });
            expect(TransactionGroup.for_id(h.db, group.id)).to.be.null;
        });

        it("with_group=false leaves the group standing", async () => {
            const [ item ] = import_items();
            const group = reconcile(item);

            await h.request(`/api/statements/statement/${item.id}?with_group=false`, { method: "DELETE", token: h.tokens.editor });
            expect(BankStatementItem.for_id(h.db, item.id)).to.be.null;
            expect(TransactionGroup.for_id(h.db, group.id)).to.not.be.null;
        });
    });
});
