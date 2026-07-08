const { expect } = require("chai");
const { start_harness } = require("./harness.js");
const ApiKey = require("../../models/ApiKey.js");

describe("API: api keys", () => {
    let h;

    beforeEach(async () => {
        h = await start_harness();
    });

    afterEach(() => h.stop());

    async function exchange(api_key) {
        return h.request("/api/auth/api-token", {
            method: "POST",
            body: { api_key },
        });
    }

    describe("POST /api/auth/api-token", () => {
        it("should exchange a key for a working sessionless access token", async () => {
            const { secret } = ApiKey.create(h.db, {
                user_id: h.users.editor.id,
                name: "importer",
                editor: true,
            });

            const res = await exchange(secret);

            expect(res.status).to.equal(200);
            expect(res.body.user.id).to.equal(h.users.editor.id);
            expect(res.body.tokens.access).to.be.a("string");
            expect(res.body.tokens).to.not.have.property("auth");

            // The payload is a standard access token, sans session/admin
            const payload = h.token_manager.verify(res.body.tokens.access);
            expect(payload.typ).to.equal("access");
            expect(payload.sid).to.be.null;
            expect(payload.admin).to.be.false;
            expect(payload.reader).to.be.true;
            expect(payload.editor).to.be.true;

            // And it works against real endpoints, read and write
            const reads = await h.request("/api/funds/funds", { token: res.body.tokens.access });
            expect(reads.status).to.equal(200);

            const writes = await h.request("/api/funds/funds", {
                method: "POST",
                token: res.body.tokens.access,
                body: { name: "Wallet", tracked: false },
            });
            expect(writes.status).to.equal(200);
        });

        it("should touch the key's last_used_at", async () => {
            const { api_key, secret } = ApiKey.create(h.db, {
                user_id: h.users.reader.id,
                name: "dashboard",
            });
            expect(api_key.last_used_at).to.be.null;

            await exchange(secret);

            expect(ApiKey.for_id(h.db, api_key.id).last_used_at).to.be.a("Date");
        });

        it("should scope the minted token by the key's flags", async () => {
            // Reader-only key on an editor user: writes are refused
            const { secret } = ApiKey.create(h.db, {
                user_id: h.users.editor.id,
                name: "read only",
            });

            const res = await exchange(secret);
            const writes = await h.request("/api/funds/funds", {
                method: "POST",
                token: res.body.tokens.access,
                body: { name: "Wallet", tracked: false },
            });

            expect(writes.status).to.equal(403);
        });

        it("should scope the minted token by the owner's effective roles", async () => {
            // Editor key on a reader-only user: the intersection wins
            const { secret } = ApiKey.create(h.db, {
                user_id: h.users.reader.id,
                name: "wishful importer",
                editor: true,
            });

            const res = await exchange(secret);
            const payload = h.token_manager.verify(res.body.tokens.access);

            expect(payload.editor).to.be.false;
        });

        it("should never mint admin, even for admin owners with sudo", async () => {
            const { secret } = ApiKey.create(h.db, {
                user_id: h.users.admin.id,
                name: "root key",
                editor: true,
            });

            const res = await exchange(secret);
            const admin = await h.request("/api/users/users", {
                token: res.body.tokens.access,
                sudo: true,
            });

            expect(admin.status).to.equal(403);
        });

        it("should uniformly 400 unknown, revoked, and expired keys", async () => {
            const { api_key, secret } = ApiKey.create(h.db, {
                user_id: h.users.reader.id,
                name: "revoked",
            });
            api_key.delete(h.db);
            const { secret: stale } = ApiKey.create(h.db, {
                user_id: h.users.reader.id,
                name: "stale",
                ttl_days: -1,
            });

            for ( const key of [ "ydd_" + "0".repeat(64), secret, stale ] ) {
                const res = await exchange(key);
                expect(res.status).to.equal(400);
                expect(res.body.message).to.equal("Bad API key");
            }
        });

        it("should 400 a missing api_key", async () => {
            const res = await h.request("/api/auth/api-token", { method: "POST", body: {} });

            expect(res.status).to.equal(400);
            expect(res.body.message).to.equal("Bad API key");
        });

        it("should keep serving an already-minted token after revocation (staleness window)", async () => {
            const { api_key, secret } = ApiKey.create(h.db, {
                user_id: h.users.reader.id,
                name: "dashboard",
            });

            const res = await exchange(secret);
            api_key.delete(h.db);

            // Future exchanges die, outstanding access tokens live out <=1h
            expect((await exchange(secret)).status).to.equal(400);
            const reads = await h.request("/api/funds/funds", { token: res.body.tokens.access });
            expect(reads.status).to.equal(200);
        });
    });
});
