const { expect } = require("chai");
const { create_connection, initialize_db, ConflictError, ForeignKeyError } = require("../../lib/db.js");
const User = require("../../models/User.js");
const Session = require("../../models/Session.js");

// User.create / set_password / authenticate / verify_password are async
// (scrypt runs on the threadpool), so throwing expectations need a helper
async function rejects(promise) {
    try {
        await promise;
    } catch (err) {
        return err;
    }
    throw new Error("Expected a rejection");
}

describe("User Model", () => {
    let db;

    beforeEach(() => {
        db = create_connection({ path: ":memory:" });
        initialize_db(db);
    });

    afterEach(() => {
        db.close();
    });

    describe("create()", () => {
        it("should create a user", async () => {
            const user = await User.create(db, {
                email: "alice@example.com",
                password: "hunter22hunter22",
            });

            expect(user.id).to.be.a("number");
            expect(user.email).to.equal("alice@example.com");
            expect(user.admin).to.be.false;
            expect(user.reader).to.be.true; // everyone defaults to reader
            expect(user.editor).to.be.false;
            expect(user.created_at).to.be.a("Date");
        });

        it("should create an admin user", async () => {
            const user = await User.create(db, {
                email: "root@example.com",
                password: "hunter22hunter22",
                admin: true,
            });

            expect(user.admin).to.be.true;
        });

        it("should create an editor user", async () => {
            const user = await User.create(db, {
                email: "editor@example.com",
                password: "hunter22hunter22",
                editor: true,
            });

            expect(user.editor).to.be.true;
            expect(user.admin).to.be.false;
        });

        it("should allow revoking the default reader role", async () => {
            const user = await User.create(db, {
                email: "norole@example.com",
                password: "hunter22hunter22",
                reader: false,
            });

            expect(user.reader).to.be.false;
        });

        it("should normalize email case and whitespace", async () => {
            const user = await User.create(db, {
                email: "  Alice@Example.COM ",
                password: "hunter22hunter22",
            });

            expect(user.email).to.equal("alice@example.com");
        });

        it("should reject duplicate emails", async () => {
            await User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });

            const err = await rejects(User.create(db, {
                email: "alice@example.com",
                password: "different-password",
            }));
            expect(err).to.be.an.instanceOf(ConflictError);
        });

        it("should reject case-insensitive duplicate emails", async () => {
            await User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });

            const err = await rejects(User.create(db, {
                email: "ALICE@example.com",
                password: "different-password",
            }));
            expect(err).to.be.an.instanceOf(ConflictError);
        });

        it("should reject missing or malformed emails", async () => {
            expect((await rejects(User.create(db, { password: "hunter22hunter22" }))).message)
                .to.include("Missing email");
            expect((await rejects(User.create(db, { email: "not-an-email", password: "hunter22hunter22" }))).message)
                .to.include("Invalid email");
        });

        it("should reject missing or short passwords", async () => {
            expect((await rejects(User.create(db, { email: "alice@example.com" }))).message)
                .to.include("Missing password");
            expect((await rejects(User.create(db, { email: "alice@example.com", password: "short12" }))).message)
                .to.include("at least 8 characters");
        });
    });

    describe("create_first_admin()", () => {
        it("should create an admin on an empty table", async () => {
            const user = await User.create_first_admin(db, {
                email: "  Root@Example.com ",
                password: "hunter22hunter22"
            });

            expect(user.email).to.equal("root@example.com");
            expect(user.admin).to.equal(true);
            // Stored flags are what was explicitly granted; admin implies
            // the rest effectively
            expect(user.reader).to.equal(true);
            expect(user.editor).to.equal(false);
            expect(user.roles).to.deep.equal({ admin: true, reader: true, editor: true });
        });

        it("should set a password that actually verifies", async () => {
            await User.create_first_admin(db, { email: "root@example.com", password: "hunter22hunter22" });
            expect(await User.authenticate(db, { email: "root@example.com", password: "hunter22hunter22" })).to.not.equal(null);
            expect(await User.authenticate(db, { email: "root@example.com", password: "wrong-password" })).to.equal(null);
        });

        it("should refuse once ANY user exists, whoever they are", async () => {
            // A plain non-admin reader is still enough to close the route
            await User.create(db, { email: "bob@example.com", password: "hunter22hunter22" });

            const err = await rejects(User.create_first_admin(db, {
                email: "root@example.com",
                password: "hunter22hunter22"
            }));
            expect(err).to.be.instanceOf(ConflictError);
            expect(err.message).to.include("already been completed");
            expect(User.count(db)).to.equal(1);
        });

        it("should validate email and password like create()", async () => {
            expect((await rejects(User.create_first_admin(db, { email: "nope", password: "hunter22hunter22" }))).message)
                .to.include("Invalid email");
            expect((await rejects(User.create_first_admin(db, { email: "root@example.com", password: "short12" }))).message)
                .to.include("at least 8 characters");

            // Neither failure consumed the one-shot
            expect(User.count(db)).to.equal(0);
        });

        it("should be atomic: only one of many concurrent calls wins", async () => {
            // The check and the insert share one transaction, so racing
            // callers cannot both pass a check-then-create
            const results = await Promise.allSettled([
                User.create_first_admin(db, { email: "a@example.com", password: "hunter22hunter22" }),
                User.create_first_admin(db, { email: "b@example.com", password: "hunter22hunter22" }),
                User.create_first_admin(db, { email: "c@example.com", password: "hunter22hunter22" }),
            ]);

            expect(results.filter(r => r.status === "fulfilled")).to.have.lengthOf(1);
            expect(results.filter(r => r.status === "rejected")).to.have.lengthOf(2);
            expect(User.count(db)).to.equal(1);
        });
    });

    describe("passwords", () => {
        it("should verify the correct password and reject others", async () => {
            const user = await User.create(db, {
                email: "alice@example.com",
                password: "hunter22hunter22",
            });

            expect(await user.verify_password("hunter22hunter22")).to.be.true;
            expect(await user.verify_password("wrong-password!")).to.be.false;
        });

        it("should store a self-describing scrypt hash string", async () => {
            const user = await User.create(db, {
                email: "alice@example.com",
                password: "hunter22hunter22",
            });

            const parts = user.password_hash.split("$");
            expect(parts).to.have.length(6);
            expect(parts[0]).to.equal("scrypt");
            expect(parseInt(parts[1])).to.be.a("number"); // N
            expect(parseInt(parts[2])).to.be.a("number"); // r
            expect(parseInt(parts[3])).to.be.a("number"); // p
        });

        it("should salt hashes uniquely", async () => {
            const a = await User.create(db, { email: "a@example.com", password: "hunter22hunter22" });
            const b = await User.create(db, { email: "b@example.com", password: "hunter22hunter22" });

            expect(a.password_hash).to.not.equal(b.password_hash);
        });

        it("should re-hash on set_password", async () => {
            const user = await User.create(db, {
                email: "alice@example.com",
                password: "hunter22hunter22",
            });

            const updated = await user.set_password(db, "a-new-password");

            expect(updated.password_hash).to.not.equal(user.password_hash);
            expect(await updated.verify_password("a-new-password")).to.be.true;
            expect(await updated.verify_password("hunter22hunter22")).to.be.false;
        });

        it("should reject short passwords on set_password", async () => {
            const user = await User.create(db, {
                email: "alice@example.com",
                password: "hunter22hunter22",
            });

            expect((await rejects(user.set_password(db, "short12"))).message)
                .to.include("at least 8 characters");
        });
    });

    describe("authenticate()", () => {
        beforeEach(async () => {
            await User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });
        });

        it("should return the user for correct credentials", async () => {
            const user = await User.authenticate(db, {
                email: "alice@example.com",
                password: "hunter22hunter22",
            });

            expect(user).to.not.be.null;
            expect(user.email).to.equal("alice@example.com");
        });

        it("should normalize the email", async () => {
            const user = await User.authenticate(db, {
                email: " ALICE@example.com ",
                password: "hunter22hunter22",
            });

            expect(user).to.not.be.null;
        });

        it("should return null for a wrong password", async () => {
            expect(await User.authenticate(db, {
                email: "alice@example.com",
                password: "wrong-password!",
            })).to.be.null;
        });

        it("should return null for an unknown email", async () => {
            expect(await User.authenticate(db, {
                email: "nobody@example.com",
                password: "hunter22hunter22",
            })).to.be.null;
        });
    });

    describe("queries", () => {
        it("should return null for missing ids and emails", () => {
            expect(User.for_id(db, 999)).to.be.null;
            expect(User.for_email(db, "nobody@example.com")).to.be.null;
        });

        it("should find by normalized email", async () => {
            const user = await User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });

            expect(User.for_email(db, " ALICE@Example.com ").id).to.equal(user.id);
        });

        it("should filter and order from_db", async () => {
            await User.create(db, { email: "b@example.com", password: "hunter22hunter22" });
            await User.create(db, { email: "a@example.com", password: "hunter22hunter22", admin: true });

            const admins = User.from_db(db, { admin: true });
            expect(admins).to.have.length(1);
            expect(admins[0].email).to.equal("a@example.com");

            const all = User.from_db(db, { order_by: "email", order_direction: "ASC" });
            expect(all.map(u => u.email)).to.deep.equal(["a@example.com", "b@example.com"]);
        });

        it("should count with the same filters as from_db, ignoring order/limit/offset", async () => {
            await User.create(db, { email: "b@example.com", password: "hunter22hunter22" });
            await User.create(db, { email: "a@example.com", password: "hunter22hunter22", admin: true });

            expect(User.count(db)).to.equal(2);
            expect(User.count(db, { admin: true })).to.equal(1);
            // Effective-role filter: the admin counts as an editor
            expect(User.count(db, { editor: true })).to.equal(1);
            expect(User.count(db, { order_by: "email", limit: 1, offset: 0 })).to.equal(2);
        });
    });

    describe("update()", () => {
        it("should update email and admin", async () => {
            const user = await User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });

            const updated = user.update(db, { email: " NEW@Example.com ", admin: true });

            expect(updated.email).to.equal("new@example.com");
            expect(updated.admin).to.be.true;
            // Password is untouched
            expect(await updated.verify_password("hunter22hunter22")).to.be.true;
        });

        it("should update the reader and editor flags", async () => {
            const user = await User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });

            const updated = user.update(db, { reader: false, editor: true });

            expect(updated.reader).to.be.false;
            expect(updated.editor).to.be.true;
        });

        it("should leave omitted fields alone", async () => {
            const user = await User.create(db, {
                email: "alice@example.com",
                password: "hunter22hunter22",
                admin: true,
                editor: true
            });

            const updated = user.update(db, { admin: false });

            expect(updated.email).to.equal("alice@example.com");
            expect(updated.admin).to.be.false;
            expect(updated.reader).to.be.true;
            expect(updated.editor).to.be.true;
        });

        it("should reject an email belonging to another user", async () => {
            await User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });
            const bob = await User.create(db, { email: "bob@example.com", password: "hunter22hunter22" });

            expect(() => bob.update(db, { email: "alice@example.com" })).to.throw(ConflictError);
        });

        it("should allow a user to keep their own email", async () => {
            const user = await User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });

            const updated = user.update(db, { email: "alice@example.com", admin: true });
            expect(updated.admin).to.be.true;
        });
    });

    describe("delete()", () => {
        it("should delete the user and cascade their sessions", async () => {
            const user = await User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });
            const session = Session.create(db, { user_id: user.id });

            user.delete(db);

            expect(User.for_id(db, user.id)).to.be.null;
            expect(Session.for_id(db, session.id)).to.be.null;
        });

        it("should throw for an already-deleted user", async () => {
            const user = await User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });
            user.delete(db);

            expect(() => user.delete(db)).to.throw(ForeignKeyError);
        });
    });

    describe("to_api()", () => {
        it("should never expose the password hash", async () => {
            const user = await User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });

            const api = user.to_api();

            expect(api).to.deep.equal({
                id: user.id,
                email: "alice@example.com",
                admin: false,
                reader: true,
                editor: false,
                roles: { admin: false, reader: true, editor: false },
                created_at: user.created_at.toISOString(),
            });
            expect(api).to.not.have.property("password_hash");
        });
    });

    describe("roles", () => {
        it("should default to reader only", async () => {
            const user = await User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });

            expect(user.roles).to.deep.equal({ admin: false, reader: true, editor: false });
        });

        it("should grant admins every other role", async () => {
            const user = await User.create(db, {
                email: "root@example.com",
                password: "hunter22hunter22",
                admin: true,
                reader: false, // even with the stored flags revoked
                editor: false,
            });

            expect(user.reader).to.be.false;
            expect(user.editor).to.be.false;
            expect(user.roles).to.deep.equal({ admin: true, reader: true, editor: true });
        });

        it("should not grant editors anything extra", async () => {
            const user = await User.create(db, {
                email: "editor@example.com",
                password: "hunter22hunter22",
                editor: true,
                reader: false,
            });

            expect(user.roles).to.deep.equal({ admin: false, reader: false, editor: true });
        });

        it("should filter from_db by effective role", async () => {
            await User.create(db, { email: "reader@example.com", password: "hunter22hunter22" });
            await User.create(db, { email: "editor@example.com", password: "hunter22hunter22", editor: true });
            await User.create(db, { email: "root@example.com", password: "hunter22hunter22", admin: true, reader: false });
            await User.create(db, { email: "norole@example.com", password: "hunter22hunter22", reader: false });

            // Admins count as editors/readers even when the stored flags are off
            const editors = User.from_db(db, { editor: true, order_by: "email" });
            expect(editors.map(u => u.email)).to.deep.equal(["editor@example.com", "root@example.com"]);

            const readers = User.from_db(db, { reader: true, order_by: "email" });
            expect(readers.map(u => u.email)).to.deep.equal(["editor@example.com", "reader@example.com", "root@example.com"]);

            const non_readers = User.from_db(db, { reader: false });
            expect(non_readers.map(u => u.email)).to.deep.equal(["norole@example.com"]);
        });
    });

    describe("token payloads", () => {
        let user;
        let session;

        beforeEach(async () => {
            user = await User.create(db, {
                email: "alice@example.com",
                password: "hunter22hunter22",
                admin: true
            });
            session = Session.create(db, { user_id: user.id });
        });

        it("should render the access token payload with effective roles", () => {
            // user is admin with editor NOT explicitly granted -- the payload
            // carries effective roles, so editor comes out true anyway
            expect(user.editor).to.be.false;
            expect(user.to_access_token_payload(session)).to.deep.equal({
                v: 1,
                typ: "access",
                sub: user.id,
                email: "alice@example.com",
                admin: true,
                reader: true,
                editor: true,
                sid: session.id,
            });
        });

        it("should render the auth token payload", () => {
            expect(user.to_auth_token_payload(session)).to.deep.equal({
                v: 1,
                typ: "auth",
                sub: user.id,
                sid: session.id,
                token: session.token,
            });
        });

        it("should reject another user's session", async () => {
            const bob = await User.create(db, { email: "bob@example.com", password: "hunter22hunter22" });

            expect(() => bob.to_access_token_payload(session)).to.throw(ConflictError);
            expect(() => bob.to_auth_token_payload(session)).to.throw(ConflictError);
        });

        it("should round-trip through from_token_payload", () => {
            const clone = User.from_token_payload(user.to_access_token_payload(session));

            expect(clone.id).to.equal(user.id);
            expect(clone.email).to.equal(user.email);
            expect(clone.admin).to.equal(user.admin);
            expect(clone.roles).to.deep.equal(user.roles);
            expect(clone.password_hash).to.be.null;
        });

        it("should reject auth payloads and unknown versions", () => {
            expect(() => User.from_token_payload(user.to_auth_token_payload(session)))
                .to.throw("Not an access token payload");
            expect(() => User.from_token_payload({ v: 2, typ: "access", sub: user.id }))
                .to.throw("Unsupported token payload version");
        });
    });
});
