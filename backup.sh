#!/usr/bin/env sh
set -eu
mkdir -p backups
file="backups/dnd-$(date -u +%Y%m%dT%H%M%SZ).dump"
partial="$file.partial"
trap 'rm -f "$partial"' EXIT INT TERM
docker compose exec -T db pg_dump -U dnd -d dnd -Fc > "$partial"
./verify-backup.sh "$partial"
mv "$partial" "$file"
trap - EXIT INT TERM
printf '备份已保存: %s\n' "$file"
