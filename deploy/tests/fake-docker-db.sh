#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "$FAKE_DOCKER_ARGS"

case "${1:-}" in
  exec)
    if printf '%s\n' "$*" | grep -q 'pg_dump'; then
      printf '%s\n' '-- PostgreSQL database dump complete' '\unrestrict test'
    elif printf '%s\n' "$*" | grep -q 'select 1'; then
      printf '1\n'
    else
      printf '42\n'
    fi
    ;;
  run)
    mount=""
    previous=""
    for arg in "$@"; do
      if [ "$previous" = "--volume" ]; then mount=$arg; break; fi
      previous=$arg
    done
    [ -n "$mount" ]
    pgpass=${mount%%:*}
    cp "$pgpass" "$FAKE_DOCKER_PGPASS"
    if printf '%s\n' "$*" | grep -q 'pg_dump'; then
      printf '%s\n' '-- PostgreSQL database dump complete' '\unrestrict test'
    elif printf '%s\n' "$*" | grep -q 'select 1'; then
      printf '1\n'
    else
      printf '42\n'
    fi
    ;;
  *)
    printf 'unexpected fake docker command: %s\n' "${1:-}" >&2
    exit 8
    ;;
esac
