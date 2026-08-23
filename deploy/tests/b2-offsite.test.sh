#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
HELPER="$ROOT/deploy/guards/b2_offsite.sh"
FAKE_RCLONE="$ROOT/deploy/tests/fake-rclone.sh"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

SOURCE_A="$TMP/database.sql.gz"
SOURCE_B="$TMP/code.tar.gz"
printf 'database-backup-content\n' > "$SOURCE_A"
printf 'command-center-content\n' > "$SOURCE_B"

run_helper() {
  B2_ENV_FILE="$1" \
  B2_TEMP_ROOT="$TMP/staging" \
  RCLONE_BIN="$FAKE_RCLONE" \
  FAKE_RCLONE_ARGS="$TMP/rclone.args" \
  FAKE_RCLONE_OBJECT="$TMP/remote.object" \
  FAKE_RCLONE_FAIL="${FAKE_RCLONE_FAIL:-0}" \
  FAKE_RCLONE_CRYPTCHECK_FAIL="${FAKE_RCLONE_CRYPTCHECK_FAIL:-0}" \
    "$HELPER" 2026-08-24 "$SOURCE_A" "$SOURCE_B"
}

expect_status() {
  local expected=$1 env_file=$2 actual
  set +e
  run_helper "$env_file" > "$TMP/output" 2>&1
  actual=$?
  set -e
  if [ "$actual" -ne "$expected" ]; then
    cat "$TMP/output" >&2
    printf 'expected status %s, got %s\n' "$expected" "$actual" >&2
    exit 1
  fi
}

EMPTY_ENV="$TMP/empty.env"
: > "$EMPTY_ENV"
expect_status 3 "$EMPTY_ENV"
grep -q 'не настроен' "$TMP/output"

PARTIAL_ENV="$TMP/partial.env"
printf 'B2_APPLICATION_KEY_ID=key-id\n' > "$PARTIAL_ENV"
expect_status 1 "$PARTIAL_ENV"
grep -q 'конфигурация неполная' "$TMP/output"

NO_PASSWORD_ENV="$TMP/no-password.env"
printf '%s\n' \
  'B2_APPLICATION_KEY_ID=key-id' \
  'B2_APPLICATION_KEY=application-secret' \
  'B2_BUCKET=mydon-backup' > "$NO_PASSWORD_ENV"
expect_status 1 "$NO_PASSWORD_ENV"
grep -q 'BACKUP_ENC_PASSPHRASE не задан' "$TMP/output"

VALID_ENV="$TMP/valid.env"
printf '%s\n' \
  'BACKUP_ENC_PASSPHRASE=encryption-secret' \
  'B2_APPLICATION_KEY_ID=key-id' \
  'B2_APPLICATION_KEY=application-secret' \
  'B2_BUCKET=mydon-backup' \
  'B2_PREFIX=mydon/daily' > "$VALID_ENV"

rm -f "$TMP/rclone.args" "$TMP/remote.object"
if ! run_helper "$VALID_ENV" > "$TMP/output" 2>&1; then
  cat "$TMP/output" >&2
  exit 1
fi
grep -q 'загружено и проверено файлов: 2' "$TMP/output"
grep -q 'mydoncrypt:2026-08-24' "$TMP/rclone.args"
if grep -q 'application-secret\|encryption-secret' "$TMP/rclone.args"; then
  printf 'secret leaked to rclone argv\n' >&2
  exit 1
fi
[ "$(dd if="$TMP/remote.object" bs=1 count=6 2>/dev/null)" = 'RCLONE' ]
[ "$(find "$TMP/staging" -mindepth 1 -maxdepth 1 -type d | wc -l)" -eq 0 ]

FAKE_RCLONE_FAIL=1
expect_status 1 "$VALID_ENV"
grep -q 'Backblaze не принял' "$TMP/output"
FAKE_RCLONE_FAIL=0

FAKE_RCLONE_CRYPTCHECK_FAIL=1
expect_status 1 "$VALID_ENV"
grep -q 'cryptcheck не подтвердил' "$TMP/output"

# Exercise the real crypt backend when rclone is available. The B2 transport is
# mocked above, while this proves authenticated encryption, encrypted names,
# cryptcheck and recovery with the exact runtime configuration shape.
if command -v rclone >/dev/null 2>&1; then
  REAL_SOURCE="$TMP/real-source"
  REAL_REMOTE="$TMP/real-remote"
  REAL_RESTORE="$TMP/real-restore"
  REAL_CONFIG="$TMP/real-rclone.conf"
  mkdir "$REAL_SOURCE" "$REAL_REMOTE" "$REAL_RESTORE"
  cp "$SOURCE_A" "$SOURCE_B" "$REAL_SOURCE/"
  : > "$REAL_CONFIG"

  real_password=$(printf '%s\n' 'encryption-secret' | rclone obscure -)
  export RCLONE_CONFIG="$REAL_CONFIG"
  export RCLONE_CONFIG_TESTLOCAL_TYPE=local
  export RCLONE_CONFIG_TESTCRYPT_TYPE=crypt
  export RCLONE_CONFIG_TESTCRYPT_REMOTE="testlocal:$REAL_REMOTE"
  export RCLONE_CONFIG_TESTCRYPT_PASSWORD="$real_password"
  export RCLONE_CONFIG_TESTCRYPT_FILENAME_ENCRYPTION=standard
  export RCLONE_CONFIG_TESTCRYPT_DIRECTORY_NAME_ENCRYPTION=true

  rclone copy "$REAL_SOURCE" testcrypt: --log-level ERROR
  rclone cryptcheck "$REAL_SOURCE" testcrypt: --one-way --log-level ERROR
  rclone copy testcrypt: "$REAL_RESTORE" --log-level ERROR
  cmp "$SOURCE_A" "$REAL_RESTORE/$(basename "$SOURCE_A")"
  cmp "$SOURCE_B" "$REAL_RESTORE/$(basename "$SOURCE_B")"
  if find "$REAL_REMOTE" -type f -name '*database*' | grep -q .; then
    printf 'rclone crypt leaked a plaintext filename\n' >&2
    exit 1
  fi
  mapfile -t encrypted_objects < <(find "$REAL_REMOTE" -type f)
  [ "${#encrypted_objects[@]}" -eq 2 ]
  [ "$(od -An -tx1 -N8 "${encrypted_objects[0]}" | tr -d ' \n')" = '52434c4f4e450000' ]
fi

printf 'b2-offsite tests: ok\n'
