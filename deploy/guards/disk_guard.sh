#!/bin/bash
# Дневной страж диска.
#
# Переведён на MYDON: вместо прямой отправки в Telegram шлёт событие в Core,
# а решение «срочно или в утреннюю сводку» принимают правила (порог 70% и 85%).
# Выигрыш: пороги меняются в одном месте, каждое срабатывание попадает в журнал.
#
# ВАЖНО: если MYDON недоступен, сообщение уходит напрямую в Telegram, как раньше.
# Тревога об инфраструктуре не должна зависеть от той же инфраструктуры —
# иначе при падении сервера некому будет сообщить, что сервер упал.
#
# Cron: 0 6 * * * /opt/mydon-stock/disk_guard.sh  (11:00 по Ташкенту)
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
# cd в /opt/mydon-stock больше не нужен: прежний код читал .env склада из
# cwd, теперь все пути абсолютные (П1 плана поглощения).

USED=$(df -P / | awk 'NR==2 {print $5+0}')

# Ниже 70% MYDON всё равно промолчит — не тратим вызов.
[ "$USED" -lt 70 ] && exit 0

MYDON_ENV=/opt/mydon-app/.env
INGEST_KEY=$(grep '^INGEST_KEY=' "$MYDON_ENV" 2>/dev/null | cut -d= -f2-)

sent_to_mydon=0
if [ -n "${INGEST_KEY}" ]; then
    payload=$(printf '{"type":"infra.disk","source":"disk_guard","payload":{"usedPercent":%d,"host":"hetzner"}}' "$USED")
    if curl -sf -m 15 -X POST "http://127.0.0.1:3001/ingest/${INGEST_KEY}" \
            -H 'Content-Type: application/json' -d "$payload" > /dev/null 2>&1; then
        sent_to_mydon=1
    fi
fi

# Запасной путь: MYDON не ответил, а диск уже в красной зоне — говорим напрямую.
# П1 плана поглощения: канал больше не зависит от бота склада — та же лесенка,
# что в backup_extra.sh: свои TG_BACKUP_* → аварийный бот сторожа.
if [ "$sent_to_mydon" -eq 0 ] && [ "$USED" -ge 85 ]; then
    BOT_TOKEN=$(grep '^TG_BACKUP_BOT_TOKEN=' "$MYDON_ENV" 2>/dev/null | tail -1 | cut -d= -f2-)
    CHAT_ID=$(grep '^TG_BACKUP_CHAT_ID=' "$MYDON_ENV" 2>/dev/null | tail -1 | cut -d= -f2-)
    if [ -z "${BOT_TOKEN:-}" ] || [ -z "${CHAT_ID:-}" ]; then
        BOT_TOKEN=$(grep '^WATCHDOG_BOT_TOKEN=' /etc/mydon-heartbeat.env 2>/dev/null | tail -1 | cut -d= -f2-)
        CHAT_ID=$(grep '^WATCHDOG_CHAT_IDS=' /etc/mydon-heartbeat.env 2>/dev/null | tail -1 | cut -d= -f2- | cut -d, -f1 | tr -d '[:space:]')
    fi
    curl -sf -m 30 -F chat_id="${CHAT_ID}" \
         -F text="🚨 Диск Hetzner заполнен на ${USED}%. (MYDON не ответил — сообщение напрямую.) Смотри: docker system df, /opt/backups." \
         -K- <<< "url = \"https://api.telegram.org/bot${BOT_TOKEN}/sendMessage\"" > /dev/null
fi

exit 0
