const { expect } = require("chai");

const { start_harness } = require("./harness.js");
const User = require("../../models/User.js");
const Session = require("../../models/Session.js");

describe("Users API", () => {
    let h;

    beforeEach(async () => {
        h = await start_harness();
    });

    afterEach(() => h.stop());

    describe("GET /api/users/me", () => {
        it("requires authentication (but no role)", async () => {
            expect((await h.request("/api/users/me")).status).to.equal(401);
        });

        it("returns the authenticated user, fresh", async () => {
            const { status, body } = await h.request("/api/users/me", { token: h.tokens.reader });
            expect(status).to.equal(200);
            expect(body.email).to.equal("reader@example.com");
            expect(body.roles).to.deep.equal({ admin: false, reader: true, editor: false });
            expect(body).to.not.have.property("password_hash");

            // Fresh from the db: a role change shows up immediately, even
            // though the access token still carries the old roles
            h.users.reader.update(h.db, { editor: true });
            const fresh = await h.request("/api/users/me", { token: h.tokens.reader });
            expect(fresh.body.roles.editor).to.be.true;
        });
    });

    describe("POST /api/users/me/password", () => {
        it("changes the password and revokes every session by default", async () => {
            const { status, body } = await h.request("/api/users/me/password", {
                method: "POST", token: h.tokens.reader,
                body: { current_password: "hunter22hunter22", password: "newpassword123" }
            });
            expect(status).to.equal(200);
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["me", "sessions"] });

            expect(await User.authenticate(h.db, { email: "reader@example.com", password: "newpassword123" })).to.not.be.null;
            expect(Session.from_db(h.db, { user_id: h.users.reader.id })).to.have.lengthOf(0);
        });

        it("keeps sessions with revoke_sessions=false", async () => {
            await h.request("/api/users/me/password", {
                method: "POST", token: h.tokens.reader,
                body: { current_password: "hunter22hunter22", password: "newpassword123", revoke_sessions: false }
            });
            expect(Session.from_db(h.db, { user_id: h.users.reader.id })).to.have.lengthOf(1);
        });

        it("uniformly 400s on a wrong current password", async () => {
            const { status, body } = await h.request("/api/users/me/password", {
                method: "POST", token: h.tokens.reader,
                body: { current_password: "wrong-password", password: "newpassword123" }
            });
            expect(status).to.equal(400);
            expect(body.message).to.equal("Bad password");
        });

        it("400s on a too-short new password (model rule)", async () => {
            const { status } = await h.request("/api/users/me/password", {
                method: "POST", token: h.tokens.reader,
                body: { current_password: "hunter22hunter22", password: "short" }
            });
            expect(status).to.equal(400);
        });
    });

    describe("GET /api/users/me/sessions", () => {
        it("lists own sessions without the secret", async () => {
            const { status, body } = await h.request("/api/users/me/sessions", { token: h.tokens.reader });
            expect(status).to.equal(200);
            expect(body).to.have.lengthOf(1);
            expect(body[0].user_id).to.equal(h.users.reader.id);
            expect(body[0]).to.not.have.property("token");
        });

        it("filters by active", async () => {
            // NOTE : expired fabrications must be created LAST -- every
            //        Session.create sweeps expired rows
            Session.create(h.db, { user_id: h.users.reader.id, ttl_days: -1 });

            let res = await h.request("/api/users/me/sessions?active=true", { token: h.tokens.reader });
            expect(res.body).to.have.lengthOf(1);

            res = await h.request("/api/users/me/sessions?active=false", { token: h.tokens.reader });
            expect(res.body).to.have.lengthOf(1);
        });
    });

    describe("DELETE /api/users/me/session/:session_id", () => {
        it("deletes an owned session", async () => {
            const [ session ] = Session.from_db(h.db, { user_id: h.users.reader.id });
            const { status, body } = await h.request(`/api/users/me/session/${session.id}`, { method: "DELETE", token: h.tokens.reader });
            expect(status).to.equal(200);
            expect(body.data).to.be.null;
            expect(Session.for_id(h.db, session.id)).to.be.null;
        });

        it("404s (not 403s) on another user's session", async () => {
            const [ foreign ] = Session.from_db(h.db, { user_id: h.users.editor.id });
            const { status } = await h.request(`/api/users/me/session/${foreign.id}`, { method: "DELETE", token: h.tokens.reader });
            expect(status).to.equal(404);
            expect(Session.for_id(h.db, foreign.id)).to.not.be.null;
        });
    });

    describe("admin gating", () => {
        it("403s without the admin role", async () => {
            expect((await h.request("/api/users/users", { token: h.tokens.editor, sudo: true })).status).to.equal(403);
        });

        it("403s an admin without X-Sudo-Mode", async () => {
            expect((await h.request("/api/users/users", { token: h.tokens.admin })).status).to.equal(403);
        });
    });

    describe("GET /api/users/users", () => {
        it("lists users; effective-role filters count admins", async () => {
            const { status, body } = await h.request("/api/users/users", { token: h.tokens.admin, sudo: true });
            expect(status).to.equal(200);
            expect(body).to.have.lengthOf(3);

            // editor filter matches the explicit editor AND the admin (effective)
            const res = await h.request("/api/users/users?editor=true", { token: h.tokens.admin, sudo: true });
            expect(res.body.map((u) => u.email)).to.include.members([ "editor@example.com", "admin@example.com" ]);
        });
    });

    describe("POST /api/users/users", () => {
        it("creates a user (normalized email)", async () => {
            const { status, body } = await h.request("/api/users/users", {
                method: "POST", token: h.tokens.admin, sudo: true,
                body: { email: "  New.User@Example.COM ", password: "longenoughpw", editor: true }
            });
            expect(status).to.equal(200);
            expect(body.data.email).to.equal("new.user@example.com");
            expect(body.data.roles.editor).to.be.true;
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["users"] });
        });

        it("409s on a duplicate email, 400s on a short password", async () => {
            let res = await h.request("/api/users/users", { method: "POST", token: h.tokens.admin, sudo: true, body: { email: "READER@example.com", password: "longenoughpw" } });
            expect(res.status).to.equal(409);

            res = await h.request("/api/users/users", { method: "POST", token: h.tokens.admin, sudo: true, body: { email: "x@example.com", password: "short" } });
            expect(res.status).to.equal(400);
        });
    });

    describe("GET /api/users/user/:user_id (+ sessions)", () => {
        it("returns a user and their sessions", async () => {
            const { body } = await h.request(`/api/users/user/${h.users.editor.id}`, { token: h.tokens.admin, sudo: true });
            expect(body.email).to.equal("editor@example.com");

            const sessions = await h.request(`/api/users/user/${h.users.editor.id}/sessions`, { token: h.tokens.admin, sudo: true });
            expect(sessions.body).to.have.lengthOf(1);
            expect(sessions.body[0]).to.not.have.property("token");
        });

        it("404s on missing", async () => {
            expect((await h.request("/api/users/user/9999", { token: h.tokens.admin, sudo: true })).status).to.equal(404);
        });
    });

    describe("PATCH /api/users/user/:user_id", () => {
        it("updates roles and email", async () => {
            const { status, body } = await h.request(`/api/users/user/${h.users.reader.id}`, {
                method: "PATCH", token: h.tokens.admin, sudo: true,
                body: { editor: true, email: "Promoted@Example.com" }
            });
            expect(status).to.equal(200);
            expect(body.data.email).to.equal("promoted@example.com");
            expect(body.data.roles.editor).to.be.true;
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["user", h.users.reader.id.toString()] });
        });

        it("adds a me invalidation when editing yourself", async () => {
            const { body } = await h.request(`/api/users/user/${h.users.admin.id}`, {
                method: "PATCH", token: h.tokens.admin, sudo: true,
                body: { editor: true }
            });
            expect(body.invalidations).to.deep.include({ type: "invalidate", key: ["me"] });
        });
    });

    describe("POST /api/users/user/:user_id/password", () => {
        it("resets the password and revokes their sessions by default", async () => {
            const { status } = await h.request(`/api/users/user/${h.users.reader.id}/password`, {
                method: "POST", token: h.tokens.admin, sudo: true,
                body: { password: "adminreset123" }
            });
            expect(status).to.equal(200);
            expect(await User.authenticate(h.db, { email: "reader@example.com", password: "adminreset123" })).to.not.be.null;
            expect(Session.from_db(h.db, { user_id: h.users.reader.id })).to.have.lengthOf(0);
        });
    });

    describe("DELETE /api/users/user/:user_id", () => {
        it("deletes a user, cascading their sessions", async () => {
            const { status, body } = await h.request(`/api/users/user/${h.users.reader.id}`, { method: "DELETE", token: h.tokens.admin, sudo: true });
            expect(status).to.equal(200);
            expect(body.data).to.be.null;
            expect(User.for_id(h.db, h.users.reader.id)).to.be.null;
            expect(Session.from_db(h.db, { user_id: h.users.reader.id })).to.have.lengthOf(0);
        });

        it("refuses self-deletion", async () => {
            const { status, body } = await h.request(`/api/users/user/${h.users.admin.id}`, { method: "DELETE", token: h.tokens.admin, sudo: true });
            expect(status).to.equal(400);
            expect(body.message).to.include("another admin");
        });
    });
});
