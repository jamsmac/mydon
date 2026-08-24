#!/bin/bash
# Бэкап того, что НЕ покрывал ночной скрипт mydon-stock:
#   1. активная база MYDON (локальная или managed PostgreSQL)
#   2. код command-center — он БЕЗ git и существует только на этом сервере
#   3. .env-файлы (в отдельном архиве с правами 600 — там секреты)
#
# Работающий скрипт /opt/mydon-stock/backup_offsite.sh намеренно НЕ трогаем.
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

DEST=/opt/backups/extra
DATE=$(date -d '+5 hours' +%F)   # дата по Ташкенту
KEEP_DAYS=30
DB_HELPER=${DB_HELPER:-/opt/backups/db_access.sh}
DB_ENV_FILE=${DB_ENV_FILE:-/opt/mydon-app/.env}
mkdir -p "$DEST"
FAILED=0

log() { echo "$(date -u '+%F %T') $*"; }

MYDON_INGEST_KEY=$(grep "^INGEST_KEY=" /opt/mydon-app/.env 2>/dev/null | cut -d= -f2-)
to_mydon() {  # событие в Core; при недоступности — алерт напрямую делает вызывающий
    [ -n "${MYDON_INGEST_KEY:-}" ] || return 1
    curl -sf -m 15 -X POST "http://127.0.0.1:3001/ingest/${MYDON_INGEST_KEY}" \
         -H "Content-Type: application/json" -d "$1" > /dev/null 2>&1
}


# --- 1. Активная база MYDON ---
F="$DEST/mydon-app_${DATE}.sql.gz"
if [ ! -x "$DB_HELPER" ]; then
  log "FAIL база MYDON: helper $DB_HELPER не установлен"
  FAILED=1
elif "$DB_HELPER" dump | gzip > "$F.tmp"; then
  # Проверяем и gzip, и финальный маркер pg_dump. Новые версии PostgreSQL могут
  # печатать после маркера служебный \unrestrict, поэтому смотрим хвост шире.
  if gunzip -t "$F.tmp" 2>/dev/null && gunzip -c "$F.tmp" | tail -10 | grep -q "dump complete"; then
    mv "$F.tmp" "$F"; log "OK база MYDON -> $(du -h "$F" | cut -f1)"
  else rm -f "$F.tmp"; log "FAIL база MYDON: дамп повреждён или оборван"; FAILED=1; fi
else
  rm -f "$F.tmp"; log "FAIL база MYDON: pg_dump не отработал"; FAILED=1
fi

# Managed plans have a hard database-size ceiling. Check it after the dump so
# a capacity warning never prevents the offsite copy itself from being made.
DB_SIZE_WARN_MB=$(grep '^DATABASE_SIZE_WARN_MB=' "$DB_ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2-)
DB_SIZE_WARN_MB=${DB_SIZE_WARN_MB:-0}
if ! [[ "$DB_SIZE_WARN_MB" =~ ^[0-9]+$ ]]; then
  log "FAIL база MYDON: DATABASE_SIZE_WARN_MB должен быть целым числом"
  FAILED=1
elif [ "$DB_SIZE_WARN_MB" -gt 0 ] && [ -x "$DB_HELPER" ]; then
  DB_SIZE_BYTES=$("$DB_HELPER" query 'select pg_database_size(current_database())' 2>/dev/null | tr -d '[:space:]')
  if [[ "$DB_SIZE_BYTES" =~ ^[0-9]+$ ]]; then
    DB_SIZE_MB=$(( (DB_SIZE_BYTES + 1048575) / 1048576 ))
    if [ "$DB_SIZE_MB" -ge "$DB_SIZE_WARN_MB" ]; then
      log "FAIL база MYDON: размер ${DB_SIZE_MB} МБ достиг порога ${DB_SIZE_WARN_MB} МБ"
      FAILED=1
    else
      log "OK ёмкость БД: ${DB_SIZE_MB} МБ из порога ${DB_SIZE_WARN_MB} МБ"
    fi
  else
    log "FAIL база MYDON: не удалось измерить размер"
    FAILED=1
  fi
fi

# --- 2. Код, которого нет в git ---
# command-center существует ТОЛЬКО здесь: потеря = потеря навсегда.
F="$DEST/command-center_${DATE}.tar.gz"
if [ -d /opt/mydon-command-center ]; then
  if tar -czf "$F.tmp" -C /opt --exclude='node_modules' --exclude='.next' --exclude='dist' \
      mydon-command-center 2>/dev/null; then
    mv "$F.tmp" "$F"; log "OK command-center -> $(du -h "$F" | cut -f1)"
  else rm -f "$F.tmp"; log "FAIL command-center"; FAILED=1; fi
else
  log "FAIL command-center: каталог /opt/mydon-command-center не найден"
  FAILED=1
fi

# --- 3. Секреты отдельно, с ограниченными правами ---
F="$DEST/env-files_${DATE}.tar.gz"
ENV_FILES=()
while IFS= read -r -d '' env_file; do
  ENV_FILES+=("$env_file")
done < <(find /opt -maxdepth 2 -name '.env' -not -path '*/node_modules/*' -print0 2>/dev/null)
if [ "${#ENV_FILES[@]}" -eq 0 ]; then
  log "FAIL .env-файлы: ни одного файла не найдено"
  FAILED=1
elif tar -czf "$F.tmp" "${ENV_FILES[@]}" 2>/dev/null; then
  mv "$F.tmp" "$F"; chmod 600 "$F"; log "OK .env-файлы -> $(du -h "$F" | cut -f1)"
else rm -f "$F.tmp"; log "FAIL .env-файлы"; FAILED=1; fi

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
            log "FAIL offsite секреты: BACKUP_ENC_PASSPHRASE не задан — открытым текстом не отправляем"
            FAILED=1
        fi
    fi
else
    log "FAIL offsite: BOT_TOKEN/TG_BACKUP_CHAT_ID не заданы"
    FAILED=1
fi

# --- 5. ВТОРОЙ OFFSITE: Backblaze B2, всё с клиентским шифрованием ---
#
# B2 не заменяет Telegram. Это независимая копия у другого провайдера. Helper
# возвращает 3, пока bucket и ограниченный application key ещё не настроены;
# частичная конфигурация или ошибка загрузки уже считаются отказом backup.
B2_HELPER=/opt/backups/b2_offsite.sh
if [ -x "$B2_HELPER" ]; then
    "$B2_HELPER" "$DATE" \
        "$DEST/mydon-app_${DATE}.sql.gz" \
        "$DEST/command-center_${DATE}.tar.gz" \
        "$DEST/env-files_${DATE}.tar.gz"
    B2_STATUS=$?
    case "$B2_STATUS" in
        0) log "OK второй offsite -> Backblaze B2" ;;
        3) log "INFO второй offsite B2 ещё не настроен" ;;
        *) log "FAIL второй offsite Backblaze B2"; FAILED=1 ;;
    esac
else
    log "FAIL второй offsite: $B2_HELPER не установлен"
    FAILED=1
fi

# --- 6. Чистка старого ---
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
