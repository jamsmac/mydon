#!/usr/bin/env bash
# OnFailure-крюк mydon-autodeploy.service: ловит отказы, о которых сам
# auto-deploy.sh сообщить не может — прежде всего kill по TimeoutStartSec
# (зависшая сборка): завершение 143 его on_exit сознательно не учитывает
# (не отличить от операторского стопа), и цикл «висим 30 мин → kill →
# немедленный повтор» шёл бы вечно без единого сигнала.
#
# Если on_exit успел отработать (свежий .fail-at), обычный алерт уже ушёл —
# молчим, чтобы не дублировать. Иначе шлём тревогу и взводим кулдаун сами.
set -uo pipefail

APP_DIR="${AUTODEPLOY_APP_DIR:-/opt/mydon-app}"
BACKUP_DIR="${AUTODEPLOY_BACKUP_DIR:-/opt/backups/mydon-autodeploy}"
STOCK_ENV="${AUTODEPLOY_STOCK_ENV:-/opt/mydon-stock/.env}"

log() { echo "$(date '+%F %T') deploy-alert: $*"; }

now=$(date +%s)
fail_at=$(cat "$BACKUP_DIR/.fail-at" 2>/dev/null || printf 0)
if [ $(( now - fail_at )) -le 120 ]; then
  log "on_exit уже учёл сбой (${fail_at}) — алерт не дублирую"
  exit 0
fi

sha=$(git -C "$APP_DIR" rev-parse origin/main 2>/dev/null || printf unknown)
# Взводим учёт сбоя: без него следующий тик перезапустил бы зависающую
# сборку немедленно, и цикл «30 минут виса» шёл бы спина к спине.
mkdir -p "$BACKUP_DIR" 2>/dev/null || true
printf '%s\n' "$sha" > "$BACKUP_DIR/.fail-sha"
printf '%s\n' "$now" > "$BACKUP_DIR/.fail-at"
if [ ! -f "$BACKUP_DIR/.fail-first-at" ]; then
  printf '%s\n' "$now" > "$BACKUP_DIR/.fail-first-at"
fi

msg="❌ Автодеплой MYDON убит аварийно (таймаут сборки/kill) на ${sha}. journalctl -u mydon-autodeploy.service"
ingest_key=$(grep '^INGEST_KEY=' "$APP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)
if [ -n "$ingest_key" ] &&
  curl -sf -m 15 -X POST "http://127.0.0.1:3001/ingest/${ingest_key}" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"infra.deploy_failed\",\"source\":\"deploy-failure-alert\",\"payload\":{\"commit\":\"$sha\",\"detail\":\"убит аварийно (таймаут сборки/kill); journalctl -u mydon-autodeploy.service\"}}" \
    >/dev/null 2>&1; then
  log "алерт ушёл в Core"
  exit 0
fi
BT=$(grep '^BOT_TOKEN=' "$STOCK_ENV" 2>/dev/null | tail -1 | cut -d= -f2- || true)
CI=$(grep '^TG_BACKUP_CHAT_ID=' "$STOCK_ENV" 2>/dev/null | tail -1 | cut -d= -f2- || true)
if [ -n "$BT" ] && [ -n "$CI" ]; then
  tg_resp=$(curl -sS -m 30 -F chat_id="$CI" -F text="$msg" \
    -K- <<< "url = \"https://api.telegram.org/bot${BT}/sendMessage\"" 2>/dev/null || true)
  if printf '%s' "$tg_resp" | grep -q '"ok":true'; then
    log "алерт ушёл в Telegram"
    exit 0
  fi
fi
log "алерт НЕ доставлен — только журнал: $msg"
