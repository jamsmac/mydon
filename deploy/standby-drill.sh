#!/usr/bin/env bash
# Build and test Core+CC on a second Tailscale machine without starting workers.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COMPOSE_FILE="$ROOT/deploy/docker-compose.standby.yml"
ENV_FILE="${1:-${STANDBY_ENV_FILE:-$HOME/.config/mydon/standby-production.env}}"
CORE_PORT="${STANDBY_CORE_PORT:-3101}"
PANEL_PORT="${STANDBY_PANEL_PORT:-3102}"

fail() { printf 'FAIL standby drill: %s\n' "$*" >&2; exit 1; }
file_mode() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1"; }

command -v docker >/dev/null 2>&1 || fail "docker не установлен"
command -v tailscale >/dev/null 2>&1 || fail "tailscale не установлен"
command -v curl >/dev/null 2>&1 || fail "curl не установлен"
[ -f "$ENV_FILE" ] || fail "не найден $ENV_FILE"
[ "$(file_mode "$ENV_FILE")" = 600 ] || fail "$ENV_FILE должен иметь права 600"
ENV_FILE=$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")

export STANDBY_ENV_FILE="$ENV_FILE"
export STANDBY_CORE_PORT="$CORE_PORT"
export STANDBY_PANEL_PORT="$PANEL_PORT"
export STANDBY_PANEL_BIND="${STANDBY_PANEL_BIND:-$(tailscale ip -4 | head -1)}"
GIT_SHA=$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || printf unknown)
export GIT_SHA
[ -n "$STANDBY_PANEL_BIND" ] || fail "не найден Tailscale IPv4"
COMPOSE=(docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE")

if docker ps --format '{{.Names}}' | grep -Eq '^mydon-standby-(bot|agents)$'; then
  fail "standby workers уже запущены; drill не будет их останавливать"
fi
cleanup() {
  "${COMPOSE[@]}" stop cc core >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "${STANDBY_SKIP_BUILD:-0}" != 1 ]; then
  "${COMPOSE[@]}" build core
fi
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

cleanup
trap - EXIT
for container in mydon-standby-core mydon-standby-cc; do
  exit_code=$(docker inspect -f '{{.State.ExitCode}}' "$container")
  case "$exit_code" in
    0 | 143) ;;
    137) fail "$container завершён через SIGKILL (137)" ;;
    *) fail "$container завершён с неожиданным кодом $exit_code" ;;
  esac
done
running=$(docker ps --format '{{.Names}}' | grep -Ec '^mydon-standby-' || true)
[ "$running" -eq 0 ] || fail "standby-контейнеры остались запущены после drill"
printf 'STANDBY_DRILL_OK commit=%s panel=http://%s:%s workers=stopped\n' \
  "$GIT_SHA" "$STANDBY_PANEL_BIND" "$PANEL_PORT"
