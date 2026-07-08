const { expect } = require("chai");
const { create_connection, initialize_db, ConflictError, ForeignKeyError } = require("../../lib/db.js");
const User = require("../../models/User.js");
const Session = require("../../models/Session.js");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe("Session Model", () => {
    let db;
    let user;

    beforeEach(async () => {
        db = create_connection({ path: ":memory:" });
        initialize_db(db);

        user = await User.create(db, {
            email: "alice@example.com",
            password: "hunter22hunter22",
        });
    });

    afterEach(() => {
        db.close();
    });

    describe("create()", () => {
        it("should create a session expiring in DEFAULT_TTL_DAYS", () => {
            const session = Session.create(db, { user_id: user.id });

            expect(session.id).to.be.a("number");
            expect(session.user_id).to.equal(user.id);
            expect(session.note).to.be.null;
            expect(session.last_used_at).to.be.null;
            expect(session.created_at).to.be.a("Date");
            expect(session.expired).to.be.false;

            const expected = Date.now() + Session.DEFAULT_TTL_DAYS * MS_PER_DAY;
            expect(session.expires_at.getTime()).to.be.closeTo(expected, 5000);
        });

        it("should honor a custom ttl_days and note", () => {
            const session = Session.create(db, {
                user_id: user.id,
                ttl_days: 1,
                note: "laptop cli",
            });

            expect(session.note).to.equal("laptop cli");

            const expected = Date.now() + 1 * MS_PER_DAY;
            expect(session.expires_at.getTime()).to.be.closeTo(expected, 5000);
        });

        it("should generate unique random token secrets", () => {
            const a = Session.create(db, { user_id: user.id });
            const b = Session.create(db, { user_id: user.id });

            expect(a.token).to.match(/^[0-9a-f]{32}$/);
            expect(b.token).to.match(/^[0-9a-f]{32}$/);
            expect(a.token).to.not.equal(b.token);
        });

        it("should reject a missing user", () => {
            expect(() => Session.create(db, { user_id: 999 })).to.throw(ForeignKeyError);
        });

        it("should reject bad inputs", () => {
            expect(() => Session.create(db, {})).to.throw("Missing user_id");
            expect(() => Session.create(db, { user_id: user.id, ttl_days: "soon" }))
                .to.throw("Invalid ttl_days");
        });

        it("should sweep expired sessions on login", () => {
            const live = Session.create(db, { user_id: user.id });
            const stale = Session.create(db, { user_id: user.id, ttl_days: -1 });

            const fresh = Session.create(db, { user_id: user.id });

            // Compare by token, not id: sqlite reuses the swept row's id for
            // the fresh session (the very hazard the token secret guards)
            const tokens = Session.from_db(db, { user_id: user.id }).map(s => s.token);
            expect(tokens).to.have.members([live.token, fresh.token]);
            expect(tokens).to.not.include(stale.token);
        });
    });

    describe("for_auth_payload()", () => {
        let session;
        let payload;

        beforeEach(() => {
            session = Session.create(db, { user_id: user.id });
            payload = user.to_auth_token_payload(session);
        });

        it("should return the session and touch last_used_at", () => {
            const refreshed = Session.for_auth_payload(db, payload);

            expect(refreshed.id).to.equal(session.id);
            expect(refreshed.last_used_at).to.be.a("Date");
            // Fixed expiry: refreshing never extends the session
            expect(refreshed.expires_at.getTime()).to.equal(session.expires_at.getTime());
        });

        it("should reject a wrong token secret", () => {
            expect(() => Session.for_auth_payload(db, { ...payload, token: "f".repeat(32) }))
                .to.throw(ConflictError);
            expect(() => Session.for_auth_payload(db, { ...payload, token: "short" }))
                .to.throw(ConflictError);
        });

        it("should reject an expired session", () => {
            const stale = Session.create(db, { user_id: user.id, ttl_days: -1 });
            const stale_payload = user.to_auth_token_payload(stale);

            expect(stale.expired).to.be.true;
            expect(() => Session.for_auth_payload(db, stale_payload))
                .to.throw(ConflictError, "expired");
        });

        it("should reject a deleted session (logout)", () => {
            session.delete(db);

            expect(() => Session.for_auth_payload(db, payload)).to.throw(ForeignKeyError);
        });

        it("should reject a sub/user mismatch", () => {
            expect(() => Session.for_auth_payload(db, { ...payload, sub: user.id + 1 }))
                .to.throw(ConflictError);
        });

        it("should reject access payloads and unknown versions", () => {
            const access = user.to_access_token_payload(session);

            expect(() => Session.for_auth_payload(db, access))
                .to.throw("Not an auth token payload");
            expect(() => Session.for_auth_payload(db, { ...payload, v: 2 }))
                .to.throw("Unsupported token payload version");
        });
    });

    describe("delete() -- logout", () => {
        it("should kill only that session", () => {
            const a = Session.create(db, { user_id: user.id });
            const b = Session.create(db, { user_id: user.id });

            a.delete(db);

            expect(Session.for_id(db, a.id)).to.be.null;
            expect(Session.for_id(db, b.id)).to.not.be.null;
        });

        it("should throw for an already-deleted session", () => {
            const session = Session.create(db, { user_id: user.id });
            session.delete(db);

            expect(() => session.delete(db)).to.throw(ForeignKeyError);
        });
    });

    describe("revoke_all()", () => {
        it("should kill all of a user's sessions and only theirs", async () => {
            const bob = await User.create(db, { email: "bob@example.com", password: "hunter22hunter22" });

            Session.create(db, { user_id: user.id });
            Session.create(db, { user_id: user.id });
            const bobs = Session.create(db, { user_id: bob.id });

            const count = Session.revoke_all(db, user.id);

            expect(count).to.equal(2);
            expect(Session.from_db(db, { user_id: user.id })).to.have.length(0);
            expect(Session.for_id(db, bobs.id)).to.not.be.null;
        });
    });

    describe("queries", () => {
        it("should filter by user_id and active", async () => {
            const bob = await User.create(db, { email: "bob@example.com", password: "hunter22hunter22" });

            Session.create(db, { user_id: bob.id });
            const live = Session.create(db, { user_id: user.id });
            // Expired sessions are created LAST: any later create would sweep them
            const stale = Session.create(db, { user_id: user.id, ttl_days: -1 });

            expect(Session.from_db(db, { user_id: user.id })).to.have.length(2);

            const active = Session.from_db(db, { user_id: user.id, active: true });
            expect(active).to.have.length(1);
            expect(active[0].id).to.equal(live.id);

            const expired = Session.from_db(db, { user_id: user.id, active: false });
            expect(expired).to.have.length(1);
            expect(expired[0].id).to.equal(stale.id);
        });

        it("should count with the same filters as from_db, ignoring order/limit/offset", async () => {
            const bob = await User.create(db, { email: "bob@example.com", password: "hunter22hunter22" });

            Session.create(db, { user_id: bob.id });
            Session.create(db, { user_id: user.id });
            // Expired sessions are created LAST: any later create would sweep them
            Session.create(db, { user_id: user.id, ttl_days: -1 });

            expect(Session.count(db)).to.equal(3);
            expect(Session.count(db, { user_id: user.id })).to.equal(2);
            expect(Session.count(db, { user_id: user.id, active: true })).to.equal(1);
            expect(Session.count(db, { user_id: user.id, limit: 1, offset: 0 })).to.equal(2);
        });

        it("should prune only expired sessions", () => {
            const live = Session.create(db, { user_id: user.id });
            Session.create(db, { user_id: user.id, ttl_days: -1 });

            const count = Session.prune(db);

            expect(count).to.equal(1);
            const remaining = Session.from_db(db, { user_id: user.id });
            expect(remaining).to.have.length(1);
            expect(remaining[0].id).to.equal(live.id);
        });
    });

    describe("to_api()", () => {
        it("should never expose the token secret", () => {
            const session = Session.create(db, { user_id: user.id, note: "laptop" });

            const api = session.to_api();

            expect(api).to.deep.equal({
                id: session.id,
                user_id: user.id,
                note: "laptop",
                expires_at: session.expires_at.toISOString(),
                last_used_at: null,
                created_at: session.created_at.toISOString(),
            });
            expect(api).to.not.have.property("token");
        });
    });
});
