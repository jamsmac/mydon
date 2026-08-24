#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
HELPER="$ROOT/deploy/guards/db_access.sh"
FAKE_DOCKER="$ROOT/deploy/tests/fake-docker-db.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

run_helper() {
  DB_ENV_FILE="$1" \
  DB_DOCKER_BIN="$FAKE_DOCKER" \
  DB_TEMP_ROOT="$TMP/staging" \
  FAKE_DOCKER_ARGS="$TMP/docker.args" \
  FAKE_DOCKER_PGPASS="$TMP/pgpass.copy" \
    "$HELPER" "${@:2}"
}

LOCAL_ENV="$TMP/local.env"
printf 'DATABASE_MODE=local\n' > "$LOCAL_ENV"
: > "$TMP/docker.args"
run_helper "$LOCAL_ENV" dump > "$TMP/output"
grep -q 'dump complete' "$TMP/output"
grep -q 'exec -i mydon-db pg_dump' "$TMP/docker.args"
run_helper "$LOCAL_ENV" ping | grep -qx 1

MISSING_ENV="$TMP/missing.env"
printf 'DATABASE_MODE=external\n' > "$MISSING_ENV"
if run_helper "$MISSING_ENV" dump > "$TMP/output" 2>&1; then
  printf 'external mode accepted an empty admin URL\n' >&2
  exit 1
fi
grep -q 'DATABASE_ADMIN_URL обязателен' "$TMP/output"

INSECURE_ENV="$TMP/insecure.env"
printf '%s\n' \
  'DATABASE_MODE=external' \
  'DATABASE_ADMIN_URL=postgresql://postgres:external-secret@db.example.test:5432/postgres?sslmode=disable' \
  > "$INSECURE_ENV"
if run_helper "$INSECURE_ENV" dump > "$TMP/output" 2>&1; then
  printf 'external mode accepted sslmode=disable\n' >&2
  exit 1
fi
grep -q 'must require TLS' "$TMP/output"

EXTERNAL_ENV="$TMP/external.env"
printf '%s\n' \
  'DATABASE_MODE=external' \
  'DATABASE_ADMIN_URL=postgresql://postgres:external-secret@db.example.test:5432/postgres?sslmode=require' \
  > "$EXTERNAL_ENV"
: > "$TMP/docker.args"
run_helper "$EXTERNAL_ENV" dump > "$TMP/output"
grep -q 'dump complete' "$TMP/output"
grep -q 'run --rm --network host' "$TMP/docker.args"
grep -q 'postgres:17-alpine pg_dump' "$TMP/docker.args"
if grep -q 'external-secret' "$TMP/docker.args"; then
  printf 'database secret leaked to docker argv\n' >&2
  exit 1
fi
grep -q 'db.example.test:5432:postgres:postgres:external-secret' "$TMP/pgpass.copy"
[ "$(find "$TMP/staging" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')" -eq 0 ]
run_helper "$EXTERNAL_ENV" 'query' 'select 42' | grep -qx 42
run_helper "$EXTERNAL_ENV" ping | grep -qx 1

BAD_MODE_ENV="$TMP/bad-mode.env"
printf 'DATABASE_MODE=surprise\n' > "$BAD_MODE_ENV"
if run_helper "$BAD_MODE_ENV" ping > "$TMP/output" 2>&1; then
  printf 'invalid database mode was accepted\n' >&2
  exit 1
fi
grep -q 'local или external' "$TMP/output"

printf 'db-access tests: ok\n'
