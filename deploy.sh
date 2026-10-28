#!/usr/bin/env sh
set -eu
command -v docker >/dev/null || { echo '需要 Docker'; exit 1; }
command -v openssl >/dev/null || { echo '需要 openssl 生成部署密钥'; exit 1; }
docker compose version >/dev/null || { echo '需要 Docker Compose'; exit 1; }
if [ ! -f .env ]; then
  if command -v ss >/dev/null 2>&1; then
    for port in 80 443; do
      if [ -n "$(ss -H -ltn "( sport = :$port )")" ]; then
        echo "端口 $port 已被占用"
        exit 1
      fi
    done
  fi
  printf '公网域名（本地测试填 localhost）: '
  read -r domain
  printf '管理员用户名 [admin]: '
  read -r admin_user
  admin_user=${admin_user:-admin}
  [ -n "$domain" ] || { echo '域名不能为空'; exit 1; }
  db_password=$(openssl rand -hex 32)
  admin_password=$(openssl rand -hex 24)
  umask 077
  cat > .env <<EOF
DOMAIN=$domain
PUBLIC_URL=https://$domain
DB_PASSWORD=$db_password
ADMIN_USERNAME=$admin_user
ADMIN_PASSWORD=$admin_password
EOF
  printf '初始管理员密码（仅此处显示）: %s\n' "$admin_password"
fi
docker compose up -d --build
docker compose ps
printf '管理后台: %s/admin/\nMCP Endpoint: %s/mcp\n' "$(sed -n 's/^PUBLIC_URL=//p' .env)" "$(sed -n 's/^PUBLIC_URL=//p' .env)"
