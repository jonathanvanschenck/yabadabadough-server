
const crypto = require("crypto");
const fs = require("fs");
const { join } = require("path");

const ALG = "EdDSA"; // Ed25519 -- the only algorithm this manager will ever emit or accept

function b64url_json(obj) {
    return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function parse_b64url_json(str) {
    try {
        const parsed = JSON.parse(Buffer.from(str, "base64url").toString("utf8"));
        if ( !parsed || typeof parsed !== "object" || Array.isArray(parsed) ) return null;
        return parsed;
    } catch (err) {
        return null;
    }
}

/**
 * Signs, verifies and inspects JWTs using Ed25519 key pairs (node built-in
 * crypto, no deps -- same philosophy as the scrypt password hashing).
 *
 * Rotation model: the manager holds an ordered list of keys, each named by a
 * `kid`. The FIRST key with a private half is the signing key; every key
 * verifies (matched via the token's `kid` header). Old keys may be listed
 * public-half-only, so retired private keys can be destroyed while their
 * outstanding tokens keep verifying until expiry. To rotate: generate a new
 * pair (scripts/generate-jwt-key.js), keep the old public key around for one
 * max-token-lifetime (~1 week, the auth-token TTL), then delete it.
 *
 * Keys load from a directory (TokenManager.from_dir, wired via env.js):
 *   <kid>.private.pem  -- pkcs8 Ed25519 private key (public half is derived)
 *   <kid>.public.pem   -- spki public key (verify-only entry)
 * Kids sort lexicographically DESCENDING and the newest signs, so the
 * timestamp-named kids the generator script emits rotate naturally.
 *
 * The manager owns JWT mechanics only (iat/exp, kid routing, signatures);
 * payload shapes and TTL policy live with the models
 * (user.to_access_token_payload, User.ACCESS_TOKEN_TTL_S, ...).
 */
module.exports = class TokenManager {
    /**
     * keys: [{ kid, private_key?, public_key? }] in precedence order (newest
     * first) -- PEM strings or KeyObjects. Each entry needs at least one
     * half; the public half is derived from the private one when omitted.
     */
    constructor({ keys = [] }={}) {
        this.keys = new Map();
        this.signing_key = null;

        for ( const { kid, private_key, public_key } of keys ) {
            if ( !kid || typeof kid !== "string" ) throw new Error("JWT key missing kid");
            if ( this.keys.has(kid) ) throw new Error("Duplicate JWT kid: " + kid);

            const priv = private_key ? crypto.createPrivateKey(private_key) : null;
            const pub = public_key ? crypto.createPublicKey(public_key)
                : priv ? crypto.createPublicKey(priv)
                : null;
            if ( !pub ) throw new Error("JWT key has neither private nor public half: " + kid);

            for ( const key of [ priv, pub ] ) {
                if ( key && key.asymmetricKeyType !== "ed25519" ) {
                    throw new Error(`JWT key ${kid} must be ed25519, got: ${key.asymmetricKeyType}`);
                }
            }

            // A mismatched pair would sign tokens nothing can verify -- catch
            // it at load time with a probe signature
            if ( priv ) {
                const probe = crypto.randomBytes(16);
                if ( !crypto.verify(null, probe, pub, crypto.sign(null, probe, priv)) ) {
                    throw new Error(`JWT key ${kid}: private and public halves do not match`);
                }
            }

            const entry = { kid, private_key: priv, public_key: pub };
            this.keys.set(kid, entry);
            if ( !this.signing_key && priv ) this.signing_key = entry;
        }

        if ( !this.keys.size ) throw new Error("TokenManager requires at least one key");
    }

    /**
     * Loads every <kid>.private.pem / <kid>.public.pem in dir, newest kid
     * (lexicographically greatest) signing. Missing/empty dir is a hard
     * error pointing at the bootstrap script.
     */
    static from_dir(dir) {
        let files;
        try {
            files = fs.readdirSync(dir);
        } catch (err) {
            throw new Error(`Cannot read JWT keys directory ${dir} (${err.code}); `
                + `bootstrap one with: node scripts/generate-jwt-key.js`);
        }

        const by_kid = new Map();
        const entry = (kid) => {
            if ( !by_kid.has(kid) ) by_kid.set(kid, { kid });
            return by_kid.get(kid);
        };
        for ( const file of files ) {
            let match;
            if ( match = file.match(/^(.+)\.private\.pem$/) ) {
                entry(match[1]).private_key = fs.readFileSync(join(dir, file), "utf8");
            } else if ( match = file.match(/^(.+)\.public\.pem$/) ) {
                entry(match[1]).public_key = fs.readFileSync(join(dir, file), "utf8");
            }
        }

        if ( !by_kid.size ) {
            throw new Error(`No JWT keys found in ${dir}; `
                + `bootstrap one with: node scripts/generate-jwt-key.js`);
        }

        const kids = [ ...by_kid.keys() ].sort().reverse();
        return new this({ keys: kids.map(kid => by_kid.get(kid)) });
    }

    get active_kid() {
        return this.signing_key?.kid ?? null;
    }

    /**
     * Signs payload into a JWT, stamping `iat` and `exp` (exactly one of
     * ttl_s / expires_at is required -- TTL policy belongs to the caller).
     * ttl_s may be negative (test fabrication of expired tokens, same trick
     * as Session's negative ttl_days).
     */
    tokenize(payload, { ttl_s, expires_at }={}) {
        if ( !this.signing_key ) throw new Error("No signing key (all keys are verify-only)");

        const iat = Math.floor(Date.now() / 1000);
        let exp;
        if ( expires_at != null ) {
            exp = Math.floor(new Date(expires_at).getTime() / 1000);
            if ( isNaN(exp) ) throw new Error("Invalid expires_at: " + expires_at);
        } else if ( typeof ttl_s === "number" && !isNaN(ttl_s) ) {
            exp = iat + Math.floor(ttl_s);
        } else {
            throw new Error("tokenize requires ttl_s or expires_at");
        }

        const header = { alg: ALG, typ: "JWT", kid: this.signing_key.kid };
        const body = Object.assign({}, payload, { iat, exp });

        const signing_input = b64url_json(header) + "." + b64url_json(body);
        const signature = crypto.sign(null, Buffer.from(signing_input), this.signing_key.private_key);

        return signing_input + "." + signature.toString("base64url");
    }

    /**
     * Verifies signature (via the header's kid) AND expiry, returning the
     * payload -- or null for ANY failure (malformed, wrong alg, unknown kid,
     * bad signature, expired, not yet valid). Never throws on bad input.
     */
    verify(token) {
        const decoded = this._decode(token);
        if ( !decoded ) return null;
        const { header, payload, signing_input, signature } = decoded;

        if ( header.alg !== ALG ) return null;
        const key = this.keys.get(header.kid);
        if ( !key ) return null;

        let valid;
        try {
            valid = crypto.verify(
                null,
                Buffer.from(signing_input),
                key.public_key,
                Buffer.from(signature, "base64url")
            );
        } catch (err) {
            valid = false;
        }
        if ( !valid ) return null;

        // exp is mandatory (tokenize always stamps it); no clock-skew grace
        const now = Math.floor(Date.now() / 1000);
        if ( typeof payload.exp !== "number" || payload.exp <= now ) return null;
        if ( payload.nbf !== undefined && !(typeof payload.nbf === "number" && payload.nbf <= now) ) return null;

        return payload;
    }

    /**
     * Parses the payload WITHOUT verifying signature or expiry (null only on
     * malformed input). For inspection/routing only -- e.g. reading `typ`
     * before deciding how to verify. NEVER trust a peeked payload.
     */
    peek(token) {
        return this._decode(token)?.payload ?? null;
    }

    _decode(token) {
        if ( typeof token !== "string" ) return null;

        const parts = token.split(".");
        if ( parts.length !== 3 ) return null;

        const header = parse_b64url_json(parts[0]);
        const payload = parse_b64url_json(parts[1]);
        if ( !header || !payload ) return null;

        return {
            header,
            payload,
            signing_input: parts[0] + "." + parts[1],
            signature: parts[2],
        };
    }
}
