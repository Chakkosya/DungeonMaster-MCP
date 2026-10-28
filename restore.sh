#!/usr/bin/env sh
set -eu
file=${1:-}
[ -f "$file" ] || { echo '用法: ./restore.sh backups/文件.dump'; exit 1; }
./verify-backup.sh "$file"
printf '将覆盖当前数据库。输入 RESTORE 确认: '
read -r confirm
[ "$confirm" = RESTORE ] || exit 1
./backup.sh
docker compose stop server worker
docker compose exec -T db psql -U dnd -d postgres -c 'DROP DATABASE IF EXISTS dnd WITH (FORCE)'
docker compose exec -T db psql -U dnd -d postgres -c 'CREATE DATABASE dnd OWNER dnd'
docker compose exec -T db pg_restore -U dnd -d dnd --no-owner --exit-on-error < "$file"
docker compose up -d server worker
docker compose ps
