#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "$FAKE_DOCKER_ARGS"

case "${1:-}" in
  exec)
    if printf '%s\n' "$*" | grep -q 'pg_dump'; then
      printf '%s\n' '-- PostgreSQL database dump complete' '\unrestrict test'
    elif printf '%s\n' "$*" | grep -q 'select 1'; then
      printf '1\n'
    elif printf '%s\n' "$*" | grep -q 'select 42'; then
      # Ответ только на ТОЧНЫЙ запрос теста: «42 на любой SQL» маскировал бы
      # искажение передачи аргумента (обрезанный/испорченный квотингом SQL).
      printf '42\n'
    else
      printf 'fake-docker: неожиданный SQL: %s\n' "$*" >&2
      exit 8
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
    elif printf '%s\n' "$*" | grep -q 'select 42'; then
      printf '42\n'
    else
      printf 'fake-docker: неожиданный SQL: %s\n' "$*" >&2
      exit 8
    fi
    ;;
  *)
    printf 'unexpected fake docker command: %s\n' "${1:-}" >&2
    exit 8
    ;;
esac
