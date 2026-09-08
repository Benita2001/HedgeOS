#!/bin/bash
# Deploys HedgeOS (paper mode only) to the configured VPS. Idempotent: safe
# to re-run. Never touches Hermes, firecrawl, ufw, or any file outside
# /opt/hedgeos and /etc/systemd/system/hedgeos-*.
set -euo pipefail

HOST="${HEDGEOS_DEPLOY_HOST:?set HEDGEOS_DEPLOY_HOST, e.g. root@203.0.113.10}"
REMOTE_APP_DIR="/opt/hedgeos/app"

echo "==> Ensuring dedicated unprivileged system user 'hedgeos' exists"
ssh "$HOST" "id -u hedgeos >/dev/null 2>&1 || useradd --system --home /opt/hedgeos --shell /usr/sbin/nologin hedgeos"

echo "==> Creating /opt/hedgeos layout"
ssh "$HOST" "mkdir -p /opt/hedgeos/app/data /opt/hedgeos/backups && chown -R hedgeos:hedgeos /opt/hedgeos"

echo "==> Syncing repository (excludes node_modules, .git, local db files)"
rsync -az --delete \
  --exclude 'node_modules' --exclude '.git' --exclude 'data/*.db*' --exclude 'bitsentry_audit.db' \
  ./ "$HOST:$REMOTE_APP_DIR/"

echo "==> Writing .env only if it doesn't already exist (never overwritten)"
ssh "$HOST" "test -f $REMOTE_APP_DIR/.env || cat > $REMOTE_APP_DIR/.env <<'EOF'
HEDGEOS_MODE=paper
HEDGEOS_DB_PATH=$REMOTE_APP_DIR/data/hedgeos.db
HEDGEOS_DASHBOARD_PORT=8766
HEDGEOS_DASHBOARD_HOST=127.0.0.1
HEDGEOS_TICK_MS=60000
EOF
chmod 600 $REMOTE_APP_DIR/.env"

echo "==> Ensuring HedgeOS has its OWN independent Node.js (do not assume /usr/local/bin/node is a real system install -- on this host it turned out to be a symlink into another service's private, unprivileged-unreadable home directory)"
ssh "$HOST" "test -x /opt/hedgeos/node/bin/node || (
  cd /tmp &&
  curl -fsSL -o node.tar.xz https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-x64.tar.xz &&
  mkdir -p /opt/hedgeos/node &&
  tar -xJf node.tar.xz -C /opt/hedgeos/node --strip-components=1 &&
  rm -f node.tar.xz &&
  chown -R hedgeos:hedgeos /opt/hedgeos/node
)"

echo "==> npm install as the hedgeos user, using HedgeOS's own node/npm (native deps compiled for the VPS's own Linux/arch)"
ssh "$HOST" "su -s /bin/sh hedgeos -c 'export PATH=/opt/hedgeos/node/bin:/usr/bin:/bin; cd $REMOTE_APP_DIR && npm install'"

echo "==> Installing systemd units (system-level, distinct hedgeos-* names — no collision with any existing unit)"
scp deploy/hedgeos-worker.service deploy/hedgeos-dashboard.service deploy/hedgeos-backup.service deploy/hedgeos-backup.timer "$HOST:/etc/systemd/system/"
ssh "$HOST" "chmod +x $REMOTE_APP_DIR/deploy/backup.sh && (which sqlite3 >/dev/null || apt-get install -y sqlite3)"
ssh "$HOST" "systemctl daemon-reload"

echo "==> Enabling (start on boot) and starting worker + dashboard + backup timer"
ssh "$HOST" "systemctl enable --now hedgeos-worker.service hedgeos-dashboard.service hedgeos-backup.timer"

echo "==> Status"
ssh "$HOST" "systemctl status hedgeos-worker.service hedgeos-dashboard.service --no-pager -l | head -40"

echo "==> Done. Dashboard is bound to 127.0.0.1:8766 on the VPS only — access it via:"
echo "    ssh -L 8766:127.0.0.1:8766 $HOST"
echo "    then open http://localhost:8766 on your Mac"
