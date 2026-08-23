#!/usr/bin/env bash
# Install rclone and configure the second MYDON offsite channel interactively.
# Run on mydon-os as root: /opt/mydon-app/deploy/setup-b2-offsite.sh
set -euo pipefail
umask 077

APP_DIR="${APP_DIR:-/opt/mydon-app}"
ENV_FILE="${B2_ENV_FILE:-$APP_DIR/.env}"
INSTALL_ONLY=0
[ "${1:-}" = "--install-only" ] && INSTALL_ONLY=1

[ "$(id -u)" -eq 0 ] || { echo "Запустите от root." >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "Не найден $ENV_FILE" >&2; exit 1; }

if ! command -v rclone >/dev/null 2>&1; then
  echo "Устанавливаю rclone из репозитория Debian..."
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y rclone
fi
rclone version | head -1

install -d -o root -g root -m 700 /opt/backups
install -o root -g root -m 700 \
  "$APP_DIR/deploy/guards/b2_offsite.sh" /opt/backups/b2_offsite.sh

ensure_env_key() {
  local key=$1 default=${2:-}
  grep -q "^${key}=" "$ENV_FILE" || printf '%s=%s\n' "$key" "$default" >> "$ENV_FILE"
}

ensure_env_key B2_APPLICATION_KEY_ID
ensure_env_key B2_APPLICATION_KEY
ensure_env_key B2_BUCKET
ensure_env_key B2_PREFIX mydon/daily
chmod 600 "$ENV_FILE"

if [ "$INSTALL_ONLY" -eq 1 ]; then
  echo "rclone и B2 helper установлены; значения B2 в $ENV_FILE не изменялись."
  exit 0
fi

[ -t 0 ] || {
  echo "Для ввода ключа нужен интерактивный терминал; повторите с TTY или используйте --install-only." >&2
  exit 2
}

current_value() {
  local key=$1
  awk -v prefix="${key}=" 'index($0, prefix) == 1 { value = substr($0, length(prefix) + 1) } END { print value }' "$ENV_FILE"
}

[ -n "$(current_value BACKUP_ENC_PASSPHRASE)" ] || {
  echo "Сначала задайте BACKUP_ENC_PASSPHRASE и сохраните его вне сервера." >&2
  exit 1
}

upsert_env() {
  local key=$1 value=$2 tmp
  tmp=$(mktemp "${ENV_FILE}.XXXXXX")
  awk -v prefix="${key}=" -v replacement="${key}=${value}" '
    index($0, prefix) == 1 {
      if (!written) print replacement
      written = 1
      next
    }
    { print }
    END { if (!written) print replacement }
  ' "$ENV_FILE" > "$tmp"
  chown --reference="$ENV_FILE" "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$ENV_FILE"
}

default_bucket=$(current_value B2_BUCKET)
read -r -p "Private B2 bucket${default_bucket:+ [$default_bucket]}: " bucket
bucket=${bucket:-$default_bucket}
read -r -p "Application Key ID: " key_id
read -r -s -p "Application Key (ввод скрыт): " app_key
printf '\n'

[ -n "$bucket" ] && [ -n "$key_id" ] && [ -n "$app_key" ] || {
  echo "Bucket и оба значения application key обязательны." >&2
  exit 1
}
case "$bucket" in
  *[!A-Za-z0-9-]*) echo "Недопустимое имя bucket." >&2; exit 1 ;;
esac

upsert_env B2_BUCKET "$bucket"
upsert_env B2_APPLICATION_KEY_ID "$key_id"
upsert_env B2_APPLICATION_KEY "$app_key"

echo "B2 настроен в $ENV_FILE. Ключи и пароль шифрования не выводились."
echo "Следующий /opt/backups/backup_extra.sh отправит три зашифрованных архива в B2."
