#!/usr/bin/env sh
set -eu
if [ "${1:-}" = '--delete-data' ]; then
  printf '这会永久删除数据库与备份卷。输入 DELETE ALL DATA 确认: '
  read -r confirm
  [ "$confirm" = 'DELETE ALL DATA' ] || exit 1
  docker compose down -v
else
  docker compose down
  echo '服务已停止；数据卷保留。'
fi
