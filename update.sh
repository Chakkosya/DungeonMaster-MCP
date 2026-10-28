#!/usr/bin/env sh
set -eu
./backup.sh
docker compose up -d --build
docker compose ps
