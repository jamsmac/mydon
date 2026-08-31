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

# Свежий heartbeat означает, что отвечает именно приложение с живой БД, а не
# только shell/systemd на хосте. Иначе Core мог неделями отдавать degraded, а
# сторож продолжал видеть свежую отметку и считать контур здоровым.
HEALTH_URL="${HEARTBEAT_HEALTH_URL:-http://127.0.0.1:3001/health}"
health="$(curl -fsS --max-time 10 "$HEALTH_URL")" || {
  echo "health MYDON недоступен: $HEALTH_URL" >&2
  exit 1
}
health_status="$(printf '%s' "$health" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("status", ""))' 2>/dev/null || true)"
if [ "$health_status" != "ok" ]; then
  echo "health MYDON не ok: ${health_status:-ответ не разобран}" >&2
  exit 1
fi

# Короткий статус: какие контейнеры живы. Диагноз в тревоге ценнее голого «жив».
containers="$(docker ps --format '{{.Names}}:{{.Status}}' 2>/dev/null | head -12 | tr '\n' ';' || true)"
disk_avail="$(df -BG --output=avail / | tail -1 | tr -dc '0-9' || echo '?')"
ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

payload="$(printf '{"ts":"%s","host":"mydon-os","health":"%s","disk_avail_gb":"%s","containers":"%s"}' \
  "$ts" "$health_status" "$disk_avail" "$containers")"

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
# `|| echo 000` давал «000000»: при сбое curl сам печатает 000 из -w И
# выходит ненулём (тот же фикс, что в watchdog-liveness.sh).
# ТОКЕН НЕ В АРГУМЕНТАХ: заголовок с ним уходит через config-stdin (`-K-`),
# иначе `Authorization: Bearer <PAT>` видит любой процесс через `ps auxww` —
# а heartbeat крутится по таймеру каждые 2 минуты, то есть окно наблюдения
# практически постоянное. Значение экранируем — полный идиом standby-lib.sh:
# кавычки и бэкслеши внутри двойных кавычек curl-конфига — это
# escape-последовательности, и токен с `"` без экранирования молча
# обрезается по кавычке (проверено: заголовок доезжает усечённым) — ложный
# 401 вместо heartbeat.
gh_token_esc="$(printf '%s' "$HEARTBEAT_GH_TOKEN" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"
if ! code="$(curl -sS -o "$resp" -w '%{http_code}' -X PATCH \
  -H "Accept: application/vnd.github+json" \
  --max-time 20 \
  -d "$body" \
  "https://api.github.com/gists/$HEARTBEAT_GIST_ID" \
  -K- <<< "header = \"Authorization: Bearer $gh_token_esc\"")"; then
  code=000
fi

if [ "$code" != "200" ]; then
  echo "heartbeat НЕ отправлен: GitHub ответил HTTP $code" >&2
  head -c 300 "$resp" >&2
  echo >&2
  exit 1
fi

echo "heartbeat отправлен: $ts"
