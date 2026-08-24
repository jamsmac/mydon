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
# П8.2 плана поглощения (docs/PLAN_STOCK_ABSORPTION.md, связь №4): сторож живёт
# по пути mydon и ставится деплоем — `/opt/backups/disk_guard.sh`. Прежняя копия
# лежала в `/opt/mydon-stock/`, обновлялась руками и отстала от git на месяц:
# переезд склада унёс бы сторожа диска вместе с собой. Секреты берутся только из
# окружения mydon; бот склада здесь больше не при чём.
#
# Cron: 0 6 * * * /opt/backups/disk_guard.sh  (11:00 по Ташкенту)
set -uo pipefail
# Cron даёт куцый PATH — задаём полный явно. Префикс переопределяется ТОЛЬКО
# ради тестов (подмена df/curl фикстурами, deploy/tests/guards-env.test.sh):
# на сервере переменная не выставляется и PATH остаётся боевым.
export PATH=${GUARD_PATH_PREFIX:+${GUARD_PATH_PREFIX}:}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Пути переопределяемы ТОЛЬКО ради тестов (deploy/tests/guards-env.test.sh):
# на сервере переменные не выставляются и действуют боевые значения.
MYDON_ENV=${MYDON_ENV_FILE:-/opt/mydon-app/.env}
ALERT_ENV=${WATCHDOG_ENV_FILE:-/etc/mydon-heartbeat.env}
GUARD_LOG=${GUARD_LOG_FILE:-/opt/backups/backup.log}
CORE_INGEST=${CORE_INGEST_URL:-http://127.0.0.1:3001/ingest}

log() {  # log <текст>: в журнал бэкапов; если он недоступен — хотя бы в stderr
    local line
    line="$(date -u '+%F %T') disk_guard: $*"
    printf '%s\n' "$line" >> "$GUARD_LOG" 2>/dev/null || printf '%s\n' "$line" >&2
}

env_value() {  # env_value <ключ> <файл>
    [ -r "$2" ] || return 0
    grep "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2-
}

# ── Конфигурация проверяется ДО измерения диска ──
# Сторож без ключей молчит ровно до дня аварии, а в этот день молчит тоже.
# Проверять после раннего выхода «диск ниже 70%» значит узнать о поломке
# конфигурации в тот единственный момент, когда узнавать уже поздно.
if [ ! -r "$MYDON_ENV" ]; then
    log "ОШИБКА: не читается env mydon ($MYDON_ENV) — ни событие в Core, ни тревога отправлены не будут"
    exit 1
fi

INGEST_KEY=$(env_value INGEST_KEY "$MYDON_ENV")

# Аварийный канал — та же лесенка, что в backup_extra.sh (П1 плана поглощения):
#   1) свои TG_BACKUP_* в .env mydon — владелец выбирает бот и чат сам;
#   2) фолбэк — аварийный бот сторожа из /etc/mydon-heartbeat.env.
# Бота склада (/opt/mydon-stock/.env) в лесенке больше нет.
BOT_TOKEN=$(env_value TG_BACKUP_BOT_TOKEN "$MYDON_ENV")
CHAT_ID=$(env_value TG_BACKUP_CHAT_ID "$MYDON_ENV")
if [ -z "${BOT_TOKEN:-}" ] || [ -z "${CHAT_ID:-}" ]; then
    BOT_TOKEN=$(env_value WATCHDOG_BOT_TOKEN "$ALERT_ENV")
    # WATCHDOG_CHAT_IDS — список через запятую; сообщению нужен один чат — первый.
    CHAT_ID=$(env_value WATCHDOG_CHAT_IDS "$ALERT_ENV" | cut -d, -f1 | tr -d '[:space:]')
fi

if [ -z "${INGEST_KEY:-}" ] && { [ -z "${BOT_TOKEN:-}" ] || [ -z "${CHAT_ID:-}" ]; }; then
    log "ОШИБКА: нет ни INGEST_KEY в $MYDON_ENV, ни аварийного бота (TG_BACKUP_* там же или WATCHDOG_* в $ALERT_ENV) — о заполненном диске сказать будет некому"
    exit 1
fi

USED=$(df -P / | awk 'NR==2 {print $5+0}')

# Ниже 70% MYDON всё равно промолчит — не тратим вызов.
[ "$USED" -lt 70 ] && exit 0

sent_to_mydon=0
if [ -n "${INGEST_KEY:-}" ]; then
    payload=$(printf '{"type":"infra.disk","source":"disk_guard","payload":{"usedPercent":%d,"host":"hetzner"}}' "$USED")
    if curl -sf -m 15 -X POST "${CORE_INGEST}/${INGEST_KEY}" \
            -H 'Content-Type: application/json' -d "$payload" > /dev/null 2>&1; then
        sent_to_mydon=1
    fi
fi

# Запасной путь: MYDON не ответил, а диск уже в красной зоне — говорим напрямую.
if [ "$sent_to_mydon" -eq 0 ] && [ "$USED" -ge 85 ]; then
    if [ -z "${BOT_TOKEN:-}" ] || [ -z "${CHAT_ID:-}" ]; then
        log "ОШИБКА: диск ${USED}%, MYDON не ответил, а аварийного канала нет — тревога никуда не ушла"
        exit 1
    fi
    # Токен не попадает в argv (виден в ps): URL уходит через stdin (curl -K-).
    curl -sf -m 30 -F chat_id="${CHAT_ID}" \
         -F text="🚨 Диск Hetzner заполнен на ${USED}%. (MYDON не ответил — сообщение напрямую.) Смотри: docker system df, /opt/backups." \
         -K- <<< "url = \"https://api.telegram.org/bot${BOT_TOKEN}/sendMessage\"" > /dev/null ||
        log "ОШИБКА: диск ${USED}%, Telegram не принял тревогу"
fi

exit 0
