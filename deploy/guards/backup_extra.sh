#!/bin/bash
# Бэкап того, что НЕ покрывал ночной скрипт mydon-stock:
#   1. база нового MYDON (mydon-db)
#   2. код command-center — он БЕЗ git и существует только на этом сервере
#   3. .env-файлы (в отдельном архиве с правами 600 — там секреты)
#
# Работающий скрипт /opt/mydon-stock/backup_offsite.sh намеренно НЕ трогаем.
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

DEST=/opt/backups/extra
DATE=$(date -d '+5 hours' +%F)   # дата по Ташкенту
KEEP_DAYS=30
mkdir -p "$DEST"
FAILED=0

log() { echo "$(date -u '+%F %T') $*"; }

MYDON_INGEST_KEY=$(grep "^INGEST_KEY=" /opt/mydon-app/.env 2>/dev/null | cut -d= -f2-)
to_mydon() {  # событие в Core; при недоступности — алерт напрямую делает вызывающий
    [ -n "${MYDON_INGEST_KEY:-}" ] || return 1
    curl -sf -m 15 -X POST "http://127.0.0.1:3001/ingest/${MYDON_INGEST_KEY}" \
         -H "Content-Type: application/json" -d "$1" > /dev/null 2>&1
}


# --- 1. База нового MYDON ---
if docker ps --format '{{.Names}}' | grep -qx mydon-db; then
  F="$DEST/mydon-app_${DATE}.sql.gz"
  if docker exec -i mydon-db pg_dump --clean --if-exists -U mydon mydon 2>/dev/null | gzip > "$F.tmp"; then
    # Проверяем и целостность архива, и что pg_dump дошёл до конца.
    # tail -6, а не -3: PostgreSQL 16 печатает после маркера ещё строку \unrestrict.
    if gunzip -t "$F.tmp" 2>/dev/null && gunzip -c "$F.tmp" | tail -6 | grep -q "dump complete"; then
      mv "$F.tmp" "$F"; log "OK база MYDON -> $(du -h "$F" | cut -f1)"
    else rm -f "$F.tmp"; log "FAIL база MYDON: дамп повреждён или оборван"; FAILED=1; fi
  else rm -f "$F.tmp"; log "FAIL база MYDON: pg_dump не отработал"; FAILED=1; fi
else
  log "SKIP база MYDON: контейнер mydon-db не запущен"
fi

# --- 2. Код, которого нет в git ---
# command-center существует ТОЛЬКО здесь: потеря = потеря навсегда.
F="$DEST/command-center_${DATE}.tar.gz"
if [ -d /opt/mydon-command-center ]; then
  if tar -czf "$F.tmp" -C /opt --exclude='node_modules' --exclude='.next' --exclude='dist' \
      mydon-command-center 2>/dev/null; then
    mv "$F.tmp" "$F"; log "OK command-center -> $(du -h "$F" | cut -f1)"
  else rm -f "$F.tmp"; log "FAIL command-center"; FAILED=1; fi
fi

# --- 3. Секреты отдельно, с ограниченными правами ---
F="$DEST/env-files_${DATE}.tar.gz"
if tar -czf "$F.tmp" \
     $(find /opt -maxdepth 2 -name '.env' -not -path '*/node_modules/*' 2>/dev/null) 2>/dev/null; then
  mv "$F.tmp" "$F"; chmod 600 "$F"; log "OK .env-файлы -> $(du -h "$F" | cut -f1)"
else rm -f "$F.tmp"; log "SKIP .env-файлы"; fi

# --- 4. OFFSITE: копия за пределы этой машины ---
#
# ЗАЧЕМ. До сих пор наружу уходила только база склада (44 КБ) — её шлёт
# соседний backup_offsite.sh. Главная база MYDON (4,2 МБ) и код
# command-center (1 МБ) лежали ТОЛЬКО на этом диске, рядом с самой базой.
# Локальная копия защищает от «уронил таблицу», но не от потери машины —
# а ровно от неё бэкап и нужен.
#
# Канал — тот же Telegram, что уже носит базу склада: механизм проверен,
# новых учёток не требует. Лимит Bot API — 50 МБ на файл; берём 45 с
# запасом и предупреждаем ЗАРАНЕЕ, а не в день, когда копия перестанет
# уходить. Сегодня суточный объём 5,4 МБ.
#
# СЕКРЕТЫ ОТПРАВЛЯЮТСЯ ТОЛЬКО ЗАШИФРОВАННЫМИ. В env-архиве лежат пароль
# базы, сервис-токен и токены ботов; отправить их открытым текстом значит
# положить ключи от всего контура в чужое хранилище навсегда. Пароль
# шифрования задаёт владелец в /opt/mydon-app/.env и хранит у себя — на
# сервере он тоже есть, но угроза, от которой защищает offsite, это
# ПОТЕРЯ машины, а не её взлом. Пароля нет — архив просто не уходит, и об
# этом говорится вслух.
TG_LIMIT=$((45 * 1024 * 1024))
BOT_TOKEN=$(grep '^BOT_TOKEN=' /opt/mydon-stock/.env 2>/dev/null | cut -d= -f2-)
CHAT_ID=$(grep '^TG_BACKUP_CHAT_ID=' /opt/mydon-stock/.env 2>/dev/null | cut -d= -f2-)
ENC_PASS=$(grep '^BACKUP_ENC_PASSPHRASE=' /opt/mydon-app/.env 2>/dev/null | cut -d= -f2-)

# Токен не попадает в argv (виден в ps): URL уходит через stdin, как в
# backup_offsite.sh.
tg_file() {  # tg_file <файл> <подпись>
    curl -sf --connect-timeout 10 -m 300 \
         -F chat_id="${CHAT_ID}" -F caption="$2" -F document=@"$1" \
         -K- <<< "url = \"https://api.telegram.org/bot${BOT_TOKEN}/sendDocument\"" > /dev/null
}

# Имена переменных — ЛАТИНИЦЕЙ. Bash допускает в идентификаторах только
# [A-Za-z_][A-Za-z0-9_]*: `local имя=…` не объявляет переменную, а падает с
# «not a valid identifier», после чего `$размер` не раскрывается и проверка
# лимита молча не выполняется. Поймано первым же боевым прогоном.
offsite() {  # offsite <файл> <человеческое имя>
    local f=$1 label=$2 size
    [ -f "$f" ] || return 0
    size=$(stat -c %s "$f")
    if [ "$size" -gt "$TG_LIMIT" ]; then
        log "FAIL offsite $label: $(du -h "$f" | cut -f1) больше лимита Telegram — копия НЕ ушла"
        FAILED=1
        return 1
    fi
    if tg_file "$f" "MYDON offsite $DATE — $label ($(du -h "$f" | cut -f1))"; then
        log "OK offsite $label -> Telegram"
    else
        log "FAIL offsite $label: Telegram не принял"
        FAILED=1
    fi
}

if [ -n "${BOT_TOKEN:-}" ] && [ -n "${CHAT_ID:-}" ]; then
    offsite "$DEST/mydon-app_${DATE}.sql.gz" "база MYDON"
    offsite "$DEST/command-center_${DATE}.tar.gz" "код command-center"

    ENV_SRC="$DEST/env-files_${DATE}.tar.gz"
    if [ -f "$ENV_SRC" ]; then
        if [ -n "${ENC_PASS:-}" ]; then
            ENC="$ENV_SRC.enc"
            # -pbkdf2 обязателен: без него openssl берёт однократный MD5,
            # и пароль подбирается перебором на порядки быстрее.
            if printf '%s' "$ENC_PASS" |
               openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
                       -in "$ENV_SRC" -out "$ENC" -pass stdin 2>/dev/null; then
                chmod 600 "$ENC"
                offsite "$ENC" "секреты (зашифровано)"
                rm -f "$ENC"
            else
                log "FAIL offsite секреты: не удалось зашифровать"
                FAILED=1
            fi
        else
            log "SKIP offsite секреты: BACKUP_ENC_PASSPHRASE не задан — открытым текстом не отправляем"
        fi
    fi
else
    log "SKIP offsite: BOT_TOKEN/TG_BACKUP_CHAT_ID не заданы"
fi

# --- 5. Чистка старого ---
find "$DEST" -name '*.gz' -mtime +${KEEP_DAYS} -delete 2>/dev/null
find "$DEST" -name '*.enc' -delete 2>/dev/null

log "итого в $DEST: $(find "$DEST" -name '*.gz' | wc -l) файлов, $(du -sh "$DEST" | cut -f1)"

# ── итог в MYDON: упавший бэкап не имеет права остаться неуслышанным ──
if [ "$FAILED" -ne 0 ]; then
    to_mydon '{"type":"infra.backup_failed","source":"backup_extra","payload":{"what":"база MYDON / command-center","detail":"см. /opt/backups/backup.log"}}' || {
        BT=$(grep "^BOT_TOKEN=" /opt/mydon-stock/.env | cut -d= -f2-)
        CI=$(grep "^TG_BACKUP_CHAT_ID=" /opt/mydon-stock/.env | cut -d= -f2-)
        curl -sf -m 30 -F chat_id="${CI}" -F text="❌ Доп-бэкап (база MYDON / command-center) упал — см. /opt/backups/backup.log" \
             -K- <<< "url = \"https://api.telegram.org/bot${BT}/sendMessage\"" > /dev/null || true
    }
else
    to_mydon "$(printf '{"type":"infra.backup_ok","source":"backup_extra","payload":{"what":"база MYDON + command-center","size":"%s"}}' "$(du -sh "$DEST" | cut -f1)")" || true
fi
exit $FAILED

