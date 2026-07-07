const crypto = require("crypto");

const { create_connection, initialize_db } = require("../../lib/db.js");
const TokenManager = require("../../lib/TokenManager.js");
const Webserver = require("../../lib/Webserver.js");
const User = require("../../models/User.js");
const Session = require("../../models/Session.js");

const CONFIG = {
    api: {
        dev: false,
        disable_auth: false,
        secure_cookies: false,
        version: "test-version",
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

/**
 * The shared API-test harness: real Webserver on an ephemeral port, in-memory
 * db, and one user + access token per role (reader/editor/admin).
 *
 *     let h;
 *     beforeEach(async () => { h = await start_harness(); });
 *     afterEach(() => h.stop());
 *
 *     const { status, body, headers } = await h.request("/api/funds/funds", {
 *         token: h.tokens.editor, method: "POST", body: {...}, sudo: false
 *     });
 */
async function start_harness() {
    const db = create_connection({ path: ":memory:" });
    initialize_db(db);

    const tm = new TokenManager({ keys: [ generate_key() ] });

    const users = {};
    const tokens = {};
    for ( const [ name, flags ] of [
        [ "reader", {} ],
        [ "editor", { editor: true } ],
        [ "admin", { admin: true } ],
    ] ) {
        const user = await User.create(db, { email: `${name}@example.com`, password: "hunter22hunter22", ...flags });
        const session = Session.create(db, { user_id: user.id });
        users[name] = user;
        tokens[name] = tm.tokenize(user.to_access_token_payload(session), { ttl_s: User.ACCESS_TOKEN_TTL_S });
    }

    const ws = new Webserver(CONFIG, { db, token_manager: tm });
    await ws.start();
    const base = `http://127.0.0.1:${ws.server.address().port}`;

    return {
        db,
        ws,
        base,
        users,
        tokens,
        token_manager: tm,

        async request(path, { method="GET", token, body, sudo=false, headers={} }={}) {
            const res = await fetch(base + path, {
                method,
                headers: {
                    ...(token ? { authorization: `Bearer ${token}` } : {}),
                    ...(body !== undefined ? { "content-type": "application/json" } : {}),
                    ...(sudo ? { "x-sudo-mode": "true" } : {}),
                    ...headers,
                },
                body: body !== undefined ? JSON.stringify(body) : undefined,
            });
            const text = await res.text();
            let json = null;
            try { json = text ? JSON.parse(text) : null; } catch (err) { /* non-JSON body */ }
            return { status: res.status, body: json, headers: res.headers };
        },

        async stop() {
            await ws.stop();
            db.close();
        }
    };
}

module.exports = { start_harness, CONFIG, generate_key };
