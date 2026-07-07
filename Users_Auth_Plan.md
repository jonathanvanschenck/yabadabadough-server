# Users, Tokens & Sessions — Implementation Plan

## Goal

Add **users** (email + salted password hash + admin flag) with full CRUD, the
model-layer half of **JWT auth** (payload rendering / parsing for a long-lived
*auth* token ~1 week and a short-lived *access* token ~1 hour — signing and
verification happen later in an API controller), and **sessions** (a db table
that backs auth-token refresh), including **logout** (kill one session's
ability to refresh) and **revoke all logins** (kill every session for a user).

Everything here is disjoint from the funds/transactions graph — no
finalization interactions, no new invariants on existing tables.

## The token model (what the two tokens mean)

Two JWT types, distinguished by a `typ` claim in the payload:

- **Access token** (~1 hour): *stateless*. Carries everything an API request
  needs (`sub`, `email`, `admin`) so request handling never hits the users
  table. Verified by JWT signature + expiry alone.
- **Auth token** (~1 week): *stateful*. Only good for one thing — minting new
  access tokens — and every refresh checks the db. It carries just enough to
  find and prove its session: `sub`, `sid` (session id), and the session's
  random `token` secret.

A **session row = the right to refresh**. Login creates a session and issues
both tokens; refresh presents the auth token, the model checks the session
(exists, secret matches, not expired), and the controller mints a fresh
access token. Logout deletes the session row; the auth token it references is
then worthless even though its JWT signature is still valid.

**Accepted staleness window (documented, by design)**: access tokens are
stateless, so logout / revoke-all / `admin` demotion / user deletion do not
kill *outstanding* access tokens — they die at their ≤1h expiry. That is the
standard tradeoff for db-free request auth. Controllers that guard truly
sensitive actions can always re-fetch with `User.for_id` (or check
`Session.for_id(payload.sid)`) when paranoia is warranted.

### Payload shapes

Rendered by the model, signed elsewhere. `iat`/`exp` are the JWT library's
job (the controller sets `exp` from the TTL constants below; for auth tokens
it should mirror `session.expires_at`).

```js
// user.to_access_token_payload(session)
{ v: 1, typ: "access", sub: user.id, email: user.email, admin: user.admin, sid: session.id }

// user.to_auth_token_payload(session)
{ v: 1, typ: "auth", sub: user.id, sid: session.id, token: session.token }
```

- `v: 1` — payload schema version, so future shape changes can invalidate or
  migrate old tokens explicitly.
- `sid` rides along in the access token too (pure metadata: lets a controller
  optionally correlate requests to sessions or do a strict-mode db check).
  **No middleware may assume `sid` is present or non-null** — future API-key
  credentials will mint access tokens with no session behind them.

## Design decisions (and why)

1. **Password hashing: Node's built-in `crypto.scryptSync`, zero new
   dependencies.** The project is deliberately dependency-light and fully
   synchronous (better-sqlite3 style); `scryptSync` is memory-hard, built in,
   and sync. Stored as a single self-describing string in one column:

   ```
   scrypt$<N>$<r>$<p>$<salt_b64>$<hash_b64>
   ```

   Verification parses the params out of the stored string (not from code
   constants), so cost parameters can be raised later without invalidating
   existing hashes — old hashes keep verifying with their recorded params.
   Defaults: `N=16384, r=8, p=1`, 16-byte random salt, 32-byte hash.
   Comparison via `crypto.timingSafeEqual`. (bcrypt/argon2 native deps were
   considered and rejected: not worth a build dependency for a personal
   server when scrypt is in the stdlib.)

2. **Model renders payloads; the API layer owns JWT mechanics.** No JWT
   library is added in this change. `User`/`Session` expose payload
   rendering, payload → object construction, and the refresh-time session
   check; choosing `jose` vs `jsonwebtoken`, key management, and `exp`
   handling land with the API controller work. The model DOES own the TTL
   constants (`User.ACCESS_TOKEN_TTL_S = 3600`, `Session.DEFAULT_TTL_DAYS =
   7`) so policy lives in one place.

3. **`User.from_token_payload(payload)` is db-free.** "Construct a user from
   a token payload" exists to serve stateless access-token requests, so it
   builds an *unsaved* instance from `sub`/`email`/`admin` (no
   `password_hash`, no `created_at`) without touching the db. It validates
   `typ === "access"` and `v === 1` and throws otherwise. Anything needing
   fresh/trusted state uses `User.for_id(db, payload.sub)` instead — the doc
   comment says exactly that.

4. **Sessions carry a per-session random secret (`token`).** 16 random bytes
   hex-encoded (`crypto.randomBytes`), stored on the row, embedded in the
   auth payload, and required to match (timing-safe) at refresh. Why not
   just `sid`? (a) SQLite reuses integer ids, so a signed-but-orphaned old
   auth token must never match a *new* session that recycled the id; (b) it
   is the hook for future refresh-token rotation (re-roll `token` on each
   refresh) without schema changes. **v1 does NOT rotate** — the secret is
   fixed for the session's life. Rotation is listed as future work.

5. **Fixed session expiry, no sliding window (v1).** `expires_at` is set at
   login (`now + ttl_days`, default 7) and never extended: an auth token is
   good for a week, then the user logs in again. Sliding expiry ("active
   users never re-login") is future work; `last_used_at` is already updated
   on every refresh, so the data to support it will exist.

6. **Logout and revoke-all are row deletion, not a flag.** A session is
   refreshable iff its row exists and `expires_at` is in the future — one
   derivable state, no `revoked` column to keep consistent (same philosophy
   as bank statement items' three derivable states). Losing the audit trail
   of dead sessions is fine for a personal server. Expired rows are garbage,
   removed opportunistically by `Session.prune(db)`.

7. **Require direction: `Session → User`, never back.** `Session.create`
   type-checks the user id and relies on the FK for existence (mapped to a
   typed `ForeignKeyError`). `User` never requires `Session`: a user's
   sessions are listed via `Session.from_db(db, { user_id })`, revoke-all is
   `Session.revoke_all(db, user_id)`, and user deletion clears sessions via
   `ON DELETE CASCADE` at the db layer. No circular requires, no inline
   cross-table SQL.

8. **Password changes are a separate method, and they revoke nothing.**
   `user.update` handles `email`/`admin`; `user.set_password(db, password)`
   is its own call (different intent, always requires the new password
   explicitly). Whether "password changed" should also revoke sessions is a
   *policy* choice, so it belongs to the API controller — which can simply
   call `Session.revoke_all` next. The model doesn't couple them.

9. **Email is normalized, not validated hard.** Lowercase + trim at the model
   boundary (create, update, `for_email`, `authenticate`), stored normalized;
   `UNIQUE` on the column then gives case-insensitive uniqueness for free.
   Format check is minimal (non-empty, contains `@`) — real validation is a
   UI/API concern. Passwords: non-empty string, min length 8, checked in
   `create`/`set_password`.

10. **`User.authenticate` resists user enumeration.** The login helper
    (`authenticate(db, { email, password })` → `User | null`) runs a dummy
    scrypt verification against a fixed junk hash when the email is unknown,
    so "no such user" and "wrong password" take the same time. Returns
    `null` for both — never throws distinguishable errors.

11. **No last-admin guard (v1).** Nothing prevents demoting/deleting the
    final admin. Single-operator personal server; recovery is a one-line
    sqlite UPDATE. A guard adds a cross-row invariant for little value now
    (and the API layer may still choose to refuse self-demotion).

12. **`to_api` never leaks secrets.** `user.to_api()` omits `password_hash`;
    `session.to_api()` omits `token`. The secret only ever leaves the model
    embedded in an auth-token payload.

13. **Schema edited in place** (`_schema.sql`, `user_version` stays 1), same
    as the bank-statement-items change. Both tables are new and independent
    of the existing graph, so they append cleanly at the top of the file
    (before `funds`; no ordering constraints either way).

## Schema changes (`db/migrations/_schema.sql`)

```sql
CREATE TABLE users (
    id                  INTEGER PRIMARY KEY,
    email               TEXT NOT NULL UNIQUE, -- stored normalized (lowercase, trimmed)

    -- Self-describing salted hash: "scrypt$N$r$p$salt_b64$hash_b64".
    -- Params live in the string so cost can be raised without breaking
    -- existing hashes. NEVER exposed via to_api.
    password_hash       TEXT NOT NULL,

    admin               INTEGER NOT NULL DEFAULT 0 CHECK (admin IN (0,1)),

    -- Meta data
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

-- A session row IS the right to refresh: refreshable iff the row exists and
-- expires_at is in the future. Logout / revoke-all = row deletion.
CREATE TABLE user_sessions (
    id                  INTEGER PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES users(id)
                            ON DELETE CASCADE
                            ON UPDATE CASCADE,

    -- Per-session random secret, embedded in the auth-token payload and
    -- required to match at refresh (defends against sqlite id reuse; hook
    -- for future rotation). NEVER exposed via to_api.
    token               TEXT NOT NULL UNIQUE,

    note                TEXT,               -- optional device/client label

    expires_at          TEXT NOT NULL,      -- ISO 8601 datetime
    last_used_at        TEXT,               -- ISO 8601, touched on every refresh

    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;
CREATE INDEX idx_user_sessions_user_id ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_expires_at ON user_sessions(expires_at);
```

## `models/User.js`

`SELECT_COLUMNS`: id, email, password_hash, admin, created_at.

Instance fields mirror the row (`password_hash` kept on the instance for
`verify_password`; `from_token_payload` instances have it `null`).

- `static create(db, { email, password, admin = false })` — normalize +
  validate email, validate password, hash, insert; duplicate email →
  `ConflictError` (checked in-transaction, UNIQUE backstops). Returns `User`.
- `static for_id(db, id)` / `static for_email(db, email)` (normalizes first).
- `static from_db(db, { admin, order_by = "id", order_direction, limit,
  offset })` — same dynamic-where + cached-statement-key pattern as
  `BankStatementItem.from_db`. `ORDER_BY_MAP`: id, email, created_at.
- `static from_row(row)` / `to_api()` → `{ id, email, admin, created_at }`.
- `update(db, { email, admin })` — normalize/uniqueness-check email;
  in-transaction, refetch-first like `BankStatementItem._update`.
- `set_password(db, password)` — validate, re-hash (fresh salt), update.
- `verify_password(password)` → boolean; parses stored params,
  `timingSafeEqual`. Pure (no db).
- `static authenticate(db, { email, password })` → `User | null`; dummy-hash
  on unknown email (decision 10).
- `delete(db)` — plain row delete; sessions die via CASCADE.
- `to_access_token_payload(session)` / `to_auth_token_payload(session)` —
  shapes above; throw if `session.user_id !== this.id` (cheap foot-gun
  guard).
- `static from_token_payload(payload)` — db-free unsaved instance from an
  access payload (decision 3).
- `static ACCESS_TOKEN_TTL_S = 3600`.

Password helpers (`_hash_password(password)`,
`_verify_password(password, stored)`) are private statics on the model —
no new lib file for ~30 lines, and no other model needs them.

## `models/Session.js` (table `user_sessions`)

`SELECT_COLUMNS`: id, user_id, token, note, expires_at, last_used_at,
created_at.

- `static create(db, { user_id, ttl_days = Session.DEFAULT_TTL_DAYS, note =
  null })` — generates `token`, computes `expires_at = now + ttl_days`;
  missing user → `ForeignKeyError`. Returns `Session`.
- `static for_id(db, id)`.
- `static from_db(db, { user_id, active, order_by = "id", order_direction,
  limit, offset })` — `active: true` ⇒ `expires_at > now`, `false` ⇒ the
  complement ("list my logins" is `{ user_id, active: true }`).
- `static from_row(row)` / `to_api()` → `{ id, user_id, note, expires_at,
  last_used_at, created_at }` (no `token`).
- `static for_auth_payload(db, payload)` — **the refresh guard**, one
  transaction: assert `typ === "auth"` and `v === 1`, load `sid` (missing →
  `ForeignKeyError`), timing-safe-compare `payload.token` vs row (mismatch →
  `ConflictError`), reject expired (`ConflictError`), touch `last_used_at`,
  return the fresh `Session`. Also sanity-checks `payload.sub ===
  session.user_id`. The controller then does `User.for_id(db,
  session.user_id)` → `to_access_token_payload(session)`.
- `expired` getter (`expires_at <= now`) for convenience.
- `delete(db)` — **logout**: plain row delete, idempotent-safe error if
  already gone.
- `static revoke_all(db, user_id)` — **revoke all logins**: delete all rows
  for the user, returns count.
- `static prune(db)` — delete all expired rows (housekeeping; callable from
  a future cron/controller), returns count.
- `static DEFAULT_TTL_DAYS = 7`.

## Bootstrap CLI (`scripts/create-user.js`)

The API layer doesn't exist yet, so `User.create` needs a caller: a small
CLI script (new `scripts/` directory) that opens the db via `env.js` config +
`create_connection`/`initialize_db`, then creates a user from args:

```
node scripts/create-user.js <email> <password> [--admin]
```

Prints the created user's `to_api()` JSON. Duplicate email → clean error
message, nonzero exit. Also the recovery path for a forgotten password later
(a `--set-password` flag that calls `user.set_password` on an existing email
— same script, one branch). Thin wrapper over model methods; the logic it
exercises is already covered by the model tests, so the script itself gets
no test file.

## Tests

`test/models/test-user.js` (in-memory db per test, as usual):
- create: happy path; admin flag; email normalized (case/whitespace);
  duplicate email (incl. case-insensitive dupe) → ConflictError; bad email /
  short password rejected.
- password: `verify_password` true/false; hash string format + unique salts
  (two users, same password, different hashes); `set_password` re-hashes and
  old password stops verifying.
- authenticate: correct / wrong password / unknown email → user, null, null.
- from_db filters + ordering; for_id / for_email miss → null.
- update: email + uniqueness conflict; admin toggle; delete cascades sessions
  (create session, delete user, session gone).
- to_api omits password_hash.
- tokens: both payload shapes exact-match; cross-user session throws;
  `from_token_payload` round-trip (`user → payload → user'` with matching
  id/email/admin); rejects `typ: "auth"` payloads and bad `v`.

`test/models/test-session.js`:
- create: expires_at ≈ now + ttl; custom ttl_days; unique tokens; missing
  user → ForeignKeyError.
- for_auth_payload: happy path returns session and bumps last_used_at;
  wrong token secret / expired / deleted sid / `typ: "access"` payload /
  sub–user_id mismatch all rejected with typed errors.
- logout: delete kills refresh (for_auth_payload then fails); other sessions
  for the same user survive.
- revoke_all: kills all of user A's sessions, leaves user B's; returns count.
- from_db: user_id + active filters (fabricate an expired session by direct
  ttl manipulation); prune removes only expired.
- to_api omits token.

## CLAUDE.md additions

New "Users" and "Sessions" sections under Schema Hierarchy: the
scrypt-string format, the two token types + payload shapes, the "session row
= right to refresh" rule, the staleness window for outstanding access tokens,
the Session → User require direction, and the no-rotation/no-sliding v1
scope.

## Future work (explicitly out of scope)

- API controllers: JWT signing/verification (lib choice), login/refresh/
  logout endpoints, auth middleware, secret/key management via `env.js`.
- Refresh-token rotation (re-roll `token` per refresh; enables theft
  detection) — schema already supports it.
- Sliding session expiry (`last_used_at` already recorded).
- Password-change ⇒ revoke-all policy (one controller line when wanted).
- **API keys / OAuth-style machine credentials** (external tools and cli
  scripts hitting the API without a password). The intended shape, so this
  change doesn't drift away from it:
  - An API key is a *long-lived credential exchanged for the same short-lived
    access tokens* — the token-exchange endpoint mirrors the refresh flow
    (present credential → db check → `user.to_access_token_payload(...)`),
    so request-path auth middleware does not change at all.
  - Keys get their **own table + model** (`ApiKey → User`, sibling of
    `Session → User`), NOT rows in `user_sessions`: different lifecycle
    (optional/no expiry, named, listable, individually revocable) and a
    different storage rule — key secrets are presented raw as bearer strings
    and stored **hashed** (sha256), unlike session tokens, which ride inside
    signed JWTs and may be stored plain.
  - Keys inherit the user's permissions for free by minting through the same
    payload path (`sub`/`email`/`admin` snapshot). Key-minted access tokens
    carry `sid: null` (or a future `akid`) — hence the "never assume `sid`"
    rule above.
  - Scoping keys *below* the user's permissions (e.g. read-only) is a
    `scopes` claim added to the access payload later, via a `v` bump.
- Scoping funds/transactions to users (today the data is global; multi-user
  data ownership is a much bigger change).
