#!/usr/bin/env bash
# Safe access to the active MYDON PostgreSQL for operational scripts.
#
# DATABASE_MODE=local uses the rollback container. DATABASE_MODE=external
# requires a direct TLS URL for pg_dump and administrative reads. Credentials
# are passed through a temporary pgpass file, never through process arguments.
set -euo pipefail
umask 077

ENV_FILE="${DB_ENV_FILE:-/opt/mydon-app/.env}"
DOCKER_BIN="${DB_DOCKER_BIN:-docker}"
CLIENT_IMAGE="${DB_CLIENT_IMAGE:-postgres:17-alpine}"
LOCAL_CONTAINER="${DB_LOCAL_CONTAINER:-mydon-db}"
LOCAL_USER="${DB_LOCAL_USER:-mydon}"
LOCAL_DATABASE="${DB_LOCAL_DATABASE:-mydon}"
TEMP_ROOT="${DB_TEMP_ROOT:-/opt/backups}"
TMP_DIR=""

fail() { printf 'FAIL database access: %s\n' "$*" >&2; exit 1; }
env_value() {
  local key=$1
  [ -f "$ENV_FILE" ] || return 0
  awk -v prefix="${key}=" \
    'index($0, prefix) == 1 { value = substr($0, length(prefix) + 1) } END { print value }' \
    "$ENV_FILE"
}
cleanup() {
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf -- "$TMP_DIR"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

prepare_external() {
  local url metadata
  command -v python3 >/dev/null 2>&1 || fail "python3 не установлен"
  command -v jq >/dev/null 2>&1 || fail "jq не установлен"
  mkdir -p "$TEMP_ROOT"
  TMP_DIR=$(mktemp -d "$TEMP_ROOT/.mydon-db-access.XXXXXX") ||
    fail "не удалось создать временный каталог"

  url=$(env_value DATABASE_ADMIN_URL)
  [ -n "$url" ] || fail "DATABASE_ADMIN_URL обязателен для external mode"
  metadata=$(
    DATABASE_ADMIN_URL="$url" PGPASS_PATH="$TMP_DIR/pgpass" python3 <<'PY'
import json
import os
import sys
from urllib.parse import parse_qs, unquote, urlsplit

try:
    parsed = urlsplit(os.environ["DATABASE_ADMIN_URL"])
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise ValueError("scheme must be postgresql")
    if not parsed.hostname or not parsed.username or parsed.password is None:
        raise ValueError("host, user and password are required")
    database = unquote(parsed.path.lstrip("/"))
    if not database or "/" in database:
        raise ValueError("database name is invalid")
    port = parsed.port or 5432
    user = unquote(parsed.username)
    password = unquote(parsed.password)
    query = parse_qs(parsed.query)
    sslmode = query.get("sslmode", ["require"])[-1]
    if sslmode not in {"require", "verify-ca", "verify-full"}:
        raise ValueError("external database must require TLS")
    values = (parsed.hostname, str(port), database, user, password)
    if any("\n" in value or "\r" in value for value in values):
        raise ValueError("connection value contains a newline")

    def pgpass_escape(value: str) -> str:
        return value.replace("\\", "\\\\").replace(":", "\\:")

    pgpass = ":".join(pgpass_escape(value) for value in values) + "\n"
    path = os.environ["PGPASS_PATH"]
    with open(path, "x", encoding="utf-8") as handle:
        handle.write(pgpass)
    os.chmod(path, 0o600)
    print(json.dumps({
        "host": parsed.hostname,
        "port": port,
        "database": database,
        "user": user,
        "sslmode": sslmode,
    }))
except Exception as error:
    print(f"invalid DATABASE_ADMIN_URL: {error}", file=sys.stderr)
    raise SystemExit(2)
PY
  ) || fail "DATABASE_ADMIN_URL не прошёл проверку"

  DB_HOST=$(printf '%s' "$metadata" | jq -er .host) || fail "нет database host"
  DB_PORT=$(printf '%s' "$metadata" | jq -er .port) || fail "нет database port"
  DB_NAME=$(printf '%s' "$metadata" | jq -er .database) || fail "нет database name"
  DB_USER=$(printf '%s' "$metadata" | jq -er .user) || fail "нет database user"
  DB_SSLMODE=$(printf '%s' "$metadata" | jq -er .sslmode) || fail "нет sslmode"
}

external_client() {
  "$DOCKER_BIN" run --rm --network host \
    --volume "$TMP_DIR/pgpass:/run/secrets/pgpass:ro" \
    --env PGPASSFILE=/run/secrets/pgpass \
    --env PGCONNECT_TIMEOUT=15 \
    --env "PGSSLMODE=$DB_SSLMODE" \
    "$CLIENT_IMAGE" "$@"
}

MODE=$(env_value DATABASE_MODE)
MODE=${MODE:-local}
COMMAND=${1:-}
[ -n "$COMMAND" ] || fail "использование: $0 dump|query|ping|describe [SQL]"

case "$MODE" in
  local)
    case "$COMMAND" in
      dump)
        exec "$DOCKER_BIN" exec -i "$LOCAL_CONTAINER" pg_dump \
          --clean --if-exists --no-owner --no-privileges \
          -U "$LOCAL_USER" "$LOCAL_DATABASE"
        ;;
      query)
        [ "$#" -eq 2 ] || fail "query требует ровно один SQL-аргумент"
        exec "$DOCKER_BIN" exec "$LOCAL_CONTAINER" psql \
          -U "$LOCAL_USER" -d "$LOCAL_DATABASE" -v ON_ERROR_STOP=1 -Atc "$2"
        ;;
      ping)
        exec "$DOCKER_BIN" exec "$LOCAL_CONTAINER" psql \
          -U "$LOCAL_USER" -d "$LOCAL_DATABASE" -v ON_ERROR_STOP=1 -Atc 'select 1'
        ;;
      describe) printf 'local container=%s database=%s\n' "$LOCAL_CONTAINER" "$LOCAL_DATABASE" ;;
      *) fail "неизвестная команда '$COMMAND'" ;;
    esac
    ;;
  external)
    prepare_external
    case "$COMMAND" in
      dump)
        external_client pg_dump --clean --if-exists --no-owner --no-privileges \
          --host "$DB_HOST" --port "$DB_PORT" --username "$DB_USER" "$DB_NAME"
        ;;
      query)
        [ "$#" -eq 2 ] || fail "query требует ровно один SQL-аргумент"
        external_client psql --host "$DB_HOST" --port "$DB_PORT" \
          --username "$DB_USER" --dbname "$DB_NAME" -v ON_ERROR_STOP=1 -Atc "$2"
        ;;
      ping)
        external_client psql --host "$DB_HOST" --port "$DB_PORT" \
          --username "$DB_USER" --dbname "$DB_NAME" -v ON_ERROR_STOP=1 -Atc 'select 1'
        ;;
      describe) printf 'external host=%s database=%s tls=%s\n' "$DB_HOST" "$DB_NAME" "$DB_SSLMODE" ;;
      *) fail "неизвестная команда '$COMMAND'" ;;
    esac
    ;;
  *) fail "DATABASE_MODE должен быть local или external" ;;
esac
