#!/bin/sh
#
# One-time TLS bootstrap for this stack. Run it once, before the first
# `docker compose up -d`; renewals afterwards are automatic (the certbot
# service retries twice a day and nginx reloads every 6h).
#
#   cp .env.example .env && $EDITOR .env
#   ./init-letsencrypt.sh
#
# The problem this solves: nginx refuses to start without the certificate
# files, but certbot's http-01 challenge needs nginx already serving. So we
# lay down a throwaway self-signed pair, start nginx against it, obtain the
# real certificate through the running nginx, then swap and reload.

set -eu

cd "$(dirname "$0")"

if [ ! -f .env ]; then
    echo "Missing .env -- copy .env.example and fill in DOMAIN / LETSENCRYPT_EMAIL." >&2
    exit 1
fi

# shellcheck disable=SC1091
. ./.env

: "${DOMAIN:?DOMAIN must be set in .env}"
: "${LETSENCRYPT_EMAIL:?LETSENCRYPT_EMAIL must be set in .env}"

compose() { docker compose "$@"; }

LIVE_DIR="/etc/letsencrypt/live/$DOMAIN"

if compose run --rm --entrypoint sh certbot -c "[ -f $LIVE_DIR/fullchain.pem ]" 2>/dev/null; then
    echo "A certificate for $DOMAIN already exists. Nothing to do."
    echo "(To force a reissue, delete the certbot-conf volume first.)"
    exit 0
fi

echo "==> Creating a temporary self-signed certificate for $DOMAIN"
compose run --rm --entrypoint sh certbot -c "
    mkdir -p '$LIVE_DIR' &&
    openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
        -keyout '$LIVE_DIR/privkey.pem' \
        -out '$LIVE_DIR/fullchain.pem' \
        -subj '/CN=$DOMAIN'
"

echo "==> Starting nginx so the ACME challenge can be served"
compose up -d nginx
# Give nginx a moment to bind :80 before certbot asks Let's Encrypt to call back.
sleep 5

echo "==> Removing the temporary certificate"
compose run --rm --entrypoint sh certbot -c "rm -rf '$LIVE_DIR' /etc/letsencrypt/archive/$DOMAIN /etc/letsencrypt/renewal/$DOMAIN.conf"

echo "==> Requesting the real certificate from Let's Encrypt"
# Add --staging while testing: the production endpoint rate-limits failures
# hard (5 per account/host per hour), and a typo'd DOMAIN burns attempts.
compose run --rm --entrypoint certbot certbot \
    certonly --webroot -w /var/www/certbot \
    -d "$DOMAIN" \
    --email "$LETSENCRYPT_EMAIL" \
    --agree-tos \
    --no-eff-email \
    --non-interactive

echo "==> Reloading nginx with the real certificate"
compose exec nginx nginx -s reload

echo
echo "Done. Bring the whole stack up with:  docker compose up -d"
echo "Then create your first admin user:"
echo "  docker compose exec server node scripts/create-user.js you@example.com 'a-long-password' --admin --editor"
