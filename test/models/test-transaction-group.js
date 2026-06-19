const { expect } = require("chai");
const { create_connection, initialize_db } = require("../../lib/db.js");
const TransactionGroup = require("../../models/TransactionGroup.js");
const Fund = require("../../models/Fund.js");
const YDate = require("../../lib/YDate.js");

describe("TransactionGroup Model", () => {
    let db;
    let checking_fund;
    let groceries_fund;
    let gas_fund;

    beforeEach(() => {
        db = create_connection({ path: ":memory:" });
        initialize_db(db);

        // Create test funds
        checking_fund = Fund.create(db, {
            name: "Checking",
            tracked: true,
            monthly: false,
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

        gas_fund = Fund.create(db, {
            name: "Gas",
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

    describe("create_single()", () => {
        it("should create a transaction group with a single transaction", () => {
            const group = TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-01"),
                description: "Grocery shopping",
                note: "Weekly groceries",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 125.50,
            });

            expect(group).to.not.be.null;
            expect(group.id).to.be.a("number");
            expect(group.description).to.equal("Grocery shopping");
            expect(group.note).to.equal("Weekly groceries");
            expect(group.date.toString()).to.equal("2026-06-01");
            expect(group.split).to.be.false;
            expect(group.allocation).to.be.false;
            expect(group.eom_cleanup).to.be.false;
            expect(group.transactions).to.have.lengthOf(1);

            const txn = group.transactions[0];
            expect(txn.source_fund_id).to.equal(checking_fund.id);
            expect(txn.target_fund_id).to.equal(groceries_fund.id);
            expect(txn.amount).to.equal(125.50);
            expect(txn.description).to.equal("Grocery shopping");
            expect(txn.note).to.equal("Weekly groceries");
            expect(txn.date.toString()).to.equal("2026-06-01");
        });

        it("should create a transaction with null note when not provided", () => {
            const group = TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-01"),
                description: "Gas station",
                source_fund_id: checking_fund.id,
                target_fund_id: gas_fund.id,
                amount: 45.00,
            });

            expect(group.note).to.be.null;
            expect(group.transactions[0].note).to.be.null;
        });
    });

    describe("create()", () => {
        it("should create a transaction group with a single transaction", () => {
            const group = TransactionGroup.create(db, {
                date: YDate.parse("2026-06-02"),
                description: "Grocery shopping",
                note: "Test note",
                transactions: [{
                    source_fund_id: checking_fund.id,
                    target_fund_id: groceries_fund.id,
                    amount: 75.25,
                    description: "Grocery shopping",
                    note: "Test note",
                }]
            });

            expect(group).to.not.be.null;
            expect(group.split).to.be.false;
            expect(group.transactions).to.have.lengthOf(1);
        });

        it("should create a split transaction group with multiple transactions", () => {
            const group = TransactionGroup.create(db, {
                date: YDate.parse("2026-06-03"),
                description: "Combined shopping trip",
                transactions: [
                    {
                        source_fund_id: checking_fund.id,
                        target_fund_id: groceries_fund.id,
                        amount: 60.00,
                        description: "Groceries portion",
                    },
                    {
                        source_fund_id: checking_fund.id,
                        target_fund_id: gas_fund.id,
                        amount: 40.00,
                        description: "Gas portion",
                    }
                ]
            });

            expect(group).to.not.be.null;
            expect(group.split).to.be.true;
            expect(group.transactions).to.have.lengthOf(2);
            expect(group.transactions[0].amount).to.equal(60.00);
            expect(group.transactions[1].amount).to.equal(40.00);
        });

        it("should handle YDate objects for transaction dates", () => {
            const test_date = YDate.parse("2026-05-15");
            const group = TransactionGroup.create(db, {
                date: test_date,
                description: "Date test",
                transactions: [{
                    source_fund_id: checking_fund.id,
                    target_fund_id: groceries_fund.id,
                    amount: 50.00,
                    description: "Date test",
                }]
            });

            expect(group.date.toString()).to.equal("2026-05-15");
            expect(group.transactions[0].date.toString()).to.equal("2026-05-15");
        });
    });

    describe("error handling", () => {
        it("should throw error when no transactions provided", () => {
            expect(() => {
                TransactionGroup.create(db, {
                    date: YDate.parse("2026-06-01"),
                    description: "No transactions",
                    transactions: []
                });
            }).to.throw("Must provide at least transaction");
        });

        it("should throw error when transaction amount is zero", () => {
            expect(() => {
                TransactionGroup.create(db, {
                    date: YDate.parse("2026-06-01"),
                    description: "Zero amount",
                    transactions: [{
                        source_fund_id: checking_fund.id,
                        target_fund_id: groceries_fund.id,
                        amount: 0,
                        description: "Zero amount",
                    }]
                });
            }).to.throw("Transaction amount must be positive");
        });

        it("should throw error when transaction amount is negative", () => {
            expect(() => {
                TransactionGroup.create(db, {
                    date: YDate.parse("2026-06-01"),
                    description: "Negative amount",
                    transactions: [{
                        source_fund_id: checking_fund.id,
                        target_fund_id: groceries_fund.id,
                        amount: -50.00,
                        description: "Negative amount",
                    }]
                });
            }).to.throw("Transaction amount must be positive");
        });

        it("should throw error when source and target funds are the same", () => {
            expect(() => {
                TransactionGroup.create(db, {
                    date: YDate.parse("2026-06-01"),
                    description: "Same fund",
                    transactions: [{
                        source_fund_id: checking_fund.id,
                        target_fund_id: checking_fund.id,
                        amount: 100.00,
                        description: "Same fund",
                    }]
                });
            }).to.throw("Source and target funds cannot be the same");
        });

        it("should throw error when source fund does not exist", () => {
            expect(() => {
                TransactionGroup.create(db, {
                    date: YDate.parse("2026-06-01"),
                    description: "Invalid source",
                    transactions: [{
                        source_fund_id: 99999,
                        target_fund_id: groceries_fund.id,
                        amount: 100.00,
                        description: "Invalid source",
                    }]
                });
            }).to.throw("Source fund does not exist");
        });

        it("should throw error when target fund does not exist", () => {
            expect(() => {
                TransactionGroup.create(db, {
                    date: YDate.parse("2026-06-01"),
                    description: "Invalid target",
                    transactions: [{
                        source_fund_id: checking_fund.id,
                        target_fund_id: 99999,
                        amount: 100.00,
                        description: "Invalid target",
                    }]
                });
            }).to.throw("Target fund does not exist");
        });

        it("should throw error when description is missing", () => {
            expect(() => {
                TransactionGroup.create(db, {
                    date: YDate.parse("2026-06-01"),
                    description: "Group desc",
                    transactions: [{
                        source_fund_id: checking_fund.id,
                        target_fund_id: groceries_fund.id,
                        amount: 100.00,
                        description: "",
                    }]
                });
            }).to.throw("Missing description");
        });
    });

    describe("for_id()", () => {
        it("should retrieve a transaction group by id", () => {
            const created = TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-01"),
                description: "Test retrieval",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 99.99,
            });

            const retrieved = TransactionGroup.for_id(db, created.id);

            expect(retrieved).to.not.be.null;
            expect(retrieved.id).to.equal(created.id);
            expect(retrieved.description).to.equal("Test retrieval");
            expect(retrieved.transactions).to.have.lengthOf(1);
            expect(retrieved.transactions[0].amount).to.equal(99.99);
        });

        it("should return null for non-existent id", () => {
            const retrieved = TransactionGroup.for_id(db, 99999);
            expect(retrieved).to.be.null;
        });
    });

    describe("to_api()", () => {
        it("should serialize to API format correctly", () => {
            const group = TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-01"),
                description: "API test",
                note: "Test note",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 50.00,
            });

            const api_data = group.to_api();

            expect(api_data.id).to.equal(group.id);
            expect(api_data.description).to.equal("API test");
            expect(api_data.note).to.equal("Test note");
            expect(api_data.date).to.equal("2026-06-01");
            expect(api_data.status).to.deep.equal({
                split: false,
                allocation: false,
                eom_cleanup: false,
            });
            expect(api_data.statement_id).to.be.null;
            expect(api_data.transactions).to.be.an("array");
            expect(api_data.transactions).to.have.lengthOf(1);
            expect(api_data.created_at).to.be.a("string");
        });
    });

    describe("from_db()", () => {
        let group1, group2, group3, group4;

        beforeEach(() => {
            // Create test data with various dates and properties
            group1 = TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-01"),
                description: "Grocery shopping",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 100.00,
            });

            group2 = TransactionGroup.create(db, {
                date: YDate.parse("2026-06-05"),
                description: "Split transaction",
                transactions: [
                    {
                        source_fund_id: checking_fund.id,
                        target_fund_id: groceries_fund.id,
                        amount: 60.00,
                        description: "Groceries",
                    },
                    {
                        source_fund_id: checking_fund.id,
                        target_fund_id: gas_fund.id,
                        amount: 40.00,
                        description: "Gas",
                    }
                ]
            });

            group3 = TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-10"),
                description: "Gas station",
                source_fund_id: checking_fund.id,
                target_fund_id: gas_fund.id,
                amount: 50.00,
            });

            group4 = TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-15"),
                description: "More groceries",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 75.00,
            });
        });

        it("should return all groups with default ordering (date DESC)", () => {
            const groups = TransactionGroup.from_db(db);

            expect(groups).to.have.lengthOf(4);
            expect(groups[0].id).to.equal(group4.id); // Most recent first
            expect(groups[1].id).to.equal(group3.id);
            expect(groups[2].id).to.equal(group2.id);
            expect(groups[3].id).to.equal(group1.id);
        });

        it("should order by date ASC when specified", () => {
            const groups = TransactionGroup.from_db(db, { order_direction: "ASC" });

            expect(groups).to.have.lengthOf(4);
            expect(groups[0].id).to.equal(group1.id); // Oldest first
            expect(groups[1].id).to.equal(group2.id);
            expect(groups[2].id).to.equal(group3.id);
            expect(groups[3].id).to.equal(group4.id);
        });

        it("should filter by since", () => {
            const groups = TransactionGroup.from_db(db, {
                since: YDate.parse("2026-06-05"),
            });

            expect(groups).to.have.lengthOf(3);
            expect(groups.map(g => g.id)).to.include.members([group2.id, group3.id, group4.id]);
        });

        it("should filter by until", () => {
            const groups = TransactionGroup.from_db(db, {
                until: YDate.parse("2026-06-10"),
            });

            expect(groups).to.have.lengthOf(3);
            expect(groups.map(g => g.id)).to.include.members([group1.id, group2.id, group3.id]);
        });

        it("should filter by split", () => {
            const groups = TransactionGroup.from_db(db, { split: true });

            expect(groups).to.have.lengthOf(1);
            expect(groups[0].id).to.equal(group2.id);
            expect(groups[0].split).to.be.true;
        });

        it("should filter by non-split", () => {
            const groups = TransactionGroup.from_db(db, { split: false });

            expect(groups).to.have.lengthOf(3);
            expect(groups.map(g => g.id)).to.include.members([group1.id, group3.id, group4.id]);
        });

        it("should filter by description_like", () => {
            const groups = TransactionGroup.from_db(db, {
                description_like: "grocer",
            });

            expect(groups).to.have.lengthOf(2);
            expect(groups.map(g => g.id)).to.include.members([group1.id, group4.id]);
        });

        it("should combine multiple filters", () => {
            const groups = TransactionGroup.from_db(db, {
                since: YDate.parse("2026-06-01"),
                until: YDate.parse("2026-06-12"),
                split: false,
            });

            // group1 (2026-06-01) + group3 (2026-06-10): both >= 06-01, <= 06-12, not split
            expect(groups).to.have.lengthOf(2);
            expect(groups.map(g => g.id)).to.include.members([group1.id, group3.id]);
        });

        it("should respect limit and offset", () => {
            const page1 = TransactionGroup.from_db(db, {
                limit: 2,
                offset: 0,
                order_direction: "ASC",
            });

            expect(page1).to.have.lengthOf(2);
            expect(page1[0].id).to.equal(group1.id);
            expect(page1[1].id).to.equal(group2.id);

            const page2 = TransactionGroup.from_db(db, {
                limit: 2,
                offset: 2,
                order_direction: "ASC",
            });

            expect(page2).to.have.lengthOf(2);
            expect(page2[0].id).to.equal(group3.id);
            expect(page2[1].id).to.equal(group4.id);
        });

        it("should return empty array when no results match", () => {
            const groups = TransactionGroup.from_db(db, {
                since: YDate.parse("2026-12-31"),
            });

            expect(groups).to.be.an("array");
            expect(groups).to.have.lengthOf(0);
        });
    });
});
