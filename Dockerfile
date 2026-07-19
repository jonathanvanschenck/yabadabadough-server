# syntax=docker/dockerfile:1
#
# Production image for the Yabadaba Dough server.
#
# Three stages so the runtime image carries neither compilers nor the webapp's
# (large) build toolchain:
#
#   server-deps -- npm ci --omit=dev, with build-essential present because
#                  better-sqlite3 compiles from source when no prebuilt binary
#                  matches the platform.
#   webapp      -- vite build -> webapp/dist, which the server serves statically.
#   runtime     -- node + the two artifacts above + the app source.
#
# Build:  docker build -t yabadabadough .
# Run:    see docker-compose.yml (dev) or examples/production/ (nginx + TLS).

ARG NODE_IMAGE=node:22-bookworm-slim


# ---------------------------------------------------------------- server deps
FROM ${NODE_IMAGE} AS server-deps

WORKDIR /app

# better-sqlite3 falls back to a source build (node-gyp) if it cannot find a
# prebuilt binary for this node/platform combination.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev


# --------------------------------------------------------------------- webapp
FROM ${NODE_IMAGE} AS webapp

WORKDIR /app

# The webapp reaches UP into the server tree at build time, so both of these
# must be in place before vite runs:
#   package.json -- vite.config.js imports it for __APP_VERSION__ (server and
#                   webapp deliberately share one version).
#   lib/, collections/lib/ -- the shim modules in src/hooks/ re-export the
#                   server's ESM registries (lib/fund_colors.mjs,
#                   lib/provisional.mjs, collections/lib/query_keys.mjs) so the
#                   keys and rules the two sides use cannot drift.
COPY package.json ./
COPY lib/ ./lib/
COPY collections/lib/ ./collections/lib/

WORKDIR /app/webapp
COPY webapp/package.json webapp/package-lock.json ./
RUN npm ci

COPY webapp/ ./
RUN npm run build


# -------------------------------------------------------------------- runtime
FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production

# tini reaps zombies and forwards SIGTERM/SIGINT, which index.js handles for a
# graceful shutdown (drain sockets, close the server).
RUN apt-get update \
    && apt-get install -y --no-install-recommends tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=server-deps /app/node_modules ./node_modules
COPY --from=webapp /app/webapp/dist ./webapp/dist

COPY package.json index.js env.js ./
COPY lib/ ./lib/
COPY models/ ./models/
COPY collections/ ./collections/
COPY db/migrations/ ./db/migrations/
COPY scripts/ ./scripts/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Mount points for the two pieces of state. Created here (and owned by `node`)
# so a NAMED volume inherits the ownership; a BIND mount keeps the host's
# ownership instead and must be chown'd to uid 1000 on the host -- see README.
RUN mkdir -p /app/data /app/keys && chown -R node:node /app/data /app/keys

# NOTE ON YDD_SQLITE_PATH: lib/db.js resolves it with join(__dirname, "..", path),
# so the value is ALWAYS interpreted relative to /app -- an absolute path like
# /data/db.sqlite would land at /app/data/db.sqlite. Keep it relative.
ENV YDD_SQLITE_PATH=data/db.sqlite \
    YDD_JWT_KEYS_DIR=/app/keys \
    YDD_SERVER_ADDRESS=0.0.0.0 \
    YDD_SERVER_PORT=8383 \
    YDD_LOG_LEVEL=info \
    YDD_LOG_COLORIZED=false \
    YDD_SECURE_COOKIES=true

USER node

EXPOSE 8383

VOLUME ["/app/data", "/app/keys"]

# /api/auth/mode is the one unauthenticated GET on the API, so it works as a
# liveness probe regardless of auth configuration.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.YDD_SERVER_PORT||8383)+'/api/auth/mode').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["node", "index.js"]
