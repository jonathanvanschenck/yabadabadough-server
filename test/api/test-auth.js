const crypto = require("crypto");

const { expect } = require("chai");

const { create_connection, initialize_db } = require("../../lib/db.js");
const TokenManager = require("../../lib/TokenManager.js");
const Webserver = require("../../lib/Webserver.js");
const User = require("../../models/User.js");
const Session = require("../../models/Session.js");

// Real end-to-end tests: an in-memory db behind a Webserver on an ephemeral
// port, driven with fetch. secure_cookies is off (plain http) and penalty_ms
// is tiny so the deliberate-failure tests stay fast.
const CONFIG = {
    api: {
        dev: false,
        disable_auth: false,
        secure_cookies: false,
        version: "test",
        penalty_ms: 5,
        swagger: { use: false }
    },
    webservice: {
        local: { address: "127.0.0.1", port: 0, protocol: "http" },
        proxy: { address: "localhost", port: 443, protocol: "https" }
    }
};

function generate_key() {
    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    return { kid: "test", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) };
}

describe("Auth API", () => {
    let db, tm, ws, base;
    let alice; // admin (bob is a plain reader-only user)

    beforeEach(async () => {
        db = create_connection({ path: ":memory:" });
        initialize_db(db);

        alice = await User.create(db, { email: "alice@example.com", password: "hunter22hunter22", admin: true });
        await User.create(db, { email: "bob@example.com", password: "hunter22hunter22" });

        tm = new TokenManager({ keys: [ generate_key() ] });
        ws = new Webserver(CONFIG, { db, token_manager: tm });
        await ws.start();
        base = `http://127.0.0.1:${ws.server.address().port}`;
    });

    afterEach(async () => {
        await ws.stop();
        db.close();
    });

    async function post(path, body, headers={}) {
        const res = await fetch(base + path, {
            method: "POST",
            headers: Object.assign(
                body !== undefined ? { "content-type": "application/json" } : {},
                headers
            ),
            body: body !== undefined ? JSON.stringify(body) : undefined,
        });
        return { res, body: await res.json() };
    }

    async function get(path, headers={}) {
        const res = await fetch(base + path, { headers });
        return { res, body: await res.json() };
    }

    async function login(email="alice@example.com", password="hunter22hunter22") {
        const { res, body } = await post("/api/auth/login", { email, password });
        expect(res.status).to.equal(200);
        return body;
    }

    describe("POST /api/auth/login", () => {
        it("logs in and returns user, session, and tokens", async () => {
            const { res, body } = await post("/api/auth/login", {
                email: "alice@example.com",
                password: "hunter22hunter22",
            }, { "user-agent": "mocha-test" });

            expect(res.status).to.equal(200);
            expect(body.user.email).to.equal("alice@example.com");
            expect(body.user).to.not.have.property("password_hash");
            expect(body.session.user_id).to.equal(alice.id);
            expect(body.session.note).to.equal("mocha-test");
            expect(body.session).to.not.have.property("token");
            expect(body.tokens.access.split(".")).to.have.length(3);
            expect(body.tokens.auth.split(".")).to.have.length(3);

            // The auth token expiry mirrors the session's
            const payload = tm.verify(body.tokens.auth);
            expect(payload.typ).to.equal("auth");
            expect(payload.exp).to.equal(Math.floor(new Date(body.session.expires_at).getTime() / 1000));

            // Cookies: access rides everywhere, auth only to /api/auth
            const cookies = res.headers.getSetCookie();
            const access_cookie = cookies.find(c => c.startsWith("access_token="));
            const auth_cookie = cookies.find(c => c.startsWith("auth_token="));
            expect(access_cookie).to.include("HttpOnly");
            expect(auth_cookie).to.include("Path=/api/auth");
            expect(auth_cookie).to.include("HttpOnly");
        });

        it("rejects bad credentials with a uniform 400", async () => {
            const wrong = await post("/api/auth/login", { email: "alice@example.com", password: "not-the-password" });
            const unknown = await post("/api/auth/login", { email: "nobody@example.com", password: "hunter22hunter22" });

            expect(wrong.res.status).to.equal(400);
            expect(unknown.res.status).to.equal(400);
            // Never distinguishable
            expect(wrong.body.message).to.equal(unknown.body.message);
        });

        it("rejects missing fields", async () => {
            const { res } = await post("/api/auth/login", { email: "alice@example.com" });
            expect(res.status).to.equal(400);
        });
    });

    describe("access control", () => {
        it("rejects unauthenticated requests with 401", async () => {
            const { res } = await get("/api/auth/check");
            expect(res.status).to.equal(401);
        });

        it("accepts the access token as a Bearer header or a cookie", async () => {
            const { tokens } = await login();

            const bearer = await get("/api/auth/check", { authorization: `Bearer ${tokens.access}` });
            expect(bearer.res.status).to.equal(200);

            const cookie = await get("/api/auth/check", { cookie: `access_token=${tokens.access}` });
            expect(cookie.res.status).to.equal(200);
        });

        it("rejects auth tokens on the request path (wrong typ)", async () => {
            const { tokens } = await login();
            const { res } = await get("/api/auth/check", { authorization: `Bearer ${tokens.auth}` });
            expect(res.status).to.equal(401);
        });

        it("gates roles: a plain user is a reader but not an editor/admin", async () => {
            const { tokens } = await login("bob@example.com");
            const headers = { authorization: `Bearer ${tokens.access}` };

            expect((await get("/api/auth/check-reader", headers)).res.status).to.equal(200);
            expect((await get("/api/auth/check-editor", headers)).res.status).to.equal(403);
            expect((await get("/api/auth/check-admin", headers)).res.status).to.equal(403);
        });

        it("admins have every role, but admin itself is masked without X-Sudo-Mode", async () => {
            const { tokens } = await login(); // alice, admin
            const headers = { authorization: `Bearer ${tokens.access}` };

            expect((await get("/api/auth/check-reader", headers)).res.status).to.equal(200);
            expect((await get("/api/auth/check-editor", headers)).res.status).to.equal(200);

            // Sudo masking: admin requires explicitly asking for it
            expect((await get("/api/auth/check-admin", headers)).res.status).to.equal(403);
            expect((await get("/api/auth/check-admin", Object.assign({ "x-sudo-mode": "true" }, headers))).res.status).to.equal(200);
        });
    });

    describe("POST /api/auth/refresh", () => {
        it("mints a fresh access token from the auth token alone", async () => {
            const { tokens, session } = await login();

            const { res, body } = await post("/api/auth/refresh", { auth: tokens.auth });

            expect(res.status).to.equal(200);
            expect(body.tokens.auth).to.equal(tokens.auth); // no rotation in v1
            expect(body.session.id).to.equal(session.id);
            expect(body.session.last_used_at).to.not.be.null;

            const check = await get("/api/auth/check", { authorization: `Bearer ${body.tokens.access}` });
            expect(check.res.status).to.equal(200);
        });

        it("accepts the auth token from its cookie", async () => {
            const { tokens } = await login();
            const { res } = await post("/api/auth/refresh", {}, { cookie: `auth_token=${tokens.auth}` });
            expect(res.status).to.equal(200);
        });

        it("rejects garbage, access-typed, and orphaned auth tokens uniformly", async () => {
            const { tokens } = await login();

            expect((await post("/api/auth/refresh", { auth: "not-a-token" })).res.status).to.equal(400);
            expect((await post("/api/auth/refresh", { auth: tokens.access })).res.status).to.equal(400);
            expect((await post("/api/auth/refresh", {})).res.status).to.equal(400);

            // Kill the session behind an otherwise-valid auth token
            Session.for_id(db, tm.peek(tokens.auth).sid).delete(db);
            expect((await post("/api/auth/refresh", { auth: tokens.auth })).res.status).to.equal(400);
        });
    });

    describe("POST /api/auth/authenticate", () => {
        it("reports current state for a valid access token without minting", async () => {
            const { tokens, session } = await login();

            const { res, body } = await post("/api/auth/authenticate", { access: tokens.access, auth: tokens.auth });

            expect(res.status).to.equal(200);
            expect(body.tokens.access).to.equal(tokens.access);
            expect(body.session.id).to.equal(session.id);
            expect(body.user.email).to.equal("alice@example.com");
        });

        it("falls back to the refresh flow with auto_refresh", async () => {
            const { tokens } = await login();
            const expired = tm.tokenize(tm.peek(tokens.access), { ttl_s: -10 });

            const denied = await post("/api/auth/authenticate", { access: expired, auth: tokens.auth });
            expect(denied.res.status).to.equal(400);

            const { res, body } = await post("/api/auth/authenticate", {
                access: expired,
                auth: tokens.auth,
                auto_refresh: true,
            });
            expect(res.status).to.equal(200);
            expect(body.tokens.access).to.not.equal(expired);

            const check = await get("/api/auth/check", { authorization: `Bearer ${body.tokens.access}` });
            expect(check.res.status).to.equal(200);
        });
    });

    describe("POST /api/auth/logout", () => {
        it("kills the session (auth token stops refreshing) and clears cookies", async () => {
            const { tokens } = await login();

            const { res, body } = await post("/api/auth/logout", {}, { cookie: `auth_token=${tokens.auth}` });
            expect(res.status).to.equal(200);
            expect(body.message).to.equal("OK");

            const cleared = res.headers.getSetCookie();
            expect(cleared.some(c => c.startsWith("access_token=;"))).to.be.true;
            expect(cleared.some(c => c.startsWith("auth_token=;"))).to.be.true;

            expect((await post("/api/auth/refresh", { auth: tokens.auth })).res.status).to.equal(400);
        });

        it("leaves other devices' sessions alone, and is idempotent", async () => {
            const phone = await login();
            const laptop = await login();

            expect((await post("/api/auth/logout", { auth: phone.tokens.auth })).res.status).to.equal(200);
            // Repeat + garbage: still OK
            expect((await post("/api/auth/logout", { auth: phone.tokens.auth })).res.status).to.equal(200);
            expect((await post("/api/auth/logout", { auth: "garbage" })).res.status).to.equal(200);
            expect((await post("/api/auth/logout", {})).res.status).to.equal(200);

            expect((await post("/api/auth/refresh", { auth: phone.tokens.auth })).res.status).to.equal(400);
            expect((await post("/api/auth/refresh", { auth: laptop.tokens.auth })).res.status).to.equal(200);
        });
    });

    describe("POST /api/auth/revoke-all", () => {
        it("kills every session for the authenticated user", async () => {
            const phone = await login();
            const laptop = await login();
            const bobs = await login("bob@example.com");

            const { res, body } = await post("/api/auth/revoke-all", undefined, {
                authorization: `Bearer ${phone.tokens.access}`,
            });

            expect(res.status).to.equal(200);
            expect(body.revoked).to.equal(2);

            expect((await post("/api/auth/refresh", { auth: phone.tokens.auth })).res.status).to.equal(400);
            expect((await post("/api/auth/refresh", { auth: laptop.tokens.auth })).res.status).to.equal(400);
            // Bob is untouched
            expect((await post("/api/auth/refresh", { auth: bobs.tokens.auth })).res.status).to.equal(200);
        });

        it("requires authentication", async () => {
            const { res } = await post("/api/auth/revoke-all", undefined);
            expect(res.status).to.equal(401);
        });
    });
});
