const { expect } = require("chai");

const { create_connection, initialize_db, schema_version } = require("../lib/db.js");
const Fund = require("../models/Fund.js");
const TransactionGroup = require("../models/TransactionGroup.js");

// The version a freshly-initialized _schema.sql lands on
const CURRENT_VERSION = 3;

// Reconstruct an older database from the CURRENT schema by undoing each
// migration in reverse, rather than carrying a frozen copy of every
// historical schema around. Each entry undoes the migration that produced
// that version -- indexes first, since sqlite refuses to drop a column an
// index still references.
const REWIND = {
    3: (db) => {
        db.exec("DROP INDEX idx_transaction_groups_expects_statement");
        db.exec("DROP INDEX idx_transaction_groups_reference");
        db.exec("ALTER TABLE transaction_groups DROP COLUMN expects_statement");
        db.exec("ALTER TABLE transaction_groups DROP COLUMN reference");
    },
    2: (db) => {
        db.exec("ALTER TABLE funds DROP COLUMN description");
    },
};

const rewind_to = (db, target) => {
    initialize_db(db);
    for ( let v = CURRENT_VERSION; v > target; v-- ) REWIND[v](db);
    db.pragma("user_version = " + target);
};

describe("lib/db.js migrations", () => {
    let db;
    beforeEach(() => {
        db = create_connection({ path: ":memory:" });
    });

    it("fresh databases get the current schema version directly", () => {
        initialize_db(db);
        expect(schema_version(db)).to.equal(CURRENT_VERSION);
    });

    describe("1 -> 2 (funds.description)", () => {
        beforeEach(() => rewind_to(db, 1));

        it("adds the column, preserves rows, and bumps the version", () => {
            db.prepare(
                "INSERT INTO funds (name, tracked) VALUES ('pre-existing', 0)"
            ).run();

            initialize_db(db);

            expect(schema_version(db)).to.equal(CURRENT_VERSION);
            const fund = Fund.from_db(db)[0];
            expect(fund.name).to.equal("pre-existing");
            expect(fund.description).to.equal(null);

            // And the migrated column is fully writable
            const updated = fund.update(db, { description: "added post-migration" });
            expect(updated.description).to.equal("added post-migration");
        });

        it("is idempotent across restarts (a migrated db initializes cleanly)", () => {
            initialize_db(db);
            initialize_db(db);
            expect(schema_version(db)).to.equal(CURRENT_VERSION);
        });

        it("runs the whole chain in one pass (1 -> 3)", () => {
            db.prepare(
                "INSERT INTO transaction_groups (date, description, split) VALUES ('2026-01-01', 'v1 group', 0)"
            ).run();

            initialize_db(db);

            expect(schema_version(db)).to.equal(3);
            const group = TransactionGroup.from_db(db)[0];
            expect(group.description).to.equal("v1 group");
            expect(group.expects_statement).to.be.false;
            expect(group.reference).to.equal(null);
        });
    });

    describe("2 -> 3 (transaction_groups.expects_statement / .reference)", () => {
        beforeEach(() => rewind_to(db, 2));

        it("adds the columns, preserves rows, and bumps the version", () => {
            db.prepare(
                "INSERT INTO transaction_groups (date, description, split) VALUES ('2026-07-01', 'pre-existing', 0)"
            ).run();

            initialize_db(db);

            expect(schema_version(db)).to.equal(3);
            const group = TransactionGroup.from_db(db)[0];
            expect(group.description).to.equal("pre-existing");
            // Existing groups default to "no bank line expected" -- the only
            // safe reading of a group that predates the flag
            expect(group.expects_statement).to.be.false;
            expect(group.reference).to.equal(null);
            expect(group.outstanding).to.be.false;
        });

        it("leaves the migrated columns fully writable", () => {
            db.prepare(
                "INSERT INTO transaction_groups (date, description, split) VALUES ('2026-07-01', 'cheque', 0)"
            ).run();

            initialize_db(db);

            const group = TransactionGroup.from_db(db)[0];
            const updated = group.update(db, { expects_statement: true, reference: "1247" });

            expect(updated.expects_statement).to.be.true;
            expect(updated.reference).to.equal("1247");
            expect(updated.outstanding).to.be.true;
        });

        it("carries the internal-group CHECK across the migration", () => {
            initialize_db(db);

            expect(() => db.prepare(
                "INSERT INTO transaction_groups (date, description, split, allocation, expects_statement)"
                + " VALUES ('2026-07-01', 'bad', 0, 1, 1)"
            ).run()).to.throw(/CHECK constraint failed/);
        });

        it("is idempotent across restarts (a migrated db initializes cleanly)", () => {
            initialize_db(db);
            initialize_db(db);
            expect(schema_version(db)).to.equal(CURRENT_VERSION);
        });
    });
});
