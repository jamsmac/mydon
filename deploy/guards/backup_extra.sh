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

# --- 4. Чистка старого ---
find "$DEST" -name '*.gz' -mtime +${KEEP_DAYS} -delete 2>/dev/null

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

