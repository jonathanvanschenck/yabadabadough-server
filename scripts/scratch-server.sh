#!/usr/bin/env bash
# Scratch dev server: a throwaway sqlite db + auth-disabled server for
# hand-testing webapp workflows against realistic data. Everything lives in
# scratch/ (gitignored): db, JWT keys, server log, pidfile. The real .env is
# never touched -- every setting is overridden on the command line (shell env
# wins over dotenv).
#
#   scripts/scratch-server.sh            # RESET: stop, wipe the db, start, seed
#   scripts/scratch-server.sh restart    # keep the db, just restart the server
#   scripts/scratch-server.sh stop
#   scripts/scratch-server.sh status
#
# Port defaults to 1234 (the project's documented dev URL); override with
# YDD_SCRATCH_PORT. Seed data comes from scripts/seed-scratch-db.js.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$ROOT/scratch"
PORT="${YDD_SCRATCH_PORT:-1234}"
URL="http://localhost:$PORT"
PIDFILE="$SCRATCH/server.pid"
LOG="$SCRATCH/server.log"
# Relative on purpose: create_connection resolves relative paths against the
# app root, so this works no matter where the script is invoked from.
DB_REL="scratch/dev.sqlite"

running_pid() {
    if [ -f "$PIDFILE" ]; then
        local pid
        pid="$(cat "$PIDFILE")"
        if kill -0 "$pid" 2>/dev/null; then
            echo "$pid"
            return 0
        fi
    fi
    return 1
}

stop_server() {
    local pid
    if pid="$(running_pid)"; then
        kill "$pid"
        for _ in $(seq 1 50); do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.1
        done
        echo "Stopped scratch server (pid $pid)"
    fi
    rm -f "$PIDFILE"
    # Belt and braces: if something is still listening on the port (e.g. an
    # orphaned server from a crashed run), kill that too -- otherwise the next
    # start dies with EADDRINUSE while the orphan keeps serving stale data.
    local port_pids
    port_pids="$(lsof -ti "tcp:$PORT" 2>/dev/null || true)"
    if [ -n "$port_pids" ]; then
        # shellcheck disable=SC2086
        kill $port_pids 2>/dev/null || true
        sleep 0.3
        echo "Killed orphaned listener(s) on port $PORT ($port_pids)"
    fi
}

start_server() {
    mkdir -p "$SCRATCH"
    if ! ls "$SCRATCH/keys/"*.private.pem >/dev/null 2>&1; then
        node "$ROOT/scripts/generate-jwt-key.js" "$SCRATCH/keys"
    fi

    # The & must background ONLY the node command (not a cd-&&-node chain), so
    # $! is node's real pid and stop_server kills the actual server.
    (
        cd "$ROOT"
        YDD_SQLITE_PATH="$DB_REL" \
        YDD_JWT_KEYS_DIR="$SCRATCH/keys" \
        YDD_SERVER_PORT="$PORT" \
        YDD_SECURE_COOKIES=false \
        YDD_DISABLE_AUTH=true \
        nohup node index.js >"$LOG" 2>&1 &
        echo $! >"$PIDFILE"
    )

    for _ in $(seq 1 50); do
        if curl -sf "$URL/api/utils/versions" >/dev/null 2>&1; then
            echo "Scratch server up at $URL (pid $(cat "$PIDFILE"), log: $LOG)"
            return 0
        fi
        sleep 0.1
    done
    echo "Scratch server failed to come up -- see $LOG" >&2
    exit 1
}

case "${1:-reset}" in
    reset)
        stop_server
        rm -f "$ROOT/$DB_REL" "$ROOT/$DB_REL-wal" "$ROOT/$DB_REL-shm"
        start_server
        YDD_SCRATCH_URL="$URL" node "$ROOT/scripts/seed-scratch-db.js"
        echo
        echo "Fresh scratch db seeded. Open $URL/statements (auth is disabled)."
        echo "Re-run 'scripts/scratch-server.sh' any time to reset to this exact state."
        ;;
    restart)
        stop_server
        start_server
        ;;
    stop)
        stop_server
        ;;
    status)
        if pid="$(running_pid)"; then
            echo "Running (pid $pid) at $URL"
        else
            echo "Not running"
        fi
        ;;
    *)
        echo "Usage: scripts/scratch-server.sh [reset|restart|stop|status]" >&2
        exit 1
        ;;
esac
