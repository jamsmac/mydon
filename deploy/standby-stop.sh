#!/usr/bin/env bash
# Stop only cold-standby containers; images, env and volumes remain prepared.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="${1:-${STANDBY_ENV_FILE:-$HOME/.config/mydon/standby-production.env}}"
file_mode() { stat -f %Lp "$1" 2>/dev/null || stat -c %a "$1"; }

command -v docker >/dev/null 2>&1 || { printf 'docker не установлен\n' >&2; exit 1; }
[ -f "$ENV_FILE" ] || { printf 'не найден %s\n' "$ENV_FILE" >&2; exit 1; }
[ "$(file_mode "$ENV_FILE")" = 600 ] || {
  printf '%s должен иметь права 600\n' "$ENV_FILE" >&2
  exit 1
}
ENV_FILE=$(cd "$(dirname "$ENV_FILE")" && pwd)/$(basename "$ENV_FILE")
export STANDBY_ENV_FILE="$ENV_FILE"
docker compose -f "$ROOT/deploy/docker-compose.standby.yml" --env-file "$ENV_FILE" \
  --profile workers stop agents bot cc core
printf 'STANDBY_STOPPED\n'
