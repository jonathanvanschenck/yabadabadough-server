# Production stack: app + nginx + Let's Encrypt

A complete deployment you can copy: the Yabadaba Dough server behind nginx,
with TLS certificates that issue and renew themselves.

```
internet ──443──> nginx ──8383──> server ──> /app/data/db.sqlite
                    │                        /app/keys/*.pem
                    └── certbot (renews every 12h, nginx reloads every 6h)
```

Only nginx publishes ports. The app listens on the internal compose network
only, so it never receives a plaintext request from the internet and needs no
TLS configuration of its own.

## Prerequisites

- A host with Docker and the compose plugin, ports **80 and 443** reachable.
- A domain whose A/AAAA record **already points at this host**. Let's Encrypt
  validates by making an http request back to you; DNS must resolve first.

## Setup

```bash
cp .env.example .env
$EDITOR .env                 # DOMAIN, LETSENCRYPT_EMAIL

./init-letsencrypt.sh        # one-time: issue the first certificate
docker compose up -d

docker compose exec server node scripts/create-user.js \
    you@example.com 'a-long-password' --admin --editor
```

Then open `https://your-domain`.

`init-letsencrypt.sh` exists to break a chicken-and-egg: nginx will not start
without certificate files, but certbot's http-01 challenge needs nginx already
serving. The script lays down a throwaway self-signed pair, starts nginx
against it, obtains the real certificate through the running nginx, then swaps
and reloads. Run it once.

> While you are still testing DNS, add `--staging` to the `certonly` call in
> the script. The production endpoint rate-limits failures hard (5 per hostname
> per hour) and a typo in `DOMAIN` burns attempts.

Renewal after that is automatic: the `certbot` service retries twice a day (a
no-op until the certificate is within 30 days of expiry) and nginx reloads
every 6 hours to pick up new files.

## What is in here

| File | Purpose |
| --- | --- |
| `docker-compose.yml` | The three services and their volumes. |
| `.env.example` | Domain and ACME email; compose interpolates these. |
| `init-letsencrypt.sh` | One-time certificate bootstrap. |
| `nginx/templates/default.conf.template` | Rendered with `envsubst` at nginx start, so `${DOMAIN}` is not hardcoded. |
| `nginx/snippets/ssl.conf` | TLS 1.2+, forward secrecy, OCSP stapling. |
| `nginx/snippets/proxy.conf` | Shared proxy headers. |

Two things in the nginx config are load-bearing and easy to break if you rewrite
it:

- **`/.well-known/acme-challenge/` stays on plain http and must not be
  redirected.** That path is how certbot proves domain control, at issuance and
  at every renewal. Redirect it and renewals fail silently until the
  certificate expires.
- **`/socket.io/` needs its own location block** with the `Upgrade`/`Connection`
  headers and a long read timeout. That is the cache-invalidation transport; if
  it fails the app still works, but clients stop noticing each other's changes
  until a manual refresh.

## Deploying a built image instead of building on the host

Building on the production host is fine for a personal deployment, but if you
would rather build elsewhere, replace the `build:` block in
`docker-compose.yml` with a pinned image:

```yaml
  server:
    image: your-registry/yabadabadough:1.0.0
```

Pin a real version rather than `latest`, so `docker compose up -d` is a
deliberate upgrade and not a surprise one.

## Operations

State lives in two named volumes, and they deserve different treatment:

- `ydd-data` — the SQLite database. This is the entire application state. WAL
  mode means you should take a real backup rather than copying the file:

  ```bash
  docker compose exec server \
      node -e "require('better-sqlite3')('/app/data/db.sqlite').backup('/app/data/backup.sqlite')"
  docker compose cp server:/app/data/backup.sqlite ./backup-$(date +%F).sqlite
  ```

- `ydd-keys` — the JWT signing keys, generated on first start. Losing them logs
  everyone out and nothing worse; leaking them lets anyone mint valid tokens.
  Back them up separately, with tighter access than the database.

Other routine commands:

```bash
docker compose logs -f server                              # tail logs
docker compose exec server node scripts/create-user.js \
    them@example.com 'password' --editor                   # add a user
docker compose exec server node scripts/create-user.js \
    them@example.com 'new-password' --set-password         # reset a password
docker compose exec server node scripts/generate-jwt-key.js /app/keys  # rotate keys
docker compose up -d --build                               # upgrade
```

## Hardening worth considering

This stack is a sound baseline for a personal deployment. Beyond it:

- Put the whole thing behind a VPN or an IP allowlist if it does not need to be
  on the public internet. It is your complete financial history.
- The `Strict-Transport-Security` header in the nginx template commits browsers
  to https for a year and **cannot be retracted early**. Leave it on for a real
  deployment; drop it while you are still experimenting with the domain.
- Rate-limit `/api/auth/login` at the nginx layer (`limit_req_zone`). The app
  already delays failed credential checks by a second and never reveals which
  check failed, but a network-layer limit costs nothing.
- Ship logs somewhere off the host, so a compromised host cannot quietly erase
  the evidence.
