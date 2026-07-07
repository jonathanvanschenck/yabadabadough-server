
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const { join } = require("path");

const { expect } = require("chai");
const TokenManager = require("../lib/TokenManager.js");

function generate_pair() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    return {
        private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
        public_key: publicKey.export({ type: "spki", format: "pem" }),
    };
}

function b64url_json(obj) {
    return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

describe("lib/TokenManager.js", () => {

    let pair_a, pair_b;
    before(() => {
        pair_a = generate_pair();
        pair_b = generate_pair();
    });

    describe("constructor", () => {

        it("Requires at least one key", () => {
            expect(() => new TokenManager({ keys: [] })).to.throw(/at least one key/);
            expect(() => new TokenManager()).to.throw(/at least one key/);
        });

        it("Requires kids", () => {
            expect(() => new TokenManager({ keys: [{ ...pair_a }] })).to.throw(/missing kid/);
        });

        it("Rejects duplicate kids", () => {
            expect(() => new TokenManager({ keys: [
                { kid: "a", ...pair_a },
                { kid: "a", ...pair_b },
            ] })).to.throw(/Duplicate/);
        });

        it("Rejects entries with no key material", () => {
            expect(() => new TokenManager({ keys: [{ kid: "a" }] })).to.throw(/neither/);
        });

        it("Rejects non-ed25519 keys", () => {
            const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
            expect(() => new TokenManager({ keys: [
                { kid: "a", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) },
            ] })).to.throw(/ed25519/);
        });

        it("Rejects mismatched private/public halves", () => {
            expect(() => new TokenManager({ keys: [
                { kid: "a", private_key: pair_a.private_key, public_key: pair_b.public_key },
            ] })).to.throw(/do not match/);
        });

        it("Derives the public half from the private key", () => {
            const tm = new TokenManager({ keys: [{ kid: "a", private_key: pair_a.private_key }] });
            const token = tm.tokenize({ foo: "bar" }, { ttl_s: 60 });
            expect(tm.verify(token)).to.not.equal(null);
        });

        it("Signs with the first key that has a private half", () => {
            const tm = new TokenManager({ keys: [
                { kid: "old-retired", public_key: pair_a.public_key },
                { kid: "current", ...pair_b },
            ] });
            expect(tm.active_kid).to.equal("current");
        });

        it("Allows a verify-only manager, but it cannot tokenize", () => {
            const tm = new TokenManager({ keys: [{ kid: "a", public_key: pair_a.public_key }] });
            expect(tm.active_kid).to.equal(null);
            expect(() => tm.tokenize({ foo: "bar" }, { ttl_s: 60 })).to.throw(/No signing key/);
        });
    });

    describe("tokenize", () => {

        let tm;
        before(() => {
            tm = new TokenManager({ keys: [{ kid: "a", ...pair_a }] });
        });

        it("Produces a three-part JWT with alg/typ/kid header", () => {
            const token = tm.tokenize({ foo: "bar" }, { ttl_s: 60 });
            const parts = token.split(".");
            expect(parts).to.have.length(3);

            const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
            expect(header).to.deep.equal({ alg: "EdDSA", typ: "JWT", kid: "a" });
        });

        it("Stamps iat and exp from ttl_s", () => {
            const now = Math.floor(Date.now() / 1000);
            const token = tm.tokenize({ foo: "bar" }, { ttl_s: 60 });
            const payload = tm.verify(token);
            expect(payload.foo).to.equal("bar");
            expect(payload.iat).to.be.closeTo(now, 2);
            expect(payload.exp).to.equal(payload.iat + 60);
        });

        it("Stamps exp from expires_at", () => {
            const expires_at = new Date(Date.now() + 3600 * 1000);
            const token = tm.tokenize({ foo: "bar" }, { expires_at });
            const payload = tm.verify(token);
            expect(payload.exp).to.equal(Math.floor(expires_at.getTime() / 1000));
        });

        it("Requires ttl_s or expires_at", () => {
            expect(() => tm.tokenize({ foo: "bar" })).to.throw(/ttl_s or expires_at/);
            expect(() => tm.tokenize({ foo: "bar" }, { expires_at: "nonsense" })).to.throw(/Invalid expires_at/);
        });

        it("Does not mutate the given payload", () => {
            const payload = { foo: "bar" };
            tm.tokenize(payload, { ttl_s: 60 });
            expect(payload).to.deep.equal({ foo: "bar" });
        });
    });

    describe("verify", () => {

        let tm;
        before(() => {
            tm = new TokenManager({ keys: [{ kid: "a", ...pair_a }] });
        });

        it("Round-trips a payload", () => {
            const token = tm.tokenize({ v: 1, typ: "access", sub: 7, admin: true }, { ttl_s: 60 });
            const payload = tm.verify(token);
            expect(payload).to.include({ v: 1, typ: "access", sub: 7, admin: true });
        });

        it("Rejects garbage", () => {
            expect(tm.verify(null)).to.equal(null);
            expect(tm.verify(42)).to.equal(null);
            expect(tm.verify("")).to.equal(null);
            expect(tm.verify("not-a-token")).to.equal(null);
            expect(tm.verify("a.b")).to.equal(null);
            expect(tm.verify("a.b.c.d")).to.equal(null);
            expect(tm.verify("!!!.???.###")).to.equal(null);
        });

        it("Rejects a tampered payload", () => {
            const token = tm.tokenize({ sub: 7, admin: false }, { ttl_s: 60 });
            const [ header, payload, signature ] = token.split(".");

            const tampered = JSON.parse(Buffer.from(payload, "base64url").toString());
            tampered.admin = true;

            expect(tm.verify([ header, b64url_json(tampered), signature ].join("."))).to.equal(null);
        });

        it("Rejects a token signed by an unknown key", () => {
            const other = new TokenManager({ keys: [{ kid: "a", ...pair_b }] }); // same kid, different key
            const token = other.tokenize({ sub: 7 }, { ttl_s: 60 });
            expect(tm.verify(token)).to.equal(null);

            const stranger = new TokenManager({ keys: [{ kid: "z", ...pair_b }] }); // unknown kid
            expect(tm.verify(stranger.tokenize({ sub: 7 }, { ttl_s: 60 }))).to.equal(null);
        });

        it("Rejects an expired token", () => {
            const token = tm.tokenize({ sub: 7 }, { ttl_s: -10 });
            expect(tm.verify(token)).to.equal(null);
            expect(tm.peek(token)).to.not.equal(null); // but it still parses
        });

        it("Rejects alg confusion (header swapped to none)", () => {
            const token = tm.tokenize({ sub: 7 }, { ttl_s: 60 });
            const [ , payload, signature ] = token.split(".");

            const none_header = b64url_json({ alg: "none", typ: "JWT", kid: "a" });
            expect(tm.verify([ none_header, payload, signature ].join("."))).to.equal(null);
            expect(tm.verify([ none_header, payload, "" ].join("."))).to.equal(null);
        });

        it("Rejects a well-signed token missing exp", () => {
            // Forge with the raw key what tokenize refuses to produce
            const header = b64url_json({ alg: "EdDSA", typ: "JWT", kid: "a" });
            const payload = b64url_json({ sub: 7 });
            const signing_input = header + "." + payload;
            const signature = crypto.sign(
                null, Buffer.from(signing_input), crypto.createPrivateKey(pair_a.private_key)
            ).toString("base64url");

            expect(tm.verify(signing_input + "." + signature)).to.equal(null);
        });

        it("Respects nbf when present", () => {
            const forge = (nbf) => {
                const header = b64url_json({ alg: "EdDSA", typ: "JWT", kid: "a" });
                const now = Math.floor(Date.now() / 1000);
                const payload = b64url_json({ sub: 7, exp: now + 60, nbf });
                const signing_input = header + "." + payload;
                const signature = crypto.sign(
                    null, Buffer.from(signing_input), crypto.createPrivateKey(pair_a.private_key)
                ).toString("base64url");
                return signing_input + "." + signature;
            };

            const now = Math.floor(Date.now() / 1000);
            expect(tm.verify(forge(now - 10))).to.not.equal(null);
            expect(tm.verify(forge(now + 60))).to.equal(null);
            expect(tm.verify(forge("soon"))).to.equal(null);
        });
    });

    describe("peek", () => {

        let tm;
        before(() => {
            tm = new TokenManager({ keys: [{ kid: "a", ...pair_a }] });
        });

        it("Parses without verifying", () => {
            const stranger = new TokenManager({ keys: [{ kid: "z", ...pair_b }] });
            const token = stranger.tokenize({ typ: "auth", sub: 7 }, { ttl_s: -10 }); // unknown key AND expired

            expect(tm.verify(token)).to.equal(null);
            expect(tm.peek(token)).to.include({ typ: "auth", sub: 7 });
        });

        it("Returns null on malformed input", () => {
            expect(tm.peek(null)).to.equal(null);
            expect(tm.peek("not-a-token")).to.equal(null);
            expect(tm.peek("a.b.c")).to.equal(null);
        });
    });

    describe("rotation", () => {

        it("A new manager keeping the old public key verifies old tokens", () => {
            const old_tm = new TokenManager({ keys: [{ kid: "2026-old", ...pair_a }] });
            const old_token = old_tm.tokenize({ sub: 7 }, { ttl_s: 60 });

            const new_tm = new TokenManager({ keys: [
                { kid: "2027-new", ...pair_b },
                { kid: "2026-old", public_key: pair_a.public_key }, // private half destroyed
            ] });

            expect(new_tm.active_kid).to.equal("2027-new");
            expect(new_tm.verify(old_token)).to.include({ sub: 7 });
            expect(new_tm.verify(new_tm.tokenize({ sub: 8 }, { ttl_s: 60 }))).to.include({ sub: 8 });

            // And once the old key is dropped entirely, its tokens die
            const final_tm = new TokenManager({ keys: [{ kid: "2027-new", ...pair_b }] });
            expect(final_tm.verify(old_token)).to.equal(null);
        });
    });

    describe("from_dir", () => {

        let dir;
        beforeEach(() => {
            dir = fs.mkdtempSync(join(os.tmpdir(), "ydd-jwt-test-"));
        });
        afterEach(() => {
            fs.rmSync(dir, { recursive: true, force: true });
        });

        it("Throws on a missing or empty directory", () => {
            expect(() => TokenManager.from_dir(join(dir, "nope"))).to.throw(/generate-jwt-key/);
            expect(() => TokenManager.from_dir(dir)).to.throw(/generate-jwt-key/);
        });

        it("Loads pairs and signs with the newest kid", () => {
            fs.writeFileSync(join(dir, "20260101000000.private.pem"), pair_a.private_key);
            fs.writeFileSync(join(dir, "20260101000000.public.pem"), pair_a.public_key);
            fs.writeFileSync(join(dir, "20270101000000.private.pem"), pair_b.private_key);
            fs.writeFileSync(join(dir, "20270101000000.public.pem"), pair_b.public_key);
            fs.writeFileSync(join(dir, "README.txt"), "ignore me");

            const tm = TokenManager.from_dir(dir);
            expect(tm.active_kid).to.equal("20270101000000");

            // Both keys verify
            const old_tm = new TokenManager({ keys: [{ kid: "20260101000000", ...pair_a }] });
            expect(tm.verify(old_tm.tokenize({ sub: 7 }, { ttl_s: 60 }))).to.include({ sub: 7 });
            expect(tm.verify(tm.tokenize({ sub: 8 }, { ttl_s: 60 }))).to.include({ sub: 8 });
        });

        it("Treats a public-only file as verify-only, even when newest", () => {
            fs.writeFileSync(join(dir, "20260101000000.private.pem"), pair_a.private_key);
            fs.writeFileSync(join(dir, "20270101000000.public.pem"), pair_b.public_key);

            const tm = TokenManager.from_dir(dir);
            expect(tm.active_kid).to.equal("20260101000000");

            const other = new TokenManager({ keys: [{ kid: "20270101000000", ...pair_b }] });
            expect(tm.verify(other.tokenize({ sub: 7 }, { ttl_s: 60 }))).to.include({ sub: 7 });
        });
    });
});
