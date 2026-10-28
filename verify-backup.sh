#!/usr/bin/env sh
set -eu
file=${1:-}
[ -f "$file" ] || { echo '用法: ./verify-backup.sh backups/文件.dump'; exit 1; }
test_db="dnd_restore_test_$(date -u +%s)_$$"
docker compose exec -T db createdb -U dnd "$test_db"
cleanup() { docker compose exec -T db dropdb -U dnd --if-exists "$test_db"; }
trap cleanup EXIT INT TERM
docker compose exec -T db pg_restore -U dnd -d "$test_db" --no-owner --exit-on-error < "$file"
docker compose exec -T db psql -U dnd -d "$test_db" -Atc 'SELECT count(*) FROM worlds' >/dev/null
printf '备份可完整恢复: %s\n' "$file"
