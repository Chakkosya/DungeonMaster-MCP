#!/usr/bin/env sh
set -eu
./backup.sh
docker compose pull
docker compose up -d
docker compose ps
