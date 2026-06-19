const { expect } = require("chai");
const { create_connection, initialize_db } = require("../../lib/db.js");
const Transaction = require("../../models/Transaction.js");
const TransactionGroup = require("../../models/TransactionGroup.js");
const Fund = require("../../models/Fund.js");
const YDate = require("../../lib/YDate.js");

describe("Transaction Model", () => {
    let db;
    let checking_fund;
    let savings_fund;
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

        savings_fund = Fund.create(db, {
            name: "Savings",
            tracked: true,
            monthly: false,
            start_date: YDate.parse("2026-01-01"),
            start_balance: 5000.00,
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

    describe("from_db()", () => {
        let group1, group2, group3, group4;

        beforeEach(() => {
            // Create various transaction groups with different patterns
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

            group3 = TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-10"),
                description: "Gas station",
                source_fund_id: checking_fund.id,
                target_fund_id: gas_fund.id,
                amount: 50.00,
            });

            group4 = TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-15"),
                description: "Transfer to savings",
                source_fund_id: checking_fund.id,
                target_fund_id: savings_fund.id,
                amount: 200.00,
            });
        });

        it("should return all transactions with default ordering (date DESC)", () => {
            const transactions = Transaction.from_db(db);

            // 5 total transactions: group1(1) + group2(2) + group3(1) + group4(1)
            expect(transactions).to.have.lengthOf(5);

            // Most recent first
            expect(transactions[0].date.toString()).to.equal("2026-06-15");
            expect(transactions[4].date.toString()).to.equal("2026-06-01");
        });

        it("should order by date ASC when specified", () => {
            const transactions = Transaction.from_db(db, { order_direction: "ASC" });

            expect(transactions).to.have.lengthOf(5);
            expect(transactions[0].date.toString()).to.equal("2026-06-01");
            expect(transactions[4].date.toString()).to.equal("2026-06-15");
        });

        it("should filter by source_fund_id", () => {
            const transactions = Transaction.from_db(db, {
                source_fund_id: checking_fund.id,
            });

            // All transactions come from checking
            expect(transactions).to.have.lengthOf(5);
            transactions.forEach(txn => {
                expect(txn.source_fund_id).to.equal(checking_fund.id);
            });
        });

        it("should filter by target_fund_id", () => {
            const transactions = Transaction.from_db(db, {
                target_fund_id: groceries_fund.id,
            });

            // group1 (1 txn) + group2 first txn (1) = 2 total
            expect(transactions).to.have.lengthOf(2);
            transactions.forEach(txn => {
                expect(txn.target_fund_id).to.equal(groceries_fund.id);
            });
        });

        it("should filter by involving_fund_id (source OR target)", () => {
            const transactions = Transaction.from_db(db, {
                involving_fund_id: gas_fund.id,
            });

            // group2 second txn (gas) + group3 (gas) = 2 total
            expect(transactions).to.have.lengthOf(2);
            transactions.forEach(txn => {
                const involves_gas =
                    txn.source_fund_id === gas_fund.id ||
                    txn.target_fund_id === gas_fund.id;
                expect(involves_gas).to.be.true;
            });
        });

        it("should filter by group_id", () => {
            const transactions = Transaction.from_db(db, {
                group_id: group2.id,
            });

            // group2 has 2 transactions (split)
            expect(transactions).to.have.lengthOf(2);
            transactions.forEach(txn => {
                expect(txn.group_id).to.equal(group2.id);
            });
        });

        it("should filter by since", () => {
            const transactions = Transaction.from_db(db, {
                since: YDate.parse("2026-06-05"),
            });

            // group2 (2) + group3 (1) + group4 (1) = 4 (includes 2026-06-05)
            expect(transactions).to.have.lengthOf(4);
            transactions.forEach(txn => {
                expect(txn.date.toString() >= "2026-06-05").to.be.true;
            });
        });

        it("should filter by until", () => {
            const transactions = Transaction.from_db(db, {
                until: YDate.parse("2026-06-10"),
            });

            // group1 (1) + group2 (2) + group3 (1) = 4 (includes 2026-06-10)
            expect(transactions).to.have.lengthOf(4);
            transactions.forEach(txn => {
                expect(txn.date.toString() <= "2026-06-10").to.be.true;
            });
        });

        it("should filter by description_like", () => {
            const transactions = Transaction.from_db(db, {
                description_like: "Gas",
            });

            // group2 second txn ("Gas portion") + group3 ("Gas station") = 2
            expect(transactions).to.have.lengthOf(2);
        });

        it("should combine multiple filters", () => {
            const transactions = Transaction.from_db(db, {
                involving_fund_id: groceries_fund.id,
                since: YDate.parse("2026-06-01"),
                until: YDate.parse("2026-06-10"),
            });

            // group1 txn (2026-06-01) + group2 first txn (2026-06-05), both involving groceries_fund
            expect(transactions).to.have.lengthOf(2);
            transactions.forEach(txn => {
                expect(txn.target_fund_id).to.equal(groceries_fund.id);
            });
        });

        it("should respect limit and offset", () => {
            const page1 = Transaction.from_db(db, {
                limit: 2,
                offset: 0,
                order_direction: "ASC",
            });

            expect(page1).to.have.lengthOf(2);
            expect(page1[0].date.toString()).to.equal("2026-06-01");

            const page2 = Transaction.from_db(db, {
                limit: 2,
                offset: 2,
                order_direction: "ASC",
            });

            expect(page2).to.have.lengthOf(2);
            expect(page2[0].date.toString()).to.equal("2026-06-05");
        });

        it("should return empty array when no results match", () => {
            const transactions = Transaction.from_db(db, {
                since: YDate.parse("2026-12-31"),
            });

            expect(transactions).to.be.an("array");
            expect(transactions).to.have.lengthOf(0);
        });

        it("should handle involving_fund_id with fund as source", () => {
            // Create a transaction where savings is the source
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-20"),
                description: "Transfer from savings",
                source_fund_id: savings_fund.id,
                target_fund_id: checking_fund.id,
                amount: 100.00,
            });

            const transactions = Transaction.from_db(db, {
                involving_fund_id: savings_fund.id,
            });

            // group4 (savings as target) + new group (savings as source) = 2
            expect(transactions).to.have.lengthOf(2);
            transactions.forEach(txn => {
                const involves_savings =
                    txn.source_fund_id === savings_fund.id ||
                    txn.target_fund_id === savings_fund.id;
                expect(involves_savings).to.be.true;
            });
        });
    });

    describe("for_id()", () => {
        it("should retrieve a transaction by id", () => {
            const group = TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-01"),
                description: "Test",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 50.00,
            });

            const txn_id = group.transactions[0].id;
            const retrieved = Transaction.for_id(db, txn_id);

            expect(retrieved).to.not.be.null;
            expect(retrieved.id).to.equal(txn_id);
            expect(retrieved.amount).to.equal(50.00);
        });

        it("should return null for non-existent id", () => {
            const retrieved = Transaction.for_id(db, 99999);
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

            const txn = group.transactions[0];
            const api_data = txn.to_api();

            expect(api_data.id).to.equal(txn.id);
            expect(api_data.source_fund_id).to.equal(checking_fund.id);
            expect(api_data.target_fund_id).to.equal(groceries_fund.id);
            expect(api_data.group_id).to.equal(group.id);
            expect(api_data.amount).to.equal(50.00);
            expect(api_data.date).to.equal("2026-06-01");
            expect(api_data.description).to.equal("API test");
            expect(api_data.note).to.equal("Test note");
            expect(api_data.created_at).to.be.a("string");
        });
    });

    describe("net_transfer()", () => {
        it("should return 0 when there are no transactions", () => {
            expect(Transaction.net_transfer(db, groceries_fund.id)).to.equal(0);
        });

        it("should return positive net for fund receiving money", () => {
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-01"),
                description: "Groceries",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 100.00,
            });

            expect(Transaction.net_transfer(db, groceries_fund.id)).to.equal(100.00);
            expect(Transaction.net_transfer(db, checking_fund.id)).to.equal(-100.00);
        });

        it("should accumulate across multiple transactions", () => {
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-01"),
                description: "Groceries",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 100.00,
            });
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-05"),
                description: "More groceries",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 60.00,
            });

            expect(Transaction.net_transfer(db, groceries_fund.id)).to.equal(160.00);
            expect(Transaction.net_transfer(db, checking_fund.id)).to.equal(-160.00);
        });

        it("should filter by since (inclusive)", () => {
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-01"),
                description: "Early",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 100.00,
            });
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-10"),
                description: "Late",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 50.00,
            });

            // since 2026-06-10 includes the 06-10 transaction but not 06-01
            expect(Transaction.net_transfer(db, groceries_fund.id, { since: YDate.parse("2026-06-10") })).to.equal(50.00);
            // since 2026-06-01 includes both
            expect(Transaction.net_transfer(db, groceries_fund.id, { since: YDate.parse("2026-06-01") })).to.equal(150.00);
        });

        it("should filter by until (inclusive)", () => {
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-01"),
                description: "Early",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 100.00,
            });
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-10"),
                description: "Late",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 50.00,
            });

            // until 2026-06-01 includes only the 06-01 transaction
            expect(Transaction.net_transfer(db, groceries_fund.id, { until: YDate.parse("2026-06-01") })).to.equal(100.00);
            // until 2026-06-10 includes both
            expect(Transaction.net_transfer(db, groceries_fund.id, { until: YDate.parse("2026-06-10") })).to.equal(150.00);
        });

        it("should return 0 for non-tracked fund even with transactions", () => {
            const untracked = Fund.create(db, { name: "Untracked", tracked: false });
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-01"),
                description: "Test",
                source_fund_id: checking_fund.id,
                target_fund_id: untracked.id,
                amount: 100.00,
            });

            expect(Transaction.net_transfer(db, untracked.id)).to.equal(0);
            expect(Transaction.net_transfer(db, checking_fund.id)).to.equal(-100.00);
        });

        it("should combine since and until to form a window", () => {
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-01"),
                description: "Before window",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 100.00,
            });
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-10"),
                description: "Inside window",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 50.00,
            });
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-20"),
                description: "After window",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 25.00,
            });

            expect(Transaction.net_transfer(db, groceries_fund.id, {
                since: YDate.parse("2026-06-05"),
                until: YDate.parse("2026-06-15"),
            })).to.equal(50.00);
        });
    });

    describe("net_transfers()", () => {
        it("should return net for multiple funds in one call", () => {
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-01"),
                description: "Groceries",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 100.00,
            });
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-05"),
                description: "Gas",
                source_fund_id: checking_fund.id,
                target_fund_id: gas_fund.id,
                amount: 40.00,
            });

            const results = Transaction.net_transfers(db, [groceries_fund.id, gas_fund.id, checking_fund.id]);

            const by_fund = Object.fromEntries(results.map(r => [r.fund_id, r.net]));
            expect(by_fund[groceries_fund.id]).to.equal(100.00);
            expect(by_fund[gas_fund.id]).to.equal(40.00);
            expect(by_fund[checking_fund.id]).to.equal(-140.00);
        });

        it("should return 0 for a fund with no transactions", () => {
            const results = Transaction.net_transfers(db, [groceries_fund.id]);

            expect(results).to.have.lengthOf(1);
            expect(results[0].fund_id).to.equal(groceries_fund.id);
            expect(results[0].net).to.equal(0);
        });

        it("should apply date filters across all funds", () => {
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-01"),
                description: "Early groceries",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 100.00,
            });
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-15"),
                description: "Late gas",
                source_fund_id: checking_fund.id,
                target_fund_id: gas_fund.id,
                amount: 40.00,
            });

            // Window covers only the groceries transaction
            const results = Transaction.net_transfers(db, [groceries_fund.id, gas_fund.id], {
                since: YDate.parse("2026-06-01"),
                until: YDate.parse("2026-06-10"),
            });

            const by_fund = Object.fromEntries(results.map(r => [r.fund_id, r.net]));
            expect(by_fund[groceries_fund.id]).to.equal(100.00);
            expect(by_fund[gas_fund.id]).to.equal(0);
        });

        it("should return 0 for non-tracked fund even with transactions", () => {
            const untracked = Fund.create(db, { name: "Untracked", tracked: false });
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-01"),
                description: "Test",
                source_fund_id: checking_fund.id,
                target_fund_id: untracked.id,
                amount: 100.00,
            });

            const results = Transaction.net_transfers(db, [untracked.id, checking_fund.id]);
            const by_fund = Object.fromEntries(results.map(r => [r.fund_id, r.net]));
            expect(by_fund[untracked.id]).to.equal(0);
            expect(by_fund[checking_fund.id]).to.equal(-100.00);
        });

        it("should return empty array for empty fund list", () => {
            const results = Transaction.net_transfers(db, []);
            expect(results).to.be.an("array").with.lengthOf(0);
        });
    });
});
