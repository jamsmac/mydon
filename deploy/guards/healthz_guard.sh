#!/bin/bash
# Liveness-страж: каждые 5 минут дёргает /healthz.
#
# Переведён на MYDON: вместо прямой отправки в Telegram шлёт событие в Core.
# Что СОХРАНЕНО без изменений, потому что это про качество тревог, а не про канал:
#   • защита от спама — тревога на 2-м провале, дальше примерно раз в час;
#   • различение слоёв — если Docker говорит «контейнер здоров», а /healthz
#     недоступен с хоста, то лежит сеть/Tailscale, а не приложение.
# Защиту от спама намеренно оставляем ЗДЕСЬ: Core шлёт уведомление на каждое
# событие, поэтому отправлять их каждые 5 минут означало бы 12 тревог в час.
#
# ДОБАВЛЕНО: сообщение о восстановлении. Получив тревогу, владелец ждёт отбоя —
# без него приходится лезть на сервер и проверять руками.
#
# П8.2 плана поглощения (docs/PLAN_STOCK_ABSORPTION.md, связь №4): сторож живёт
# по пути mydon и ставится деплоем — `/opt/backups/healthz_guard.sh`. Наблюдает
# он по-прежнему панель склада (до П8 она жива), но САМ от каталога склада не
# зависит: секреты и ключи — только из окружения mydon.
#
# Cron: */5 * * * * /opt/backups/healthz_guard.sh >/dev/null 2>&1
set -u
# Cron даёт куцый PATH — задаём полный явно. Префикс переопределяется ТОЛЬКО
# ради тестов (подмена df/curl фикстурами, deploy/tests/guards-env.test.sh):
# на сервере переменная не выставляется и PATH остаётся боевым.
export PATH=${GUARD_PATH_PREFIX:+${GUARD_PATH_PREFIX}:}/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Пути переопределяемы ТОЛЬКО ради тестов (deploy/tests/guards-env.test.sh):
# на сервере переменные не выставляются и действуют боевые значения.
MYDON_ENV=${MYDON_ENV_FILE:-/opt/mydon-app/.env}
ALERT_ENV=${WATCHDOG_ENV_FILE:-/etc/mydon-heartbeat.env}
# Адрес наблюдаемой панели склада она держит в своём .env. Это ЕДИНСТВЕННОЕ,
# что здесь ещё читается из /opt/mydon-stock, и это адрес, а не секрет: пока
# склад жив, брать адрес из его же конфигурации честнее, чем зашивать в git
# Tailscale-IP, который однажды сменится и даст ложную тревогу. Чтобы снять и
# эту зависимость — задайте HEALTHZ_TARGET в .env mydon, он имеет приоритет.
STOCK_ENV=${STOCK_ENV_FILE:-/opt/mydon-stock/.env}
STATE=${HEALTHZ_STATE_FILE:-/opt/backups/.healthz_fails}
GUARD_LOG=${GUARD_LOG_FILE:-/opt/backups/backup.log}
CORE_INGEST=${CORE_INGEST_URL:-http://127.0.0.1:3001/ingest}
CONTAINER=${HEALTHZ_CONTAINER:-mydon-stock-app-1}
SERVICE=${HEALTHZ_SERVICE:-mydon-stock}

log() {  # log <текст>: в журнал бэкапов; если он недоступен — хотя бы в stderr
    local line
    line="$(date -u '+%F %T') healthz: $*"
    printf '%s\n' "$line" >> "$GUARD_LOG" 2>/dev/null || printf '%s\n' "$line" >&2
}

env_value() {  # env_value <ключ> <файл>
    [ -r "$2" ] || return 0
    grep "^$1=" "$2" 2>/dev/null | tail -1 | cut -d= -f2-
}

# ── Конфигурация проверяется до первой проверки здоровья ──
# Сторож без ключей не сторож: он ходит по кругу и молчит в том числе тогда,
# когда сервис действительно лёг.
if [ ! -r "$MYDON_ENV" ]; then
    log "ОШИБКА: не читается env mydon ($MYDON_ENV) — ни событие в Core, ни тревога отправлены не будут"
    exit 1
fi

INGEST_KEY=$(env_value INGEST_KEY "$MYDON_ENV")

# Аварийный канал — та же лесенка, что в backup_extra.sh и disk_guard.sh
# (П1 плана поглощения): свои TG_BACKUP_* → аварийный бот сторожа.
# Бота склада (BOT_TOKEN/ADMIN_TG_IDS из /opt/mydon-stock/.env) здесь больше нет.
BOT_TOKEN=$(env_value TG_BACKUP_BOT_TOKEN "$MYDON_ENV")
CHAT_ID=$(env_value TG_BACKUP_CHAT_ID "$MYDON_ENV")
if [ -z "${BOT_TOKEN:-}" ] || [ -z "${CHAT_ID:-}" ]; then
    BOT_TOKEN=$(env_value WATCHDOG_BOT_TOKEN "$ALERT_ENV")
    # WATCHDOG_CHAT_IDS — список через запятую; сообщению нужен один чат — первый.
    CHAT_ID=$(env_value WATCHDOG_CHAT_IDS "$ALERT_ENV" | cut -d, -f1 | tr -d '[:space:]')
fi

if [ -z "${INGEST_KEY:-}" ] && { [ -z "${BOT_TOKEN:-}" ] || [ -z "${CHAT_ID:-}" ]; }; then
    log "ОШИБКА: нет ни INGEST_KEY в $MYDON_ENV, ни аварийного бота (TG_BACKUP_* там же или WATCHDOG_* в $ALERT_ENV) — о падении ${SERVICE} сказать будет некому"
    exit 1
fi

HOSTPORT=$(env_value HEALTHZ_TARGET "$MYDON_ENV")
[ -n "${HOSTPORT:-}" ] || HOSTPORT=$(env_value WEB_PORT "$STOCK_ENV")
HOSTPORT=${HOSTPORT:-127.0.0.1:8080}

# Шлёт событие в MYDON. Возвращает 0, если Core принял.
to_mydon() {  # to_mydon <json>
    [ -n "${INGEST_KEY}" ] || return 1
    curl -sf -m 15 -X POST "${CORE_INGEST}/${INGEST_KEY}" \
         -H 'Content-Type: application/json' -d "$1" > /dev/null 2>&1
}

# Запасной путь: Core молчит — говорим напрямую, как раньше.
# Тревога об инфраструктуре не должна зависеть от той же инфраструктуры.
to_telegram() {  # to_telegram <text>
    if [ -z "${BOT_TOKEN:-}" ] || [ -z "${CHAT_ID:-}" ]; then
        log "нет канала для алерта (TG_BACKUP_* / WATCHDOG_*)"
        return 1
    fi
    # Токен не попадает в argv (виден в ps): URL уходит через stdin (curl -K-).
    curl -sf -m 30 -F chat_id="${CHAT_ID}" -F text="$1" \
         -K- <<< "url = \"https://api.telegram.org/bot${BOT_TOKEN}/sendMessage\"" > /dev/null
}

# ── Сервис отвечает ──
if curl -sf -m 10 "http://${HOSTPORT}/healthz" > /dev/null 2>&1; then
    PREV=$(cat "$STATE" 2>/dev/null || echo 0)
    rm -f "$STATE"
    # Отбой шлём только если тревога успела уйти (то есть было >= 2 провалов).
    if [ "${PREV:-0}" -ge 2 ]; then
        json=$(printf '{"type":"infra.service_up","source":"healthz_guard","payload":{"service":"%s","downChecks":%d}}' "$SERVICE" "$PREV")
        to_mydon "$json" || to_telegram "🟢 ${SERVICE} снова отвечает (был недоступен ${PREV} проверок)."
    fi
    exit 0
fi

# ── Сервис не отвечает ──
FAILS=$(( $(cat "$STATE" 2>/dev/null || echo 0) + 1 ))
echo "$FAILS" > "$STATE"
[ "$FAILS" -lt 2 ] && exit 0
# слать на 2-м провале и далее каждые ~12 циклов (раз в час)
if [ "$FAILS" -ne 2 ] && [ $((FAILS % 12)) -ne 2 ]; then
    exit 0
fi

# Различаем слои: контейнер сам себя проверяет изнутри (compose healthcheck) —
# если Docker говорит healthy, лежит НЕ приложение, а сеть/Tailscale до панели.
DOCKER_HEALTH=$(docker inspect --format '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo unknown)
if [ "$DOCKER_HEALTH" = "healthy" ]; then
    DETAIL="недоступен с хоста ${FAILS} проверок, но контейнер ЗДОРОВ — похоже на сеть/Tailscale, а не на приложение"
    TEXT="⚠️ ${SERVICE}: /healthz недоступен с хоста ${FAILS} проверок, но контейнер ЗДОРОВ — проверь tailscale status на сервере."
else
    DETAIL="не отвечает ${FAILS} проверок подряд (docker health: ${DOCKER_HEALTH})"
    TEXT="🚨 ${SERVICE}: /healthz не отвечает ${FAILS} проверок подряд (docker health: ${DOCKER_HEALTH}). docker logs ${CONTAINER}"
fi

json=$(printf '{"type":"infra.service_down","source":"healthz_guard","payload":{"service":"%s","detail":"%s","fails":%d,"dockerHealth":"%s"}}' \
       "$SERVICE" "$DETAIL" "$FAILS" "$DOCKER_HEALTH")
to_mydon "$json" || to_telegram "$TEXT"

exit 0
