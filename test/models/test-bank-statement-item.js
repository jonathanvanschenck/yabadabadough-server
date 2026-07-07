const { expect } = require("chai");
const { create_connection, initialize_db, ConflictError } = require("../../lib/db.js");
const BankStatementItem = require("../../models/BankStatementItem.js");
const TransactionGroup = require("../../models/TransactionGroup.js");
const Fund = require("../../models/Fund.js");
const YDate = require("../../lib/YDate.js");

describe("BankStatementItem Model", () => {
    let db;
    let checking_fund;
    let groceries_fund;

    beforeEach(() => {
        db = create_connection({ path: ":memory:" });
        initialize_db(db);

        checking_fund = Fund.create(db, {
            name: "Checking",
            tracked: true,
            monthly: false,
            pool: true,
            start_date: YDate.parse("2026-01-01"),
            start_balance: 1000.00,
        });

        groceries_fund = Fund.create(db, {
            name: "Groceries",
            tracked: true,
            monthly: true,
            parent_id: checking_fund.id,
            start_date: YDate.parse("2026-01-01"),
            start_balance: 0.00,
        });
    });

    afterEach(() => {
        db.close();
    });

    // Reconcile an item into a simple single-transaction group
    function reconcile(item) {
        return TransactionGroup.create_from_statements(db, {
            statement_ids: [item.id],
            transactions: [{
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: Math.abs(item.amount),
                description: "Reconciled",
            }]
        });
    }

    describe("create()", () => {
        it("should create a pending item", () => {
            const item = BankStatementItem.create(db, {
                source: "boa",
                key: "txn-001",
                amount: -52.30,
                date: YDate.parse("2026-06-02"),
                note: "WALMART #1234",
            });

            expect(item.id).to.be.a("number");
            expect(item.source).to.equal("boa");
            expect(item.key).to.equal("txn-001");
            expect(item.amount).to.equal(-52.30);
            expect(item.date.toString()).to.equal("2026-06-02");
            expect(item.note).to.equal("WALMART #1234");
            expect(item.ignored).to.be.false;
            expect(item.group_id).to.be.null;
            expect(item.created_at).to.be.a("Date");
        });

        it("should round-trip positive amounts and null notes", () => {
            const item = BankStatementItem.create(db, {
                source: "boa",
                key: "txn-002",
                amount: 1234.56,
                date: YDate.parse("2026-06-03"),
            });

            expect(item.amount).to.equal(1234.56);
            expect(item.note).to.be.null;
        });

        it("should reject a duplicate (source, key)", () => {
            BankStatementItem.create(db, {
                source: "boa",
                key: "txn-001",
                amount: -10.00,
                date: YDate.parse("2026-06-02"),
            });

            expect(() => BankStatementItem.create(db, {
                source: "boa",
                key: "txn-001",
                amount: -99.00,
                date: YDate.parse("2026-06-09"),
            })).to.throw(ConflictError);
        });

        it("should allow the same key under a different source", () => {
            BankStatementItem.create(db, {
                source: "boa",
                key: "txn-001",
                amount: -10.00,
                date: YDate.parse("2026-06-02"),
            });

            const item = BankStatementItem.create(db, {
                source: "chase",
                key: "txn-001",
                amount: -20.00,
                date: YDate.parse("2026-06-02"),
            });

            expect(item.source).to.equal("chase");
        });

        it("should reject a zero amount", () => {
            expect(() => BankStatementItem.create(db, {
                source: "boa",
                key: "txn-001",
                amount: 0,
                date: YDate.parse("2026-06-02"),
            })).to.throw(/zero/);
        });

        it("should reject missing facts", () => {
            expect(() => BankStatementItem.create(db, {
                key: "txn-001", amount: -1, date: YDate.parse("2026-06-02"),
            })).to.throw(/source/);
            expect(() => BankStatementItem.create(db, {
                source: "boa", amount: -1, date: YDate.parse("2026-06-02"),
            })).to.throw(/key/);
            expect(() => BankStatementItem.create(db, {
                source: "boa", key: "txn-001", amount: -1,
            })).to.throw(/date/);
            expect(() => BankStatementItem.create(db, {
                source: "boa", key: "txn-001", date: YDate.parse("2026-06-02"),
            })).to.throw(/amount/);
        });
    });

    describe("import_many()", () => {
        const items = [
            { source: "boa", key: "txn-001", amount: -52.30, date: YDate.parse("2026-06-02"), note: "WALMART" },
            { source: "boa", key: "txn-002", amount: -12.00, date: YDate.parse("2026-06-03"), note: "GAS" },
            { source: "boa", key: "txn-003", amount: 2500.00, date: YDate.parse("2026-06-05"), note: "PAYROLL" },
        ];

        it("should import all new items", () => {
            const { created, skipped } = BankStatementItem.import_many(db, items);

            expect(created).to.have.lengthOf(3);
            expect(skipped).to.have.lengthOf(0);
            expect(created.map(i => i.key)).to.deep.equal(["txn-001", "txn-002", "txn-003"]);
            expect(created[0].amount).to.equal(-52.30);
        });

        it("should skip everything on a full re-import", () => {
            BankStatementItem.import_many(db, items);
            const { created, skipped } = BankStatementItem.import_many(db, items);

            expect(created).to.have.lengthOf(0);
            expect(skipped).to.deep.equal(items.map(({ source, key }) => ({ source, key })));
        });

        it("should import only the new items on a partial overlap", () => {
            BankStatementItem.import_many(db, items.slice(0, 2));
            const { created, skipped } = BankStatementItem.import_many(db, items);

            expect(created).to.have.lengthOf(1);
            expect(created[0].key).to.equal("txn-003");
            expect(skipped).to.have.lengthOf(2);
        });

        it("should never mutate existing rows on re-import", () => {
            const [item] = BankStatementItem.import_many(db, items.slice(0, 1)).created;
            item.update(db, { ignored: true, note: "user note" });

            // Re-import the same key with different facts: everything is
            // ignored, the original row survives untouched
            BankStatementItem.import_many(db, [
                { source: "boa", key: "txn-001", amount: -99.99, date: YDate.parse("2026-06-09"), note: "CHANGED" },
            ]);

            const fresh = BankStatementItem.for_id(db, item.id);
            expect(fresh.amount).to.equal(-52.30);
            expect(fresh.date.toString()).to.equal("2026-06-02");
            expect(fresh.note).to.equal("user note");
            expect(fresh.ignored).to.be.true;
        });

        it("should roll back the whole batch when an item is invalid", () => {
            expect(() => BankStatementItem.import_many(db, [
                ...items,
                { source: "boa", key: "txn-bad", amount: 0, date: YDate.parse("2026-06-05") },
            ])).to.throw(/zero/);

            expect(BankStatementItem.from_db(db)).to.have.lengthOf(0);
        });
    });

    describe("for_id() / for_key()", () => {
        it("should retrieve by id and by (source, key)", () => {
            const item = BankStatementItem.create(db, {
                source: "boa",
                key: "txn-001",
                amount: -52.30,
                date: YDate.parse("2026-06-02"),
            });

            expect(BankStatementItem.for_id(db, item.id).key).to.equal("txn-001");
            expect(BankStatementItem.for_key(db, { source: "boa", key: "txn-001" }).id).to.equal(item.id);
        });

        it("should return null when missing", () => {
            expect(BankStatementItem.for_id(db, 99999)).to.be.null;
            expect(BankStatementItem.for_key(db, { source: "boa", key: "nope" })).to.be.null;
        });
    });

    describe("from_db()", () => {
        let walmart, gas, payroll;

        beforeEach(() => {
            walmart = BankStatementItem.create(db, {
                source: "boa", key: "txn-001", amount: -52.30, date: YDate.parse("2026-06-02"),
            });
            gas = BankStatementItem.create(db, {
                source: "boa", key: "txn-002", amount: -12.00, date: YDate.parse("2026-06-03"),
            });
            payroll = BankStatementItem.create(db, {
                source: "chase", key: "txn-001", amount: 2500.00, date: YDate.parse("2026-06-05"),
            });

            gas.update(db, { ignored: true });
            reconcile(walmart);
        });

        it("should filter by source", () => {
            const rows = BankStatementItem.from_db(db, { source: "boa" });
            expect(rows.map(r => r.key).sort()).to.deep.equal(["txn-001", "txn-002"]);
        });

        it("should filter by date window (inclusive)", () => {
            const rows = BankStatementItem.from_db(db, {
                since: YDate.parse("2026-06-03"),
                until: YDate.parse("2026-06-05"),
                order_by: "date",
                order_direction: "ASC",
            });
            expect(rows.map(r => r.id)).to.deep.equal([gas.id, payroll.id]);
        });

        it("should filter by ignored", () => {
            const rows = BankStatementItem.from_db(db, { ignored: true });
            expect(rows.map(r => r.id)).to.deep.equal([gas.id]);
        });

        it("should filter by has_group", () => {
            const linked = BankStatementItem.from_db(db, { has_group: true });
            expect(linked.map(r => r.id)).to.deep.equal([walmart.id]);
            expect(linked[0].group_id).to.be.a("number");

            const unlinked = BankStatementItem.from_db(db, { has_group: false });
            expect(unlinked.map(r => r.id).sort()).to.deep.equal([gas.id, payroll.id].sort());
        });

        it("should find pending items (not ignored, no group)", () => {
            const rows = BankStatementItem.from_db(db, { ignored: false, has_group: false });
            expect(rows.map(r => r.id)).to.deep.equal([payroll.id]);
        });

        it("should filter by group_id", () => {
            const group_id = BankStatementItem.for_id(db, walmart.id).group_id;
            const rows = BankStatementItem.from_db(db, { group_id });
            expect(rows.map(r => r.id)).to.deep.equal([walmart.id]);
        });

        it("should order and paginate", () => {
            const rows = BankStatementItem.from_db(db, {
                order_by: "date",
                order_direction: "ASC",
                limit: 1,
                offset: 1,
            });
            expect(rows.map(r => r.id)).to.deep.equal([gas.id]);
        });
    });

    describe("update()", () => {
        let item;

        beforeEach(() => {
            item = BankStatementItem.create(db, {
                source: "boa", key: "txn-001", amount: -52.30, date: YDate.parse("2026-06-02"),
            });
        });

        it("should toggle ignored both ways", () => {
            let fresh = item.update(db, { ignored: true });
            expect(fresh.ignored).to.be.true;

            fresh = fresh.update(db, { ignored: false });
            expect(fresh.ignored).to.be.false;
        });

        it("should update note without touching ignored", () => {
            item.update(db, { ignored: true });
            const fresh = BankStatementItem.for_id(db, item.id).update(db, { note: "hello" });

            expect(fresh.note).to.equal("hello");
            expect(fresh.ignored).to.be.true;
        });

        it("should refuse to ignore a reconciled item", () => {
            reconcile(item);
            expect(() => item.update(db, { ignored: true })).to.throw(ConflictError);
        });

        it("should allow ignore -> unignore -> reconcile", () => {
            item.update(db, { ignored: true });
            BankStatementItem.for_id(db, item.id).update(db, { ignored: false });

            const group = reconcile(item);
            expect(BankStatementItem.for_id(db, item.id).group_id).to.equal(group.id);
        });
    });

    describe("delete()", () => {
        it("should always throw, pointing at TransactionGroup.delete_statement_item", () => {
            const item = BankStatementItem.create(db, {
                source: "boa", key: "txn-001", amount: -52.30, date: YDate.parse("2026-06-02"),
            });

            expect(() => item.delete(db)).to.throw(/TransactionGroup\.delete_statement_item/);
            expect(BankStatementItem.for_id(db, item.id)).to.not.be.null;
        });
    });

    describe("db CHECK backstop", () => {
        it("should reject ignored + linked at the db level", () => {
            const item = BankStatementItem.create(db, {
                source: "boa", key: "txn-001", amount: -52.30, date: YDate.parse("2026-06-02"),
            });
            const group = reconcile(item);

            // Around the model layer entirely: SQLite itself must refuse
            expect(() => db.prepare(
                "UPDATE bank_statement_items SET ignored = 1 WHERE id = ?"
            ).run(item.id)).to.throw(/CHECK/);

            const ignored = BankStatementItem.create(db, {
                source: "boa", key: "txn-002", amount: -1.00, date: YDate.parse("2026-06-02"),
            }).update(db, { ignored: true });
            expect(() => db.prepare(
                "UPDATE bank_statement_items SET group_id = ? WHERE id = ?"
            ).run(group.id, ignored.id)).to.throw(/CHECK/);
        });
    });

    describe("to_api()", () => {
        it("should serialize to API format correctly", () => {
            const item = BankStatementItem.create(db, {
                source: "boa",
                key: "txn-001",
                amount: -52.30,
                date: YDate.parse("2026-06-02"),
                note: "WALMART #1234",
            });

            const api_data = item.to_api();

            expect(api_data.id).to.equal(item.id);
            expect(api_data.source).to.equal("boa");
            expect(api_data.key).to.equal("txn-001");
            expect(api_data.ignored).to.be.false;
            expect(api_data.group_id).to.be.null;
            expect(api_data.amount).to.equal(-52.30);
            expect(api_data.date).to.equal("2026-06-02");
            expect(api_data.note).to.equal("WALMART #1234");
            expect(api_data.created_at).to.be.a("string");
        });
    });
});
