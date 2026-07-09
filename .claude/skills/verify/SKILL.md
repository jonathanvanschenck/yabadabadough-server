---
name: verify
description: Launch this server against a scratch db and drive the HTTP API to verify changes end-to-end.
---

# Verifying yabadabadough/server changes

The surface is the HTTP API (plus socket.io on the same port). Run the REAL server
(`index.js`) against a scratch db and drive it with curl — don't rely on `npm test` for
verification.

## Launch recipe

`.env` points at the real db (`YDD_SQLITE_PATH`), but shell env vars win over dotenv, so
override everything on the command line. Gotcha: `create_connection` joins relative db paths
to the repo root, and absolute paths mis-join — compute a RELATIVE path to your scratch dir.

```bash
SCRATCH=<scratchpad>/verify && mkdir -p $SCRATCH
node scripts/generate-jwt-key.js $SCRATCH/keys
REL=$(realpath --relative-to=. $SCRATCH/verify.sqlite)

# Bootstrap users (same env; the script auto-initializes the schema)
YDD_SQLITE_PATH="$REL" YDD_JWT_KEYS_DIR=$SCRATCH/keys \
    node scripts/create-user.js editor@example.com hunter22hunter22 --editor
YDD_SQLITE_PATH="$REL" YDD_JWT_KEYS_DIR=$SCRATCH/keys \
    node scripts/create-user.js admin@example.com hunter22hunter22 --admin

# Run in background; port default is 1234, pick a free one
YDD_SQLITE_PATH="$REL" YDD_JWT_KEYS_DIR=$SCRATCH/keys \
    YDD_SERVER_PORT=43210 YDD_SECURE_COOKIES=false node index.js
```

Up when `curl http://localhost:43210/api/utils/versions` returns 401 (auth live).

## Driving it

```bash
B=http://localhost:43210
ACCESS=$(curl -s -X POST $B/api/auth/login -H 'content-type: application/json' \
    -d '{"email":"editor@example.com","password":"hunter22hunter22"}' | jq -r .tokens.access)
curl -s $B/api/funds/funds -H "authorization: Bearer $ACCESS"
```

- Admin routes need BOTH an admin token and `-H 'x-sudo-mode: true'`.
- Credential failures are uniform 400s with a real `penalty_ms` of 1000 — a slow auth
  failure is the penalty working, not a hang.
- Decode a JWT payload with `echo $TOKEN | cut -d. -f2 | base64 -d | jq .`.
- Swagger spec sanity: `curl -s $B/api-docs.json | jq '.paths | keys'`.
- socket.io handshake (polling probe): `curl "$B/socket.io/?EIO=4&transport=polling" -H
  "cookie: access_token=$ACCESS"` — note unauthed handshakes ALSO return 200 at the HTTP
  layer (the slow-fail disconnect happens after penalty_ms), so a 200 alone doesn't prove
  auth.

Kill with `pkill -f "node index.js"` (exit 144 is normal for the killed process).

## Flows worth driving

Login → mint (whatever the change touches) → use → revoke/negative probes. API keys:
`POST /api/users/me/api-keys` → `POST /api/auth/api-token` → use the minted bearer token.
