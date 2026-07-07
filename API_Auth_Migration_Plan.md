# API Auth Migration — from dax-auth-client to our models

## Goal

The webserver/collections code was copied from hyperspace, whose `token_manager` was
`@daxbot/dax-auth-client`: an **async client for a remote auth server** with its own users,
GUIDs, display names, global role strings, and a login/authenticate/refresh method surface.
Our ground truth is completely different: **local, synchronous models** (`User`, `Session`)
plus a **JWT-mechanics-only** `lib/TokenManager.js`. This plan inventories every divergence
and proposes the rewrite that brings the API layer into agreement with our auth conventions.

## The two worlds

### What the copied code assumes (dax-auth-client)

| Surface | Shape |
|---|---|
| `token_manager.login(username, password)` | `[success, info]`, hits remote server |
| `token_manager.authenticate({ access, refresh }, auto_refresh)` | `[success, info]`, verifies + optionally refreshes |
| `token_manager.refresh({ access, refresh })` | `[success, info]`, requires BOTH tokens |
| `info` | `{ access: { sub: GUID, type, name, verified, roles: ["PREFIX.api.reader", ...] }, tokens: { access, refresh } }` |
| Roles | Global namespaced strings, parsed client-side via `Access.parse_roles(roles_array, roles_prefix, req)` |
| Identity | `access.name` (display name) becomes `req.access.identifier` |
| Logout | Clear cookies only — the remote server owns session state |
| Lifecycle | `await token_manager.start()` (remote connection) |

### Ground truth (our models + lib/TokenManager.js)

| Surface | Shape |
|---|---|
| `TokenManager` | `tokenize(payload, { ttl_s \| expires_at })`, `verify(token) → payload \| null`, `peek(token)` — sync, JWT mechanics ONLY |
| Login | `User.authenticate(db, { email, password }) → User \| null` + `Session.create(db, { user_id, note })` |
| Access payload | `{ v: 1, typ: "access", sub, email, admin, reader, editor, sid }` — **effective** roles, flat booleans |
| Auth payload | `{ v: 1, typ: "auth", sub, sid, token }` (we say "auth token", not "refresh token") |
| exp policy | access: `User.ACCESS_TOKEN_TTL_S` (1h); auth: mirrors `session.expires_at` (fixed at login, never slides) |
| Refresh guard | `Session.for_auth_payload(db, payload)` — row exists, secret matches, not expired; touches `last_used_at`; typed errors |
| Logout | `session.delete(db)` — **the row IS the right to refresh** |
| Revoke all | `Session.revoke_all(db, user_id)` |
| Stateless requests | `User.from_token_payload(payload)` → unsaved instance with `.roles` getter |

## Findings (what is broken/divergent today)

1. **Every `token_manager` call site is incompatible.** `login`/`authenticate`/`refresh` do
   not exist on our TokenManager; the middleware, all three token controllers, and the
   Webserver socket.io handshake would all throw at runtime.
2. **Logout violates our core convention.** It only clears cookies; it never deletes the
   session row, so the auth token keeps refreshing for its full week. Ours must call
   `session.delete(db)`.
3. **Refresh demands BOTH tokens** (`access` + `refresh`) — a dax-ism. Our refresh needs
   ONLY the auth token; the session row + secret is the whole check.
4. **Role model mismatch.** `Access.parse_roles` expects global role strings and a
   `roles_prefix` (which our `env.js` doesn't even define). Our access payload already
   carries effective `admin`/`reader`/`editor` booleans — no parsing, no prefix.
5. **Identity mismatch.** `access.name`/`sub`-GUID/`type`/`verified` don't exist; our
   identity is `sub` (integer id) + `email`.
6. **`InfoResponseSchema` documents dax shapes** (GUID subs, verified flags, role-string
   arrays) that can never come out of our models.
7. **Cookie naming**: `refresh_token` should be `auth_token` to match our vocabulary.
8. **Dead code**: `Webserver.js` imports `APIKeyMiddleware` which `asseverate.js` doesn't
   export (API keys are documented future work); `securitySchemes`/`openapi_get_security`
   advertise `APIKey` and `CookieRefreshToken` schemes that don't exist yet.
9. **Typo in the local asseverate wrapper**: `Collection.opeanapi_Tags` (base-class default)
   — harmless today because AuthCollection re-declares `openapi_Tags`, but fix it.
10. **What already agrees** (keep as-is): `Controller.reader = true` default matches our
    reader-by-default convention; the X-Sudo-Mode admin masking is a design feature to keep;
    `penalize()`/`penalty_ms` brute-force damping stays; `disable_auth` dev bypass stays.

## Proposed design

### 1. `Access` (collections/lib/asseverate.js) — rebuild around payloads

```js
class Access {
    static requests_admin(req) { ... unchanged (X-Sudo-Mode header) ... }

    // payload: a signature-verified ACCESS token payload (typ already checked)
    static from_payload(payload, req = null) {
        const sudo = this.requests_admin(req);
        return new this(payload.email, {
            admin: !!payload.admin && sudo,   // masked unless sudo requested
            adminable: !!payload.admin,
            editor: !!payload.editor,
            reader: !!payload.reader,
        }, { user_id: payload.sub, session_id: payload.sid ?? null });
    }

    static from_unauthed() { ... unchanged ... }
}
```

- `parse_roles`, `roles_prefix`, and `from_api_key` are DELETED (API keys return with their
  own model later; nothing may assume `sid` is non-null, so keep `session_id` nullable).
- `identifier` = email (for morgan logs); expose `user_id`/`session_id` for controllers.
- Controllers needing a real User can do `User.for_id(db, req.access.user_id)` (fresh) or
  `User.from_token_payload` (stateless) — the documented staleness window applies.

### 2. Middleware (JWT + Cookie) — verify locally

Both middlewares share one `_authenticate(token, req)`:

```js
const payload = this.token_manager.verify(token);   // sync; null on ANY failure
if ( !payload || payload.typ !== "access" || payload.v !== 1 ) return Access.from_unauthed();
return Access.from_payload(payload, req);
```

- No `await`, no `[success, info]` tuples, no remote calls. Purely stateless — logout /
  revoke-all latency is the accepted ≤1h staleness window from the plan docs.
- Bearer-header and `access_token`-cookie sources are unchanged.

### 3. Auth collection (collections/Auth.js) — compose the models

All controllers get `db` via `init` (already plumbed). Everything is synchronous.

**POST /api/auth/login** `{ email, password }` (rename from `username`)
1. `User.authenticate(db, { email, password })` → null ⇒ `penalize()` + 400 (message never
   distinguishes unknown-email from bad-password; the model already burns a dummy scrypt).
2. `Session.create(db, { user_id: user.id, note: req.headers["user-agent"] ?? null })`.
3. Mint: `access = token_manager.tokenize(user.to_access_token_payload(session), { ttl_s: User.ACCESS_TOKEN_TTL_S })`,
   `auth = token_manager.tokenize(user.to_auth_token_payload(session), { expires_at: session.expires_at })`.
4. Cookies: `access_token` (maxAge = TTL), `auth_token` (expires = `session.expires_at`,
   **path: "/api/auth"** so the long-lived credential only ever travels to auth endpoints).
   Both httpOnly + sameSite Strict; `secure` from a new `env.webserver.api.secure_cookies`.
5. Respond `{ user: user.to_api(), session: session.to_api(), tokens: { access, auth } }`.

**POST /api/auth/refresh** `{ auth? }` (body or `auth_token` cookie — auth token ONLY)
1. `token_manager.verify(auth)` → null ⇒ `penalize()` + 400.
2. `Session.for_auth_payload(db, payload)` — catch `ForeignKeyError`/`ConflictError` ⇒
   `penalize()` + 400 (uniform message; don't leak which check failed).
3. `User.for_id(db, session.user_id)` (fresh roles at refresh time) → mint a new access
   token; the auth token is returned UNCHANGED (v1 has no rotation — `Session.token` is the
   future hook).
4. Reset the `access_token` cookie; respond the same shape as login.

**POST /api/auth/authenticate** `{ access?, auth?, auto_refresh? }` — keep the
"check, and refresh if stale" convenience: verify access ⇒ return current info (no new
tokens); invalid + `auto_refresh` + auth present ⇒ run the refresh flow; else 400.

**POST /api/auth/logout** — the behavioral fix:
1. Take the auth token (cookie or body). If it verifies, `Session.for_id(db, payload.sid)`
   and — after checking `payload.token` matches (timing-safe, same rule as refresh) —
   `session.delete(db)`.
2. ALWAYS clear both cookies and return OK, even when the row is already gone (idempotent);
   an unverifiable token still logs out the browser, it just can't kill a row.

**POST /api/auth/revoke-all** (new, `access = true`, `reader = false`) —
`Session.revoke_all(db, req.access.user_id)`, clear cookies, return the count. This is the
"kill every login" story from the session plan (and the one controllers chain after
password changes).

**GET /api/auth/check\*** — unchanged (they already gate on the new role booleans).

**Response/OpenAPI**: delete `InfoResponseSchema`; build the login/refresh/authenticate
response schema from `$ref`s to `UserSchema` + `SessionSchema` plus an inline
`tokens: { access, auth }` (format: 'jwt'). Error responses keep the 400+penalty pattern.

### 4. Webserver.js

- Socket.io handshake: replace `token_manager.authenticate({ access })` with the same
  verify-and-build-Access path as the middleware (extract cookie, `verify`, typ check,
  `Access.from_payload(payload, null)`).
- Drop the dead `APIKeyMiddleware` import and the `roles_prefix` pass-through.
- `securitySchemes`: keep `AccessToken` + `CookieAccessToken`; `openapi_get_security()`
  drops `APIKey`/`CookieRefreshToken` until those credentials exist.
- Swagger title says "Hyperspace API" — rename while we're in there.

### 5. Config (env.js)

- Remove: `roles_prefix` (never defined here anyway).
- Add: `secure_cookies` (`YDD_SECURE_COOKIES`, default true; the `secure: false /* TODO */`s
  become configuration instead of TODOs).
- Keep: `disable_auth`, `penalty_ms`, `dev`, `swagger`.

### 6. Async password hashing (de-blocking the event loop)

`User.authenticate` / `create` / `set_password` use `crypto.scryptSync` (~50–100ms of CPU),
which stalls the whole server per login attempt — and `penalize()` only delays the
*response*, not the hash, so a hammered `/login` degrades everything. Switch the scrypt
calls to the async `crypto.scrypt` (promisified):

- `hash_password` / `verify_password` become async; `authenticate`, `create`,
  `set_password`, and `verify_password` (instance) grow `await`s. The dummy-hash burn for
  unknown emails stays (same timing-resistance rule, now non-blocking).
- The sqlite transaction rule is already satisfied: hashing happens BEFORE entering the
  transaction (`User.create` does this deliberately) and must stay there — better-sqlite3
  transactions cannot contain an `await`. Only the hash moves off-thread; every db
  read/write stays sync.
- Ripples: the Auth controllers `await User.authenticate(...)` (asseverate handlers are
  already async); `scripts/create-user.js` gains an async wrapper; the model tests touching
  passwords become async. Ed25519 sign/verify stays sync (µs — not worth it).

### 7. CLAUDE.md

Document the API-layer conventions once the code lands: token flow per endpoint, the
auth-token-only refresh rule, cookie names/scoping, logout-deletes-the-row, X-Sudo-Mode
masking, and the penalize-uniform-400 policy for credential failures.

## Migration order (each step leaves the tree working)

1. **Access + middleware** rewrite (asseverate.js) — the verify path, plus the
   `opeanapi_Tags` typo and dead-import cleanup. Unit-testable without HTTP.
2. **Auth collection** rewrite — login/refresh/authenticate/logout/revoke-all against the
   models; new response schemas.
3. **Webserver** — socket handshake, securitySchemes, config threading.
4. **Async scrypt** — flip User's password hashing to async `crypto.scrypt` and thread the
   `await`s through controllers/script/tests (natural to do right after the login endpoint
   exists to exercise it, but independent of the other steps).
5. **env.js / CLAUDE.md** — config block + documentation.

Tests: models are already covered; add API-level tests (in-memory db + supertest or raw
http against a started Webserver) for login/refresh/logout/revoke-all round-trips, the
penalize paths, cookie flags, and the sudo-mode masking. This needs the Webserver to be
constructible in tests (static-file/webapp paths may need to tolerate absence).

## Explicitly out of scope (unchanged future work)

- API keys (own table/model, `sid: null` access tokens) — the reason nothing may assume a
  non-null `sid`.
- Refresh-token rotation (re-roll `Session.token` per refresh) and sliding expiry.
- Password-change ⇒ revoke-all policy (one controller line when wanted).
- Session management UI endpoints (list my sessions / revoke one by id) — trivial with
  `Session.from_db(db, { user_id, active })` when wanted.
