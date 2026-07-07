const { expect } = require("chai");
const { create_connection, initialize_db, ConflictError, ForeignKeyError } = require("../../lib/db.js");
const TransactionGroup = require("../../models/TransactionGroup.js");
const Transaction = require("../../models/Transaction.js");
const BankStatementItem = require("../../models/BankStatementItem.js");
const MonthFinalization = require("../../models/MonthFinalization.js");
const Allocation = require("../../models/Allocation.js");
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

        it("should allow zero-amount transactions at the model level", () => {
            // Zero amounts are needed internally for eom_cleanup transactions;
            // USER-facing positivity is enforced at the API layer, not here
            const group = TransactionGroup.create(db, {
                date: YDate.parse("2026-06-01"),
                description: "Zero amount",
                transactions: [{
                    source_fund_id: checking_fund.id,
                    target_fund_id: groceries_fund.id,
                    amount: 0,
                    description: "Zero amount",
                }]
            });
            expect(group.transactions[0].amount).to.equal(0);
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
            }).to.throw("Transaction amount cannot be negative");
        });

        it("should throw error when the transaction predates a fund's start_date", () => {
            const late_fund = Fund.create(db, {
                name: "Late",
                tracked: true,
                start_date: YDate.parse("2026-03-15"),
                start_balance: 0,
            });

            expect(() => {
                TransactionGroup.create(db, {
                    date: YDate.parse("2026-03-14"),
                    description: "Too early",
                    transactions: [{
                        source_fund_id: checking_fund.id,
                        target_fund_id: late_fund.id,
                        amount: 10.00,
                        description: "Too early",
                    }]
                });
            }).to.throw("Transaction predates the target fund's start_date");

            expect(() => {
                TransactionGroup.create(db, {
                    date: YDate.parse("2026-03-14"),
                    description: "Too early",
                    transactions: [{
                        source_fund_id: late_fund.id,
                        target_fund_id: checking_fund.id,
                        amount: 10.00,
                        description: "Too early",
                    }]
                });
            }).to.throw("Transaction predates the source fund's start_date");

            // On the start date itself is fine
            const group = TransactionGroup.create(db, {
                date: YDate.parse("2026-03-15"),
                description: "On start date",
                transactions: [{
                    source_fund_id: checking_fund.id,
                    target_fund_id: late_fund.id,
                    amount: 10.00,
                    description: "On start date",
                }]
            });
            expect(group).to.not.be.null;
        });

        it("should throw error when the group is dated in a finalized month", () => {
            // No MonthFinalization model use here -- insert the row directly so this
            // test only exercises the TransactionGroup guard
            db.prepare(`
                INSERT INTO month_finalizations (som_date, eom_date, sonm_date)
                VALUES ('2026-05-01', '2026-05-31', '2026-06-01')
            `).run();

            // In the finalized month
            expect(() => {
                TransactionGroup.create_single(db, {
                    date: YDate.parse("2026-05-10"),
                    description: "In finalized month",
                    source_fund_id: checking_fund.id,
                    target_fund_id: groceries_fund.id,
                    amount: 10.00,
                });
            }).to.throw("Cannot modify transaction groups in a finalized month");

            // Before the finalized month
            expect(() => {
                TransactionGroup.create_single(db, {
                    date: YDate.parse("2026-04-10"),
                    description: "Before finalized month",
                    source_fund_id: checking_fund.id,
                    target_fund_id: groceries_fund.id,
                    amount: 10.00,
                });
            }).to.throw("Cannot modify transaction groups in a finalized month");

            // After the finalized month is fine
            const group = TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-01"),
                description: "After finalized month",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 10.00,
            });
            expect(group).to.not.be.null;
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

        it("should reject the reserved allocation/eom_cleanup flags", () => {
            // These flags are managed by Allocation / MonthFinalization
            expect(() => {
                TransactionGroup.create(db, {
                    date: YDate.parse("2026-06-01"),
                    description: "Fake allocation",
                    allocation: true,
                    transactions: [{
                        source_fund_id: checking_fund.id,
                        target_fund_id: groceries_fund.id,
                        amount: 100.00,
                        description: "Fake allocation",
                    }]
                });
            }).to.throw("Allocation groups may only be created via Allocation.set");

            expect(() => {
                TransactionGroup.create(db, {
                    date: YDate.parse("2026-06-01"),
                    description: "Fake cleanup",
                    eom_cleanup: true,
                    transactions: [{
                        source_fund_id: checking_fund.id,
                        target_fund_id: groceries_fund.id,
                        amount: 100.00,
                        description: "Fake cleanup",
                    }]
                });
            }).to.throw("EOM cleanup groups may only be created via MonthFinalization.create");
        });
    });

    describe("delete()", () => {
        it("should delete the group and its transactions", () => {
            const group = TransactionGroup.create(db, {
                date: YDate.parse("2026-06-03"),
                description: "Doomed",
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

            group.delete(db);

            expect(TransactionGroup.for_id(db, group.id)).to.be.null;
            const orphans = db.prepare(
                "SELECT COUNT(*) AS n FROM transactions WHERE group_id = ?"
            ).get(group.id);
            expect(orphans.n).to.equal(0);
        });

        it("should refuse deleting groups in finalized months", () => {
            const group = TransactionGroup.create_single(db, {
                date: YDate.parse("2026-05-10"),
                description: "About to be locked in",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 10.00,
            });

            // Insert the finalization row directly so this test only
            // exercises the TransactionGroup guard
            db.prepare(`
                INSERT INTO month_finalizations (som_date, eom_date, sonm_date)
                VALUES ('2026-05-01', '2026-05-31', '2026-06-01')
            `).run();

            expect(() => group.delete(db))
                .to.throw("Cannot modify transaction groups in a finalized month");
            expect(TransactionGroup.for_id(db, group.id)).to.not.be.null;
        });
    });

    describe("update()", () => {
        let group;

        beforeEach(() => {
            group = TransactionGroup.create(db, {
                date: YDate.parse("2026-06-05"),
                description: "Split shopping",
                note: "Costco run",
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
        });

        it("should update description and note without touching transactions", () => {
            const updated = group.update(db, { description: "Renamed", note: null });

            expect(updated.id).to.equal(group.id);
            expect(updated.description).to.equal("Renamed");
            expect(updated.note).to.be.null;
            expect(updated.date.toString()).to.equal("2026-06-05");
            expect(updated.transactions).to.have.lengthOf(2);
            expect(updated.transactions.map(t => t.amount)).to.have.members([60.00, 40.00]);
        });

        it("should leave omitted fields unchanged (merge semantics)", () => {
            const updated = group.update(db, {});

            expect(updated.description).to.equal("Split shopping");
            expect(updated.note).to.equal("Costco run");
            expect(updated.date.toString()).to.equal("2026-06-05");
        });

        it("should cascade a date change to every child transaction", () => {
            const updated = group.update(db, { date: YDate.parse("2026-06-20") });

            expect(updated.date.toString()).to.equal("2026-06-20");
            updated.transactions.forEach(t => {
                expect(t.date.toString()).to.equal("2026-06-20");
            });
        });

        it("should refuse moving the group into a finalized month", () => {
            db.prepare(`
                INSERT INTO month_finalizations (som_date, eom_date, sonm_date)
                VALUES ('2026-05-01', '2026-05-31', '2026-06-01')
            `).run();

            expect(() => group.update(db, { date: YDate.parse("2026-05-15") }))
                .to.throw(ConflictError, /finalized month/);
        });

        it("should refuse any edit while the group's month is finalized", () => {
            db.prepare(`
                INSERT INTO month_finalizations (som_date, eom_date, sonm_date)
                VALUES ('2026-06-01', '2026-06-30', '2026-07-01')
            `).run();

            expect(() => group.update(db, { description: "sneaky" }))
                .to.throw(ConflictError, /finalized month/);
        });

        it("should refuse a date move that predates a child fund's start_date", () => {
            const late_fund = Fund.create(db, {
                name: "Late starter",
                tracked: true,
                start_date: YDate.parse("2026-06-01"),
                start_balance: 0.00,
            });
            const late_group = TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-10"),
                description: "Late fund spending",
                source_fund_id: checking_fund.id,
                target_fund_id: late_fund.id,
                amount: 10.00,
            });

            expect(() => late_group.update(db, { date: YDate.parse("2026-05-20") }))
                .to.throw(ConflictError, /predates the target fund's start_date/);

            // Atomicity: nothing moved
            const fresh = TransactionGroup.for_id(db, late_group.id);
            expect(fresh.date.toString()).to.equal("2026-06-10");
            fresh.transactions.forEach(t => {
                expect(t.date.toString()).to.equal("2026-06-10");
            });
        });

        it("should refuse allocation groups", () => {
            Allocation.set(db, {
                month: YDate.parse("2026-06-01"),
                fund_id: groceries_fund.id,
                amount: 200.00,
            });
            const alloc_group = TransactionGroup.from_db(db, { allocation: true })[0];

            expect(() => alloc_group.update(db, { description: "sneaky" }))
                .to.throw(Error, /managed via Allocation.set/);
        });

        it("should refuse eom_cleanup groups", () => {
            MonthFinalization.create(db, {
                month: YDate.parse("2026-06-15"),
                recursive: true,
            });
            const cleanup_group = TransactionGroup.from_db(db, { eom_cleanup: true })[0];

            expect(() => cleanup_group.update(db, { description: "sneaky" }))
                .to.throw(Error, /EOM cleanup groups cannot be edited/);
        });

        it("should keep bank statement reconciliation intact (id stable)", () => {
            const item = BankStatementItem.create(db, {
                source: "boa",
                key: "txn-777",
                amount: -100.00,
                date: YDate.parse("2026-06-05"),
                note: "COSTCO",
            });
            const linked = TransactionGroup.create_from_statements(db, {
                statement_ids: [item.id],
                transactions: [{
                    source_fund_id: checking_fund.id,
                    target_fund_id: groceries_fund.id,
                    amount: 100.00,
                    description: "Costco",
                }]
            });

            const updated = linked.update(db, {
                description: "Renamed",
                date: YDate.parse("2026-06-25"),
            });

            expect(updated.id).to.equal(linked.id);
            expect(updated.statements).to.have.lengthOf(1);
            expect(updated.statements[0].id).to.equal(item.id);
            expect(BankStatementItem.for_id(db, item.id).group_id).to.equal(linked.id);
        });
    });

    describe("edit_transactions()", () => {
        let group, groceries_txn, gas_txn;

        beforeEach(() => {
            group = TransactionGroup.create(db, {
                date: YDate.parse("2026-06-05"),
                description: "Split shopping",
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
            groceries_txn = group.transactions.find(t => t.target_fund_id === groceries_fund.id);
            gas_txn = group.transactions.find(t => t.target_fund_id === gas_fund.id);
        });

        it("should add a transaction (inheriting the group's date) and resync split", () => {
            const single = TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-10"),
                description: "Just gas",
                source_fund_id: checking_fund.id,
                target_fund_id: gas_fund.id,
                amount: 30.00,
            });
            expect(single.split).to.be.false;

            const updated = TransactionGroup.edit_transactions(db, single, {
                add: [{
                    source_fund_id: checking_fund.id,
                    target_fund_id: groceries_fund.id,
                    amount: 20.00,
                    description: "Snacks",
                }]
            });

            expect(updated.transactions).to.have.lengthOf(2);
            expect(updated.split).to.be.true;
            const added = updated.transactions.find(t => t.description === "Snacks");
            expect(added.date.toString()).to.equal("2026-06-10");
            expect(added.allocation).to.be.false;
        });

        it("should remove a transaction and resync split", () => {
            const updated = TransactionGroup.edit_transactions(db, group, {
                remove: [gas_txn.id]
            });

            expect(updated.transactions).to.have.lengthOf(1);
            expect(updated.transactions[0].id).to.equal(groceries_txn.id);
            expect(updated.split).to.be.false;
            expect(Transaction.for_id(db, gas_txn.id)).to.be.null;
        });

        it("should update a transaction's fields in place", () => {
            const updated = TransactionGroup.edit_transactions(db, group, {
                update: [{ id: gas_txn.id, amount: 55.00, description: "More gas" }]
            });

            const fresh_gas = updated.transactions.find(t => t.id === gas_txn.id);
            expect(fresh_gas.amount).to.equal(55.00);
            expect(fresh_gas.description).to.equal("More gas");
            // The other line is untouched
            const fresh_groceries = updated.transactions.find(t => t.id === groceries_txn.id);
            expect(fresh_groceries.amount).to.equal(60.00);
        });

        it("should apply a mixed add/update/remove batch atomically", () => {
            const updated = TransactionGroup.edit_transactions(db, group, {
                remove: [gas_txn.id],
                update: [{ id: groceries_txn.id, amount: 75.00 }],
                add: [{
                    source_fund_id: checking_fund.id,
                    target_fund_id: gas_fund.id,
                    amount: 25.00,
                    description: "Replacement gas",
                }]
            });

            expect(updated.transactions).to.have.lengthOf(2);
            expect(updated.split).to.be.true;
            expect(updated.transactions.find(t => t.id === groceries_txn.id).amount).to.equal(75.00);
            expect(updated.transactions.find(t => t.description === "Replacement gas").amount).to.equal(25.00);
            // The removed line is gone (NOTE: its rowid may be reused by the
            // add, so check membership rather than for_id)
            expect(updated.transactions.some(t => t.description === "Gas portion")).to.be.false;
        });

        it("should refuse emptying the group", () => {
            expect(() => TransactionGroup.edit_transactions(db, group, {
                remove: [groceries_txn.id, gas_txn.id]
            })).to.throw(Error, /at least one transaction; delete the group instead/);

            // Nothing was deleted
            expect(TransactionGroup.for_id(db, group.id).transactions).to.have.lengthOf(2);
        });

        it("should allow remove-all when adds keep the group non-empty", () => {
            const updated = TransactionGroup.edit_transactions(db, group, {
                remove: [groceries_txn.id, gas_txn.id],
                add: [{
                    source_fund_id: checking_fund.id,
                    target_fund_id: gas_fund.id,
                    amount: 99.00,
                    description: "The whole thing",
                }]
            });

            expect(updated.transactions).to.have.lengthOf(1);
            expect(updated.split).to.be.false;
            expect(updated.transactions[0].description).to.equal("The whole thing");
        });

        it("should reject ids that do not belong to the group", () => {
            const other = TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-11"),
                description: "Other group",
                source_fund_id: checking_fund.id,
                target_fund_id: gas_fund.id,
                amount: 5.00,
            });
            const foreign_id = other.transactions[0].id;

            expect(() => TransactionGroup.edit_transactions(db, group, {
                remove: [foreign_id]
            })).to.throw(ForeignKeyError, /not in group/);
            expect(() => TransactionGroup.edit_transactions(db, group, {
                update: [{ id: foreign_id, amount: 1.00 }]
            })).to.throw(ForeignKeyError, /not in group/);
        });

        it("should reject an id referenced twice", () => {
            expect(() => TransactionGroup.edit_transactions(db, group, {
                remove: [gas_txn.id],
                update: [{ id: gas_txn.id, amount: 1.00 }]
            })).to.throw(Error, /referenced twice/);
            expect(() => TransactionGroup.edit_transactions(db, group, {
                remove: [gas_txn.id, gas_txn.id]
            })).to.throw(Error, /referenced twice/);
        });

        it("should refuse groups in finalized months", () => {
            db.prepare(`
                INSERT INTO month_finalizations (som_date, eom_date, sonm_date)
                VALUES ('2026-06-01', '2026-06-30', '2026-07-01')
            `).run();

            expect(() => TransactionGroup.edit_transactions(db, group, {
                update: [{ id: gas_txn.id, amount: 1.00 }]
            })).to.throw(ConflictError, /finalized month/);
        });

        it("should refuse allocation and eom_cleanup groups", () => {
            Allocation.set(db, {
                month: YDate.parse("2026-06-01"),
                fund_id: groceries_fund.id,
                amount: 200.00,
            });
            const alloc_group = TransactionGroup.from_db(db, { allocation: true })[0];
            expect(() => TransactionGroup.edit_transactions(db, alloc_group, {
                remove: [alloc_group.transactions[0].id]
            })).to.throw(Error, /managed via Allocation.set/);

            MonthFinalization.create(db, {
                month: YDate.parse("2026-06-15"),
                recursive: true,
            });
            const cleanup_group = TransactionGroup.from_db(db, { eom_cleanup: true })[0];
            expect(() => TransactionGroup.edit_transactions(db, cleanup_group, {
                remove: [cleanup_group.transactions[0].id]
            })).to.throw(Error, /EOM cleanup groups cannot be edited/);
        });

        it("should validate added transactions like creation", () => {
            expect(() => TransactionGroup.edit_transactions(db, group, {
                add: [{
                    source_fund_id: checking_fund.id,
                    target_fund_id: 99999,
                    amount: 10.00,
                    description: "Bad fund",
                }]
            })).to.throw(ForeignKeyError, /Target fund does not exist/);

            expect(() => TransactionGroup.edit_transactions(db, group, {
                add: [{
                    source_fund_id: checking_fund.id,
                    target_fund_id: checking_fund.id,
                    amount: 10.00,
                    description: "Self transfer",
                }]
            })).to.throw(ConflictError, /same/);
        });

        it("should roll back the whole batch when a later op fails (atomicity)", () => {
            expect(() => TransactionGroup.edit_transactions(db, group, {
                remove: [gas_txn.id],                    // would succeed...
                add: [{
                    source_fund_id: checking_fund.id,
                    target_fund_id: 99999,               // ...but this fails
                    amount: 10.00,
                    description: "Bad fund",
                }]
            })).to.throw(ForeignKeyError);

            // The remove was rolled back with everything else
            const fresh = TransactionGroup.for_id(db, group.id);
            expect(fresh.transactions).to.have.lengthOf(2);
            expect(Transaction.for_id(db, gas_txn.id)).to.not.be.null;
            expect(fresh.split).to.be.true;
        });

        it("should keep bank statement reconciliation intact", () => {
            const item = BankStatementItem.create(db, {
                source: "boa",
                key: "txn-888",
                amount: -100.00,
                date: YDate.parse("2026-06-05"),
                note: "COSTCO",
            });
            const linked = TransactionGroup.create_from_statements(db, {
                statement_ids: [item.id],
                transactions: [{
                    source_fund_id: checking_fund.id,
                    target_fund_id: groceries_fund.id,
                    amount: 100.00,
                    description: "Costco",
                }]
            });

            const updated = TransactionGroup.edit_transactions(db, linked, {
                add: [{
                    source_fund_id: checking_fund.id,
                    target_fund_id: gas_fund.id,
                    amount: 15.00,
                    description: "Costco gas",
                }]
            });

            expect(updated.id).to.equal(linked.id);
            expect(updated.transactions).to.have.lengthOf(2);
            expect(updated.statements).to.have.lengthOf(1);
            expect(updated.statements[0].id).to.equal(item.id);
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
            expect(api_data.statements).to.deep.equal([]);
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

    describe("bank statement reconciliation", () => {
        let savings_fund;
        let walmart_item;

        beforeEach(() => {
            savings_fund = Fund.create(db, {
                name: "Savings",
                tracked: true,
                monthly: false,
                pool: false,
                start_date: YDate.parse("2026-01-01"),
                start_balance: 500.00,
            });

            walmart_item = BankStatementItem.create(db, {
                source: "boa",
                key: "txn-001",
                amount: -52.30,
                date: YDate.parse("2026-06-02"),
                note: "WALMART #1234",
            });
        });

        describe("create_from_statements()", () => {
            it("should create a group reconciling a single item", () => {
                const group = TransactionGroup.create_from_statements(db, {
                    statement_ids: [walmart_item.id],
                    transactions: [{
                        source_fund_id: groceries_fund.id,
                        target_fund_id: savings_fund.id,
                        amount: 52.30,
                        description: "Walmart",
                    }]
                });

                // Defaults derived from the item
                expect(group.date.toString()).to.equal("2026-06-02");
                expect(group.description).to.equal("WALMART #1234");
                expect(group.split).to.be.false;
                expect(group.allocation).to.be.false;
                expect(group.eom_cleanup).to.be.false;
                expect(group.transactions).to.have.lengthOf(1);

                // Hydrated statements + item linked
                expect(group.statements).to.have.lengthOf(1);
                expect(group.statements[0].id).to.equal(walmart_item.id);
                expect(group.statements[0].amount).to.equal(-52.30);
                expect(BankStatementItem.for_id(db, walmart_item.id).group_id).to.equal(group.id);
            });

            it("should fall back to the item key when it has no note", () => {
                const item = BankStatementItem.create(db, {
                    source: "boa", key: "txn-002", amount: -5.00, date: YDate.parse("2026-06-02"),
                });
                const group = TransactionGroup.create_from_statements(db, {
                    statement_ids: [item.id],
                    transactions: [{
                        source_fund_id: groceries_fund.id,
                        target_fund_id: savings_fund.id,
                        amount: 5.00,
                        description: "Something",
                    }]
                });
                expect(group.description).to.equal("txn-002");
            });

            it("should reconcile a transfer: two items, one group, one transaction", () => {
                const checking_side = BankStatementItem.create(db, {
                    source: "boa", key: "txn-777", amount: -500.00,
                    date: YDate.parse("2026-06-10"), note: "TRANSFER TO SAVINGS",
                });
                const savings_side = BankStatementItem.create(db, {
                    source: "ally", key: "dep-042", amount: 500.00,
                    date: YDate.parse("2026-06-12"), note: "TRANSFER FROM CHECKING",
                });

                const group = TransactionGroup.create_from_statements(db, {
                    statement_ids: [checking_side.id, savings_side.id],
                    transactions: [{
                        source_fund_id: checking_fund.id,
                        target_fund_id: savings_fund.id,
                        amount: 500.00,
                        description: "Transfer",
                    }]
                });

                // Default date is the LATER side (when the movement completed)
                expect(group.date.toString()).to.equal("2026-06-12");
                expect(group.description).to.equal("TRANSFER TO SAVINGS / TRANSFER FROM CHECKING");
                expect(group.split).to.be.false;
                expect(group.transactions).to.have.lengthOf(1);
                expect(group.statements.map(s => s.id)).to.deep.equal([checking_side.id, savings_side.id]);

                expect(BankStatementItem.for_id(db, checking_side.id).group_id).to.equal(group.id);
                expect(BankStatementItem.for_id(db, savings_side.id).group_id).to.equal(group.id);
            });

            it("should allow splits whose amounts do NOT match the item amount", () => {
                // Amount reconciliation is intentionally not enforced
                const group = TransactionGroup.create_from_statements(db, {
                    statement_ids: [walmart_item.id],
                    transactions: [
                        {
                            source_fund_id: groceries_fund.id,
                            target_fund_id: savings_fund.id,
                            amount: 40.00,
                            description: "Groceries part",
                        },
                        {
                            source_fund_id: gas_fund.id,
                            target_fund_id: savings_fund.id,
                            amount: 99.99,
                            description: "Definitely not the remainder",
                        }
                    ]
                });

                expect(group.split).to.be.true;
                expect(group.transactions).to.have.lengthOf(2);
            });

            it("should respect explicit date and description overrides", () => {
                const group = TransactionGroup.create_from_statements(db, {
                    statement_ids: [walmart_item.id],
                    date: YDate.parse("2026-06-20"),
                    description: "Custom",
                    note: "Custom note",
                    transactions: [{
                        source_fund_id: groceries_fund.id,
                        target_fund_id: savings_fund.id,
                        amount: 52.30,
                        description: "Walmart",
                    }]
                });

                expect(group.date.toString()).to.equal("2026-06-20");
                expect(group.description).to.equal("Custom");
                expect(group.note).to.equal("Custom note");
            });

            it("should reject missing, ignored, and already-reconciled items", () => {
                const transactions = [{
                    source_fund_id: groceries_fund.id,
                    target_fund_id: savings_fund.id,
                    amount: 52.30,
                    description: "Walmart",
                }];

                expect(() => TransactionGroup.create_from_statements(db, {
                    statement_ids: [99999], transactions,
                })).to.throw(ForeignKeyError);

                const ignored = BankStatementItem.create(db, {
                    source: "boa", key: "txn-ign", amount: -1.00, date: YDate.parse("2026-06-02"),
                }).update(db, { ignored: true });
                expect(() => TransactionGroup.create_from_statements(db, {
                    statement_ids: [ignored.id], transactions,
                })).to.throw(ConflictError);

                TransactionGroup.create_from_statements(db, {
                    statement_ids: [walmart_item.id], transactions,
                });
                expect(() => TransactionGroup.create_from_statements(db, {
                    statement_ids: [walmart_item.id], transactions,
                })).to.throw(ConflictError);
            });

            it("should reject one side of a transfer being already reconciled", () => {
                const peer = BankStatementItem.create(db, {
                    source: "ally", key: "dep-042", amount: 500.00, date: YDate.parse("2026-06-12"),
                });
                TransactionGroup.create_from_statements(db, {
                    statement_ids: [walmart_item.id],
                    transactions: [{
                        source_fund_id: groceries_fund.id,
                        target_fund_id: savings_fund.id,
                        amount: 52.30,
                        description: "Walmart",
                    }]
                });

                expect(() => TransactionGroup.create_from_statements(db, {
                    statement_ids: [peer.id, walmart_item.id],
                    transactions: [{
                        source_fund_id: checking_fund.id,
                        target_fund_id: savings_fund.id,
                        amount: 500.00,
                        description: "Transfer",
                    }]
                })).to.throw(ConflictError);

                // And the whole thing rolled back: peer is still pending
                expect(BankStatementItem.for_id(db, peer.id).group_id).to.be.null;
            });

            it("should reject empty/duplicate statement ids and empty transactions", () => {
                const transactions = [{
                    source_fund_id: groceries_fund.id,
                    target_fund_id: savings_fund.id,
                    amount: 52.30,
                    description: "Walmart",
                }];

                expect(() => TransactionGroup.create_from_statements(db, {
                    transactions,
                })).to.throw(/statement id/);
                expect(() => TransactionGroup.create_from_statements(db, {
                    statement_ids: [walmart_item.id, walmart_item.id], transactions,
                })).to.throw(/Duplicate/);
                expect(() => TransactionGroup.create_from_statements(db, {
                    statement_ids: [walmart_item.id],
                })).to.throw(/transaction/);
            });

            it("should respect the finalized-month guard through the default date", () => {
                MonthFinalization.create(db, {
                    month: YDate.parse("2026-06-15"),
                    recursive: true,
                });

                const transactions = [{
                    source_fund_id: checking_fund.id,
                    target_fund_id: savings_fund.id,
                    amount: 52.30,
                    description: "Walmart",
                }];

                // Item is dated inside the finalized month: default date throws
                expect(() => TransactionGroup.create_from_statements(db, {
                    statement_ids: [walmart_item.id], transactions,
                })).to.throw(ConflictError);

                // ...but reconciling forward into an open month works
                const group = TransactionGroup.create_from_statements(db, {
                    statement_ids: [walmart_item.id],
                    date: YDate.parse("2026-07-03"),
                    transactions,
                });
                expect(group.date.toString()).to.equal("2026-07-03");
            });
        });

        describe("create()", () => {
            it("should no longer accept statement linkage (reserved for create_from_statements)", () => {
                const group = TransactionGroup.create(db, {
                    date: YDate.parse("2026-06-02"),
                    description: "Plain group",
                    transactions: [{
                        source_fund_id: groceries_fund.id,
                        target_fund_id: savings_fund.id,
                        amount: 10.00,
                        description: "Plain",
                    }]
                });

                // statement_id is not a column anymore; groups start unlinked
                expect(group.statements).to.deep.equal([]);
            });
        });

        describe("querying", () => {
            let linked_group, plain_group;

            beforeEach(() => {
                linked_group = TransactionGroup.create_from_statements(db, {
                    statement_ids: [walmart_item.id],
                    transactions: [{
                        source_fund_id: groceries_fund.id,
                        target_fund_id: savings_fund.id,
                        amount: 52.30,
                        description: "Walmart",
                    }]
                });
                plain_group = TransactionGroup.create_single(db, {
                    date: YDate.parse("2026-06-03"),
                    description: "Cash thing",
                    source_fund_id: checking_fund.id,
                    target_fund_id: savings_fund.id,
                    amount: 10.00,
                });
            });

            it("should hydrate statements in for_id and from_db", () => {
                const fetched = TransactionGroup.for_id(db, linked_group.id);
                expect(fetched.statements).to.have.lengthOf(1);
                expect(fetched.statements[0]).to.be.an.instanceOf(BankStatementItem);
                expect(fetched.statements[0].key).to.equal("txn-001");

                const listed = TransactionGroup.from_db(db, { has_statements: true });
                expect(listed.map(g => g.id)).to.deep.equal([linked_group.id]);
                expect(listed[0].statements).to.have.lengthOf(1);
            });

            it("should filter by has_statements both ways", () => {
                const without = TransactionGroup.from_db(db, { has_statements: false });
                expect(without.map(g => g.id)).to.deep.equal([plain_group.id]);
            });

            it("should include statements in to_api()", () => {
                const api_data = TransactionGroup.for_id(db, linked_group.id).to_api();
                expect(api_data.statements).to.have.lengthOf(1);
                expect(api_data.statements[0].key).to.equal("txn-001");
                expect(api_data.statements[0].group_id).to.equal(linked_group.id);
            });

            it("should not cross-product multiple transactions with multiple statements", () => {
                // Guards the subquery-not-join hydration choice: 2 statements
                // x 2 transactions must NOT duplicate either array
                const item_a = BankStatementItem.create(db, {
                    source: "ally", key: "dep-042", amount: -500.00, date: YDate.parse("2026-06-12"),
                });
                const item_b = BankStatementItem.create(db, {
                    source: "chase", key: "dep-043", amount: 500.00, date: YDate.parse("2026-06-13"),
                });
                const group = TransactionGroup.create_from_statements(db, {
                    statement_ids: [item_a.id, item_b.id],
                    transactions: [
                        {
                            source_fund_id: checking_fund.id,
                            target_fund_id: savings_fund.id,
                            amount: 400.00,
                            description: "Part one",
                        },
                        {
                            source_fund_id: checking_fund.id,
                            target_fund_id: savings_fund.id,
                            amount: 100.00,
                            description: "Part two",
                        }
                    ]
                });

                const fetched = TransactionGroup.for_id(db, group.id);
                expect(fetched.transactions).to.have.lengthOf(2);
                expect(fetched.statements).to.have.lengthOf(2);
                expect(fetched.statements.map(s => s.key)).to.deep.equal(["dep-042", "dep-043"]);
                expect(fetched.transactions.map(t => t.description)).to.deep.equal(["Part one", "Part two"]);
            });
        });

        describe("delete()", () => {
            it("should release linked items back to pending", () => {
                const peer = BankStatementItem.create(db, {
                    source: "ally", key: "dep-042", amount: 500.00, date: YDate.parse("2026-06-12"),
                });
                const group = TransactionGroup.create_from_statements(db, {
                    statement_ids: [walmart_item.id, peer.id],
                    transactions: [{
                        source_fund_id: checking_fund.id,
                        target_fund_id: savings_fund.id,
                        amount: 500.00,
                        description: "Transfer",
                    }]
                });

                group.delete(db);

                // Both items pending again, and re-reconcilable
                expect(BankStatementItem.for_id(db, walmart_item.id).group_id).to.be.null;
                expect(BankStatementItem.for_id(db, peer.id).group_id).to.be.null;

                const again = TransactionGroup.create_from_statements(db, {
                    statement_ids: [walmart_item.id],
                    transactions: [{
                        source_fund_id: groceries_fund.id,
                        target_fund_id: savings_fund.id,
                        amount: 52.30,
                        description: "Walmart",
                    }]
                });
                expect(again).to.not.be.null;
            });
        });

        describe("delete_statement_item()", () => {
            function reconcile_walmart() {
                return TransactionGroup.create_from_statements(db, {
                    statement_ids: [walmart_item.id],
                    transactions: [{
                        source_fund_id: groceries_fund.id,
                        target_fund_id: savings_fund.id,
                        amount: 52.30,
                        description: "Walmart",
                    }]
                });
            }

            it("should delete a pending item", () => {
                TransactionGroup.delete_statement_item(db, walmart_item);
                expect(BankStatementItem.for_id(db, walmart_item.id)).to.be.null;
            });

            it("should throw for a non-existent item", () => {
                expect(() => TransactionGroup.delete_statement_item(db, { id: 99999 }))
                    .to.throw(ForeignKeyError);
            });

            it("should delete the reconciling group (and its transactions) by default", () => {
                const group = reconcile_walmart();

                TransactionGroup.delete_statement_item(db, walmart_item);

                expect(BankStatementItem.for_id(db, walmart_item.id)).to.be.null;
                expect(TransactionGroup.for_id(db, group.id)).to.be.null;
            });

            it("should release (not delete) a transfer peer when deleting the group", () => {
                const peer = BankStatementItem.create(db, {
                    source: "ally", key: "dep-042", amount: 500.00, date: YDate.parse("2026-06-12"),
                });
                const group = TransactionGroup.create_from_statements(db, {
                    statement_ids: [walmart_item.id, peer.id],
                    transactions: [{
                        source_fund_id: checking_fund.id,
                        target_fund_id: savings_fund.id,
                        amount: 500.00,
                        description: "Transfer",
                    }]
                });

                TransactionGroup.delete_statement_item(db, walmart_item);

                expect(BankStatementItem.for_id(db, walmart_item.id)).to.be.null;
                expect(TransactionGroup.for_id(db, group.id)).to.be.null;
                const fresh_peer = BankStatementItem.for_id(db, peer.id);
                expect(fresh_peer).to.not.be.null;
                expect(fresh_peer.group_id).to.be.null;
            });

            it("should keep the group when with_group is false", () => {
                const group = reconcile_walmart();

                TransactionGroup.delete_statement_item(db, walmart_item, { with_group: false });

                expect(BankStatementItem.for_id(db, walmart_item.id)).to.be.null;
                const fresh = TransactionGroup.for_id(db, group.id);
                expect(fresh).to.not.be.null;
                expect(fresh.statements).to.deep.equal([]);
                expect(fresh.transactions).to.have.lengthOf(1);
            });

            it("should refuse the with_group arm inside a finalized month", () => {
                const group = reconcile_walmart();
                MonthFinalization.create(db, {
                    month: YDate.parse("2026-06-15"),
                    recursive: true,
                });

                expect(() => TransactionGroup.delete_statement_item(db, walmart_item))
                    .to.throw(ConflictError);
                // Atomic: nothing was deleted
                expect(BankStatementItem.for_id(db, walmart_item.id)).to.not.be.null;
                expect(TransactionGroup.for_id(db, group.id)).to.not.be.null;

                // The item row itself is still deletable if the group is kept
                TransactionGroup.delete_statement_item(db, walmart_item, { with_group: false });
                expect(BankStatementItem.for_id(db, walmart_item.id)).to.be.null;
                expect(TransactionGroup.for_id(db, group.id)).to.not.be.null;
            });

            it("should let a deleted item reappear as pending on re-import", () => {
                reconcile_walmart();
                TransactionGroup.delete_statement_item(db, walmart_item);

                // The documented double-count hazard: the dedupe row is gone,
                // so a re-sync happily recreates the item as pending
                const { created } = BankStatementItem.import_many(db, [{
                    source: "boa", key: "txn-001", amount: -52.30,
                    date: YDate.parse("2026-06-02"), note: "WALMART #1234",
                }]);
                expect(created).to.have.lengthOf(1);
                expect(created[0].group_id).to.be.null;
                expect(created[0].ignored).to.be.false;
            });
        });
    });

    describe("count()", () => {
        beforeEach(() => {
            TransactionGroup.create_single(db, {
                date: YDate.parse("2026-06-01"),
                description: "Grocery shopping",
                source_fund_id: checking_fund.id,
                target_fund_id: groceries_fund.id,
                amount: 100.00,
            });
            TransactionGroup.create(db, {
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
            const item = BankStatementItem.create(db, {
                source: "big-bank",
                key: "count-test-1",
                amount: -50.00,
                date: YDate.parse("2026-06-10"),
            });
            TransactionGroup.create_from_statements(db, {
                statement_ids: [item.id],
                transactions: [{
                    source_fund_id: checking_fund.id,
                    target_fund_id: gas_fund.id,
                    amount: 50.00,
                    description: "Gas station",
                }]
            });
        });

        it("counts all groups with no filters", () => {
            expect(TransactionGroup.count(db)).to.equal(3);
        });

        it("counts with the same filters as from_db", () => {
            expect(TransactionGroup.count(db, { split: true })).to.equal(1);
            expect(TransactionGroup.count(db, { has_statements: true })).to.equal(1);
            expect(TransactionGroup.count(db, { has_statements: false })).to.equal(2);
            expect(TransactionGroup.count(db, { since: YDate.parse("2026-06-05") })).to.equal(2);
            expect(TransactionGroup.count(db, { description_like: "split" })).to.equal(1);
        });

        it("ignores order/limit/offset so it can share the from_db filter object", () => {
            const filter = { order_by: "date", order_direction: "DESC", limit: 1, offset: 0 };
            expect(TransactionGroup.count(db, filter)).to.equal(3);
            expect(TransactionGroup.from_db(db, filter)).to.have.lengthOf(1);
        });
    });

});
