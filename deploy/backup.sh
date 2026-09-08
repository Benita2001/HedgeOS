#!/bin/sh
# Uses SQLite's own online .backup command (safe against a live writer,
# unlike a raw file copy of a WAL-mode database) to snapshot the DB, then
# prunes anything older than 14 days. Runs as the hedgeos user via the
# hedgeos-backup.timer/.service pair — never touches root's crontab.
set -eu

DB_PATH="/opt/hedgeos/app/data/hedgeos.db"
BACKUP_DIR="/opt/hedgeos/backups"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"
sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/hedgeos-$STAMP.db'"
find "$BACKUP_DIR" -name 'hedgeos-*.db' -mtime +14 -delete

echo "[hedgeos-backup] snapshot written: $BACKUP_DIR/hedgeos-$STAMP.db"
