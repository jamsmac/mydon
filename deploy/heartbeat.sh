#!/usr/bin/env bash
# Heartbeat MYDON — «я жив» для внешнего сторожа (dead-man switch).
#
# Наружу с сервера ничего не открыто (всё на 127.0.0.1/Tailscale), поэтому
# внешний сторож не может опрашивать сервер сам. Вместо этого сервер каждые
# 2 минуты пишет отметку в GitHub Gist; сторож (GitHub Actions,
# .github/workflows/watchdog.yml) проверяет её свежесть с ДРУГОГО провайдера
# и бьёт тревогу в отдельный Telegram-бот, если отметка протухла.
#
# Настройка: /etc/mydon-heartbeat.env с
#   HEARTBEAT_GIST_ID=...      # id приватного gist c файлом heartbeat.json
#   HEARTBEAT_GH_TOKEN=...     # fine-grained token, право только Gists:write
# См. docs/watchdog.md.
set -euo pipefail

ENV_FILE="/etc/mydon-heartbeat.env"
[ -f "$ENV_FILE" ] || { echo "нет $ENV_FILE — heartbeat не настроен"; exit 1; }
# shellcheck disable=SC1090
. "$ENV_FILE"
: "${HEARTBEAT_GIST_ID:?HEARTBEAT_GIST_ID не задан}"
: "${HEARTBEAT_GH_TOKEN:?HEARTBEAT_GH_TOKEN не задан}"

# Короткий статус: какие контейнеры живы. Диагноз в тревоге ценнее голого «жив».
containers="$(docker ps --format '{{.Names}}:{{.Status}}' 2>/dev/null | head -12 | tr '\n' ';' || true)"
disk_avail="$(df -BG --output=avail / | tail -1 | tr -dc '0-9' || echo '?')"
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

payload="$(printf '{"ts":"%s","host":"mydon-os","disk_avail_gb":"%s","containers":"%s"}' \
  "$ts" "$disk_avail" "$containers")"

# PATCH gist: содержимое файла heartbeat.json заменяется целиком.
body="$(printf '{"files":{"heartbeat.json":{"content":%s}}}' "$(printf '%s' "$payload" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")"

resp="$(mktemp)"
trap 'rm -f "$resp"' EXIT

# curl без -f не отличает HTTP-ошибку от успеха: PATCH без права записи в
# Gist отвечает 403/404 с телом ошибки, а curl всё равно завершается нулём.
# Найдено на практике: fine-grained PAT не поддерживает Gists вовсе, и без
# этой проверки скрипт часами печатал "heartbeat отправлен", пока gist молча
# оставался пустым — сторож в это время без единого сбоя решал, что сервер
# лежит, хотя сервер был жив и исправно (как ему казалось) отчитывался.
code="$(curl -sS -o "$resp" -w '%{http_code}' -X PATCH \
  -H "Authorization: Bearer $HEARTBEAT_GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  --max-time 20 \
  -d "$body" \
  "https://api.github.com/gists/$HEARTBEAT_GIST_ID" || echo "000")"

if [ "$code" != "200" ]; then
  echo "heartbeat НЕ отправлен: GitHub ответил HTTP $code" >&2
  head -c 300 "$resp" >&2
  echo >&2
  exit 1
fi

echo "heartbeat отправлен: $ts"
