#!/bin/sh
#
# Container entrypoint: make sure the two pieces of persistent state exist
# before handing off to the real command (node index.js by default).
#
# Everything here is idempotent -- it runs on every container start, including
# restarts against already-populated volumes.

set -e

KEYS_DIR="${YDD_JWT_KEYS_DIR:-/app/keys}"
DB_PATH="${YDD_SQLITE_PATH:-/app/data/db.sqlite}"

# Mirror lib/db.js: absolute paths verbatim, relative ones against the app
# root, ":memory:" straight through (and needing no directory at all).
case "$DB_PATH" in
    ":memory:") DB_DIR="" ;;
    /*)         DB_DIR="$(dirname "$DB_PATH")" ;;
    *)          DB_DIR="$(dirname "/app/$DB_PATH")" ;;
esac

writable_or_die() {
    dir="$1"
    label="$2"
    if ! mkdir -p "$dir" 2>/dev/null || [ ! -w "$dir" ]; then
        echo "FATAL: $label ($dir) is not writable by uid $(id -u)." >&2
        echo "       If you bind-mounted a host directory, chown it: sudo chown -R 1000:1000 <host-dir>" >&2
        exit 1
    fi
}

[ -n "$DB_DIR" ] && writable_or_die "$DB_DIR" "database directory"
writable_or_die "$KEYS_DIR" "JWT keys directory"

# TokenManager.from_dir treats a missing/empty keys directory as a hard startup
# error, so bootstrap the first Ed25519 pair automatically. Rotation stays
# manual and deliberate (see README): re-running the generator adds a NEWER kid
# which then signs, while the old public half keeps verifying live tokens.
if [ -z "$(ls -A "$KEYS_DIR" 2>/dev/null)" ]; then
    echo "No JWT signing keys found in $KEYS_DIR -- generating an initial pair."
    echo "This directory is the root of all session auth: back it up, and do not"
    echo "let it be recreated empty (that invalidates every outstanding token)."
    node /app/scripts/generate-jwt-key.js "$KEYS_DIR"
fi

exec "$@"
