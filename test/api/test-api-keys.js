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

            // Future exchanges die, outstanding access tokens live out <=20m
            expect((await exchange(secret)).status).to.equal(400);
            const reads = await h.request("/api/funds/funds", { token: res.body.tokens.access });
            expect(reads.status).to.equal(200);
        });
    });

    describe("POST /api/users/user/:user_id/api-keys", () => {
        it("should mint a key for yourself and show the secret exactly once", async () => {
            const res = await h.request(`/api/users/user/${h.users.reader.id}/api-keys`, {
                method: "POST",
                token: h.tokens.reader,
                body: { name: "dashboard" },
            });

            expect(res.status).to.equal(200);
            expect(res.body.data.name).to.equal("dashboard");
            expect(res.body.data.reader).to.be.true;
            expect(res.body.data.editor).to.be.false;
            expect(res.body.data.expires_at).to.be.null;
            expect(res.body.data.api_key).to.match(/^ydd_[0-9a-f]{64}$/);
            expect(res.body.data).to.not.have.property("token_hash");
            expect(res.body.invalidations).to.deep.equal([
                { type: "invalidate", key: ["user", h.users.reader.id.toString(), "api-keys"] },
            ]);

            // The minted secret exchanges, and the list never re-shows it
            expect((await exchange(res.body.data.api_key)).status).to.equal(200);
            const list = await h.request(`/api/users/user/${h.users.reader.id}/api-keys`, { token: h.tokens.reader });
            expect(JSON.stringify(list.body)).to.not.include(res.body.data.api_key);
        });

        it("should honor role flags and ttl_days", async () => {
            const res = await h.request(`/api/users/user/${h.users.editor.id}/api-keys`, {
                method: "POST",
                token: h.tokens.editor,
                body: { name: "importer", reader: false, editor: true, ttl_days: 30 },
            });

            expect(res.status).to.equal(200);
            expect(res.body.data.reader).to.be.false;
            expect(res.body.data.editor).to.be.true;
            expect(res.body.data.expires_at).to.be.a("string");
        });

        it("should 400 bad parameters", async () => {
            for ( const body of [
                {},                                    // missing name
                { name: "" },                          // empty name
                { name: "x", ttl_days: -1 },           // non-positive ttl
                { name: "x", ttl_days: "soon" },       // non-numeric ttl
                { name: "x", editor: "yes" },          // non-boolean flag
            ] ) {
                const res = await h.request(`/api/users/user/${h.users.reader.id}/api-keys`, {
                    method: "POST",
                    token: h.tokens.reader,
                    body,
                });
                expect(res.status, JSON.stringify(body)).to.equal(400);
            }
        });

        it("should 401 unauthenticated", async () => {
            const res = await h.request(`/api/users/user/${h.users.reader.id}/api-keys`, {
                method: "POST",
                body: { name: "sneaky" },
            });

            expect(res.status).to.equal(401);
        });

        it("should 404 minting for another user without admin, and allow it with sudo", async () => {
            const denied = await h.request(`/api/users/user/${h.users.editor.id}/api-keys`, {
                method: "POST",
                token: h.tokens.reader,
                body: { name: "sneaky" },
            });
            expect(denied.status).to.equal(404);

            // Admin onboarding path: the key belongs to (and is scoped by) the target
            const res = await h.request(`/api/users/user/${h.users.reader.id}/api-keys`, {
                method: "POST",
                token: h.tokens.admin,
                sudo: true,
                body: { name: "handed over" },
            });
            expect(res.status).to.equal(200);
            expect(res.body.data.user_id).to.equal(h.users.reader.id);
            expect(res.body.invalidations).to.deep.equal([
                { type: "invalidate", key: ["user", h.users.reader.id.toString(), "api-keys"] },
            ]);
        });
    });

    describe("GET /api/users/user/:user_id/api-keys", () => {
        it("should list only that user's keys, with X-Total-Count", async () => {
            ApiKey.create(h.db, { user_id: h.users.editor.id, name: "not mine" });
            ApiKey.create(h.db, { user_id: h.users.reader.id, name: "mine" });

            const res = await h.request(`/api/users/user/${h.users.reader.id}/api-keys`, { token: h.tokens.reader });

            expect(res.status).to.equal(200);
            expect(res.body.map(k => k.name)).to.deep.equal(["mine"]);
            expect(res.headers.get("x-total-count")).to.equal("1");
        });

        it("should filter by active (expired keys stay listed by default)", async () => {
            ApiKey.create(h.db, { user_id: h.users.reader.id, name: "live" });
            ApiKey.create(h.db, { user_id: h.users.reader.id, name: "stale", ttl_days: -1 });

            const all = await h.request(`/api/users/user/${h.users.reader.id}/api-keys`, { token: h.tokens.reader });
            expect(all.body.map(k => k.name)).to.have.members(["live", "stale"]);

            const active = await h.request(`/api/users/user/${h.users.reader.id}/api-keys?active=true`, { token: h.tokens.reader });
            expect(active.body.map(k => k.name)).to.deep.equal(["live"]);
        });
    });

    describe("DELETE /api/users/user/:user_id/api-key/:api_key_id", () => {
        it("should revoke the caller's own key", async () => {
            const { api_key, secret } = ApiKey.create(h.db, {
                user_id: h.users.reader.id,
                name: "doomed",
            });

            const res = await h.request(`/api/users/user/${h.users.reader.id}/api-key/${api_key.id}`, {
                method: "DELETE",
                token: h.tokens.reader,
            });

            expect(res.status).to.equal(200);
            expect(res.body.data).to.be.null;
            expect(ApiKey.for_id(h.db, api_key.id)).to.be.null;
            expect((await exchange(secret)).status).to.equal(400);
        });

        it("should 404 a key under the wrong user and unknown/invalid ids", async () => {
            const { api_key } = ApiKey.create(h.db, {
                user_id: h.users.editor.id,
                name: "not yours",
            });

            for ( const id of [ api_key.id, 999, "nonsense" ] ) {
                const res = await h.request(`/api/users/user/${h.users.reader.id}/api-key/${id}`, {
                    method: "DELETE",
                    token: h.tokens.reader,
                });
                expect(res.status, String(id)).to.equal(404);
            }
            expect(ApiKey.for_id(h.db, api_key.id)).to.not.be.null;
        });
    });

    describe("admin: /api/users/user/:user_id/api-keys", () => {
        it("should list a user's keys, sudo-gated", async () => {
            ApiKey.create(h.db, { user_id: h.users.reader.id, name: "theirs" });

            const denied = await h.request(`/api/users/user/${h.users.reader.id}/api-keys`, {
                token: h.tokens.admin,
            });
            expect(denied.status).to.equal(403);

            const res = await h.request(`/api/users/user/${h.users.reader.id}/api-keys`, {
                token: h.tokens.admin,
                sudo: true,
            });
            expect(res.status).to.equal(200);
            expect(res.body.map(k => k.name)).to.deep.equal(["theirs"]);
            expect(res.headers.get("x-total-count")).to.equal("1");

            const unknown = await h.request("/api/users/user/999/api-keys", {
                token: h.tokens.admin,
                sudo: true,
            });
            expect(unknown.status).to.equal(404);
        });

        it("should revoke a user's key, 404ing a key under the wrong user", async () => {
            const { api_key } = ApiKey.create(h.db, {
                user_id: h.users.reader.id,
                name: "compromised",
            });

            const wrong_user = await h.request(`/api/users/user/${h.users.editor.id}/api-key/${api_key.id}`, {
                method: "DELETE",
                token: h.tokens.admin,
                sudo: true,
            });
            expect(wrong_user.status).to.equal(404);

            const res = await h.request(`/api/users/user/${h.users.reader.id}/api-key/${api_key.id}`, {
                method: "DELETE",
                token: h.tokens.admin,
                sudo: true,
            });
            expect(res.status).to.equal(200);
            expect(ApiKey.for_id(h.db, api_key.id)).to.be.null;
        });

        it("should 404 non-admins targeting another user (existence is never leaked)", async () => {
            const res = await h.request(`/api/users/user/${h.users.reader.id}/api-keys`, {
                token: h.tokens.editor,
                sudo: true,
            });

            expect(res.status).to.equal(404);
        });
    });

    describe("cascades", () => {
        it("should cascade keys away with user deletion", async () => {
            const { api_key, secret } = ApiKey.create(h.db, {
                user_id: h.users.reader.id,
                name: "orphaned",
            });

            const res = await h.request(`/api/users/user/${h.users.reader.id}`, {
                method: "DELETE",
                token: h.tokens.admin,
                sudo: true,
            });

            expect(res.status).to.equal(200);
            expect(res.body.invalidations).to.deep.include(
                { type: "remove", key: ["user", h.users.reader.id.toString(), "api-keys"] });
            expect(ApiKey.for_id(h.db, api_key.id)).to.be.null;
            expect((await exchange(secret)).status).to.equal(400);
        });
    });
});
