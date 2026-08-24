#!/usr/bin/env bash
# Stop only cold-standby containers; images, env and host data remain prepared.
#
# Аварийный рубильник split-brain: НИКАКИХ предусловий кроме docker.
# Прежний путь через docker compose требовал полный env-файл (интерполяция
# ${VAR:?} отказывалась даже останавливать контейнеры) — выключатель не должен
# зависеть от полноты секретов.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
fail() { printf 'FAIL standby stop: %s\n' "$*" >&2; exit 1; }
# shellcheck source=deploy/standby-lib.sh
. "$ROOT/deploy/standby-lib.sh"

command -v docker >/dev/null 2>&1 || fail "docker не установлен"
ps_names=$(docker_ps_names)
to_stop=$(printf '%s\n' "$ps_names" | grep -E '^mydon-standby-(agents|bot|cc|core)$' || true)
if [ -n "$to_stop" ]; then
  printf '%s\n' "$to_stop" | xargs docker stop
fi
printf 'STANDBY_STOPPED\n'
STANDBY_ATTACHMENTS_DIR="${STANDBY_ATTACHMENTS_DIR:-$HOME/.local/state/mydon-standby/attachments}"
if [ -n "$(ls -A "$STANDBY_ATTACHMENTS_DIR" 2>/dev/null)" ]; then
  printf 'НАПОМИНАНИЕ: в %s есть вложения, загруженные за время аварии — перенесите их на primary в /opt/mydon-data/attachments (docs/DATABASE_DR.md).\n' \
    "$STANDBY_ATTACHMENTS_DIR"
fi
