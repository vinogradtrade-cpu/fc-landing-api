#!/usr/bin/env bash
# Бэкап SQLite-БД с WAL-checkpoint и ротацией.
# Запускать через cron под пользователем clawd.
#
# crontab -e (под clawd):
#   0 3 * * * /opt/fc-landing-api/current/scripts/backup-db.sh >> /opt/fc-landing-api/shared/backup.log 2>&1

set -euo pipefail

DB="${BRIEF_DB_PATH:-/opt/fc-landing-api/shared/briefs.db}"
BACKUP_DIR="${BRIEF_BACKUP_DIR:-/opt/fc-landing-api/shared/backups}"
KEEP="${BRIEF_BACKUP_KEEP:-30}"   # сколько последних бэкапов хранить

mkdir -p "$BACKUP_DIR"
TS=$(date +%Y%m%d-%H%M%S)
DST="$BACKUP_DIR/briefs-$TS.db"

# Через node:sqlite — выполним WAL-checkpoint, затем скопируем.
node -e "
const { DatabaseSync } = require('node:sqlite');
const fs = require('fs');
const src = process.argv[1];
const dst = process.argv[2];
const db = new DatabaseSync(src);
db.exec('PRAGMA wal_checkpoint(FULL)');
db.close();
fs.copyFileSync(src, dst);
" "$DB" "$DST"

# Сжимаем (.gz)
gzip "$DST"

# Ротация — оставляем последние $KEEP файлов
ls -1t "$BACKUP_DIR"/briefs-*.db.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f

echo "[$(date '+%F %T')] backup ok → $DST.gz"
