<div align="center">

<img src="webapp/public/svg/logo-badge.svg" alt="Yabadaba Dough" width="120" height="120">

# Yabadaba Dough

**Self-hosted personal finance, envelope budgeting generalized —<br>your funds, your ledger, your SQLite file.**

[![Node](https://img.shields.io/badge/Node-22.12%2B-5FA04E?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?logo=sqlite&logoColor=white)](https://www.sqlite.org/)
[![React](https://img.shields.io/badge/React-frontend-61DAFB?logo=react&logoColor=black)](https://react.dev/)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

[The ideas](#the-ideas) &nbsp;·&nbsp; [Running it](#running-it) &nbsp;·&nbsp; [Deploying](#deploying) &nbsp;·&nbsp; [Releases](#releases) &nbsp;·&nbsp; [API reference](#the-api)

</div>

---

A self-hosted personal finance server: a hierarchy of **funds**, a ledger of
**transactions** that move money between them, monthly **allocations** that
budget into them, and **bank statement** import so the ledger can be reconciled
against what the bank actually did.

Node.js + SQLite on the backend, React on the frontend, both served from one
process. There is no cloud service, no third-party bank aggregator, and no
telemetry — you run it, and the SQLite file is yours.

<a name="the-api"></a>The API is documented as you run it: Swagger UI at
`/api-docs`, the raw OpenAPI spec at `/api-docs.json`.

---

## The ideas

The model is *envelope budgeting*, generalized. Money does not sit in
"accounts" that mirror your bank; it sits in **funds** you define, arranged in a
tree, and every movement is an explicit transfer from one fund to another.

### Funds

A fund is a named bucket. Funds nest via a parent link, so you can group them
however you think about your money (`Savings > Travel > Japan 2027`). Four
properties do the real work:

**Tracked.** A tracked fund has a balance the server computes — it carries a
`start_date` and a `start_balance` and every transfer since. An untracked fund
is pure organization: a folder in the tree with no balance of its own. Use
untracked funds for headings, tracked funds for anything you want a number on.

**Monthly.** A monthly fund resets to zero at the end of every month. This is
the classic envelope: `Groceries` gets $600 each month, and whatever is left on
the 31st goes back where it came from rather than silently rolling over. Monthly
funds must be tracked and must live under a pool.

**Pool.** A pool is the source and sink for its descendants. Allocations into a
fund are drawn from the nearest pool *ancestor*, and when a monthly fund resets
its leftover flows back to that same pool. A pool is typically the thing that
corresponds to real money sitting in a real bank account — `Checking` as a pool,
with `Groceries`, `Gas`, and `Dining` as monthly funds beneath it. Pools are
tracked and never monthly.

**Deprecated.** Funds are closed, not deleted. Setting a fund's `deprecated`
date marks its last active day: no transaction may touch it after that, and the
webapp hides it from pickers and columns. Closing out is atomic — the
`deprecate` action drops future allocations, sweeps any remaining balance into a
fund you name, and then marks the date. Deprecation is bottom-up (children
first) and reversible: un-deprecate to edit the history again.

The distinction that trips people up first is **monthly vs. saving**. Both are
tracked funds under a pool. A monthly fund is money you intend to spend this
month and lose access to afterwards; a plain tracked fund accumulates
indefinitely. `Groceries` is monthly. `Car Repairs`, where you set aside $100 a
month for years against an eventual $2,000 bill, is not.

### Transactions and transaction groups

Every movement of money is a **transaction**: an amount, a source fund, and a
target fund. Transactions never exist alone — they belong to a **transaction
group**, which owns the date, the description, and the note.

The group exists so one real-world event can be one ledger entry even when it
touches several funds. A $140 supermarket run that was $110 of groceries and $30
of household supplies is one group, dated once, described once, holding two
transactions. That is what the "split" flag on a group means.

Group ids are **stable across edits**, which matters more than it sounds: a
bank statement line points at a group, so editing a group in place preserves the
reconciliation, while deleting and recreating it silently releases the bank line
back to pending and sets up a double-count on the next import. Edit; don't
delete and retype.

### Allocations

An **allocation** is a monthly budget line: "`Groceries` gets $600 in March".

Allocations are not a separate kind of record with its own semantics. Setting
one *immediately* creates a real transaction, dated the first of the month,
moving money from the fund's nearest pool ancestor into the fund. There is no
pending state and no second copy of the number — budgeting the money *is*
moving the money. All of a month's allocations share a single transaction group.

Two consequences worth internalizing:

- **The source is derived, never stored.** Move a fund to a different part of
  the tree and its allocations in unfinalized months follow the new pool.
  Finalized months keep their historical routing.
- **The ledger routinely holds future-dated money.** If you budget three months
  ahead, transactions exist for months that have not happened. This is why
  every balance query requires an explicit date — "the balance" with no date is
  not a question with a useful answer. See [Balances and dates](#balances-and-dates).

`copy_month` clones a whole month's allocations forward, which is the normal way
to start a new month.

### Bank statements

Bank statement items are imported lines from your bank: a source (which bank),
a dedupe key, a signed amount (negative = money left the account), a date, and
an optional note. Import is **idempotent** — items are deduped on
`(source, key)` and existing rows are never updated, so re-syncing the same
export repeatedly is safe and never clobbers work you have done.

Getting the data in is deliberately your problem: the API takes JSON, and how
you turn your bank's CSV into that is a script you write. There is no scraping
and no aggregator credentials.

Each item is always in exactly one of three states:

| State | Meaning |
| --- | --- |
| **pending** | Imported, not yet explained. The work queue. |
| **ignored** | Deliberately set aside. Still visible, never nags. |
| **reconciled** | Linked to a transaction group that explains it. |

Reconciling goes one of two ways: create a new group *from* the item (the
common case — the bank tells you what you spent, you say which funds it came
out of), or link the item to a group you already entered by hand. A transfer
between two of your own accounts shows up as two bank lines, one per account,
and both link to the *same* group — which is why the link lives on the
statement item rather than on the group.

Amounts are never checked against the group's transaction totals. Transfers and
splits make any simple rule wrong more often than right, so the judgement is
left to you.

> **Deleting statement items is for undoing bad imports, not for hiding
> things.** A deleted item takes its dedupe row with it, so it comes back as
> pending on the next sync — and reconciling it again double-counts. To make an
> item stop bothering you, mark it *ignored*.

### Month finalization

Finalizing a month closes the books on it. The server computes every tracked
fund's end-of-month balance, records it, and writes the cleanup transactions
that zero out each monthly fund into its pool. After that the month is
immutable: no transactions may be added in it or before it.

Months finalize **contiguously**, oldest first, and unfinalize strictly in
reverse. You finalize a *month*, never an individual fund — the whole point is a
consistent snapshot.

Finalization is reversible, so a premature one is not a disaster. The server
deliberately does not stop you from finalizing the current month: it has no
reliable notion of your timezone, and guessing would be worse than trusting you.

### Balances and dates

Two phrasings, and the difference is load-bearing:

- **Balance *on* date D** — includes transactions dated D. Always computed.
- **Forward balance *entering* date D** — excludes transactions dated D. This is
  what gets stored (a fund's starting balance, a finalization's snapshot).

Because allocations are dated the first of the month and can be budgeted well
ahead, an unbounded "sum everything" balance answers a question nobody asks.
Both balance endpoints therefore **require** an `on` date and 400 without one.
The server has no clock of its own here; the caller names the date.

**Provisional balances.** A balance is provisional when an earlier month is
still unfinalized — finalizing writes cleanup transactions dated that month's
last day, so the number can move without anyone touching it. A monthly fund
showing $120 on Jan 31 reads $0 the instant January finalizes. The balance
endpoints flag this as `provisional` and the webapp marks it, so a figure that
is about to change never looks settled.

### Users, roles, and API keys

Three roles: **reader** (default — everyone can read unless revoked), **editor**
(can write), and **admin** (user management; implies the others). Admin rights
are additionally masked unless a request carries an explicit `X-Sudo-Mode: true`
header, so an accidental admin call is not a thing that happens.

Logging in returns a short-lived access token (~20 min) and a session-bound
auth token (~1 week) used to refresh it; both are also set as httpOnly cookies,
which is how the webapp works. For scripts — your bank import, say — mint an
**API key** instead and exchange it for access tokens. API keys carry their own
reader/editor scope, can never mint admin, survive password changes, and are
revoked by deletion.

---

## Running it

### With Docker (recommended)

```bash
git clone <this-repo> && cd server
mkdir -p db/backup keys        # bind-mount targets, owned by you
docker compose up --build
```

Then open <http://localhost:8383>. A database with no accounts greets you with a
first-run setup form instead of a login form: fill it in and you have an
administrator and an active session. That's the whole install — no CLI step.

(The setup route closes itself the moment it succeeds. It only exists while the
database holds zero users, and every later call is a 409 whatever the
credentials, so it can hand out exactly one account. Later users come from the
Users page, or from `scripts/create-user.js` below.)

If you already run `node index.js` on the host, stop it first or change the
published port — both default to 8383 and the container will fail to bind.

The dev compose file bind-mounts the source tree, serves plain http (with
`YDD_SECURE_COOKIES=false`, or the browser would drop the cookies), and keeps
the database in `db/backup/` and signing keys in `keys/` — the same places a
non-Docker run uses. Backend edits need a `docker compose restart server`;
there is no watcher.

For the frontend loop, uncomment the `webapp/dist` mount in `docker-compose.yml`
and run `cd webapp && npm run build:dev:watch` on the host — **create the dist
first**, or Docker will mount an empty root-owned directory over it.

To skip login entirely while poking at the UI, set `YDD_DISABLE_AUTH=true`.

### Without Docker

Requires **Node 22.12+** (the codebase `require()`s ESM modules shared with the
webapp).

```bash
npm install
cd webapp && npm install && npm run build && cd ..

cp template.env .env            # then edit
node scripts/generate-jwt-key.js

node index.js
```

Then open the server and use the first-run setup form, exactly as with Docker.

To create accounts from the command line instead — the headless and
forgotten-password path — use `scripts/create-user.js`. Omitting the password
prompts for it (twice, with the echo off), which keeps it out of your shell
history:

```bash
node scripts/create-user.js you@example.com --admin --editor
node scripts/create-user.js you@example.com --set-password   # reset a password
```

Tests: `npm test` (Mocha + an in-memory database per test).

---

## Deploying

[`examples/production/`](examples/production/) is a complete, working stack —
the app behind nginx, with Let's Encrypt certificates that issue and renew
themselves. Read that directory's README; the short version is:

```bash
cd examples/production
cp .env.example .env            # set DOMAIN and LETSENCRYPT_EMAIL
./init-letsencrypt.sh           # one-time certificate issuance
docker compose up -d
```

Only nginx publishes ports; the app is reachable solely on the internal compose
network and never sees a plaintext request from the internet.

### Configuration

Read from the environment, with `.env` as a fallback for local runs (real
environment variables always win, so the container's config is not fighting a
stray `.env`).

| Variable | Default | Notes |
| --- | --- | --- |
| `YDD_SQLITE_PATH` | — | Required. Absolute paths are used as given; relative ones resolve against the app root, not the working directory. `:memory:` for an ephemeral database. |
| `YDD_JWT_KEYS_DIR` | `./keys` | Ed25519 signing keys. |
| `YDD_SERVER_ADDRESS` | `localhost` | `0.0.0.0` in a container. |
| `YDD_SERVER_PORT` | `1234` | The Docker images default to `8383`. |
| `YDD_SECURE_COOKIES` | `true` | Set `false` **only** for plain-http local dev. |
| `YDD_DISABLE_AUTH` | `false` | Bypasses every auth gate. Development only. |
| `YDD_LOG_LEVEL` | `debug` | `info` is a saner production choice. |
| `YDD_LOG_COLORIZED` | `true` | Set `false` to drop ANSI escapes — worth doing wherever logs are captured to a file or a log shipper rather than a terminal. |
| `YDD_LOG_VERBOSITY` | `full` | `full`, `short`, or `simple` — how much prefix each line carries. |
| `YDD_PROXY_ADDRESS`/`_PORT`/`_PROTOCOL` | — | Cosmetic: the public URL in the startup log. |

Booleans are read strictly: a variable counts as true only when it is exactly `true`, so a
typo fails closed rather than quietly switching something on.

### What to back up

Two things, with different risk profiles:

1. **The SQLite database.** This is the entire application state. It runs in WAL
   mode, so copy it with `sqlite3 <db> ".backup <dest>"` rather than `cp` —
   a raw copy can miss a live write-ahead log.

   ```bash
   docker compose exec server \
       node -e "require('better-sqlite3')('/app/data/db.sqlite').backup('/app/data/backup.sqlite')"
   ```

2. **The JWT keys directory.** Losing it logs everyone out and nothing more;
   *leaking* it lets anyone mint valid tokens. Back it up separately, with
   tighter permissions than the database.

### Rotating signing keys

Generating a new key pair *is* the rotation — the newest kid signs, and every
key still present verifies:

```bash
docker compose exec server node scripts/generate-jwt-key.js /app/keys
# wait out the longest token lifetime (~1 week), then delete the old pair
```

Deleting the old pair early just forces everyone to log in again.

### Upgrading

The schema version lives in the database (`PRAGMA user_version`) and migrations
run automatically at startup. Back up first anyway, then:

```bash
git pull
docker compose up -d --build
```

If you deploy the published image instead of building from source, bump the
pinned tag in your compose file and pull:

```bash
docker compose pull && docker compose up -d
```

The webapp polls `/api/utils/versions` and prompts users to reload when the
server version changes, so a deploy does not leave stale frontends running
against a new API.

---

## Releases

Container images are published to the GitHub Container Registry at
[`ghcr.io/jonathanvanschenck/yabadabadough-server`](https://github.com/jonathanvanschenck/yabadabadough-server/pkgs/container/yabadabadough-server),
built and pushed by GitHub Actions whenever a version tag is pushed.

```bash
docker pull ghcr.io/jonathanvanschenck/yabadabadough-server:1.0.0
```

Each release publishes three tags: the exact version (`1.2.0`), the
major.minor line (`1.2`, which advances with patch releases), and `latest`
(the newest non-prerelease). Pin the exact version in production — see
[`examples/production/`](examples/production/) — so upgrades are deliberate.
Images are multi-arch (`linux/amd64` and `linux/arm64`).

### Cutting a release (maintainers)

The root `package.json` `version` is the single source of truth: the server
reports it at `/api/utils/versions`, the webapp bakes it in at build time, and
the release workflow **refuses to publish if the git tag disagrees with it**,
so the image tag and the version the running app reports can never drift. A
release is therefore just: bump that version, tag it, push the tag.

```bash
# on a branch
npm version minor          # 1.0.0 -> 1.1.0: edits package.json, commits, tags v1.1.0
git push origin HEAD        # open a PR; CI (tests + image build) must pass
# merge the PR into master, then:
git push origin v1.1.0      # the tag push triggers the release workflow
```

`npm version {patch|minor|major}` picks the bump. Two workflows back this:

- [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — on every pull
  request and push to master: runs the test suite and builds the image without
  pushing. Mark its jobs **required** in the master branch protection rule so
  nothing merges red.
- [`.github/workflows/release.yml`](.github/workflows/release.yml) — on a `v*`
  tag: re-runs the tests, verifies the tag matches `package.json`, then builds
  and pushes the multi-arch image to GHCR.

> The published package starts **private** — make it public in the repo's
> *Packages* settings, or give your deploy host a read token, before pulling
> from another machine. Actions pushes with the built-in `GITHUB_TOKEN`, so
> there is no registry secret to configure.

---

## Layout

```
index.js            entrypoint: db, keys, webserver, signal handling
env.js              environment -> config
lib/                db, YDate, TokenManager, Webserver, shared registries
models/             one file per table; owns all SQL against that table
collections/        HTTP API, one file per resource area
db/migrations/      schema
scripts/            bootstrap CLIs (users, JWT keys)
test/               mocha; models/ and api/
webapp/             React frontend, built to webapp/dist and served by the server
examples/           deployment examples
```

`CLAUDE.md` documents the internal conventions in considerably more depth than
this README, and is the right thing to read before changing code.
