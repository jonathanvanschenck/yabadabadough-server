const { expect } = require("chai");
const { create_connection, initialize_db, ConflictError, ForeignKeyError } = require("../../lib/db.js");
const User = require("../../models/User.js");
const Session = require("../../models/Session.js");

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
        it("should create a user", () => {
            const user = User.create(db, {
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

        it("should create an admin user", () => {
            const user = User.create(db, {
                email: "root@example.com",
                password: "hunter22hunter22",
                admin: true,
            });

            expect(user.admin).to.be.true;
        });

        it("should create an editor user", () => {
            const user = User.create(db, {
                email: "editor@example.com",
                password: "hunter22hunter22",
                editor: true,
            });

            expect(user.editor).to.be.true;
            expect(user.admin).to.be.false;
        });

        it("should allow revoking the default reader role", () => {
            const user = User.create(db, {
                email: "norole@example.com",
                password: "hunter22hunter22",
                reader: false,
            });

            expect(user.reader).to.be.false;
        });

        it("should normalize email case and whitespace", () => {
            const user = User.create(db, {
                email: "  Alice@Example.COM ",
                password: "hunter22hunter22",
            });

            expect(user.email).to.equal("alice@example.com");
        });

        it("should reject duplicate emails", () => {
            User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });

            expect(() => User.create(db, {
                email: "alice@example.com",
                password: "different-password",
            })).to.throw(ConflictError);
        });

        it("should reject case-insensitive duplicate emails", () => {
            User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });

            expect(() => User.create(db, {
                email: "ALICE@example.com",
                password: "different-password",
            })).to.throw(ConflictError);
        });

        it("should reject missing or malformed emails", () => {
            expect(() => User.create(db, { password: "hunter22hunter22" }))
                .to.throw("Missing email");
            expect(() => User.create(db, { email: "not-an-email", password: "hunter22hunter22" }))
                .to.throw("Invalid email");
        });

        it("should reject missing or short passwords", () => {
            expect(() => User.create(db, { email: "alice@example.com" }))
                .to.throw("Missing password");
            expect(() => User.create(db, { email: "alice@example.com", password: "short12" }))
                .to.throw("at least 8 characters");
        });
    });

    describe("passwords", () => {
        it("should verify the correct password and reject others", () => {
            const user = User.create(db, {
                email: "alice@example.com",
                password: "hunter22hunter22",
            });

            expect(user.verify_password("hunter22hunter22")).to.be.true;
            expect(user.verify_password("wrong-password!")).to.be.false;
        });

        it("should store a self-describing scrypt hash string", () => {
            const user = User.create(db, {
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

        it("should salt hashes uniquely", () => {
            const a = User.create(db, { email: "a@example.com", password: "hunter22hunter22" });
            const b = User.create(db, { email: "b@example.com", password: "hunter22hunter22" });

            expect(a.password_hash).to.not.equal(b.password_hash);
        });

        it("should re-hash on set_password", () => {
            const user = User.create(db, {
                email: "alice@example.com",
                password: "hunter22hunter22",
            });

            const updated = user.set_password(db, "a-new-password");

            expect(updated.password_hash).to.not.equal(user.password_hash);
            expect(updated.verify_password("a-new-password")).to.be.true;
            expect(updated.verify_password("hunter22hunter22")).to.be.false;
        });

        it("should reject short passwords on set_password", () => {
            const user = User.create(db, {
                email: "alice@example.com",
                password: "hunter22hunter22",
            });

            expect(() => user.set_password(db, "short12")).to.throw("at least 8 characters");
        });
    });

    describe("authenticate()", () => {
        beforeEach(() => {
            User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });
        });

        it("should return the user for correct credentials", () => {
            const user = User.authenticate(db, {
                email: "alice@example.com",
                password: "hunter22hunter22",
            });

            expect(user).to.not.be.null;
            expect(user.email).to.equal("alice@example.com");
        });

        it("should normalize the email", () => {
            const user = User.authenticate(db, {
                email: " ALICE@example.com ",
                password: "hunter22hunter22",
            });

            expect(user).to.not.be.null;
        });

        it("should return null for a wrong password", () => {
            expect(User.authenticate(db, {
                email: "alice@example.com",
                password: "wrong-password!",
            })).to.be.null;
        });

        it("should return null for an unknown email", () => {
            expect(User.authenticate(db, {
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

        it("should find by normalized email", () => {
            const user = User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });

            expect(User.for_email(db, " ALICE@Example.com ").id).to.equal(user.id);
        });

        it("should filter and order from_db", () => {
            User.create(db, { email: "b@example.com", password: "hunter22hunter22" });
            User.create(db, { email: "a@example.com", password: "hunter22hunter22", admin: true });

            const admins = User.from_db(db, { admin: true });
            expect(admins).to.have.length(1);
            expect(admins[0].email).to.equal("a@example.com");

            const all = User.from_db(db, { order_by: "email", order_direction: "ASC" });
            expect(all.map(u => u.email)).to.deep.equal(["a@example.com", "b@example.com"]);
        });
    });

    describe("update()", () => {
        it("should update email and admin", () => {
            const user = User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });

            const updated = user.update(db, { email: " NEW@Example.com ", admin: true });

            expect(updated.email).to.equal("new@example.com");
            expect(updated.admin).to.be.true;
            // Password is untouched
            expect(updated.verify_password("hunter22hunter22")).to.be.true;
        });

        it("should update the reader and editor flags", () => {
            const user = User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });

            const updated = user.update(db, { reader: false, editor: true });

            expect(updated.reader).to.be.false;
            expect(updated.editor).to.be.true;
        });

        it("should leave omitted fields alone", () => {
            const user = User.create(db, {
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

        it("should reject an email belonging to another user", () => {
            User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });
            const bob = User.create(db, { email: "bob@example.com", password: "hunter22hunter22" });

            expect(() => bob.update(db, { email: "alice@example.com" })).to.throw(ConflictError);
        });

        it("should allow a user to keep their own email", () => {
            const user = User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });

            const updated = user.update(db, { email: "alice@example.com", admin: true });
            expect(updated.admin).to.be.true;
        });
    });

    describe("delete()", () => {
        it("should delete the user and cascade their sessions", () => {
            const user = User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });
            const session = Session.create(db, { user_id: user.id });

            user.delete(db);

            expect(User.for_id(db, user.id)).to.be.null;
            expect(Session.for_id(db, session.id)).to.be.null;
        });

        it("should throw for an already-deleted user", () => {
            const user = User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });
            user.delete(db);

            expect(() => user.delete(db)).to.throw(ForeignKeyError);
        });
    });

    describe("to_api()", () => {
        it("should never expose the password hash", () => {
            const user = User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });

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
        it("should default to reader only", () => {
            const user = User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });

            expect(user.roles).to.deep.equal({ admin: false, reader: true, editor: false });
        });

        it("should grant admins every other role", () => {
            const user = User.create(db, {
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

        it("should not grant editors anything extra", () => {
            const user = User.create(db, {
                email: "editor@example.com",
                password: "hunter22hunter22",
                editor: true,
                reader: false,
            });

            expect(user.roles).to.deep.equal({ admin: false, reader: false, editor: true });
        });

        it("should filter from_db by effective role", () => {
            User.create(db, { email: "reader@example.com", password: "hunter22hunter22" });
            User.create(db, { email: "editor@example.com", password: "hunter22hunter22", editor: true });
            User.create(db, { email: "root@example.com", password: "hunter22hunter22", admin: true, reader: false });
            User.create(db, { email: "norole@example.com", password: "hunter22hunter22", reader: false });

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

        beforeEach(() => {
            user = User.create(db, {
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

        it("should reject another user's session", () => {
            const bob = User.create(db, { email: "bob@example.com", password: "hunter22hunter22" });

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
