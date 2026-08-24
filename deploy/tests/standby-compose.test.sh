#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
COMPOSE="$ROOT/deploy/docker-compose.standby.yml"
PRODUCTION_COMPOSE="$ROOT/deploy/docker-compose.yml"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

ENV_FILE="$TMP/standby.env"
printf '%s\n' \
  'DATABASE_URL=postgresql://runtime-user:runtime-secret@db.example.test/postgres?sslmode=require' \
  'SERVICE_TOKEN=service-secret' \
  'DATABASE_ADMIN_URL=postgresql://admin:admin-secret@direct.example.test/postgres' \
  'POSTGRES_PASSWORD=local-db-secret' \
  'B2_APPLICATION_KEY=b2-secret' \
  'BACKUP_ENC_PASSPHRASE=backup-secret' \
  > "$ENV_FILE"
chmod 600 "$ENV_FILE"

rendered=$(
  STANDBY_PANEL_BIND=127.0.0.1 \
    docker compose -f "$COMPOSE" --env-file "$ENV_FILE" config
)
printf '%s' "$rendered" | grep -q 'runtime-secret'
printf '%s' "$rendered" | grep -q 'service-secret'
for forbidden in admin-secret local-db-secret b2-secret backup-secret; do
  if printf '%s' "$rendered" | grep -q "$forbidden"; then
    printf 'standby leaked %s into a container\n' "$forbidden" >&2
    exit 1
  fi
done

rendered_json=$(
  STANDBY_PANEL_BIND=127.0.0.1 \
    docker compose -f "$COMPOSE" --env-file "$ENV_FILE" --profile workers \
      config --format json
)
printf '%s' "$rendered_json" | node -e '
  const fs = require("node:fs");
  const config = JSON.parse(fs.readFileSync(0, "utf8"));
  for (const service of ["core", "cc", "bot", "agents"]) {
    if (config.services[service]?.init !== true) {
      throw new Error(service + " must run behind Docker init");
    }
  }
'

production_json=$(
  PANEL_BIND=127.0.0.1 \
    docker compose -f "$PRODUCTION_COMPOSE" --env-file "$ENV_FILE" \
      config --format json
)
printf '%s' "$production_json" | node -e '
  const fs = require("node:fs");
  const config = JSON.parse(fs.readFileSync(0, "utf8"));
  for (const service of ["mydon-core", "mydon-cc", "mydon-bot", "mydon-agents"]) {
    if (config.services[service]?.init !== true) {
      throw new Error(service + " must run behind Docker init");
    }
  }
'

default_services=$(
  STANDBY_PANEL_BIND=127.0.0.1 \
    docker compose -f "$COMPOSE" --env-file "$ENV_FILE" config --services | sort
)
[ "$default_services" = $'cc\ncore' ]
worker_services=$(
  STANDBY_PANEL_BIND=127.0.0.1 \
    docker compose -f "$COMPOSE" --env-file "$ENV_FILE" --profile workers \
      config --services | sort
)
[ "$worker_services" = $'agents\nbot\ncc\ncore' ]

MISSING_ENV="$TMP/missing.env"
printf 'SERVICE_TOKEN=still-not-enough\n' > "$MISSING_ENV"
if STANDBY_PANEL_BIND=127.0.0.1 \
  docker compose -f "$COMPOSE" --env-file "$MISSING_ENV" config --quiet \
  >"$TMP/missing.out" 2>&1; then
  printf 'standby accepted a missing DATABASE_URL\n' >&2
  exit 1
fi
grep -q 'DATABASE_URL is required' "$TMP/missing.out"

if "$ROOT/deploy/standby-promote.sh" "$ENV_FILE" >"$TMP/promote.out" 2>&1; then
  printf 'standby promotion accepted missing operator confirmation\n' >&2
  exit 1
fi
grep -q 'STANDBY_CONFIRM_PRODUCTION_DOWN=YES' "$TMP/promote.out"

printf 'standby-compose tests: ok\n'
