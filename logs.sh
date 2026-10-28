#!/usr/bin/env sh
set -eu
docker compose logs --tail=200 -f "${1:-server}"
