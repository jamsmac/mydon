#!/usr/bin/env bash
# Static rollout contract for paid-provider workers. This test intentionally
# reads the scripts themselves: a future refactor must preserve the observable
# command order in both automatic and manual deployment paths.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
AUTO="$ROOT/deploy/auto-deploy.sh"
MANUAL="$ROOT/deploy/deploy.sh"
RUNBOOK="$ROOT/docs/DEPLOY.md"

AUTO_STOP="\"\${COMPOSE[@]}\" stop mydon-agents"
AUTO_CORE_START="\"\${COMPOSE[@]}\" up -d --no-deps mydon-core"
AUTO_CLIENTS='for service in mydon-bot mydon-cc; do'
AUTO_AGENTS_START="\"\${COMPOSE[@]}\" up -d --no-deps mydon-agents"
AUTO_BOT_START="\"\${COMPOSE[@]}\" up -d --no-deps mydon-bot"

MANUAL_STOP='  docker compose -f deploy/docker-compose.yml --env-file .env stop mydon-agents'
MANUAL_CORE_START='  docker compose -f deploy/docker-compose.yml --env-file .env up -d --no-deps mydon-core'
MANUAL_CLIENTS='  for service in mydon-bot mydon-cc; do'
MANUAL_AGENTS_START='  docker compose -f deploy/docker-compose.yml --env-file .env up -d --no-deps mydon-agents'

fail() { printf 'deploy-rollout-order: FAIL %s\n' "$*" >&2; exit 1; }

# Safety anchors must name one exact executable line. A contains/last match is
# unsafe here: both scripts deliberately repeat stop/start text in EXIT cleanup
# and repair branches, which used to let removal of the normal command pass CI.
line_exact_once() {
  local file="$1"
  local exact="$2"
  local label="$3"
  local line
  if ! line=$(awk -v exact="$exact" '
    $0 == exact { count += 1; found = NR }
    END {
      if (count == 1) print found
      else exit 1
    }
  ' "$file"); then
    fail "нужна ровно одна executable-строка '$label' в ${file#"$ROOT/"}"
  fi
  printf '%s\n' "$line"
}

line_code_contains_once() {
  local file="$1"
  local needle="$2"
  local label="$3"
  local line
  if ! line=$(awk -v needle="$needle" '
    $0 !~ /^[[:space:]]*#/ && index($0, needle) { count += 1; found = NR }
    END {
      if (count == 1) print found
      else exit 1
    }
  ' "$file"); then
    fail "нужна ровно одна executable-строка с '$label' в ${file#"$ROOT/"}"
  fi
  printf '%s\n' "$line"
}

assert_lt() {
  local left="$1"
  local right="$2"
  local detail="$3"
  [ "$left" -lt "$right" ] || fail "$detail ($left !< $right)"
}

assert_no_unscoped_up() {
  local file="$1"
  local bad
  bad=$(awk '
    /^[[:space:]]*docker compose .* up -d[[:space:]]*$/ ||
    /^[[:space:]]*"\$\{COMPOSE\[@\]\}" up -d[[:space:]]*$/ {
      print NR ":" $0
    }
  ' "$file")
  [ -z "$bad" ] || fail "общий compose up -d в ${file#"$ROOT/"}: $bad"
}

assert_agents_last() {
  local file="$1"
  local agents_line="$2"
  local bad
  bad=$(awk -v start="$agents_line" '
    NR > start && /up -d/ &&
    ($0 ~ /^[[:space:]]*docker compose/ ||
     $0 ~ /^[[:space:]]*"\$\{COMPOSE\[@\]\}"/ ||
     $0 ~ /^[[:space:]]*up -d/) &&
    $0 !~ /mydon-agents/ {
      print NR ":" $0
    }
  ' "$file")
  [ -z "$bad" ] || fail "после Agents запускается другой service в ${file#"$ROOT/"}: $bad"
}

check_script() {
  local file="$1"
  local kind="$2"
  local stop_exact core_exact clients_exact agents_exact
  local stop started migrate core health clients agents

  case "$kind" in
    auto)
      stop_exact="$AUTO_STOP"
      core_exact="$AUTO_CORE_START"
      clients_exact="$AUTO_CLIENTS"
      agents_exact="$AUTO_AGENTS_START"
      ;;
    manual)
      stop_exact="$MANUAL_STOP"
      core_exact="$MANUAL_CORE_START"
      clients_exact="$MANUAL_CLIENTS"
      agents_exact="$MANUAL_AGENTS_START"
      ;;
    *) fail "неизвестный rollout profile '$kind'" ;;
  esac

  stop=$(line_exact_once "$file" "$stop_exact" 'normal stop mydon-agents')
  started=$(line_exact_once "$file" 'MIGRATION_STARTED=1' 'migration fence')
  migrate=$(line_code_contains_once "$file" 'node packages/db/dist/migrate.js' 'migration invocation')
  core=$(line_exact_once "$file" "$core_exact" 'normal Core start')
  health=$(line_code_contains_once "$file" '127.0.0.1:3001/health' 'Core health')
  clients=$(line_exact_once "$file" "$clients_exact" 'Bot/CC phase')
  agents=$(line_exact_once "$file" "$agents_exact" 'first normal Agents start')

  assert_lt "$stop" "$started" "Agents должен остановиться до migration fence в ${file#"$ROOT/"}"
  assert_lt "$started" "$migrate" "migration fence должен ставиться до invocation в ${file#"$ROOT/"}"
  assert_lt "$migrate" "$core" "Core нельзя переключать до успешного migrate в ${file#"$ROOT/"}"
  assert_lt "$core" "$health" "Core health должен идти после Core up в ${file#"$ROOT/"}"
  assert_lt "$health" "$clients" "Bot/CC нельзя переключать до Core health в ${file#"$ROOT/"}"
  assert_lt "$clients" "$agents" "Agents должен стартовать последним в ${file#"$ROOT/"}"

  grep -q 'docker start mydon-agents' "$file" ||
    fail "нет восстановления точного старого Agents container в ${file#"$ROOT/"}"
  grep -q 'MIGRATION_STARTED.*-eq 0' "$file" ||
    fail "cleanup не различает pre-attempt/post-attempt migration в ${file#"$ROOT/"}"
  assert_no_unscoped_up "$file"
  assert_agents_last "$file" "$agents"
}

check_rollout_scripts() {
  check_script "$1" auto
  check_script "$2" manual
}

mutate_remove_exact() {
  local source="$1"
  local exact="$2"
  local destination="$3"
  awk -v exact="$exact" '
    $0 == exact { removed += 1; next }
    { print }
    END { if (removed != 1) exit 1 }
  ' "$source" > "$destination"
}

mutate_insert_after_exact() {
  local source="$1"
  local anchor="$2"
  local inserted_line="$3"
  local destination="$4"
  awk -v anchor="$anchor" -v inserted_line="$inserted_line" '
    { print }
    $0 == anchor { print inserted_line; inserted += 1 }
    END { if (inserted != 1) exit 1 }
  ' "$source" > "$destination"
}

expect_check_failure() {
  local label="$1"
  local expected="$2"
  local auto_file="$3"
  local manual_file="$4"
  local output
  if output=$(check_rollout_scripts "$auto_file" "$manual_file" 2>&1); then
    fail "mutation '$label' ложно прошла rollout checker"
  fi
  case "$output" in
    *"$expected"*) ;;
    *) fail "mutation '$label' упала не на ожидаемом invariant: $output" ;;
  esac
}

check_rollout_scripts "$AUTO" "$MANUAL"

# Mutation checks prove the checker guards executable phases rather than a
# duplicate string in cleanup/repair. Each mutant changes one invariant only.
TMP_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/mydon-rollout-test.XXXXXX")
cleanup() { rm -rf -- "$TMP_ROOT"; }
trap cleanup EXIT

auto_without_stop="$TMP_ROOT/auto-without-stop.sh"
mutate_remove_exact "$AUTO" "$AUTO_STOP" "$auto_without_stop"
expect_check_failure 'auto normal stop removed' 'normal stop mydon-agents' "$auto_without_stop" "$MANUAL"

manual_without_stop="$TMP_ROOT/manual-without-stop.sh"
mutate_remove_exact "$MANUAL" "$MANUAL_STOP" "$manual_without_stop"
expect_check_failure 'manual normal stop removed' 'normal stop mydon-agents' "$AUTO" "$manual_without_stop"

auto_after_agents="$TMP_ROOT/auto-service-after-agents.sh"
mutate_insert_after_exact "$AUTO" "$AUTO_AGENTS_START" \
  "$AUTO_BOT_START" "$auto_after_agents"
expect_check_failure 'auto service after Agents' 'после Agents запускается другой service' "$auto_after_agents" "$MANUAL"

manual_after_agents="$TMP_ROOT/manual-service-after-agents.sh"
mutate_insert_after_exact "$MANUAL" "$MANUAL_AGENTS_START" \
  '  docker compose -f deploy/docker-compose.yml --env-file .env up -d --no-deps mydon-bot' "$manual_after_agents"
expect_check_failure 'manual service after Agents' 'после Agents запускается другой service' "$AUTO" "$manual_after_agents"

# auto-deploy runs from a pre-reset self-copy, so the first 0077 rollout cannot
# rely on the just-merged script. The runbook must keep the bootstrap exception.
grep -q 'Первая выкатка 0077' "$RUNBOOK" || fail "нет first-run 0077 warning"
grep -q 'mydon-autodeploy.timer' "$RUNBOOK" || fail "first-run warning не останавливает timer"
grep -q 'deploy/deploy.sh' "$RUNBOOK" || fail "first-run warning не требует manual deploy"

printf 'deploy-rollout-order tests: ok\n'
