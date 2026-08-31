const { expect } = require("chai");

const { create_connection, initialize_db, schema_version } = require("../lib/db.js");
const Fund = require("../models/Fund.js");

describe("lib/db.js migrations", () => {
    let db;
    beforeEach(() => {
        db = create_connection({ path: ":memory:" });
    });

    it("fresh databases get the current schema version directly", () => {
        initialize_db(db);
        expect(schema_version(db)).to.equal(2);
    });

    describe("1 -> 2 (funds.description)", () => {
        // Reconstruct a version-1 database from the current schema: drop the
        // column the migration adds and rewind user_version. This keeps the
        // fixture honest without carrying a frozen copy of the old schema.
        beforeEach(() => {
            initialize_db(db);
            db.exec("ALTER TABLE funds DROP COLUMN description");
            db.pragma("user_version = 1");
        });

        it("adds the column, preserves rows, and bumps the version", () => {
            db.prepare(
                "INSERT INTO funds (name, tracked) VALUES ('pre-existing', 0)"
            ).run();

            initialize_db(db);

            expect(schema_version(db)).to.equal(2);
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
            expect(schema_version(db)).to.equal(2);
        });
    });
});
