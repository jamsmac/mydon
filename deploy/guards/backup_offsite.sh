#!/bin/bash
# Ночной бэкап mydon-stock: локально (/opt/backups, 60 дней) + offsite в Telegram.
#
# Переведён на MYDON: уведомления о результате идут событиями в Core
# (журнал + утренняя сводка). САМ ФАЙЛ дампа по-прежнему уходит в Telegram
# напрямую — он и есть offsite-копия; маршрутизировать её через MYDON значило бы
# встроить точку отказа в сам механизм защиты от отказов.
#
# Запасной путь: если Core не ответил, алерт уходит в Telegram напрямую,
# как раньше. Упавший бэкап не имеет права остаться неуслышанным.
#
# Cron: 0 22 * * * (03:00 по Ташкенту)
set -euo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
cd /opt/mydon-stock

BOT_TOKEN=$(grep '^BOT_TOKEN=' .env | cut -d= -f2-)
CHAT_ID=$(grep '^TG_BACKUP_CHAT_ID=' .env | cut -d= -f2-)
INGEST_KEY=$(grep '^INGEST_KEY=' /opt/mydon-app/.env 2>/dev/null | cut -d= -f2- || true)

# Токен не попадает в argv (виден в ps на shared-хосте) — URL уходит через stdin (curl -K-).
tg() {  # tg <method> <timeout> [curl -F args...]
    local method=$1 tmo=$2; shift 2
    curl -sf --connect-timeout 10 -m "$tmo" "$@" \
         -K- <<< "url = \"https://api.telegram.org/bot${BOT_TOKEN}/${method}\"" > /dev/null
}

to_mydon() {  # to_mydon <json>: событие в Core; 0 — принято
    [ -n "${INGEST_KEY}" ] || return 1
    curl -sf -m 15 -X POST "http://127.0.0.1:3001/ingest/${INGEST_KEY}" \
         -H 'Content-Type: application/json' -d "$1" > /dev/null 2>&1
}

fail() {
    local json
    json=$(printf '{"type":"infra.backup_failed","source":"backup_offsite","payload":{"what":"база склада (mydon-stock)","detail":"строка %s, подробности в /opt/backups/backup.log"}}' "$1")
    to_mydon "$json" || tg sendMessage 30 -F chat_id="${CHAT_ID}" \
       -F text="❌ Бэкап mydon-stock УПАЛ: $(date -u '+%F %T') UTC, строка $1. Проверь /opt/backups/backup.log" || true
    echo "$(date -u '+%F %T') FAIL line $1"
}
trap 'fail $LINENO' ERR

DATE=$(date -d '+5 hours' +%F)   # дата по Ташкенту
FILE="/opt/backups/mydon_${DATE}.sql.gz"
TMP="${FILE}.tmp"

# Дамп в staging-файл: недописанный дамп никогда не занимает слот суточного бэкапа.
docker compose exec -T db pg_dump --clean --if-exists -U mydon mydon | gzip > "$TMP"
gunzip -t "$TMP"
gunzip -c "$TMP" | tail -n 5 | grep -q 'PostgreSQL database dump complete'
mv "$TMP" "$FILE"

SIZE=$(du -h "$FILE" | cut -f1)
SIZE_B=$(stat -c%s "$FILE")
if [ "$SIZE_B" -gt 47000000 ]; then
    # Лимит Bot API — 50MB: бэкап есть, но offsite-копии НЕТ. Говорим громко.
    json=$(printf '{"type":"infra.backup_oversize","source":"backup_offsite","payload":{"what":"база склада (mydon-stock)","size":"%s","file":"%s"}}' "$SIZE" "$FILE")
    to_mydon "$json" || tg sendMessage 30 -F chat_id="${CHAT_ID}" \
       -F text="⚠️ Бэкап mydon-stock ${DATE} (${SIZE}) превысил лимит Telegram — лежит только локально: ${FILE}. Пора добавить второй offsite (B2/Storage Box)."
else
    # Сам файл — напрямую в Telegram: это offsite-копия, а не уведомление.
    # -m 300: многомегабайтная загрузка не должна упираться в 30-секундный таймаут.
    tg sendDocument 300 -F chat_id="${CHAT_ID}" -F document=@"${FILE}" \
       -F caption="🗄 Бэкап mydon-stock ${DATE} (${SIZE}). Восстановление: gunzip -c файл | docker compose exec -T db psql -U mydon -v ON_ERROR_STOP=1 --single-transaction mydon"
    # Событие об успехе — в журнал и утреннюю сводку. Не страшно, если Core спит:
    # файл уже в Telegram, это и есть подтверждение.
    to_mydon "$(printf '{"type":"infra.backup_ok","source":"backup_offsite","payload":{"what":"база склада (mydon-stock)","size":"%s"}}' "$SIZE")" || true
fi

# --- второй offsite: Hetzner Storage Box (включается переменной в .env) ---
# STORAGE_BOX=u123456@u123456.your-storagebox.de  (SSH-ключ /root/.ssh/storagebox
# должен быть добавлен в боксе; порт 23). Без переменной шаг просто пропускается.
# Host-key бокса ПИНЕН в known_hosts_storagebox (заполняется при настройке через
# ssh-keyscan + сверку отпечатка с docs.hetzner.com) — по каналу идут полные дампы,
# TOFU здесь недопустим.
SB=$(grep '^STORAGE_BOX=' .env | cut -d= -f2- || true)
if [ -n "${SB}" ]; then
    rsync -az -e "ssh -p 23 -i /root/.ssh/storagebox -o UserKnownHostsFile=/root/.ssh/known_hosts_storagebox -o StrictHostKeyChecking=yes -o ConnectTimeout=20" \
        /opt/backups/ "${SB}:mydon-stock-backups/"
    echo "$(date -u '+%F %T') OK storage-box sync"
fi

find /opt/backups -name 'mydon_*.sql.gz' -mtime +60 -delete
find /opt/backups -name '*.tmp' -mtime +1 -delete
echo "$(date -u '+%F %T') OK ${FILE} ${SIZE}"
