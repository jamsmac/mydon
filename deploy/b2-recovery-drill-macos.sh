#!/usr/bin/env bash
# Full Backblaze B2 recovery drill from a separate macOS recovery machine.
set -euo pipefail
umask 077

RECOVERY_FILE="${B2_RECOVERY_FILE:-$HOME/.config/mydon/b2-recovery.json}"
PRODUCTION_HOST="${PRODUCTION_HOST:-root@100.81.197.68}"
RCLONE_BIN="${RCLONE_BIN:-rclone}"
DATE="${1:-}"

log() { printf '%s\n' "$*"; }
fail() { log "FAIL B2 recovery drill: $*" >&2; exit 1; }

command -v jq >/dev/null 2>&1 || fail "jq не установлен"
command -v "$RCLONE_BIN" >/dev/null 2>&1 || fail "rclone не установлен"
command -v ssh >/dev/null 2>&1 || fail "ssh не установлен"
[ -f "$RECOVERY_FILE" ] || fail "не найден $RECOVERY_FILE"
[ "$(stat -f %Su "$RECOVERY_FILE")" = "$(id -un)" ] || fail "$RECOVERY_FILE принадлежит другому пользователю"
[ "$(stat -f %Lp "$RECOVERY_FILE")" = 600 ] || fail "$RECOVERY_FILE должен иметь права 600"
RECOVERY_DIR=$(dirname "$RECOVERY_FILE")
[ "$(stat -f %Su "$RECOVERY_DIR")" = "$(id -un)" ] || fail "$RECOVERY_DIR принадлежит другому пользователю"
[ "$(stat -f %Lp "$RECOVERY_DIR")" = 700 ] || fail "$RECOVERY_DIR должен иметь права 700"

if [ -z "$DATE" ]; then
  DATE=$(ssh -o BatchMode=yes "$PRODUCTION_HOST" 'date -d "+5 hours" +%F') ||
    fail "не удалось определить production-дату"
fi
case "$DATE" in
  ????-??-??) ;;
  *) fail "неверная дата '$DATE'" ;;
esac

bucket=$(jq -er '.bucket' "$RECOVERY_FILE") || fail "в recovery-файле нет bucket"
prefix=$(jq -er '.prefix' "$RECOVERY_FILE") || fail "в recovery-файле нет prefix"
key_id=$(jq -er '.applicationKeyId' "$RECOVERY_FILE") || fail "в recovery-файле нет key id"
app_key=$(jq -er '.applicationKey' "$RECOVERY_FILE") || fail "в recovery-файле нет application key"
passphrase=$(jq -er '.encryptionPassphrase' "$RECOVERY_FILE") || fail "в recovery-файле нет пароля шифрования"
jq -e '(.permissions | index("writeFiles") | not) and (.permissions | index("deleteFiles") | not)' \
  "$RECOVERY_FILE" >/dev/null || fail "recovery key не read-only"
case "$bucket" in
  *[!A-Za-z0-9-]*|'') fail "недопустимое имя bucket" ;;
esac
case "$prefix" in
  /*|*..*|*:*|*[!A-Za-z0-9._/-]*|'') fail "недопустимый prefix" ;;
esac
case "$key_id" in
  *[!A-Za-z0-9]*|'') fail "недопустимый key id" ;;
esac
case "$app_key" in
  *[!A-Za-z0-9+/]*|'') fail "недопустимый application key" ;;
esac

WORK=$(mktemp -d "${TMPDIR:-/tmp}/mydon-b2-recovery.XXXXXX")
TESTDB="mydon_b2_restore_$(date +%s)_$$"
DB_CREATED=0
cleanup() {
  unset key_id app_key passphrase obscured
  if [ "$DB_CREATED" -eq 1 ]; then
    ssh -o BatchMode=yes "$PRODUCTION_HOST" \
      "docker exec mydon-db dropdb -U mydon --if-exists --force '$TESTDB'" \
      >/dev/null 2>&1 || true
  fi
  rm -rf -- "$WORK"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

: > "$WORK/rclone.conf"
obscured=$(printf '%s\n' "$passphrase" | "$RCLONE_BIN" obscure -) ||
  fail "rclone не подготовил ключ шифрования"
export RCLONE_CONFIG="$WORK/rclone.conf"
export RCLONE_CONFIG_RESTOREB2_TYPE=b2
export RCLONE_CONFIG_RESTOREB2_ACCOUNT="$key_id"
export RCLONE_CONFIG_RESTOREB2_KEY="$app_key"
export RCLONE_CONFIG_RESTORECRYPT_TYPE=crypt
export RCLONE_CONFIG_RESTORECRYPT_REMOTE="restoreb2:${bucket}/${prefix%/}"
export RCLONE_CONFIG_RESTORECRYPT_PASSWORD="$obscured"
export RCLONE_CONFIG_RESTORECRYPT_FILENAME_ENCRYPTION=standard
export RCLONE_CONFIG_RESTORECRYPT_DIRECTORY_NAME_ENCRYPTION=true

raw_list=$("$RCLONE_BIN" lsf "restoreb2:${bucket}/${prefix%/}" \
  --recursive --files-only --log-level ERROR) || fail "read-only key не читает B2"
raw_count=$(printf '%s\n' "$raw_list" | awk 'NF { count++ } END { print count + 0 }')
plain_leaks=$(printf '%s\n' "$raw_list" | grep -Ec 'mydon-app_|command-center_|env-files_' || true)
[ "$raw_count" -ge 3 ] || fail "в B2 меньше трёх объектов"
[ "$plain_leaks" -eq 0 ] || fail "B2 раскрыл открытые имена файлов"
first_raw=$(printf '%s\n' "$raw_list" | awk 'NF { print; exit }')
crypt_header=$("$RCLONE_BIN" cat \
  "restoreb2:${bucket}/${prefix%/}/${first_raw}" --head 8 --log-level ERROR |
  xxd -p | tr -d '\n')
[ "$crypt_header" = "52434c4f4e450000" ] || fail "объект не имеет заголовка rclone crypt"
log "B2 raw: objects=$raw_count plaintext_names=$plain_leaks crypt_header=$crypt_header"

mkdir "$WORK/download"
"$RCLONE_BIN" copy "restorecrypt:${DATE}" "$WORK/download" \
  --contimeout 15s --timeout 5m --retries 3 --low-level-retries 10 --log-level ERROR ||
  fail "не удалось скачать и расшифровать backup"

names=(
  "mydon-app_${DATE}.sql.gz"
  "command-center_${DATE}.tar.gz"
  "env-files_${DATE}.tar.gz"
)
for name in "${names[@]}"; do
  [ -s "$WORK/download/$name" ] || fail "нет восстановленного $name"
done
[ "$(find "$WORK/download" -maxdepth 1 -type f | wc -l | tr -d ' ')" -eq 3 ] ||
  fail "в суточном каталоге не ровно три файла"
gzip -t "$WORK/download/mydon-app_${DATE}.sql.gz" || fail "SQL gzip повреждён"
tar -tzf "$WORK/download/command-center_${DATE}.tar.gz" >/dev/null || fail "command-center tar повреждён"
tar -tzf "$WORK/download/env-files_${DATE}.tar.gz" >/dev/null || fail "env tar повреждён"
log "Архивы: gzip/tar integrity OK, files=3"

local_manifest=$(
  for name in "${names[@]}"; do
    hash=$(shasum -a 256 "$WORK/download/$name" | awk '{ print $1 }')
    printf '%s %s\n' "$hash" "$name"
  done | sort
)
remote_manifest=$(
  ssh -o BatchMode=yes "$PRODUCTION_HOST" bash -s -- "$DATE" <<'REMOTE'
set -euo pipefail
date=$1
for name in "mydon-app_${date}.sql.gz" "command-center_${date}.tar.gz" "env-files_${date}.tar.gz"; do
  hash=$(sha256sum "/opt/backups/extra/$name" | awk '{ print $1 }')
  printf '%s %s\n' "$hash" "$name"
done | sort
REMOTE
) || fail "не удалось получить production checksum"
[ "$local_manifest" = "$remote_manifest" ] || fail "скачанные байты отличаются от production"
log "SHA-256: downloaded bytes exactly match production originals"
log "$local_manifest"

ssh -o BatchMode=yes "$PRODUCTION_HOST" \
  "docker exec mydon-db createdb -U mydon '$TESTDB'" \
  >/dev/null || fail "не удалось создать временную БД"
DB_CREATED=1
gzip -dc "$WORK/download/mydon-app_${DATE}.sql.gz" |
  ssh -o BatchMode=yes "$PRODUCTION_HOST" \
    "docker exec -i mydon-db psql -U mydon -d '$TESTDB' -v ON_ERROR_STOP=1 --single-transaction" \
    >/dev/null || fail "SQL не восстановился атомарно"
log "Database restore: SQL applied atomically to $TESTDB"

if ! ssh -o BatchMode=yes "$PRODUCTION_HOST" bash -s -- "$TESTDB" <<'REMOTE'
set -euo pipefail
testdb=$1
q() { docker exec mydon-db psql -U mydon -d "$1" -tAc "$2" 2>/dev/null | tr -d ' '; }
for table in entity collection sale purchase machine_stock person task audit_log; do
  live=$(q mydon "select count(*) from $table")
  restored=$(q "$testdb" "select count(*) from $table")
  [ -n "$live" ] && [ -n "$restored" ]
  if [ "$restored" -eq 0 ] && [ "$live" -gt 0 ]; then exit 31; fi
  printf '  %-16s live=%s restored=%s\n' "$table" "$live" "$restored"
done
live_sum=$(q mydon "select coalesce(sum(amount),0)::bigint from collection where status='received'")
restored_sum=$(q "$testdb" "select coalesce(sum(amount),0)::bigint from collection where status='received'")
[ -n "$live_sum" ] && [ -n "$restored_sum" ]
if [ "$restored_sum" -eq 0 ] && [ "$live_sum" -gt 0 ]; then exit 32; fi
printf '  collection_sum   live=%s restored=%s\n' "$live_sum" "$restored_sum"
REMOTE
then
  fail "содержимое восстановленной БД не прошло сверку"
fi

ssh -o BatchMode=yes "$PRODUCTION_HOST" \
  "docker exec mydon-db dropdb -U mydon --if-exists --force '$TESTDB'" \
  >/dev/null || fail "не удалось удалить временную БД"
DB_CREATED=0
leftover=$(ssh -o BatchMode=yes "$PRODUCTION_HOST" \
  "docker exec mydon-db psql -U mydon -d postgres -tAc \"select count(*) from pg_database where datname='$TESTDB'\"") ||
  fail "не удалось проверить удаление временной БД"
[ "$leftover" -eq 0 ] || fail "временная БД осталась после dropdb"
log "Database restore: comparison OK, temporary database removed"
log "RECOVERY_DRILL_OK date=$DATE bucket=$bucket"
