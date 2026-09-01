#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/home/adncapital/app/adnzalo-scan-backend}"
NGINX_CONF="${NGINX_CONF:-/etc/nginx/sites-available/adncapital}"
NGINX_SNIPPET="${NGINX_SNIPPET:-/etc/nginx/snippets/adnzalo-scan.conf}"
SERVICE_NAME="adnzalo-scan-backend.service"

cd "$APP_DIR"

[[ -f .env ]] || { echo '[adnzalo-deploy][ABORT] Missing .env' >&2; exit 1; }
id -u adnzalo-scan >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin adnzalo-scan

npm ci --omit=dev
install -o root -g root -m 0644 "$APP_DIR/$SERVICE_NAME" "/etc/systemd/system/$SERVICE_NAME"
install -d -m 0755 /etc/nginx/snippets
install -o root -g root -m 0644 "$APP_DIR/adnzalo-scan.nginx" "$NGINX_SNIPPET"

chown -R adnzalo-scan:adnzalo-scan "$APP_DIR"
chmod 600 "$APP_DIR/.env"
systemctl daemon-reload
systemctl enable "$SERVICE_NAME" >/dev/null
systemctl restart "$SERVICE_NAME"

sleep 2
systemctl is-active --quiet "$SERVICE_NAME"
curl -fsS --max-time 10 http://127.0.0.1:3100/api/health >/dev/null

backup="${NGINX_CONF}.pre-adnzalo.$(date +%Y%m%d%H%M%S)"
cp -a "$NGINX_CONF" "$backup"
if ! grep -Fq 'include /etc/nginx/snippets/adnzalo-scan.conf;' "$NGINX_CONF"; then
  tmp="$(mktemp "${NGINX_CONF}.tmp.XXXXXX")"
  awk '
    /^[[:space:]]*listen 443 ssl;/ && !inserted {
      print "    include /etc/nginx/snippets/adnzalo-scan.conf;"
      inserted = 1
    }
    { print }
    END {
      if (!inserted) exit 2
    }
  ' "$NGINX_CONF" > "$tmp"
  chown --reference="$NGINX_CONF" "$tmp"
  chmod --reference="$NGINX_CONF" "$tmp"
  mv "$tmp" "$NGINX_CONF"
fi

if ! nginx -t; then
  cp -a "$backup" "$NGINX_CONF"
  nginx -t
  echo "[adnzalo-deploy][ABORT] nginx validation failed; restored $backup" >&2
  exit 1
fi
systemctl reload nginx

echo "[adnzalo-deploy] service=$(systemctl is-active "$SERVICE_NAME")"
echo "[adnzalo-deploy] nginx=validated-and-reloaded"
echo "[adnzalo-deploy] backup=$backup"
echo '[adnzalo-deploy] done'
