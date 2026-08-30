#!/usr/bin/env bash
# Regression gate: no root or per-app env file may reach COPY . . in the
# production Dockerfile. Uses a scratch image, so the check needs no network.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TMP_ROOT=$(mktemp -d)
CONTEXT="$TMP_ROOT/context"
OUTPUT="$TMP_ROOT/output"

cleanup() { rm -rf -- "$TMP_ROOT"; }
trap cleanup EXIT

fail() {
  printf 'docker-build-context: FAIL %s\n' "$*" >&2
  exit 1
}

mkdir -p "$CONTEXT/apps/cc" "$CONTEXT/apps/core/config"
cp "$ROOT/.dockerignore" "$CONTEXT/.dockerignore"
printf 'FROM scratch\nCOPY . /\n' > "$CONTEXT/Dockerfile"

printf 'root-secret\n' > "$CONTEXT/.env"
printf 'root-local-secret\n' > "$CONTEXT/.env.local"
printf 'cc-secret\n' > "$CONTEXT/apps/cc/.env"
printf 'cc-local-secret\n' > "$CONTEXT/apps/cc/.env.local"
printf 'core-secret\n' > "$CONTEXT/apps/core/config/.env.production"
printf 'root-example\n' > "$CONTEXT/.env.example"
printf 'cc-example\n' > "$CONTEXT/apps/cc/.env.example"
printf 'visible\n' > "$CONTEXT/visible.txt"

DOCKER_BUILDKIT=1 docker build --quiet \
  --file "$CONTEXT/Dockerfile" \
  --output "type=local,dest=$OUTPUT" \
  "$CONTEXT" >/dev/null

for path in \
  .env \
  .env.local \
  apps/cc/.env \
  apps/cc/.env.local \
  apps/core/config/.env.production; do
  [ ! -e "$OUTPUT/$path" ] || fail "$path попал в Docker build context"
done

for path in .env.example apps/cc/.env.example visible.txt; do
  [ -f "$OUTPUT/$path" ] || fail "$path ошибочно исключён из Docker build context"
done

grep -Fq -- "--exclude '.env*'" "$ROOT/deploy/deploy.sh" ||
  fail 'ручной deploy не исключает всю .env* семью из rsync'

printf 'docker-build-context: OK\n'
