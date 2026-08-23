#!/usr/bin/env bash
# Upload MYDON backup archives to a private Backblaze B2 bucket.
#
# Every payload is encrypted and authenticated by rclone crypt before B2 sees
# it. Credentials are passed through environment-based config, not argv.
# Exit codes: 0 uploaded, 3 not configured, any other value is a real failure.
set -uo pipefail
umask 077

export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

ENV_FILE="${B2_ENV_FILE:-/opt/mydon-app/.env}"
TEMP_ROOT="${B2_TEMP_ROOT:-/opt/backups}"
RCLONE_BIN="${RCLONE_BIN:-rclone}"

log() { printf '%s %s\n' "$(date -u '+%F %T')" "$*"; }

env_value() {
  local key=$1
  [ -f "$ENV_FILE" ] || return 0
  awk -v prefix="${key}=" 'index($0, prefix) == 1 { value = substr($0, length(prefix) + 1) } END { print value }' "$ENV_FILE"
}

[ "$#" -ge 2 ] || {
  log "FAIL B2 offsite: использование: $0 YYYY-MM-DD файл [файл ...]"
  exit 2
}

BACKUP_DATE=$1
shift
case "$BACKUP_DATE" in
  ????-??-??) ;;
  *) log "FAIL B2 offsite: неверная дата '$BACKUP_DATE'"; exit 2 ;;
esac

B2_KEY_ID=$(env_value B2_APPLICATION_KEY_ID)
B2_APP_KEY=$(env_value B2_APPLICATION_KEY)
B2_BUCKET=$(env_value B2_BUCKET)
B2_PREFIX=$(env_value B2_PREFIX)
ENC_PASS=$(env_value BACKUP_ENC_PASSPHRASE)
B2_PREFIX=${B2_PREFIX:-mydon/daily}

configured=0
for value in "$B2_KEY_ID" "$B2_APP_KEY" "$B2_BUCKET"; do
  [ -n "$value" ] && configured=$((configured + 1))
done
if [ "$configured" -eq 0 ]; then
  log "INFO B2 offsite: не настроен, Telegram остаётся единственным внешним каналом"
  exit 3
fi
if [ "$configured" -ne 3 ]; then
  log "FAIL B2 offsite: конфигурация неполная (нужны B2_APPLICATION_KEY_ID, B2_APPLICATION_KEY и B2_BUCKET)"
  exit 1
fi
if [ -z "$ENC_PASS" ]; then
  log "FAIL B2 offsite: BACKUP_ENC_PASSPHRASE не задан, незашифрованные архивы не отправляем"
  exit 1
fi
case "$B2_BUCKET" in
  *[!A-Za-z0-9-]*|'') log "FAIL B2 offsite: недопустимое имя bucket"; exit 1 ;;
esac
case "$B2_PREFIX" in
  /*|*..*|*:*|*[!A-Za-z0-9._/-]*) log "FAIL B2 offsite: недопустимый B2_PREFIX"; exit 1 ;;
esac

command -v "$RCLONE_BIN" >/dev/null 2>&1 || {
  log "FAIL B2 offsite: rclone не установлен"
  exit 1
}
mkdir -p "$TEMP_ROOT"
TMP_DIR=$(mktemp -d "$TEMP_ROOT/.mydon-b2.XXXXXX") || {
  log "FAIL B2 offsite: не удалось создать временный каталог"
  exit 1
}
cleanup() { rm -rf -- "$TMP_DIR"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# An empty temporary config prevents accidental use of a root-level rclone
# profile. The only usable remote is the bucket-scoped key below.
: > "$TMP_DIR/rclone.conf"
export RCLONE_CONFIG="$TMP_DIR/rclone.conf"
export RCLONE_CONFIG_MYDONB2_TYPE=b2
export RCLONE_CONFIG_MYDONB2_ACCOUNT="$B2_KEY_ID"
export RCLONE_CONFIG_MYDONB2_KEY="$B2_APP_KEY"

# rclone crypt expects an obscured password. `obscure -` reads it from stdin,
# so the clear passphrase never appears in argv. The obscured form is only a
# config representation; the temporary config and environment die with us.
OBSCURED_PASS=$(printf '%s\n' "$ENC_PASS" | "$RCLONE_BIN" obscure - 2>/dev/null) || {
  log "FAIL B2 offsite: rclone не подготовил ключ шифрования"
  exit 1
}
export RCLONE_CONFIG_MYDONCRYPT_TYPE=crypt
export RCLONE_CONFIG_MYDONCRYPT_REMOTE="mydonb2:${B2_BUCKET}/${B2_PREFIX%/}"
export RCLONE_CONFIG_MYDONCRYPT_PASSWORD="$OBSCURED_PASS"
export RCLONE_CONFIG_MYDONCRYPT_FILENAME_ENCRYPTION=standard
export RCLONE_CONFIG_MYDONCRYPT_DIRECTORY_NAME_ENCRYPTION=true

FAILED=0
PLAIN_DIR="$TMP_DIR/plain"
mkdir "$PLAIN_DIR"
for source in "$@"; do
  if [ ! -s "$source" ]; then
    log "FAIL B2 offsite: исходный файл отсутствует или пуст: $(basename "$source")"
    FAILED=1
    continue
  fi

  target="$PLAIN_DIR/$(basename "$source")"
  if [ -e "$target" ]; then
    log "FAIL B2 offsite: два исходных файла имеют имя $(basename "$source")"
    FAILED=1
    continue
  fi
  if ! ln "$source" "$target" 2>/dev/null; then
    cp --reflink=auto "$source" "$target" || {
      log "FAIL B2 offsite: не удалось подготовить $(basename "$source")"
      FAILED=1
    }
  fi
done

[ "$FAILED" -eq 0 ] || exit 1

REMOTE="mydoncrypt:${BACKUP_DATE}"
if ! "$RCLONE_BIN" copy "$PLAIN_DIR" "$REMOTE" \
    --no-traverse --contimeout 15s --timeout 5m --retries 3 \
    --low-level-retries 10 --log-level ERROR; then
  log "FAIL B2 offsite: Backblaze не принял зашифрованные архивы"
  exit 1
fi

# cryptcheck reads each object's nonce, encrypts the local file identically and
# compares it with B2's stored checksum. This catches corruption or truncation
# without downloading the full backup.
if ! "$RCLONE_BIN" cryptcheck "$PLAIN_DIR" "$REMOTE" \
    --one-way --checkers 3 --contimeout 15s --timeout 5m \
    --retries 3 --low-level-retries 10 --log-level ERROR; then
  log "FAIL B2 offsite: cryptcheck не подтвердил целостность объектов"
  exit 1
fi

remote_count=$("$RCLONE_BIN" lsf "$REMOTE" --files-only --log-level ERROR 2>/dev/null |
  awk 'NF { count++ } END { print count + 0 }')
if [ "$remote_count" -lt "$#" ]; then
  log "FAIL B2 offsite: в суточном каталоге меньше объектов, чем отправлено"
  exit 1
fi

for source in "$@"; do
  if [ -s "$source" ]; then
    log "OK B2 offsite: $(basename "$source") -> Backblaze (rclone crypt + cryptcheck)"
  else
    # Source removal during upload is a local backup failure, even if B2
    # accepted the already-open hard link.
    log "FAIL B2 offsite: исходный файл исчез во время загрузки: $(basename "$source")"
    FAILED=1
  fi
done

[ "$FAILED" -eq 0 ] || exit 1
log "OK B2 offsite: загружено и проверено файлов: $#"
