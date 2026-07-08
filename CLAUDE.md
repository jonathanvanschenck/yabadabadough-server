## Project Overview

Personal finance server application built with Node.js and SQLite. Manages funds (hierarchical), transactions, allocations, and bank statement reconciliation. Supports monthly budgets with end-of-month finalization.

The React webapp lives in `webapp/` and has its own conventions file at `webapp/CLAUDE.md` (loaded automatically when working under that directory).

## Commands

### Testing
- Run all tests: `npm test`
- Run specific test file: `npx mocha test/models/test-fund.js`
- Test pattern: Files named `test-*.js` in `test/` directory (recursive)

### Database
- Database path configured via `.env` file: `YDD_SQLITE_PATH`
- Database uses WAL mode and foreign key constraints
- Schema version tracked via `PRAGMA user_version`
- Fresh schema applied automatically to new databases via `db/migrations/_schema.sql`

### Scripts
- Create a user (bootstrap; no API yet): `node scripts/create-user.js <email> <password> [--admin] [--editor]`
- Reset a password: `node scripts/create-user.js <email> <new-password> --set-password`
- Generate/rotate a JWT signing key pair: `node scripts/generate-jwt-key.js [dir]`

## Architecture

### Database Layer (`lib/db.js`)

Central module for database operations:
- `create_connection(config)`: Creates SQLite connection with WAL mode, foreign keys enabled
- `initialize_db(db)`: Applies schema for new databases, handles migrations for existing ones
- Caches prepared statements and transactions on `db.prepared_stmts` and `db.prepared_transactions` Maps
- Exports `ConflictError` and `ForeignKeyError` for model validation

### Token Manager (`lib/TokenManager.js`)

Owns JWT mechanics only (payload shapes / TTL policy live with the models):
- Ed25519 (`EdDSA`) signatures via node built-in crypto, no deps — same philosophy as scrypt
  password hashing. The algorithm is pinned: any other `alg` header is rejected
- Holds an ordered list of `kid`-named key pairs; the first with a private half signs, ALL
  verify (matched by the token's `kid` header). Old keys may be public-half-only, which is the
  rotation story: generate a new pair, keep the old public key one max-token-lifetime (~1w),
  then delete. `TokenManager.from_dir(dir)` loads `<kid>.private.pem` / `<kid>.public.pem`,
  kids sorted DESCENDING so the newest timestamp-named kid (from `scripts/generate-jwt-key.js`)
  signs. Missing/empty dir is a hard startup error pointing at the script
- `tokenize(payload, { ttl_s | expires_at })` stamps `iat`/`exp` (exp source is required —
  negative `ttl_s` allowed for test fabrication); `verify(token)` checks signature AND
  expiry/nbf, returning the payload or `null` on ANY failure (never throws on bad input);
  `peek(token)` parses without verifying (routing/inspection only — never trust it)
- Wired in `index.js` from the `tokens` env block (`YDD_JWT_KEYS_DIR`, default `./keys`,
  gitignored) and passed to `Webserver` as `token_manager`

### API Layer (`lib/Webserver.js`, `collections/`)

Express app built from asseverate Collections/Controllers (local wrappers in
`collections/lib/asseverate.js`); controllers declare role gates via static flags
(`access`/`admin`/`editor`/`reader` — reader defaults ON, matching the model default):
- `req.access` is built ONLY from a signature-verified access-token payload
  (`Access.from_access_token`, used by the Bearer middleware, the cookie middleware, and the
  socket.io handshake): identifier = email, plus `user_id`/`session_id` (`session_id`
  IS NULL on API-key-minted access tokens — nothing may assume it exists). Roles come straight
  off the payload (already effective) with ONE twist: `admin` is masked out unless the request
  carries `X-Sudo-Mode: true` (`adminable` says whether sudo would work) — a deliberate
  guard against accidental admin calls
- Auth endpoints (`collections/Auth.js`, `/api/auth/*`): `login` (email+password →
  new session + access/auth tokens, also set as cookies), `refresh` (needs ONLY the auth
  token; runs `Session.for_auth_payload` with `rotate: true`, so every successful refresh
  regenerates the per-session secret and returns/sets a NEW auth token — the presented one is
  single-use; failed refreshes never rotate, and rotation never slides the session's expiry),
  `authenticate` ("check my auth, refresh if stale" — browsers call it with cookies +
  `auto_refresh`; its refresh path rotates too), `logout` (deletes the session row via the full guard, idempotent, always
  clears cookies), `revoke-all` (kills every session for the authed user), `api-token`
  (exchanges a plaintext API key for a ~20m SESSIONLESS access token — `sid: null`, roles =
  owner's effective roles ∩ the key's flags, `admin` always false; no cookies, programmatic
  clients just re-exchange on expiry), the
  `check`/`check-admin`/`check-editor`/`check-reader` role probes, and `mode` (GET,
  unauthenticated: reports `{ disable_auth }` so the webapp can skip the login workflow
  entirely when the server runs with `YDD_DISABLE_AUTH`)
- Cookies: `access_token` (maxAge = 20m TTL, rides on every request) and `auth_token`
  (path-scoped to `/api/auth`, expires with the session); both httpOnly + SameSite Strict;
  `Secure` from `secure_cookies` (`YDD_SECURE_COOKIES`, default true — set false for plain-http
  dev only)
- Credential failures are a UNIFORM 400 + `penalize()` (`penalty_ms` delay): never leak which
  check failed (bad email vs password, bad signature vs dead session, ...)
- socket.io (in `lib/Webserver.js`, attached to the same http server; `serveClient: false` —
  the webapp bundles its own client): the READ-ONLY invalidation transport. Handshake auth via
  `Access.from_access_token` — handshake `auth.token` field first, then the `access_token`
  cookie (same precedence as the HTTP middlewares); unauthed sockets are disconnected after a
  `penalty_ms` slow-fail (skipped under `YDD_DISABLE_AUTH`); no sudo masking (sockets never
  take admin actions). Every connect (re)sends an `["versions"]` invalidation so clients
  detect redeploys; every controller write broadcasts `clean_queries` to all clients via the
  `invalidator` (`broadcast_invalidation_array`). A client-emitted `clean_queries` is relayed
  to every OTHER client (FIXME: to be removed so clients cannot trigger invalidations).
  Tests: `test/api/test-socketio.js` (socket.io-client devDependency)
- Utils (`collections/Utils.js`, `/api/utils/versions`): reports webserver/webapp versions
  (currently the same value — they deploy together) and the schema version via
  `schema_version(db)` (the `PRAGMA user_version` helper in `lib/db.js`); authed, no role
- `YDD_DISABLE_AUTH` bypasses the gates for development; API tests live in `test/api/`
  (real Webserver on an ephemeral port, in-memory db, fetch) — use the shared
  `test/api/harness.js` (`start_harness()` gives db + running server + one user & access
  token per role, plus a `request()` helper with `token`/`body`/`sudo` options)

### CRUD API Conventions (`collections/*.js`)

The CRUD collections (Funds, Transactions, Statements, Allocations, Finalizations, Users)
all follow the same shape:

- **Paths**: the collection prefix names the logical area; inside it, list/create routes use
  the PLURAL resource name and single-resource routes the SINGULAR + id — e.g.
  `GET /api/funds/funds` (list), `GET /api/funds/fund/:fund_id` (single). The plural/singular
  split means literal segments never collide with param routes, so controller order is never
  load-bearing. Resources without ids use collection-root verbs instead (Allocations:
  GET/PUT/DELETE on `/allocations` keyed by `(fund_id, month)` + `POST /allocations/copy`)
- **Roles**: reads = `reader` (the Controller default), writes = `editor: true`, user
  management = `admin: true` (which implies the `X-Sudo-Mode` header requirement). There are
  deliberately NO `/me` routes (viewer-relative endpoints want viewer-relative query keys,
  which break under broadcast invalidations): self-service goes through the SELF-OR-ADMIN
  `/api/users/user/:user_id/...` routes (`reader = false` + the `get_target_user` helper in
  `collections/Users.js` — your own id needs no role or sudo; anyone else's needs admin +
  X-Sudo-Mode and reads as 404 for non-admins / 403 for admins missing sudo). Clients learn
  their own user id from the login/authenticate response
- **Parsers** (`collections/lib/parsers.js`): request BODIES use the strict `only_*` parsers
  (`only_id`, `only_number`, `only_positive_number`, `only_boolean`, `only_ydate`,
  `only_non_empty_string`, the `nullable(parser)` combinator) — no string coercion; QUERY
  params use the coercive/lenient `to_*` parsers, where invalid values fall back to
  "filter not applied". Exception: a query param whose misparse would silently return wrong
  data (e.g. `?on=` for balances, `?descendant_of=` for the funds list — the fallback would
  return ALL funds) hard-400s instead, via `parse_strict_query_param`
- **Shared controller helpers** (`collections/lib/asseverate.js`):
  - `parse_body_fields(body, [[key, parser, expected, {required}]])` — the body-validation
    loop; parsers signal failure by returning `undefined` (400 `Bad parameter`/`Missing
    parameter`). Per-element array validation wraps it and prefixes `items[i]:` context
  - `parse_strict_query_param(query, key, parser, expected)` — the strict query-param
    exception above: undefined when absent, parsed value, or hard 400 — never lenient
  - `assert_found(value, label)` — 404 for path-id lookups (invalid ids 404 too, never 400)
  - `translate_model_error(err)` — wraps ONLY the model write call: `ConflictError` → 409,
    `ForeignKeyError` → 400 (bad body reference), plain `Error` (model consistency checks)
    → 400, anything else rethrown → 500
  - `parse_list_params` / `openapi_list_parameters` — the shared
    order_by/order_direction/limit/offset handling (order_by is whitelisted per endpoint,
    matching the model's `ORDER_BY_MAP`)
  - `data_invalidations_response(schema)` — the `{ data, invalidations }` response schema
- **Write responses & invalidations**: every write returns
  `{ data: <to_api() | null-for-delete>, invalidations: [...] }` and broadcasts the same
  actions via `this.broadcast_invalidations()`, which emits a `clean_queries` socket.io event
  (`[source, meta, [{ method: "invalidateQueries"|"removeQueries", args: [{ queryKey }] }]]` —
  tanstack-shaped by `Webserver.generate_tanstack_invalidation`) to every connected client. The
  webapp applies them to its tanstack-query cache. ALL query keys and actions come from
  `collections/lib/query_keys.mjs` (`QK`, `invalidate`, `remove`, `money_moved()`) — never
  inline key literals. The registry is deliberately ESM (.mjs) and runtime-agnostic (no node
  builtins): the CJS server `require()`s it (Node ≥ 22.12 require(esm)) and the webapp imports
  the SAME file (via its `src/hooks/queryKeys.js` shim), so the keys the webapp caches under
  and the keys the server invalidates can never drift.
  Invalidations cross collections constantly (allocation writes touch
  transaction/balance keys; finalizations touch nearly everything). Key conventions: plural
  list keys (`["funds"]`), singular + STRINGIFIED id singles (`["fund", "3"]`), computed
  subresources under their own top-level key (`["fund-balance", id]`) so hot invalidations
  don't refetch cold data; when in doubt, over-invalidate
- **Pagination**: EVERY list endpoint sets `X-Total-Count` from the model's
  `count(db, filters)` static (which shares `_from_db_wheres` with `from_db` and ignores
  order/limit/offset, so one filter object serves both) and declares the header in
  `openapi_ResponseHeaders`; the API-layer default limit is a generous 1000
- **API-layer rules on top of the models**: USER transaction/allocation amounts are strictly
  positive (zero is reserved for internal eom_cleanup rows); allocation and eom_cleanup groups
  cannot be deleted OR edited through the transaction-groups API (API-layer 409 guards, with
  the model refusals as backstop); bank-statement deletion defaults to
  `with_group=true` and its OpenAPI description carries the re-import double-count hazard;
  password changes revoke sessions by default (`revoke_sessions: true` — API-layer policy per
  the model docs — but API keys deliberately survive password changes; `POST /user/:id/password`
  splits semantics on sudo-mode admin rights: without them the target must be yourself and
  `current_password` is verified with a uniform penalized 400, with them it is an
  administrative reset); self-deletion of users
  is refused; foreign sessions AND foreign API keys read as 404, not 403 (as do foreign USERS
  for non-admins on the self-or-admin routes); the API-key mint
  response is the only surface that ever shows the key's plaintext secret
- **Transaction editing** (three PATCH routes, all in `collections/Transactions.js`; group ids
  are stable across all of them, so bank statement reconciliation survives edits):
  `PATCH /transaction-group/:id` (scalars — description/note/date; a date edit broadcasts
  `money_moved()`, cosmetic edits skip the `fund-balance` refetch),
  `PATCH /transaction-group/:id/transactions` (atomic add/update/remove line editor; the group
  must keep ≥ 1 line — emptying it is a 400 pointing at DELETE), and
  `PATCH /transaction/:id` (in-place field edit of one line — the `/transaction` resource's
  ONLY write: creating/deleting lines stays group-scoped, and `date` is group-level)
- **OpenAPI**: every controller declares Summary/Description/Parameters/RequestBodySchema/
  ResponseSchema/ErrorResponses, `$ref`-ing the model schemas registered by `lib/openapi.js`;
  error schemas come from the shared `*ResponseSchema` set there. Swagger UI at `/api-docs`,
  spec at `/api-docs.json`

### Data Type Conventions

**Currency**: Stored as INTEGER with 4 decimal places (e.g., 10000 = $1.00)
- `currency2stmt(value)`: Converts float to 4-decimal integer
- `stmt2currency(value)`: Converts 4-decimal integer to float

**Dates**: Stored as TEXT in 'YYYY-MM-DD' format
- Use `YDate` class (lib/YDate.js) for date handling
- `ydate2stmt(value)`: Converts YDate to string
- `stmt2ydate(value)`: Parses string to YDate

**Booleans**: Stored as INTEGER 0/1
- `boolean2stmt(value)`: Converts boolean to 0/1
- `stmt2boolean(value)`: Converts 0/1 to boolean

**Datetime**: ISO 8601 format with timezone
- `datetime2stmt(value)`: Converts Date to ISO string
- `stmt2datetime(value)`: Parses ISO string to Date

### Date & Balance Conventions

- **"Forward balance entering date D"**: includes every transaction *before* D, but NOT
  transactions on D itself. Every stored balance is a forward balance (`funds.start_balance`,
  `fund_finalizations.sonm_balance`), and the API exposes them as `{ date, forward_balance }` pairs.
- **"Balance on date D"**: includes every transaction up to *and on* D. Only returned from
  calculation methods (`fund.calculate_balance_on(db, date)`), never stored.
- The one exception: `fund_finalizations.eom_balance` is the balance on `eom_date` *excluding*
  eom_cleanup transactions — a surplus/loss history snapshot, NOT a reconciliation point.
- `Transaction.net_transfer` bounds (`since`/`until`) are both inclusive, so
  `balance_on(D) = forward_balance_entering(C) + net_transfer(since=C, until=D)`.
- Transactions may not predate a tracked fund's `start_date` (enforced at transaction creation).

### Model Pattern (`models/Base.js`)

Base class for all models with pattern:

**Static properties**:
- `PREPARED_STMTS`: Object mapping statement keys to SQL strings
- `PREPARED_TRANSACTIONS`: Object mapping transaction keys to functions
- `ORDER_BY_MAP`: Valid column names for ordering

**Statement caching**:
- `build_stmt(db, key, sql)`: Creates/retrieves cached prepared statement
- `get_stmt(db, key)`: Retrieves statement from PREPARED_STMTS
- Similar pattern for `build_transaction()` and `get_transaction()`

**Model methods**:
- `static create(db, {...})`: Creates new record, returns model instance
    - This method assumes inputs have been type checked, but the method will run consistency checks,
      and then db-related conflict/missing resource checks in a transaction.
- `static from_db(db, {...})`: Flexible query method with filtering
- `static for_id(db, id)`: Retrieves single record by ID
- `static from_row(row)`: Converts DB row to model instance
- `instance.to_api()`: Serializes for API response
- `instance.update(db, {...})`: Updates record
- `instance.delete(db)`: Deletes record

**OpenAPI schema convention**: each model declares `static openapi_<Name>Schema` properties —
OpenAPI 3.0 schema objects documenting its API representations. `lib/openapi.js` scans every
`models/*.js` export for `openapi_`-prefixed statics, strips the prefix, and registers them
under `components.schemas.<Name>Schema` (so all names must be globally unique and end in
`Schema`). The main schema documents `to_api()` exactly — every emitted key listed in
`required` (nullable fields are `nullable: true`, not omitted) — and lives directly above
`to_api()` in the file; models may declare additional statics for shared sub-shapes (e.g.
`Fund.openapi_ForwardBalanceSchema`). Cross-schema links use
`{ $ref: '#/components/schemas/<Name>Schema' }` — the registry is global, so referencing
another model's schema is fine. Nullable refs compose with the `NullSchema` helper via `oneOf`;
a described ref wraps its `$ref` in `allOf` (a bare sibling `description` would be ignored).
Conventions for the field types: currency → `number` (float dollars), YDate → `string` with
`format: 'date'`, datetimes → `string` with `format: 'date-time'`.

**SQL locality convention**: each model file owns ALL SQL against its table; cross-model
operations go through (possibly internal `_`-prefixed) model methods, never inline SQL at the
call site (e.g. Allocation edits groups only via `TransactionGroup._add_transaction` /
`_remove_transaction`). The only sanctioned exception: small inline guard queries against
*other* tables used solely to avoid circular requires (e.g. `month_is_finalized` in
TransactionGroup, `finalized_months_since` in Fund).

### Schema Hierarchy

**Funds** (`funds` table):
- Hierarchical structure via `parent_id` (self-referencing)
- Triggers prevent cycles in hierarchy
- `tracked=1` funds have `start_date`/`start_balance` (untracked funds must not); there is no
  stored running balance — balances are calculated from the cache point plus net transfers since
- `monthly=1` funds reset at end of month (requires parent_id, tracked=1, and a pool ancestor)
- `pool=1` funds are the source/sink of money for their descendants: allocations draw from the
  nearest pool ancestor, and monthly funds return their EOM balances directly to it (skipping
  intermediate non-pool funds). Pools require tracked=1 and monthly=0 (db CHECK). The "every
  monthly fund has a pool ancestor" invariant is hierarchy-global, enforced at the model layer
  on every fund create/update (plus: a monthly fund may not start before its pool ancestor).
  `fund.nearest_pool(db)` resolves the ancestor
- `finalization_id` references the most recent fund finalization; the model-level "cache"
  (`cached_date`/`cached_balance`) falls back to the start values (backdated to the first of the
  month) when the fund has never been finalized, so callers always have one place to look
- History-affecting fields (`start_date`, `start_balance`, `tracked`, `monthly`, `pool`, and the
  `parent_id` of any fund that is or contains a monthly fund) are immutable while any
  finalizations exist (`fund.assert_unfinalized`)
- `color` is a palette SLUG (never a hex) from `lib/fund_colors.mjs` — an ESM registry shared
  with the webapp exactly like the query-key registry (webapp shim: `src/hooks/fundColors.js`;
  hex values live only in `webapp/public/styles.css` as `--fund-<slug>` variables). Validated
  at the model layer and by the strict API parser, with a `CHECK` constraint as backstop;
  adding/renaming a slug means updating registry + styles.css + schema in one commit

**Transaction Groups** (`transaction_groups` table):
- Container for one or more related transactions
- May be linked FROM `bank_statement_items` (via that table's `group_id`); groups hydrate a
  `statements` array on read (correlated subquery, like `transactions`), and `from_db` filters
  on `has_statements`. Linking happens only in `TransactionGroup.create_from_statements`;
  public `create` has no statement surface
- Has `date` field (YYYY-MM-DD)
- Has several denormalized values (`split`,`allocation`,`eom_cleanup`) for easier querying; the
  `allocation`/`eom_cleanup` flags are reserved for the internal Allocation / MonthFinalization
  paths — public `create` rejects them (at most one of the two, db CHECK)
- `group.delete(db)` removes a group and its transactions; the only guard is the finalized-month
  check (which inherently protects eom_cleanup groups — they only exist inside finalized months).
  `TransactionGroup.assert_month_unfinalized(db, date)` is the shared guard helper
- **In-place edits** (updates are preferred over delete-and-recreate because the group id — and
  therefore any bank statement reconciliation pointing at it — stays stable; deleting a
  reconciled group releases its items to pending via `ON DELETE SET NULL`, setting up a
  double-count on re-sync):
  - `group.update(db, { description, note, date })` — scalar fields; a `date` change re-checks
    every line's start-date invariant, refuses moving into (or editing within) a finalized
    month, and cascades to the denormalized date on every transaction
    (`Transaction._set_date_for_group`)
  - `TransactionGroup.edit_transactions(db, group, { add, update, remove })` — the atomic line
    editor: adds go through `_create_with_group` (full creation validation, group's date),
    updates through `Transaction._update`, removes through `Transaction._delete`, one `split`
    resync at the end. Referenced ids must belong to the group and appear once; the group must
    keep ≥ 1 transaction (delete the group to empty it)
  - Both refuse allocation/eom_cleanup groups (managed by Allocation / MonthFinalization) and
    run inside one sqlite transaction — any failed check rolls the whole edit back

**Transactions** (`transactions` table):
- Moves money from `source_fund_id` to `target_fund_id`
- Belongs to `transaction_groups` via `group_id`
- May link to `fund_finalizations` (via `eom_cleanup_id`)
- Date and `allocation` flag denormalized from group for query performance; a partial unique
  index on `(target_fund_id, date) WHERE allocation = 1` backstops
  one-allocation-per-fund-per-month
- Zero amounts are allowed at the db/model level (needed for eom_cleanup transactions); USER
  transactions must be positive, enforced at the API layer
- `transaction.update(db, { amount, source_fund_id, target_fund_id, description, note })` edits
  one line in place, re-running the same checks as creation (the shared
  `Transaction._assert_transaction_valid`, extracted from `_create_with_group`). `date` and
  `allocation` are group-level facts and only change via the group; allocation/eom_cleanup
  transactions and finalized months are refused. Creating/deleting lines goes through
  `TransactionGroup` (`create`/`delete`/`edit_transactions`) — `transaction.delete()` is a
  throwing stub pointing there

**Bank Statement Items** (`bank_statement_items` table, `models/BankStatementItem.js`):
- One imported bank statement line, deduped on `(source, key)` — `key` is externally derived, so
  re-syncing via `BankStatementItem.import_many` never duplicates rows and NEVER updates existing
  ones (user state must survive re-syncs). Bank facts (`source`, `key`, `amount`, `date`) are
  immutable; only `ignored`/`note` are mutable (`item.update`)
- `amount` is signed (negative = money leaving that bank account) and is intentionally NEVER
  checked against the linked group's transaction amounts (transfers make any simple rule
  ambiguous)
- Always in exactly one of three derivable states: *pending* (`ignored = 0`, `group_id` NULL),
  *ignored* (`ignored = 1`), or *reconciled* (`group_id` set). Ignored+linked is impossible: a
  single-row db CHECK backstops the model-layer checks
- `group_id` lives on THIS table (not on `transaction_groups`) so transfer-type events — two
  items from two different bank imports (e.g. checking → savings) — can share one group. Linked
  via `TransactionGroup.create_from_statements(db, { statement_ids, ... })`: one id normally,
  both sides' ids for a transfer; group `date` defaults to the LATEST item date, `description`
  to the items' notes (fallback: keys)
- Unlinking only via group deletion (FK `ON DELETE SET NULL` releases items to pending) or
  `TransactionGroup.delete_statement_item(db, item, { with_group = true })`. Deletion lives on
  TransactionGroup (the with_group arm deletes a group in the same sqlite transaction, and the
  require direction is strictly TG → BSI); `item.delete()` is a throwing stub pointing there
- **Deletion hazard (by design, documented on the method)**: deleting is for undoing bad
  imports, NOT for hiding items (use `ignored`). `with_group` destroys the group's real
  transactions, and any deleted item REAPPEARS as pending on the next re-sync (its dedupe row
  is gone) — reconciling it again double-counts

**Allocations** (`models/Allocation.js` — intentionally NO table):
- A start-of-month transfer into a fund ("monthly" budgets and progressive saving), created
  immediately as a real transaction — no trigger step, no second copy of the amount
- Each month has at most ONE allocation transaction group (`allocation = 1`, dated the first of
  the month) holding one transaction per allocated fund; created lazily on the month's first
  allocation, deleted when the last is removed, `split` kept in sync
- The money comes from the target's nearest pool ancestor. `source_fund_id` is DERIVED, never
  snapshotted: hierarchy changes repoint allocations in unfinalized months
  (`Fund._rederive_allocation_sources`, which also rejects changes that would orphan one);
  finalized months keep their historical routing
- Managed exclusively through `Allocation.set` / `remove` / `for_month` / `for_fund` /
  `copy_month({ from, to, on_conflict: "error"|"merge"|"overwrite" })`; the model owns no table
  SQL — it composes TransactionGroup/Transaction methods
- Targets must be tracked, started by the first of the month (a fund starting mid-month cannot
  receive an allocation for that month — hard error by design; use an ordinary transaction group
  or backdate `start_date` to the 1st), and have a pool ancestor that has also started (pools
  under pools may receive allocations)
- Finalized months are immutable: allocations there cannot be set/removed/overwritten

**Month Finalizations** (`month_finalizations` table, `models/MonthFinalization.js`):
- Is the parent of the Fund Finalizations for bucketing into a single month
- Stores `som_date` (first day of month), `eom_date` (last day of month), and `sonm_date` (first
  day of next month) for easy querying; `UNIQUE(som_date)` prevents double-finalization
- `MonthFinalization.create(db, { month, recursive })` is the ONLY way to finalize: users work on
  months as a whole, never on individual funds. Months finalize contiguously (oldest first);
  `recursive: true` auto-finalizes intervening months
- Finalizing computes each tracked fund's eom balance, inserts one `eom_cleanup` transaction group
  zeroing every monthly fund directly into its nearest pool ancestor (no ordering or relaying —
  each monthly fund moves exactly its own eom balance, even when monthly funds nest), and
  repoints `funds.finalization_id`
- `month.unfinalize(db)` reverses this, strictly LIFO (latest month only), and repoints funds at
  their previous finalization
- Once a month is finalized, no transaction groups may be added in (or before) it
- The server intentionally does NOT restrict finalizing the current/future month (timezone
  complications); a premature finalization can be unfinalized

**Future direction — hierarchy restructuring / snapshotting** (not supported today): routing
(pool flags, parents of monthly funds) is currently write-once against history — changing it
requires unfinalizing all the way back and rewriting history as if the hierarchy had always
looked that way. Eventually we want point-in-time hierarchy changes ("X stops being a pool as of
month M") without rewriting earlier months, applied consistently to finalizations and
allocations.

**Fund Finalizations** (`fund_finalizations` table, `models/FundFinalization.js`):
- Historical record of end-of-month (excluding monthly budget cleanups) and start-of-next-month
  balances; managed internally by MonthFinalization (plus Fund creation backfill), never created
  directly
- Stores `eom_balance` (4 decimal) at end of `eom_date`. It does NOT include the "reset
  monthly-type funds to zero" cleanup transaction — its whole purpose is to track surplus/loss in
  monthly-type funds historically (`fund.finalization_history(db)`)
- Stores `sonm_balance` (4 decimal) entering `sonm_date` (denormalized onto this table), used to
  quickly reconcile a fund from a cached starting point
- `UNIQUE(month_id, fund_id)`; the most recent id is referenced on the funds table
- Tracked funds created with a `start_date` in/before finalized months are backfilled
  automatically (`eom = sonm = start_balance`); backdated monthly funds must start at 0

**Users** (`users` table, `models/User.js`):
- Email is normalized (lowercase + trim) at every model boundary and stored normalized, so the
  column `UNIQUE` gives case-insensitive uniqueness. Minimal format check (contains `@`);
  passwords are min 8 chars, enforced in `create`/`set_password`
- Three role flags: `admin`, `reader` (default 1 — everyone is a reader unless revoked), and
  `editor`. Stored flags hold what was explicitly granted; `user.roles` is the EFFECTIVE set,
  where admin implies every other role (derived at read time, never written back). ALL role
  checks go through `roles`; access-token payloads carry effective roles (applied at mint time),
  and `from_db`'s `reader`/`editor` filters match effective roles (admins count) while `admin`
  is exact. Editor does NOT imply reader (the default covers it)
- Passwords are salted scrypt hashes (node built-in crypto, no deps) stored as ONE
  self-describing string: `scrypt$N$r$p$salt_b64$hash_b64`. Verification parses params from the
  stored string (not code constants), so cost can be raised later without invalidating existing
  hashes. `to_api` NEVER includes `password_hash`. Everything touching scrypt (`create`,
  `set_password`, `verify_password`, `authenticate`) is ASYNC — the hash runs on the libuv
  threadpool, never the event loop, and always OUTSIDE the sqlite transaction (better-sqlite3
  transactions cannot contain an await)
- `update` handles only `email` and the role flags; passwords change via `set_password` (fresh
  salt).
  Password changes deliberately do NOT revoke sessions — that's API-layer policy (one
  `Session.revoke_all` call). `User.authenticate` returns `User | null` and burns a dummy scrypt
  verify on unknown emails (user-enumeration timing resistance). No last-admin guard by design
- JWT payloads (signed/verified by `lib/TokenManager.js` at the API layer; the model only
  renders payload objects, with `typ` + `v` claims discriminating kinds):
  - access (~20m, `User.ACCESS_TOKEN_TTL_S`, stateless): `{ v, typ: "access", sub, email, admin, reader, editor, sid }` (effective roles)
  - auth (~1w, session-bound): `{ v, typ: "auth", sub, sid, token }`
  - access from an API key (~20m, sessionless): same `typ: "access"` shape but `sid: null`,
    `akid` = the minting key's id, `admin` ALWAYS false, `reader`/`editor` masked by the
    key's flags (`user.to_api_key_access_token_payload(api_key)`)
  Rendered by `user.to_access_token_payload(session)` / `to_auth_token_payload(session)`;
  `User.from_token_payload(payload)` is the db-free inverse for access payloads (unsaved
  instance, `admin` may be ~20m stale — use `for_id` when freshness matters). NOTHING may assume
  `sid` is non-null: API-key-minted access tokens have no session behind them
- Bootstrap via `scripts/create-user.js` (also the forgotten-password recovery path)

**Sessions** (`user_sessions` table, `models/Session.js`):
- A session row IS the right to refresh: refreshable iff the row exists and `expires_at` is in
  the future. Logout (`session.delete`) and revoke-all (`Session.revoke_all(db, user_id)`) are
  row deletions — no revoked flag. `Session.prune` reclaims expired rows, and `Session.create`
  runs the same sweep on every login (no cron needed — the table stays bounded by real usage;
  tests fabricating expired sessions via negative `ttl_days` must create them last)
- `token` is a per-session random secret (16 bytes hex) embedded in the auth payload and
  required to match (timing-safe) at refresh — defends against sqlite id reuse and is what
  rotation regenerates. NEVER in `to_api`
- `Session.for_auth_payload(db, payload, { rotate })` is the refresh guard: checks `typ`/`v`,
  row exists, secret matches, `sub` owns the session, not expired; touches `last_used_at`;
  returns the fresh Session. With `rotate: true` (the API refresh path) the secret is
  regenerated in the same transaction, making the presented payload single-use — guard
  failures never rotate. Expiry is FIXED at creation (`ttl_days`, default
  `Session.DEFAULT_TTL_DAYS` = 7) — refreshes/rotation never extend it (no sliding window)
- Require direction is strictly `Session → User` (user existence via FK, mapped to
  `ForeignKeyError`); `User` never requires `Session` — list a user's sessions via
  `Session.from_db(db, { user_id, active })`. User deletion cascades sessions at the db layer
- Accepted staleness window (by design): access tokens are stateless, so logout / revoke-all /
  admin changes / user deletion do not kill OUTSTANDING access tokens — they die at their ≤20m
  expiry. Controllers guarding sensitive actions can re-check with `User.for_id` /
  `Session.for_id`

**API Keys** (`user_api_keys` table, `models/ApiKey.js`):
- An API key row + its secret is the right to mint SESSIONLESS access tokens: the plaintext
  (`ydd_` + 64 hex chars) is exchanged at `POST /api/auth/api-token`
  (`ApiKey.for_exchange(db, secret)` — row exists for the secret's hash, not expired; touches
  `last_used_at`) for a standard ~20m access token with `sid: null`. Everything downstream
  (middlewares, role gates, socket handshake) treats it like any other access token
- The secret is stored ONLY as `token_hash` (sha256 hex, `UNIQUE`): it leaves `ApiKey.create`
  (which returns `{ api_key, secret }`) exactly once — the POST `/user/:user_id/api-keys`
  response is the only API surface that ever shows it. Lookup is BY hash, so no timing-safe
  compare is needed (unlike `Session.token`, which is stored plaintext and compared)
- Per-key role scope: `reader` (default 1) / `editor` (default 0) flags mask the OWNER's
  effective roles at exchange time; `admin` is never minted from an API key (no column — user
  management stays interactive-login-only). Hierarchy: minted roles = user effective ∩ key flags
- `expires_at` is NULLABLE (null = never expires); expired keys refuse exchange but stay
  listed (no prune sweep — visibility over housekeeping; negative `ttl_days` fabricates
  expired keys in tests, and there is no create-time sweep to worry about, unlike sessions)
- Revocation = row deletion (`api_key.delete`) via the self-or-admin
  `DELETE /api/users/user/:user_id/api-key/:id` (own keys need no role; another user's need
  admin + X-Sudo-Mode, and a key under the wrong user reads as 404) — the admin kill path
  matters because password resets do NOT touch API keys (they are not password-derived).
  User deletion cascades keys. The ≤20m staleness window applies exactly as for sessions
- Mint/list via the self-or-admin `GET|POST /api/users/user/:user_id/api-keys` (list takes
  the `active` filter and sets `X-Total-Count`). The query key is the id-scoped
  `["user", <id>, "api-keys"]` with deliberately NO `["me", ...]` variant:
  invalidations broadcast to every socket.io client, and a viewer-relative key would
  spuriously invalidate other users' own-keys caches (the webapp keys its self view by its
  own user id, known from the login/authenticate response)

### YDate Class (`lib/YDate.js`)

Wrapper around dayjs for strict YYYY-MM-DD date handling:
- `YDate.parse(str)`: Returns YDate or null (validates exact format)
- `ydate.toString()`: Returns 'YYYY-MM-DD' string
- `ydate.toJSON()`: Returns 'YYYY-MM-DD' string
- `ydate.end_of_month()`: Returns YDate for last day of month
- `ydate.start_of_month()`: Returns YDate for first day of month
- `ydate.start_of_next_month()`: Returns YDate for first day of the next month
- `ydate.offset_days(days)`: Returns YDate offset by the given number of days

### Test Pattern

Tests use Mocha + Chai with in-memory SQLite:

```javascript
let db;
beforeEach(() => {
    db = create_connection({ path: ":memory:" });
    initialize_db(db)
});
```

Each test gets fresh database initialized with current schema.
