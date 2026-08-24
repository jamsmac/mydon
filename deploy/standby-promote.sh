#!/usr/bin/env bash
# Promote a prepared cold standby. Workers remain opt-in to prevent split brain.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COMPOSE_FILE="$ROOT/deploy/docker-compose.standby.yml"
ENV_FILE="${1:-${STANDBY_ENV_FILE:-$HOME/.config/mydon/standby-production.env}}"
CORE_PORT="${STANDBY_CORE_PORT:-3101}"
PANEL_PORT="${STANDBY_PANEL_PORT:-3102}"
PRIMARY_PANEL_URL="${PRIMARY_PANEL_URL:-http://100.81.197.68:3002/}"

fail() { printf 'FAIL standby promotion: %s\n' "$*" >&2; exit 1; }
file_mode() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1"; }

[ "${STANDBY_CONFIRM_PRODUCTION_DOWN:-}" = YES ] ||
  fail "нужно STANDBY_CONFIRM_PRODUCTION_DOWN=YES"
command -v docker >/dev/null 2>&1 || fail "docker не установлен"
command -v tailscale >/dev/null 2>&1 || fail "tailscale не установлен"
command -v curl >/dev/null 2>&1 || fail "curl не установлен"
[ -f "$ENV_FILE" ] || fail "не найден $ENV_FILE"
[ "$(file_mode "$ENV_FILE")" = 600 ] || fail "$ENV_FILE должен иметь права 600"
docker image inspect mydon:standby >/dev/null 2>&1 ||
  fail "образ mydon:standby не подготовлен; сначала standby-drill.sh"

primary_status=000
if [ "${STANDBY_ALLOW_SPLIT_BRAIN:-0}" != 1 ]; then
  primary_status=$(curl -sS -L -o /dev/null -w '%{http_code}' --max-time 10 \
    "$PRIMARY_PANEL_URL" || true)
  [ "$primary_status" != 200 ] ||
    fail "production CC отвечает HTTP 200; standby запускать нельзя"
  if [ "${STANDBY_START_WORKERS:-0}" = 1 ] && [ "$primary_status" != 000 ]; then
    fail "production CC отвечает HTTP $primary_status; нельзя доказать остановку primary workers"
  fi
fi

ENV_FILE=$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")
export STANDBY_ENV_FILE="$ENV_FILE"
export STANDBY_CORE_PORT="$CORE_PORT"
export STANDBY_PANEL_PORT="$PANEL_PORT"
export STANDBY_PANEL_BIND="${STANDBY_PANEL_BIND:-$(tailscale ip -4 | head -1)}"
GIT_SHA=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || printf unknown)
export GIT_SHA
[ -n "$STANDBY_PANEL_BIND" ] || fail "не найден Tailscale IPv4"
image_sha=$(docker image inspect mydon:standby --format '{{range .Config.Env}}{{println .}}{{end}}' |
  sed -n 's/^GIT_SHA=//p' | head -1)
[ "$image_sha" = "$GIT_SHA" ] ||
  fail "образ собран из ${image_sha:-unknown}, репозиторий на $GIT_SHA; сначала standby-drill.sh"
COMPOSE=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")

cleanup_failed_promotion() {
  "${COMPOSE[@]}" --profile workers stop agents bot cc core >/dev/null 2>&1 || true
}
trap cleanup_failed_promotion EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${COMPOSE[@]}" up -d core cc
health=""
for _ in $(seq 1 60); do
  health=$(curl -sf --max-time 5 "http://127.0.0.1:${CORE_PORT}/health" || true)
  if printf '%s' "$health" | grep -q '"status":"ok"'; then break; fi
  sleep 2
done
printf '%s' "$health" | grep -q '"status":"ok"' || fail "Core standby не стал healthy"
printf '%s' "$health" | grep -q '"dbOk":true' || fail "Core standby не видит managed DB"

panel_status=000
for _ in $(seq 1 60); do
  panel_status=$(curl -sS -L -o /dev/null -w '%{http_code}' --max-time 10 \
    "http://${STANDBY_PANEL_BIND}:${PANEL_PORT}/" || true)
  [ "$panel_status" = 200 ] && break
  sleep 2
done
[ "$panel_status" = 200 ] || fail "CC standby не вернул HTTP 200"

workers=stopped
if [ "${STANDBY_START_WORKERS:-0}" = 1 ]; then
  "${COMPOSE[@]}" --profile workers up -d bot agents
  sleep 2
  for container in mydon-standby-bot mydon-standby-agents; do
    [ "$(docker inspect -f '{{.State.Running}}' "$container")" = true ] ||
      fail "$container не остался запущен"
  done
  docker exec mydon-standby-bot sh -c \
    '[ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_ALLOWED_CHAT_IDS" ]' ||
    fail "для standby Bot не заданы Telegram token/allowlist"
  workers=running
fi
trap - EXIT INT TERM
printf 'STANDBY_PROMOTED panel=http://%s:%s workers=%s\n' \
  "$STANDBY_PANEL_BIND" "$PANEL_PORT" "$workers"
