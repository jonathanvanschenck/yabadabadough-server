#!/usr/bin/env node
/**
 * Bootstrap / rotation CLI for JWT signing keys:
 *
 *   node scripts/generate-jwt-key.js [dir]
 *
 * Generates a fresh Ed25519 pair as <kid>.private.pem / <kid>.public.pem in
 * the configured keys directory (env YDD_JWT_KEYS_DIR unless overridden by
 * [dir]). The kid is a UTC timestamp, and TokenManager signs with the newest
 * kid, so running this again IS rotation: outstanding tokens keep verifying
 * against the old key until they expire (~1 week max, the auth-token TTL),
 * after which the old pair -- or just its private half -- can be deleted.
 */

const crypto = require("crypto");
const fs = require("fs");
const { join } = require("path");

const env = require("../env.js");

const dir = process.argv[2] || env.tokens.keys_dir;
const kid = new Date().toISOString().replace(/\D/g, "").slice(0, 14); // YYYYMMDDHHMMSS UTC

const private_path = join(dir, kid + ".private.pem");
const public_path = join(dir, kid + ".public.pem");

if ( fs.existsSync(private_path) || fs.existsSync(public_path) ) {
    console.error("Key already exists: " + kid + " (wait a second and retry)");
    process.exit(1);
}

fs.mkdirSync(dir, { recursive: true });

const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
fs.writeFileSync(private_path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
fs.writeFileSync(public_path, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });

console.log("Created JWT key pair " + kid + ":");
console.log("  " + private_path);
console.log("  " + public_path);
