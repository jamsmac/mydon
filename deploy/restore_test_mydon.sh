#!/usr/bin/env bash
# Restore-test the latest MYDON dump in an isolated, disposable PostgreSQL 17.
# The active database and the local rollback database are only read, never
# modified. The restore container has no network and stores all data in tmpfs.
set -uo pipefail
umask 077

BACKUP_DIR="${RESTORE_BACKUP_DIR:-/opt/backups/extra}"
DUMP="${RESTORE_DUMP_PATH:-}"
MAX_DUMP_AGE_HOURS="${RESTORE_DUMP_MAX_AGE_HOURS:-48}"
DB_HELPER="${DB_HELPER:-/opt/backups/db_access.sh}"
DOCKER_BIN="${RESTORE_DOCKER_BIN:-docker}"
CLIENT_IMAGE="${DB_CLIENT_IMAGE:-postgres:17-alpine}"
RESTORE_CONTAINER="mydon-restore-test-$(date +%s)-$$"
TEMP_ROOT="${RESTORE_TEMP_ROOT:-/opt/backups}"
TMP_DIR=""
CONTAINER_CREATED=0
FAILED=0
NEW_TABLES=0

say() { printf '%s\n' "$1"; }
cleanup() {
  if [ "$CONTAINER_CREATED" -eq 1 ]; then
    "$DOCKER_BIN" rm -f "$RESTORE_CONTAINER" >/dev/null 2>&1 || true
    CONTAINER_CREATED=0
  fi
  if [ -n "$TMP_DIR" ] && [ -d "$TMP_DIR" ]; then
    rm -rf -- "$TMP_DIR"
    TMP_DIR=""
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

q_live() {
  "$DB_HELPER" query "$1" 2>/dev/null | tr -d '[:space:]'
}
q_restore() {
  "$DOCKER_BIN" exec "$RESTORE_CONTAINER" psql -U mydon -d restore \
    -v ON_ERROR_STOP=1 -Atc "$1" 2>/dev/null | tr -d '[:space:]'
}

say "=== Проверка восстановления базы MYDON · $(date '+%d.%m.%Y %H:%M') ==="

if [ -z "$DUMP" ]; then
  DUMP=$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'mydon-app_*.sql.gz' \
    -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -n 1 | cut -d' ' -f2-)
fi
if [ -z "${DUMP:-}" ] || [ ! -f "$DUMP" ]; then
  say "ПРОВАЛ: дамп MYDON не найден"
  exit 1
fi
if ! [[ "$MAX_DUMP_AGE_HOURS" =~ ^[1-9][0-9]*$ ]]; then
  say "ПРОВАЛ: RESTORE_DUMP_MAX_AGE_HOURS должен быть целым числом больше нуля"
  exit 1
fi
dump_age_seconds=$(( $(date +%s) - $(stat -c %Y "$DUMP") ))
if [ "$dump_age_seconds" -lt 0 ]; then dump_age_seconds=0; fi
dump_age_hours=$(( dump_age_seconds / 3600 ))
if [ "$dump_age_hours" -gt "$MAX_DUMP_AGE_HOURS" ]; then
  say "ПРОВАЛ: свежему дампу уже ${dump_age_hours} ч (порог ${MAX_DUMP_AGE_HOURS} ч)"
  exit 1
fi
say "1. Дамп: $(basename "$DUMP") ($(du -h "$DUMP" | cut -f1)), снят $(stat -c %y "$DUMP" | cut -d. -f1)"

if ! gunzip -t "$DUMP" 2>/dev/null; then
  say "ПРОВАЛ: архив повреждён"
  exit 1
fi
if ! gunzip -c "$DUMP" | tail -10 | grep -q 'dump complete'; then
  say "ПРОВАЛ: в SQL нет финального маркера pg_dump"
  exit 1
fi
[ -x "$DB_HELPER" ] || { say "ПРОВАЛ: helper $DB_HELPER не установлен"; exit 1; }
if ! "$DB_HELPER" ping >/dev/null 2>&1; then
  say "ПРОВАЛ: активная БД недоступна для контрольного чтения"
  exit 1
fi
say "   архив целый, активная БД отвечает"

mkdir -p "$TEMP_ROOT"
TMP_DIR=$(mktemp -d "$TEMP_ROOT/.mydon-restore.XXXXXX") || {
  say "ПРОВАЛ: не удалось создать временный каталог"
  exit 1
}
password=$(openssl rand -hex 24) || { say "ПРОВАЛ: openssl не создал пароль"; exit 1; }
printf 'POSTGRES_USER=mydon\nPOSTGRES_PASSWORD=%s\nPOSTGRES_DB=restore\n' "$password" \
  > "$TMP_DIR/postgres.env"
unset password
chmod 600 "$TMP_DIR/postgres.env"

if ! "$DOCKER_BIN" run -d --name "$RESTORE_CONTAINER" --network none \
  --tmpfs /var/lib/postgresql/data:rw,noexec,nosuid,size=768m \
  --env-file "$TMP_DIR/postgres.env" "$CLIENT_IMAGE" >/dev/null; then
  say "ПРОВАЛ: не удалось запустить изолированный PostgreSQL"
  exit 1
fi
CONTAINER_CREATED=1
ready=0
for _ in $(seq 1 60); do
  if "$DOCKER_BIN" exec "$RESTORE_CONTAINER" pg_isready -U mydon -d restore >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  "$DOCKER_BIN" logs --tail 30 "$RESTORE_CONTAINER" >&2 || true
  say "ПРОВАЛ: временный PostgreSQL не стал ready за 60 секунд"
  exit 1
fi
say "2. Изолированный PostgreSQL 17 готов (network=none, data=tmpfs)"

if ! gunzip -c "$DUMP" | "$DOCKER_BIN" exec -i "$RESTORE_CONTAINER" \
  psql -U mydon -d restore -v ON_ERROR_STOP=1 --single-transaction >/dev/null 2>&1; then
  say "ПРОВАЛ: psql не смог восстановить дамп целиком"
  exit 1
fi
say "3. Дамп развёрнут атомарно"

say "4. Сверка данных (активная база → восстановленная):"
for table in entity collection sale purchase machine_stock person task audit_log; do
  live=$(q_live "select count(*) from $table")
  restored=$(q_restore "select count(*) from $table")
  if ! [[ "$live" =~ ^[0-9]+$ ]]; then
    say "   ПРОВАЛ $table: таблица не читается в активной базе"
    FAILED=1
  elif [ -z "$restored" ]; then
    # A migration can add a table after the nightly dump. It will be covered by
    # the next backup, while all objects present in this dump remain strict.
    say "   новая $table: в дампе ещё нет, в активной базе $live"
    NEW_TABLES=$((NEW_TABLES + 1))
  elif ! [[ "$restored" =~ ^[0-9]+$ ]]; then
    say "   ПРОВАЛ $table: восстановленное значение некорректно"
    FAILED=1
  elif [ "$restored" -eq 0 ] && [ "$live" -gt 0 ]; then
    say "   ПРОВАЛ $table: в дампе пусто, а в активной базе $live"
    FAILED=1
  else
    say "   ок $table: активная $live → из дампа $restored"
  fi
done

live_sum=$(q_live "select coalesce(sum(amount),0)::bigint from collection where status='received'")
restored_sum=$(q_restore "select coalesce(sum(amount),0)::bigint from collection where status='received'")
if ! [[ "$live_sum" =~ ^-?[0-9]+$ ]] || ! [[ "$restored_sum" =~ ^-?[0-9]+$ ]]; then
  say "   ПРОВАЛ инкассации: таблица или сумма не читается"
  FAILED=1
elif [ "$restored_sum" -eq 0 ] && [ "$live_sum" -gt 0 ]; then
  say "   ПРОВАЛ инкассации: суммы в дампе нулевые"
  FAILED=1
else
  say "   ок суммы инкассаций: активная $live_sum → из дампа $restored_sum"
fi

cleanup
if "$DOCKER_BIN" ps -a --format '{{.Names}}' | grep -qx "$RESTORE_CONTAINER"; then
  say "ПРОВАЛ: временный контейнер остался после проверки"
  exit 1
fi
say "5. Временный контейнер и данные удалены"

if [ "$FAILED" -ne 0 ]; then
  say "ИТОГ: ЕСТЬ ПРОБЛЕМЫ — смотри строки «ПРОВАЛ» выше."
  exit 1
fi
if [ "$NEW_TABLES" -gt 0 ]; then
  say "ИТОГ: бэкап восстанавливается. Новых таблиц вне дампа: $NEW_TABLES."
else
  say "ИТОГ: бэкап базы MYDON восстанавливается, данные на месте."
fi

# Weekly cron:
#   45 3 * * 1 /opt/backups/restore_test_mydon.sh >> /opt/backups/restore_test_mydon.log 2>&1
