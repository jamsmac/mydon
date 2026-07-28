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
# Cron: */5 * * * * /opt/mydon-stock/healthz_guard.sh >/dev/null 2>&1
set -u
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
cd /opt/mydon-stock

STATE=/opt/backups/.healthz_fails
HOSTPORT=$(grep '^WEB_PORT=' .env | cut -d= -f2-)
HOSTPORT=${HOSTPORT:-127.0.0.1:8080}

MYDON_ENV=/opt/mydon-app/.env
INGEST_KEY=$(grep '^INGEST_KEY=' "$MYDON_ENV" 2>/dev/null | cut -d= -f2-)

# Шлёт событие в MYDON. Возвращает 0, если Core принял.
to_mydon() {  # to_mydon <json>
    [ -n "${INGEST_KEY}" ] || return 1
    curl -sf -m 15 -X POST "http://127.0.0.1:3001/ingest/${INGEST_KEY}" \
         -H 'Content-Type: application/json' -d "$1" > /dev/null 2>&1
}

# Запасной путь: Core молчит — говорим напрямую, как раньше.
# Тревога об инфраструктуре не должна зависеть от той же инфраструктуры.
to_telegram() {  # to_telegram <text>
    BOT_TOKEN=$(grep '^BOT_TOKEN=' .env | cut -d= -f2-)
    CHAT_ID=$(grep '^TG_BACKUP_CHAT_ID=' .env | cut -d= -f2-)
    if [ -z "${CHAT_ID}" ]; then
        CHAT_ID=$(grep '^ADMIN_TG_IDS=' .env | cut -d= -f2- | grep -oE '[0-9]+' | head -1)
    fi
    [ -z "${CHAT_ID}" ] && { echo "$(date -u '+%F %T') healthz: нет чата для алерта" >> /opt/backups/backup.log; return 1; }
    curl -sf -m 30 -F chat_id="${CHAT_ID}" -F text="$1" \
         -K- <<< "url = \"https://api.telegram.org/bot${BOT_TOKEN}/sendMessage\"" > /dev/null
}

# ── Сервис отвечает ──
if curl -sf -m 10 "http://${HOSTPORT}/healthz" > /dev/null 2>&1; then
    PREV=$(cat "$STATE" 2>/dev/null || echo 0)
    rm -f "$STATE"
    # Отбой шлём только если тревога успела уйти (то есть было >= 2 провалов).
    if [ "${PREV:-0}" -ge 2 ]; then
        json=$(printf '{"type":"infra.service_up","source":"healthz_guard","payload":{"service":"mydon-stock","downChecks":%d}}' "$PREV")
        to_mydon "$json" || to_telegram "🟢 mydon-stock снова отвечает (был недоступен ${PREV} проверок)."
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
DOCKER_HEALTH=$(docker inspect --format '{{.State.Health.Status}}' mydon-stock-app-1 2>/dev/null || echo unknown)
if [ "$DOCKER_HEALTH" = "healthy" ]; then
    DETAIL="недоступен с хоста ${FAILS} проверок, но контейнер ЗДОРОВ — похоже на сеть/Tailscale, а не на приложение"
    TEXT="⚠️ mydon-stock: /healthz недоступен с хоста ${FAILS} проверок, но контейнер ЗДОРОВ — проверь tailscale status на сервере."
else
    DETAIL="не отвечает ${FAILS} проверок подряд (docker health: ${DOCKER_HEALTH})"
    TEXT="🚨 mydon-stock: /healthz не отвечает ${FAILS} проверок подряд (docker health: ${DOCKER_HEALTH}). docker logs mydon-stock-app-1"
fi

json=$(printf '{"type":"infra.service_down","source":"healthz_guard","payload":{"service":"mydon-stock","detail":"%s","fails":%d,"dockerHealth":"%s"}}' \
       "$DETAIL" "$FAILS" "$DOCKER_HEALTH")
to_mydon "$json" || to_telegram "$TEXT"

exit 0
