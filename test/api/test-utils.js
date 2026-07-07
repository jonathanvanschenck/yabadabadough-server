const crypto = require("crypto");

const { expect } = require("chai");

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

describe("Utils API", () => {
    let db, ws, base, access;

    beforeEach(async () => {
        db = create_connection({ path: ":memory:" });
        initialize_db(db);

        const user = await User.create(db, { email: "alice@example.com", password: "hunter22hunter22" });
        const session = Session.create(db, { user_id: user.id });

        const tm = new TokenManager({ keys: [ generate_key() ] });
        access = tm.tokenize(user.to_access_token_payload(session), { ttl_s: User.ACCESS_TOKEN_TTL_S });

        ws = new Webserver(CONFIG, { db, token_manager: tm });
        await ws.start();
        base = `http://127.0.0.1:${ws.server.address().port}`;
    });

    afterEach(async () => {
        await ws.stop();
        db.close();
    });

    describe("GET /api/utils/versions", () => {
        it("requires authentication (but no role)", async () => {
            const res = await fetch(base + "/api/utils/versions");
            expect(res.status).to.equal(401);
        });

        it("reports the webserver, webapp, and schema versions", async () => {
            const res = await fetch(base + "/api/utils/versions", {
                headers: { authorization: `Bearer ${access}` },
            });

            expect(res.status).to.equal(200);
            expect(await res.json()).to.deep.equal({
                webserver: "test-version",
                webapp: "test-version",
                db: 1, // PRAGMA user_version of a freshly-initialized schema
            });
        });
    });
});
