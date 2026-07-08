# API Implementation Plan

Full CRUD API for the finance models, following the asseverate Collection/Controller pattern
demonstrated by `~/git/hyperspace/collections/Vendors.js`, adapted to this project's existing
conventions (`collections/Auth.js`, `collections/Utils.js`, `collections/lib/asseverate.js`).

Every controller declares `query_key` statics chosen for tanstack-query invalidation on the
webapp side; every write endpoint returns `{ data, invalidations }` and broadcasts the same
invalidation actions through `this.broadcast_invalidations(...)` (currently a noop invalidator
in `lib/Webserver.js`; wired up for real when socket.io lands).

---

## Status: IMPLEMENTED (2026-07-07)

All eight phases landed, one commit each (`9660a54..47a0341`): 36 routes across Funds,
Transactions, Statements, Allocations, Finalizations, Users (+ the pre-existing Auth/Utils),
462 tests passing, conventions documented in CLAUDE.md ("CRUD API Conventions"). The phase
sections below are the as-built record; what follows here is what is deliberately NOT built
yet, and why.

### Since implemented

- **Transaction editing (2026-07-07)**: real in-place updates replaced the original
  delete-and-recreate workflow (which was non-atomic across two HTTP calls and lost the group
  id — and with it any bank statement reconciliation, since `bank_statement_items.group_id` is
  `ON DELETE SET NULL`). See `Transaction_Update_Implementation_Plan.md` for the full design.
  Three PATCH routes in `collections/Transactions.js`:
  - `PATCH /api/transactions/transaction-group/:group_id` — scalars (`description`/`note`/
    `date`; date cascades to the lines and broadcasts `money_moved()`, cosmetic edits skip the
    balance keys)
  - `PATCH /api/transactions/transaction-group/:group_id/transactions` — atomic
    `add`/`update`/`remove` line editor (`TransactionGroup.edit_transactions`)
  - `PATCH /api/transactions/transaction/:transaction_id` — in-place edit of one line; the
    `/transaction` resource's only write (create/delete of lines stays group-scoped)

- **Fund descendants (2026-07-07)**: shipped as a `descendant_of` filter on
  `GET /api/funds/funds` (the filter surface won over a dedicated `/descendants` route — it
  composes with the tracked/monthly/pool filters for free). Self-inclusive subtree
  (recursive CTE in `Fund.from_db`); an unknown id returns an empty list, a malformed value
  hard-400s (the documented "silently wrong data" exception to lenient query parsing — the
  fallback would return ALL funds). The throwing `Fund#descendants` stub was deleted (it had
  no callers); use `Fund.from_db(db, { descendant_of })`.

- **`X-Total-Count` everywhere (2026-07-07)**: the "small-table lists" (funds, users,
  sessions, month-finalizations) now send the header too — untracked funds can balloon
  (tracked funds stay under ~100, but nothing bounds the untracked tree), and the count
  costs almost nothing, so every list endpoint is now symmetric. Same mechanics as the big
  tables: `_from_db_wheres` extracted in Fund/User/Session/MonthFinalization, `count()`
  statics sharing it with `from_db`, respond sets the header from the same filter object.

- **Bulk balances (2026-07-07)**: `GET /api/funds/balances[?on=]` returns every tracked
  fund's balance in one response (`[{ fund_id, on, balance }]`, same item shape as the
  per-fund route; webapp key `["fund-balance", "all", on]`). A round-trip optimization for
  dashboards — the per-fund calculation was already cheap. Divergences from the per-fund
  route, both because one fund must not fail the whole response: funds whose `start_date`
  is after `on` are OMITTED (per-fund 400s), and untracked funds are excluded entirely
  (per-fund reports 0). Unpaginated (tracked funds stay small); `X-Total-Count` is still
  set for symmetry and equals the array length.

### Outstanding — deferred by choice (add when a real need shows up)
- **Admin per-session revocation** (`DELETE /api/users/user/:user_id/session/:session_id`):
  admins today reset the user's password with `revoke_sessions: true` (kills everything) or
  the user self-serves via `/api/users/me/session/:id` and `/api/auth/revoke-all`. A
  surgical admin kill-one-session endpoint adds little until there is a support workflow
  that needs it.

### Outstanding — waiting on future architecture (tracked elsewhere, listed for completeness)

- **socket.io invalidation transport**: the invalidator in `lib/Webserver.js` is a noop and
  the handshake/`clean_queries` code is commented out. Every write already returns and
  broadcasts the correct action arrays, so wiring the transport requires no controller
  changes.
- **API-key credentials** (sessionless access tokens; `sid: null` is already tolerated
  everywhere by design): needs mint/list/revoke endpoints — probably
  `/api/users/me/api-keys` for self-service plus admin visibility under
  `/api/users/user/:user_id/api-keys` — and a token-minting path that skips Session. No
  model exists yet.
- **Auth-token rotation on refresh**: v1 `/api/auth/refresh` returns the auth token
  unchanged; `Session.token` (the per-session secret) is the designed hook. Rotation is an
  Auth-collection change, not a new endpoint.
- **Hierarchy restructuring / snapshotting** ("X stops being a pool as of month M" without
  rewriting earlier months — see the Future direction note in CLAUDE.md): routing is
  currently write-once against history, so no endpoints exist for point-in-time hierarchy
  changes. When the model story lands this likely becomes a new resource (hierarchy
  revisions) rather than extra PATCH fields on funds.

---

## Phase 0 — Shared helpers

### 0.1 `collections/lib/asseverate.js`: body-validation helper (the requested one)

Replace the repeated Vendors-style loop:

```js
if ( data[key] !== req.body[key] ) throw new HTTPCodeError(400, `Bad parameter: ...`)
```

with one exported function:

```js
/**
 * Validate/normalize a request body against a field spec.
 *
 *   fields: [ [ key, parser, expected, { required=false }={} ], ... ]
 *
 * - key absent from body: skipped (or 400 `Missing parameter: <key>` when required)
 * - parser returns undefined: 400 `Bad parameter: <key> (got '<v>' expected <expected>)`
 * - otherwise the PARSED value lands in the returned object
 */
function parse_body_fields(body = {}, fields = []) { ... }
```

Contract change vs the hyperspace `!==` comparison, on purpose: parsers signal failure by
returning `undefined` (all `collections/lib/parsers.js` parsers already default their fallback
to `undefined`). This keeps identity-parser behavior the same while also supporting
*transforming* parsers (`YDate.parse` returns an object, so `!==` could never work). To avoid
losing strictness for numbers (`to_int(5.7) === 5` would silently truncate), body validation
uses new strict `only_*` parsers (0.2); the coercive `to_*` parsers stay for query strings.

Also add to `asseverate.js`:

- `assert_found(value, label)` — returns `value`, or throws `HTTPCodeError(404, "Not found: <label>")`
  when null/undefined. Used after every `Model.for_id`. (Plays the role of hyperspace's
  `get_vendor` helper without needing one method per model.)
- `translate_model_error(err)` — the write-path error mapper, used as
  `.catch()`/try-catch around model create/update/delete calls **only** (never around whole
  handlers):
  - `ConflictError` → `HTTPCodeError(409, err.message)`
  - `ForeignKeyError` → `HTTPCodeError(400, err.message)` (bad reference in the body; path-id
    lookups have already 404'd via `assert_found`)
  - plain `Error` (i.e. `err.constructor === Error` — the models' consistency-check throws,
    e.g. "Cannot create a monthly fund without a parent") → `HTTPCodeError(400, err.message)`
  - anything else (TypeError etc. = real bugs) → rethrow → 500

### 0.2 `collections/lib/parsers.js`: new parsers

- `only_int(v)` — strict: `Number.isInteger(v)` or undefined (no string coercion)
- `only_id(v)` — strict positive integer
- `only_positive_number(v)` — strict `typeof v === "number" && v > 0` (user-facing currency
  amounts; the models accept float dollars)
- `only_ydate(v)` — `typeof v === "string"` then `YDate.parse(v)`; undefined on failure
  (works for both body fields and query params)
- `nullable(parser)` — combinator replacing the repeated `(v) => v===null ? v : only_string(v)`
  lambdas: passes `null` through, otherwise applies `parser`
- `to_ydate(v)` — alias of `only_ydate` for query-param call sites, for naming symmetry

### 0.3 `collections/lib/query_keys.js`: the key registry

Invalidations cross collection boundaries constantly (an allocation write must invalidate
transaction-group queries; a finalization touches almost everything), so key literals must not
be scattered. One small module exports both the key constants and pre-built action helpers:

```js
const QK = {
    funds: ["funds"],                     fund: (id) => ["fund", id.toString()],
    fund_balance: (id) => ["fund-balance", id.toString()],   // prefix ["fund-balance"] invalidates all
    transaction_groups: ["transaction-groups"], transaction_group: (id) => [...],
    transactions: ["transactions"],       transaction: (id) => [...],
    statements: ["statements"],           statement: (id) => [...],
    allocations: ["allocations"],
    month_finalizations: ["month-finalizations"], month_finalization: (id) => [...],
    fund_finalizations: ["fund-finalizations"],   fund_finalization: (id) => [...],
    users: ["users"],                     user: (id) => [...],
    me: ["me"],                           me_sessions: ["me", "sessions"],
};
const invalidate = (key) => ({ type: "invalidate", key });
const remove = (key) => ({ type: "remove", key });
```

IDs are stringified in keys (matching hyperspace's `vendor.id.toString()`); tanstack matches
by prefix, so `invalidate(["fund", "3"])` also catches `["fund", "3", ...]` subkeys the webapp
may hang off it. List keys are invalidated on every write to that resource; single keys are
invalidated on update and `remove`d on delete.

### 0.4 Model layer: `static count(db, filters)` for the paginated tables

The list endpoints for the big tables mirror hyperspace's `X-Total-Count` header, which needs
a count query. Per the SQL-locality convention this SQL lives in the models: extract each
model's `from_db` WHERE-building into a private `_from_db_wheres(filters)` returning
`{ wheres, params, keys }`, used by both `from_db` and a new `count`:

- `TransactionGroup.count` (no JOIN needed — its wheres only touch `transaction_groups` plus
  the EXISTS subquery)
- `Transaction.count`
- `BankStatementItem.count`
- `FundFinalization.count`

Deliberately skipped for `funds`, `users`, `user_sessions`, `month_finalizations`: these tables
are small (a personal-finance fund tree, a handful of users), the endpoints just use a generous
default limit, and `count` is a mechanical follow-up if ever needed. Model unit tests for each
new `count` go in the existing `test/models/test-*.js` files.

---

## Conventions applied to every collection below

- **Paths**: hyperspace style (per review) — the prefix names the logical area, and inside it
  lists/creates are plural while single-resource routes are singular + id:
  `GET /api/funds/funds`, `GET /api/funds/fund/:fund_id`. The plural/singular split also means
  literal segments never collide with param routes (`/month-finalizations/latest` vs
  `/month-finalization/:id` live under different literals), so controller ordering is never
  load-bearing — except `/me` routes, which use their own `/me...` literal prefix.
- **Roles**: reads = `reader` (the default), writes = `editor: true`, user management =
  `admin: true` (which per the local Controller means X-Sudo-Mode). `/me` endpoints use
  `reader = false` (any authed user).
- **List endpoints**: expose exactly the model's `from_db` filters as query params (coercive
  `to_*`/`to_ydate` parsers, invalid values fall back to "filter not applied" — same as
  hyperspace), plus `order_by` (whitelist matching the model's `ORDER_BY_MAP`, handled with an
  explicit switch, same SQL-injection warning comments), `order_direction` (`only_direction`),
  `limit`, `offset`. Where a `count` static exists, respond sets `X-Total-Count` and declares
  `openapi_ResponseHeaders`.
- **Single endpoints**: `to_int(req.params.x)` then `assert_found(Model.for_id(...))`.
- **Bodies**: validated with `parse_body_fields` + strict parsers; write model calls wrapped
  with `translate_model_error`. USER transaction amounts are checked `> 0` at this layer
  (models permit zero for internal eom_cleanup rows).
- **Write responses**: `{ data, invalidations }` (`data: null` for deletes), broadcast via
  `this.broadcast_invalidations(actions, meta)`, documented with the existing shared schemas
  (`InvalidationArraySchema`, `NullSchema`, `BadParameterResponseSchema`,
  `NotFoundResponseSchema`, `ConflictResponseSchema` from `lib/openapi.js`).
- **OpenAPI**: every controller gets `openapi_Summary`/`Description`/`Parameters`/
  `RequestBodySchema`/`ResponseSchema`/`ErrorResponses`, `$ref`-ing the model schemas already
  registered by `lib/openapi.js` (`FundSchema`, `TransactionGroupSchema`, etc.). Dates are
  `{ type: 'string', format: 'date' }`.

---

## Phase 1 — Funds (`collections/Funds.js`, prefix `/api/funds`, tag `Funds`)

Establishes the template; everything later copies it.

| Method | Path | Role | query_key | Model call |
|---|---|---|---|---|
| GET | `/` | reader | `["funds"]` | `Fund.from_db` (filters: `id`, `ids` (csv via `string_to_array`+`parse_and_filter_array`), `name`, `name_like`, `started_since/until`, `tracked`, `monthly`, `pool`, `root`, `descendant_of` (self-inclusive subtree; malformed → 400); order: `id`) |
| GET | `/:fund_id` | reader | `["fund", id]` | `Fund.for_id` |
| GET | `/:fund_id/balance` | reader | `["fund-balance", id]` | `?on=YYYY-MM-DD` → `calculate_balance_on`, else `calculate_balance`. Response `{ fund_id, on: date\|null, balance }`. 400 when `on` predates `start_date` (the model throws a plain Error — `translate_model_error` applies). Untracked funds return balance 0 (model behavior) — document it |
| GET | `/balances` | reader | `["fund-balance", "all"]` | Bulk companion (added 2026-07-07): every tracked fund's balance as `[{ fund_id, on, balance }]`; funds starting after `?on=` are omitted, untracked funds excluded; unpaginated |
| POST | `/` | editor | — | `Fund.create` — body: `name` (required, `only_non_empty_string`), `tracked` (required, `only_boolean`), `parent_id` (`nullable(only_id)`), `start_date` (`nullable(only_ydate)`), `start_balance` (strict number), `monthly`, `pool` (`only_boolean`), `color` (`nullable(only_non_empty_string)`) |
| PATCH | `/:fund_id` | editor | — | `fund.update` (same fields; all optional) |
| DELETE | `/:fund_id` | editor | — | `fund.delete` — 409 (ConflictError) while finalizations exist |

Invalidations:
- POST: `invalidate(QK.funds)` + `invalidate(QK.fund_finalizations)` (creation can backfill
  fund_finalizations when `start_date` falls in finalized months)
- PATCH: `invalidate(QK.funds)`, `invalidate(QK.fund(id))`, and — because hierarchy/pool edits
  can repoint allocation sources (`Fund._rederive_allocation_sources`) — `QK.allocations`,
  `QK.transactions`, `QK.transaction_groups`, `["fund-balance"]` (all). Overly generous by
  design, like hyperspace's vendor→acquisition-method note.
- DELETE: `invalidate(QK.funds)`, `remove(QK.fund(id))`, plus the same generous set.

Tests: `test/api/test-funds.js` (harness copied from `test/api/test-utils.js`: real Webserver
on port 0, in-memory db, minted tokens for a reader-only user and an editor user; assert 401
unauthenticated, 403 reader-on-write, happy paths, 400 bad params, 404, 409 finalized-fund
delete, invalidations arrays present).

## Phase 2 — Transaction groups & transactions (`collections/Transactions.js`)

Two prefixes worth of routes, one file (they share helpers); implemented as two Collections
exported as an array is NOT supported by `collections/index.js`'s shape, so: two files —
`collections/TransactionGroups.js` (prefix `/api/transaction-groups`, tag `Transaction Groups`)
and `collections/Transactions.js` (prefix `/api/transactions`, tag `Transactions`).

`/api/transaction-groups`:

| Method | Path | Role | query_key | Model call |
|---|---|---|---|---|
| GET | `/` | reader | `["transaction-groups"]` | `TransactionGroup.from_db` (filters: `since`, `until`, `split`, `allocation`, `eom_cleanup`, `has_statements`, `description_like`; order: `id`/`date`) + `count` → `X-Total-Count` |
| GET | `/:group_id` | reader | `["transaction-group", id]` | `for_id` |
| POST | `/` | editor | — | `TransactionGroup.create` — body: `date` (required, ydate), `description` (required), `note` (nullable), `transactions` (required non-empty array; each element validated with `parse_body_fields`: `source_fund_id`/`target_fund_id`/`amount` required — amount strictly positive here, API-layer rule — `description` required, `note` nullable). `allocation`/`eom_cleanup` are NOT accepted fields at all |
| POST | `/from-statements` | editor | — | `TransactionGroup.create_from_statements` — body: `statement_ids` (required array of ids, 1 normally, 2 for a transfer), `date`/`description`/`note` (optional — model derives defaults from the items), `transactions` (required, as above). 400 dup/unknown ids (FK), 409 item ignored/already reconciled |
| DELETE | `/:group_id` | editor | — | `group.delete` — plus an API-layer guard **before** the model call: 409 if `group.allocation` ("manage via /api/allocations") — eom_cleanup groups are inherently protected by the finalized-month check. 409 finalized month |

~~No PATCH in v1: `TransactionGroup#update` is still a model-layer TODO (delete + recreate is
the documented workflow). Add the endpoint when the model lands.~~ Superseded (2026-07-07):
the group-scalar PATCH, the line-editor PATCH, and the single-transaction PATCH all landed —
see "Since implemented" above and `Transaction_Update_Implementation_Plan.md`.

`/api/transactions` (read-only — all writes go through groups):

| Method | Path | Role | query_key | Model call |
|---|---|---|---|---|
| GET | `/` | reader | `["transactions"]` | `Transaction.from_db` (filters: `source_fund_id`, `target_fund_id`, `involving_fund_id`, `group_id`, `since`, `until`, `allocation`, `description_like`; order: `id`/`date`) + `count` → `X-Total-Count` |
| GET | `/:transaction_id` | reader | `["transaction", id]` | `for_id` |

Invalidations (both POSTs and DELETE): `QK.transaction_groups`, `QK.transactions`,
`["fund-balance"]`; DELETE also `remove(QK.transaction_group(id))`; the statement variants also
`QK.statements` (linking/releasing items changes their state).

Tests: `test/api/test-transaction-groups.js`, `test/api/test-transactions.js`.

## Phase 3 — Bank statement items (`collections/Statements.js`, prefix `/api/statements`, tag `Bank Statements`)

| Method | Path | Role | query_key | Model call |
|---|---|---|---|---|
| GET | `/` | reader | `["statements"]` | `BankStatementItem.from_db` (filters: `source`, `since`, `until`, `ignored`, `has_group`, `group_id`; plus API-layer sugar `state=pending\|ignored\|reconciled` that expands to `ignored`/`has_group` combos; order: `id`/`date`) + `count` → `X-Total-Count` |
| GET | `/:statement_id` | reader | `["statement", id]` | `for_id` |
| POST | `/import` | editor | — | `BankStatementItem.import_many` — body `{ items: [{ source, key, amount (signed number, only strict number — zero/negative legal), date, note? }] }` (each element via `parse_body_fields`); response data `{ created: [...to_api], skipped: [{source,key}] }`. Idempotent by design |
| PATCH | `/:statement_id` | editor | — | `item.update` — body: `ignored` (`only_boolean`), `note` (nullable string). 409 ignoring a reconciled item |
| DELETE | `/:statement_id` | editor | — | `TransactionGroup.delete_statement_item(db, item, { with_group })` — `with_group` query param via `string_to_boolean`, default true. OpenAPI description carries the model's re-import/double-count hazard warning verbatim. 409 finalized month (with_group arm) |

Invalidations: import → `QK.statements`; PATCH → `QK.statements`, `QK.statement(id)`;
DELETE → `QK.statements`, `remove(QK.statement(id))`, and when a group was destroyed also
`QK.transaction_groups`, `QK.transactions`, `["fund-balance"]`.

Tests: `test/api/test-statements.js` (including: re-import skips, ignore-reconciled 409,
delete releases the transfer peer to pending).

## Phase 4 — Allocations (`collections/Allocations.js`, prefix `/api/allocations`, tag `Allocations`)

No table, no ids — `(fund_id, month)` addresses an allocation, so the surface is verbs on the
collection root rather than `/:id` routes.

| Method | Path | Role | query_key | Model call |
|---|---|---|---|---|
| GET | `/` | reader | `["allocations"]` | Two modes, exactly one required: `?month=YYYY-MM-DD` → `Allocation.for_month`; `?fund_id=N[&since&until]` → `Allocation.for_fund`. 400 when neither/both given. (Webapp hangs params off the key itself: `["allocations", { month }]` — invalidating the `["allocations"]` prefix catches all of them) |
| PUT | `/` | editor | — | `Allocation.set` — body: `month` (required ydate — any day within the month), `fund_id` (required id), `amount` (required strictly positive). Upsert semantics = PUT. 400 model consistency errors (untracked target, started mid-month, no started pool ancestor), 409 finalized month |
| DELETE | `/` | editor | — | `Allocation.remove` — body: `month`, `fund_id` (both required). 404 when no such allocation (model ConflictError/plain-Error mapped appropriately — check the model's throw and map "no allocation" to 404 explicitly) |
| POST | `/copy` | editor | — | `Allocation.copy_month` — body: `from`, `to` (required ydates), `on_conflict` (`string_to_enum` of `error\|merge\|overwrite`, default `error`). 409 on conflict-mode `error` collisions or finalized target month |

Invalidations (all writes): `QK.allocations`, `QK.transaction_groups`, `QK.transactions`,
`["fund-balance"]`.

Tests: `test/api/test-allocations.js`.

## Phase 5 — Finalizations (`collections/Finalizations.js`, prefix `/api/finalizations`, tag `Finalizations`)

Month finalizations and fund finalizations share the prefix as subresources.

| Method | Path | Role | query_key | Model call |
|---|---|---|---|---|
| GET | `/months` | reader | `["month-finalizations"]` | `MonthFinalization.from_db` (`since`, `until` on som_date; order: `id`/`som_date`) |
| GET | `/months/latest` | reader | `["month-finalizations", "latest"]` | `MonthFinalization.latest` — data is the finalization or `null` (200 either way: "nothing finalized yet" is a normal state, not a 404). **Registered before `/months/:id`** |
| GET | `/months/:month_finalization_id` | reader | `["month-finalization", id]` | `for_id` |
| POST | `/months` | editor | — | `MonthFinalization.create` — body: `month` (required ydate, any day in month), `recursive` (`only_boolean`, default false). 409 already-finalized / non-contiguous without recursive |
| DELETE | `/months/:month_finalization_id` | editor | — | `month.unfinalize` — 409 unless it is the latest (LIFO) |
| GET | `/funds` | reader | `["fund-finalizations"]` | `FundFinalization.from_db` (`fund_id`, `month_id`, `since`, `until` on sonm_date; order: `id`/`sonm_date`) + `count` → `X-Total-Count`. This is also the "fund finalization history" endpoint (`?fund_id=`) — no separate `/api/funds/:id/finalizations` route, one canonical query |
| GET | `/funds/:fund_finalization_id` | reader | `["fund-finalization", id]` | `for_id` |

Invalidations (POST and DELETE — finalization touches nearly everything): 
`QK.month_finalizations`, `QK.fund_finalizations`, `QK.funds` (cache points repoint), `["fund"]`
(all singles), `["fund-balance"]`, `QK.transaction_groups`, `QK.transactions` (eom_cleanup
groups appear/disappear), `QK.allocations` (mutability boundary moves).

Tests: `test/api/test-finalizations.js` (contiguity 409, recursive, LIFO unfinalize 409,
latest-null case).

## Phase 6 — Users & sessions (`collections/Users.js`, prefix `/api/users`, tag `Users`)

Admin-gated management plus `/me` self-service. **Route order: all `/me...` controllers before
any `/:user_id...` controller.** Note in every admin-write description: outstanding access
tokens keep their old roles for up to ~1h (accepted staleness window).

| Method | Path | Role | query_key | Model call |
|---|---|---|---|---|
| GET | `/me` | authed (`reader=false`) | `["me"]` | `User.for_id(req.access.user_id)` (fresh, not the token payload) |
| POST | `/me/password` | authed | — | body: `current_password`, `password` (required), `revoke_other_sessions` (`only_boolean`, default true). Flow: `user.verify_password(current_password)` — on failure `penalize()` + uniform 400 — then `set_password`, then optionally `Session.revoke_all` minus... v1: revoke_all (the current session dies too; the response says so and the webapp re-logs-in). Keep it simple and safe |
| GET | `/me/sessions` | authed | `["me", "sessions"]` | `Session.from_db({ user_id: self, active })` (`active` via `string_to_boolean`, default true) |
| DELETE | `/me/sessions/:session_id` | authed | — | `Session.for_id` → 404; 404 (not 403 — don't leak existence) when `session.user_id !== req.access.user_id`; `session.delete` |
| GET | `/` | admin | `["users"]` | `User.from_db` (filters `admin`, `reader`, `editor` — effective-role semantics documented; order: `id`/`email`/`created_at`) |
| GET | `/:user_id` | admin | `["user", id]` | `for_id` |
| GET | `/:user_id/sessions` | admin | `["user", id, "sessions"]` | `Session.from_db({ user_id, active })` |
| POST | `/` | admin | — | `await User.create` — body: `email` (required), `password` (required), `admin`/`reader`/`editor` (`only_boolean`). 409 duplicate email (ConflictError), 400 short password/bad email (plain Error) |
| PATCH | `/:user_id` | admin | — | `user.update` — `email`, `admin`, `reader`, `editor` |
| POST | `/:user_id/password` | admin | — | `await user.set_password(password)`; body `revoke_sessions` (default true) → `Session.revoke_all` (API-layer policy, per the model docs) |
| DELETE | `/:user_id` | admin | — | `user.delete` (sessions cascade). Refuse self-delete (400 "use another admin") to keep the footgun small; no last-admin guard by design (matches model) |

Invalidations: writes → `QK.users`, `QK.user(id)` (+`remove` on delete); self/password/session
writes → `QK.me`, `QK.me_sessions`; admin session-affecting writes → `["user", id, "sessions"]`.
When an admin edits the *calling* user, also `QK.me`.

Tests: `test/api/test-users.js` (X-Sudo-Mode required on admin routes, /me without roles,
ownership 404 on foreign session delete, penalized uniform 400 on wrong current_password,
password-change revocation behavior).

## Phase 7 — Registration, docs, polish

1. `collections/index.js`: append Funds, TransactionGroups, Transactions, Statements,
   Allocations, Finalizations, Users.
2. `npm test` green across `test/models` (count additions) and `test/api`.
3. Update `CLAUDE.md` API-layer section: list the new collections/prefixes, the
   `parse_body_fields`/`assert_found`/`translate_model_error` helpers, the query-key registry
   (`collections/lib/query_keys.js`), and the strict-body / coercive-query parser split.
4. Sanity-pass `/api-docs`: every route documented, no schema $ref typos (swagger-ui renders
   or it doesn't).

---

## Query-key summary (the webapp contract)

| Key | Meaning | Invalidated by |
|---|---|---|
| `["versions"]` | existing Utils endpoint | (socket reconnect, already planned) |
| `["funds"]` / `["fund", id]` | fund list / single | fund writes; finalize/unfinalize (cache repoints) |
| `["fund-balance", id]` | computed balances (prefix-invalidated as a whole) | any transaction-affecting write: group create/delete, allocations, statement delete w/ group, finalize/unfinalize, fund hierarchy edits |
| `["transaction-groups"]` / `["transaction-group", id]` | group list / single | group writes, allocations, statement deletes, finalize/unfinalize |
| `["transactions"]` / `["transaction", id]` | flat transaction list / single | same as groups |
| `["statements"]` / `["statement", id]` | bank statement items | import, item patch/delete, reconcile (from-statements), group delete |
| `["allocations"]` | allocation views (webapp appends `{month}`/`{fund_id}` params) | allocation writes, fund hierarchy edits, finalize/unfinalize |
| `["month-finalizations"]` (+`"latest"`) / `["month-finalization", id]` | finalized months | finalize/unfinalize |
| `["fund-finalizations"]` / `["fund-finalization", id]` | per-fund history | finalize/unfinalize, fund create (backfill) |
| `["users"]` / `["user", id]` (+ `["user", id, "sessions"]`) | admin views | user/session admin writes |
| `["me"]` / `["me", "sessions"]` | self views | self writes, admin edits of self |

Guiding rules: list key = plural resource name; single = singular + stringified id; computed
subresources get their own top-level key (`fund-balance`) so hot invalidation (every
transaction write) doesn't force refetching cold data (fund objects); when in doubt,
over-invalidate (hyperspace's documented stance).

## Suggested commit sequence

One commit per phase (helpers; funds; groups+transactions; statements; allocations;
finalizations; users; registration/docs), each with its tests — mirrors how Auth/Utils landed.
