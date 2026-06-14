const { expect } = require("chai");

const {
    create_connection,
    initialize_db,
    ConflictError,
    ForeignKeyError,
} = require("../../lib/db.js");

const YDate = require("../../lib/YDate.js");
const Fund = require("../../models/Fund.js");

describe("models/Fund.js", () => {

    let db;
    beforeEach(() => {
        db = create_connection({ path: ":memory:" });
        initialize_db(db)
    });

    describe(".create()", () => {
        it("can create untracked", () => {
            const fund = Fund.create(db, {
                name: "test",
                tracked: false,
            });

            expect(fund.name).to.equal("test");
            expect(fund.tracked).to.equal(false);
            expect(fund.start_date).to.equal(null);
            expect(fund.start_balance).to.equal(null);
            expect(fund.balance).to.equal(null);
            expect(fund.monthly).to.equal(false);
        });

        it("can create tracked non-monthly", () => {
            const fund = Fund.create(db, {
                name: "test",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
            });

            expect(fund.name).to.equal("test");
            expect(fund.tracked).to.equal(true);
            expect(fund.start_date).to.not.equal(null);
            expect(fund.start_date.toString()).to.equal("2026-01-01");
            expect(fund.start_balance).to.equal(0);
            expect(fund.balance).to.equal(0);
            expect(fund.monthly).to.equal(false);
        });

        it("can create with parent", () => {
            const pfund = Fund.create(db, {
                name: "parent",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                monthly: false,
            });

            const fund = Fund.create(db, {
                name: "test",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                parent_id: pfund.id
            });

            expect(fund.name).to.equal("test");
            expect(fund.tracked).to.equal(true);
            expect(fund.start_date).to.not.equal(null);
            expect(fund.start_date.toString()).to.equal("2026-01-01");
            expect(fund.start_balance).to.equal(0);
            expect(fund.balance).to.equal(0);
            expect(fund.monthly).to.equal(false);
            expect(fund.parent_id).to.equal(pfund.id);
        });


        it("can create tracked monthly", () => {
            const pfund = Fund.create(db, {
                name: "parent",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
            });
            const fund = Fund.create(db, {
                name: "test",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                monthly: true,
                parent_id: pfund.id
            });

            expect(fund.name).to.equal("test");
            expect(fund.tracked).to.equal(true);
            expect(fund.start_date).to.not.equal(null);
            expect(fund.start_date.toString()).to.equal("2026-01-01");
            expect(fund.start_balance).to.equal(0);
            expect(fund.balance).to.equal(0);
            expect(fund.monthly).to.equal(true);
            expect(fund.parent_id).to.equal(pfund.id);
        });

        it("can create with initial balance", () => {
            const fund = Fund.create(db, {
                name: "test",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                start_balance: 100,
            });

            expect(fund.name).to.equal("test");
            expect(fund.tracked).to.equal(true);
            expect(fund.start_date).to.not.equal(null);
            expect(fund.start_date.toString()).to.equal("2026-01-01");
            expect(fund.start_balance).to.equal(100);
            expect(fund.balance).to.equal(100);
            expect(fund.monthly).to.equal(false);
        });

        it("untracked rejects balance and date", () => {
            const fund = Fund.create(db, {
                name: "test",
                tracked: false,
                start_date: YDate.parse("2026-01-01"), // ignored
                start_balance: 100, // ignored
            });

            expect(fund.name).to.equal("test");
            expect(fund.tracked).to.equal(false);
            expect(fund.start_date).to.equal(null);
            expect(fund.start_balance).to.equal(null);
            expect(fund.balance).to.equal(null);
            expect(fund.monthly).to.equal(false);
        });


        it("Consistency: tracked requires a start date", () => {
            expect(() => Fund.create(db, {
                name: "test",
                tracked: true,
                start_date: null, // Error!
            })).to.throw("Cannot set tracked without also providing start_date")
        });

        it("Consistency: tracked requires a start balance", () => {
            expect(() => Fund.create(db, {
                name: "test",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                start_balance: null,
            })).to.throw("Cannot set tracked without also providing (non-null) start_balance")
        });

        it("Consistency: monthly requires a parent", () => {
            expect(() => Fund.create(db, {
                name: "test",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                monthly: true,
                parent_id: null, // Error!
            })).to.throw("Cannot create a monthly fund without a parent")
        });

        it("Consistency: monthly requires tracking", () => {
            const pfund = Fund.create(db, {
                name: "parent",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                monthly: false,
            });
            expect(() => Fund.create(db, {
                name: "test",
                tracked: false, // Error!
                monthly: true,
                parent_id: pfund.id
            })).to.throw("Cannot create a monthly fund unless it is also tracked")
        });

        it("Conflict: repeated name", () => {
            const pfund = Fund.create(db, {
                name: "test",
                tracked: false,
            });
            expect(() => Fund.create(db, {
                name: "test", // Error
                tracked: false,
            })).to.throw(ConflictError, "Name already exists")
        });

        it("ForeignKeyError: bad parent id", () => {
            expect(() => Fund.create(db, {
                name: "test",
                tracked: false,
                parent_id: 10 // Error
            })).to.throw(ForeignKeyError, "Parent fund does not exist")
        });

    });


    describe(".from_db()", () => {
        beforeEach(() => {
            Fund.create(db, { // id = 1
                name: "fund1",
                tracked: false
            });
            Fund.create(db, { // id = 2
                name: "child1",
                tracked: false,
                parent_id: 1,
            });
            Fund.create(db, { // id = 3
                name: "fund2",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
            });
            Fund.create(db, { // id = 4
                name: "fund3",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
            });
            Fund.create(db, { // id = 5
                name: "child2",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                parent_id: 4
            });
            Fund.create(db, { // id = 6
                name: "child3",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                parent_id: 4
            });
            Fund.create(db, { // id = 7
                name: "grandchild1",
                tracked: true,
                start_date: YDate.parse("2026-01-01"),
                parent_id: 6
            });
        });


        it("Can get all", () => {
            const results = Fund.from_db(db, {});
            expect(results).to.have.length(7);
        })
        it("Can get by name", () => {
            const results = Fund.from_db(db, { name:"child2" });
            expect(results).to.have.length(1);
            expect(results[0].name).to.equal("child2");
        })
        it("Can get by names like", () => {
            const results = Fund.from_db(db, { name_like:"hild" });
            expect(results).to.have.length(4);
        })
        it("Can get by tracked", () => {
            const results = Fund.from_db(db, { tracked:true });
            expect(results).to.have.length(5);
        })
        it("Can get by roots", () => {
            const results = Fund.from_db(db, { root:true });
            expect(results).to.have.length(3);
        })

    });

});
