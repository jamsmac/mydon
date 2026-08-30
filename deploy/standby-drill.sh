#!/usr/bin/env bash
# Build and test Core+CC on a second Tailscale machine without starting workers.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COMPOSE_FILE="$ROOT/deploy/docker-compose.standby.yml"
ENV_FILE="${1:-${STANDBY_ENV_FILE:-$HOME/.config/mydon/standby-production.env}}"
CORE_PORT="${STANDBY_CORE_PORT:-3101}"
PANEL_PORT="${STANDBY_PANEL_PORT:-3102}"

fail() { printf 'FAIL standby drill: %s\n' "$*" >&2; exit 1; }
# shellcheck source=deploy/standby-lib.sh
. "$ROOT/deploy/standby-lib.sh"

command -v docker >/dev/null 2>&1 || fail "docker не установлен"
command -v tailscale >/dev/null 2>&1 || fail "tailscale не установлен"
command -v curl >/dev/null 2>&1 || fail "curl не установлен"
ENV_FILE=$(require_env_file "$ENV_FILE")
# Напоминание на РЕПЕТИЦИИ, а не посреди аварии: promote требует этот ключ.
if [ -z "$(env_file_value "$ENV_FILE" HEARTBEAT_GIST_ID)" ]; then
  printf 'ВНИМАНИЕ: в env-файле нет HEARTBEAT_GIST_ID — promote ОТКАЖЕТ без него (гейт живости primary). Добавьте заранее из /etc/mydon-heartbeat.env primary (docs/DATABASE_DR.md, «Standby env»).\n' >&2
fi

export STANDBY_CORE_PORT="$CORE_PORT"
export STANDBY_PANEL_PORT="$PANEL_PORT"
export STANDBY_PANEL_BIND="${STANDBY_PANEL_BIND:-$(tailscale ip -4 | head -1)}"
[ -n "$STANDBY_PANEL_BIND" ] || fail "не найден Tailscale IPv4"
attachments_init
llm_outbox_init
GIT_SHA=$(repo_git_sha "$ROOT")
export GIT_SHA
compose_init "$COMPOSE_FILE" "$ENV_FILE"

# Захват отдельным присваиванием: fail() внутри пайпа убил бы только сабшелл,
# и упавший docker снова читался бы как «контейнеров нет».
ps_names=$(docker_ps_names)
if printf '%s\n' "$ps_names" | grep -Eq '^mydon-standby-(bot|agents)$'; then
  fail "standby workers уже запущены; drill не будет их останавливать"
fi
cleanup() {
  "${COMPOSE[@]}" stop cc core >/dev/null 2>&1 || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "${STANDBY_SKIP_BUILD:-0}" != 1 ]; then
  [ "$GIT_SHA" != unknown ] ||
    fail "репозиторий без git HEAD: образ будет непроверяемого возраста"
  "${COMPOSE[@]}" build core
fi
# И при пропуске сборки, и после неё drill сертифицирует ровно тот код, что в
# образе: раньше STANDBY_SKIP_BUILD=1 штамповал текущий HEAD репозитория, хотя
# контейнеры гоняли старый образ — а рассинхрон вскрывался только sha-гейтом
# promote посреди настоящей аварии, требуя многоминутный rebuild с сетью.
require_image_matches_repo "$ROOT" mydon:standby
IMAGE_SHA=$(image_git_sha mydon:standby)

"${COMPOSE[@]}" up -d core cc
wait_core_health "$CORE_PORT"
wait_panel_200 "http://${STANDBY_PANEL_BIND}:${PANEL_PORT}/"
# Дрилл обязан проверить и путь ЗАПИСИ: /health и HTTP 200 панели зелёные и
# с пустым SERVICE_TOKEN, но после promote такой standby не примет ни одной
# операции (мутации fail-closed 401).
require_service_token_works "$CORE_PORT" "$ENV_FILE"

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
ps_names=$(docker_ps_names)
running=$(printf '%s\n' "$ps_names" | grep -Ec '^mydon-standby-' || true)
[ "$running" -eq 0 ] || fail "standby-контейнеры остались запущены после drill"
printf 'STANDBY_DRILL_OK commit=%s panel=http://%s:%s workers=stopped\n' \
  "$IMAGE_SHA" "$STANDBY_PANEL_BIND" "$PANEL_PORT"
