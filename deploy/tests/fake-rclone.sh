#!/usr/bin/env bash
set -euo pipefail

printf '%s\n' "$*" >> "$FAKE_RCLONE_ARGS"

case "${1:-}" in
  obscure)
    IFS= read -r password
    [ -n "$password" ]
    printf 'obscured-for-test\n'
    ;;
  copy)
    [ "${FAKE_RCLONE_FAIL:-0}" != 1 ] || exit 9
    printf 'RCLONE\0\0encrypted' > "$FAKE_RCLONE_OBJECT"
    ;;
  cryptcheck)
    [ "${FAKE_RCLONE_CRYPTCHECK_FAIL:-0}" != 1 ] || exit 7
    ;;
  lsf)
    printf '%s\n' database.sql.gz code.tar.gz
    ;;
  *)
    printf 'unexpected fake rclone command: %s\n' "${1:-}" >&2
    exit 8
    ;;
esac
