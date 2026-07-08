const { expect } = require("chai");
const crypto = require("crypto");
const { create_connection, initialize_db, ConflictError, ForeignKeyError } = require("../../lib/db.js");
const User = require("../../models/User.js");
const ApiKey = require("../../models/ApiKey.js");

const MS_PER_DAY = 24 * 60 * 60 * 1000;

describe("ApiKey Model", () => {
    let db;
    let user;

    beforeEach(async () => {
        db = create_connection({ path: ":memory:" });
        initialize_db(db);

        user = await User.create(db, {
            email: "alice@example.com",
            password: "hunter22hunter22",
            editor: true,
        });
    });

    afterEach(() => {
        db.close();
    });

    describe("create()", () => {
        it("should create a never-expiring reader key by default", () => {
            const { api_key, secret } = ApiKey.create(db, {
                user_id: user.id,
                name: "dashboard",
            });

            expect(api_key.id).to.be.a("number");
            expect(api_key.user_id).to.equal(user.id);
            expect(api_key.name).to.equal("dashboard");
            expect(api_key.reader).to.be.true;
            expect(api_key.editor).to.be.false;
            expect(api_key.expires_at).to.be.null;
            expect(api_key.expired).to.be.false;
            expect(api_key.last_used_at).to.be.null;
            expect(api_key.created_at).to.be.a("Date");

            expect(secret).to.match(/^ydd_[0-9a-f]{64}$/);
        });

        it("should store only the sha256 of the secret", () => {
            const { api_key, secret } = ApiKey.create(db, {
                user_id: user.id,
                name: "dashboard",
            });

            const expected = crypto.createHash("sha256").update(secret, "utf8").digest("hex");
            expect(api_key.token_hash).to.equal(expected);
            expect(api_key.token_hash).to.not.include(secret);

            const row = db.prepare("SELECT * FROM user_api_keys WHERE id = ?").get(api_key.id);
            expect(row.token_hash).to.equal(expected);
        });

        it("should generate unique secrets", () => {
            const a = ApiKey.create(db, { user_id: user.id, name: "a" });
            const b = ApiKey.create(db, { user_id: user.id, name: "b" });

            expect(a.secret).to.not.equal(b.secret);
        });

        it("should honor role flags and ttl_days", () => {
            const { api_key } = ApiKey.create(db, {
                user_id: user.id,
                name: "importer",
                reader: false,
                editor: true,
                ttl_days: 30,
            });

            expect(api_key.reader).to.be.false;
            expect(api_key.editor).to.be.true;

            const expected = Date.now() + 30 * MS_PER_DAY;
            expect(api_key.expires_at.getTime()).to.be.closeTo(expected, 5000);
        });

        it("should allow a negative ttl_days to fabricate an expired key", () => {
            const { api_key } = ApiKey.create(db, {
                user_id: user.id,
                name: "stale",
                ttl_days: -1,
            });

            expect(api_key.expired).to.be.true;
            // No prune sweep: expired keys stay listed
            ApiKey.create(db, { user_id: user.id, name: "later" });
            expect(ApiKey.for_id(db, api_key.id)).to.not.be.null;
        });

        it("should reject a missing user", () => {
            expect(() => ApiKey.create(db, { user_id: 999, name: "orphan" }))
                .to.throw(ForeignKeyError);
        });

        it("should reject bad inputs", () => {
            expect(() => ApiKey.create(db, { name: "no user" })).to.throw("Missing user_id");
            expect(() => ApiKey.create(db, { user_id: user.id })).to.throw("Missing name");
            expect(() => ApiKey.create(db, { user_id: user.id, name: "   " }))
                .to.throw("Missing name");
            expect(() => ApiKey.create(db, { user_id: user.id, name: "x", ttl_days: "soon" }))
                .to.throw("Invalid ttl_days");
        });
    });

    describe("for_exchange()", () => {
        it("should return the key and touch last_used_at", () => {
            const { api_key, secret } = ApiKey.create(db, { user_id: user.id, name: "cli" });

            const exchanged = ApiKey.for_exchange(db, secret);

            expect(exchanged.id).to.equal(api_key.id);
            expect(exchanged.last_used_at).to.be.a("Date");
        });

        it("should reject an unknown secret", () => {
            ApiKey.create(db, { user_id: user.id, name: "cli" });

            expect(() => ApiKey.for_exchange(db, "ydd_" + "0".repeat(64)))
                .to.throw(ForeignKeyError);
            expect(() => ApiKey.for_exchange(db, "")).to.throw(ForeignKeyError);
        });

        it("should reject an expired key", () => {
            const { secret } = ApiKey.create(db, {
                user_id: user.id,
                name: "stale",
                ttl_days: -1,
            });

            expect(() => ApiKey.for_exchange(db, secret))
                .to.throw(ConflictError, "expired");
        });

        it("should reject a revoked key", () => {
            const { api_key, secret } = ApiKey.create(db, { user_id: user.id, name: "cli" });
            api_key.delete(db);

            expect(() => ApiKey.for_exchange(db, secret)).to.throw(ForeignKeyError);
        });

        it("should accept a never-expiring key forever", () => {
            const { secret } = ApiKey.create(db, { user_id: user.id, name: "cli" });

            expect(() => ApiKey.for_exchange(db, secret)).to.not.throw();
        });
    });

    describe("User#to_api_key_access_token_payload()", () => {
        it("should render a sessionless access payload", () => {
            const { api_key } = ApiKey.create(db, { user_id: user.id, name: "cli", editor: true });

            const payload = user.to_api_key_access_token_payload(api_key);

            expect(payload).to.deep.equal({
                v: 1,
                typ: "access",
                sub: user.id,
                email: user.email,
                admin: false,
                reader: true,
                editor: true,
                sid: null,
                akid: api_key.id,
            });
        });

        it("should mask roles by the key's flags", () => {
            const { api_key } = ApiKey.create(db, {
                user_id: user.id,
                name: "read only",
                editor: false,
            });

            const payload = user.to_api_key_access_token_payload(api_key);

            expect(payload.reader).to.be.true;
            expect(payload.editor).to.be.false;
        });

        it("should mask roles by the user's effective roles", async () => {
            const bob = await User.create(db, {
                email: "bob@example.com",
                password: "hunter22hunter22",
                // reader default on, no editor
            });
            const { api_key } = ApiKey.create(db, {
                user_id: bob.id,
                name: "wishful importer",
                editor: true,
            });

            const payload = bob.to_api_key_access_token_payload(api_key);

            expect(payload.reader).to.be.true;
            expect(payload.editor).to.be.false;
        });

        it("should never mint admin, even for admin owners", async () => {
            const root = await User.create(db, {
                email: "root@example.com",
                password: "hunter22hunter22",
                admin: true,
            });
            const { api_key } = ApiKey.create(db, {
                user_id: root.id,
                name: "root key",
                editor: true,
            });

            const payload = root.to_api_key_access_token_payload(api_key);

            expect(payload.admin).to.be.false;
            // Admin still implies the other effective roles
            expect(payload.reader).to.be.true;
            expect(payload.editor).to.be.true;
        });

        it("should reject a foreign key", async () => {
            const bob = await User.create(db, {
                email: "bob@example.com",
                password: "hunter22hunter22",
            });
            const { api_key } = ApiKey.create(db, { user_id: bob.id, name: "bobs" });

            expect(() => user.to_api_key_access_token_payload(api_key))
                .to.throw(ConflictError);
            expect(() => user.to_api_key_access_token_payload(null))
                .to.throw(ConflictError);
        });

        it("should round-trip through User.from_token_payload", () => {
            const { api_key } = ApiKey.create(db, { user_id: user.id, name: "cli", editor: true });

            const payload = user.to_api_key_access_token_payload(api_key);
            const stateless = User.from_token_payload(payload);

            expect(stateless.id).to.equal(user.id);
            expect(stateless.roles).to.deep.equal({ admin: false, reader: true, editor: true });
        });
    });

    describe("delete() -- revocation", () => {
        it("should kill only that key", () => {
            const a = ApiKey.create(db, { user_id: user.id, name: "a" }).api_key;
            const b = ApiKey.create(db, { user_id: user.id, name: "b" }).api_key;

            a.delete(db);

            expect(ApiKey.for_id(db, a.id)).to.be.null;
            expect(ApiKey.for_id(db, b.id)).to.not.be.null;
        });

        it("should throw for an already-deleted key", () => {
            const { api_key } = ApiKey.create(db, { user_id: user.id, name: "a" });
            api_key.delete(db);

            expect(() => api_key.delete(db)).to.throw(ForeignKeyError);
        });

        it("should cascade with user deletion", () => {
            const { api_key } = ApiKey.create(db, { user_id: user.id, name: "a" });

            user.delete(db);

            expect(ApiKey.for_id(db, api_key.id)).to.be.null;
        });
    });

    describe("queries", () => {
        it("should filter by user_id and active", async () => {
            const bob = await User.create(db, { email: "bob@example.com", password: "hunter22hunter22" });

            ApiKey.create(db, { user_id: bob.id, name: "bobs" });
            const forever = ApiKey.create(db, { user_id: user.id, name: "forever" }).api_key;
            const bounded = ApiKey.create(db, { user_id: user.id, name: "bounded", ttl_days: 30 }).api_key;
            const stale = ApiKey.create(db, { user_id: user.id, name: "stale", ttl_days: -1 }).api_key;

            expect(ApiKey.from_db(db, { user_id: user.id })).to.have.length(3);

            // Null expires_at counts as active
            const active = ApiKey.from_db(db, { user_id: user.id, active: true });
            expect(active.map(k => k.id)).to.have.members([forever.id, bounded.id]);

            const expired = ApiKey.from_db(db, { user_id: user.id, active: false });
            expect(expired.map(k => k.id)).to.deep.equal([stale.id]);
        });

        it("should count with the same filters as from_db, ignoring order/limit/offset", async () => {
            const bob = await User.create(db, { email: "bob@example.com", password: "hunter22hunter22" });

            ApiKey.create(db, { user_id: bob.id, name: "bobs" });
            ApiKey.create(db, { user_id: user.id, name: "forever" });
            ApiKey.create(db, { user_id: user.id, name: "stale", ttl_days: -1 });

            expect(ApiKey.count(db)).to.equal(3);
            expect(ApiKey.count(db, { user_id: user.id })).to.equal(2);
            expect(ApiKey.count(db, { user_id: user.id, active: true })).to.equal(1);
            expect(ApiKey.count(db, { user_id: user.id, limit: 1, offset: 0 })).to.equal(2);
        });

        it("should order by the whitelisted columns", () => {
            ApiKey.create(db, { user_id: user.id, name: "zebra" });
            ApiKey.create(db, { user_id: user.id, name: "aardvark" });

            const by_name = ApiKey.from_db(db, { order_by: "name" });
            expect(by_name.map(k => k.name)).to.deep.equal(["aardvark", "zebra"]);

            expect(() => ApiKey.from_db(db, { order_by: "token_hash" })).to.throw();
        });
    });

    describe("to_api()", () => {
        it("should never expose the token hash", () => {
            const { api_key } = ApiKey.create(db, {
                user_id: user.id,
                name: "dashboard",
                ttl_days: 30,
            });

            const api = api_key.to_api();

            expect(api).to.deep.equal({
                id: api_key.id,
                user_id: user.id,
                name: "dashboard",
                reader: true,
                editor: false,
                expires_at: api_key.expires_at.toISOString(),
                last_used_at: null,
                created_at: api_key.created_at.toISOString(),
            });
            expect(api).to.not.have.property("token_hash");
        });

        it("should render a null expires_at for never-expiring keys", () => {
            const { api_key } = ApiKey.create(db, { user_id: user.id, name: "forever" });

            expect(api_key.to_api().expires_at).to.be.null;
        });
    });
});
