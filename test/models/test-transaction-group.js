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
});
