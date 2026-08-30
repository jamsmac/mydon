#!/usr/bin/env bash
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
COMPOSE_YML="$ROOT/deploy/docker-compose.standby.yml"
PRODUCTION_COMPOSE="$ROOT/deploy/docker-compose.yml"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# Изоляция от окружения запуска: docker compose даёт OS-переменным приоритет
# над --env-file, поэтому экспортированный в шелле DATABASE_URL делал negative-
# проверки ложными, а оставшийся после реального promote
# STANDBY_CONFIRM_PRODUCTION_DOWN=YES заставлял «тест» исполнять НАСТОЯЩИЙ
# promote-путь против фейкового URL БД.
run_clean() {
  env -u DATABASE_URL -u DATABASE_ADMIN_URL -u SERVICE_TOKEN -u POSTGRES_PASSWORD \
    -u B2_APPLICATION_KEY -u BACKUP_ENC_PASSPHRASE \
    -u LLM_API_KEY -u LLM_ENABLED -u LLM_ROUTE -u LLM_MODEL -u LLM_BASE_URL \
    -u LLM_PRICE_PROVIDER_ID -u LLM_GLOBAL_DAILY_BUDGET_USD \
    -u LLM_MAX_RESERVATION_USD -u LLM_HTTP_BILLING_MODE \
    -u AGENT_GLOBAL_BUDGET_USD \
    -u STANDBY_CONFIRM_PRODUCTION_DOWN -u STANDBY_START_WORKERS \
    -u STANDBY_ALLOW_SPLIT_BRAIN -u STANDBY_ALLOW_UNKNOWN_SHA -u STANDBY_SKIP_BUILD \
    -u STANDBY_ENV_FILE -u GIT_SHA \
    -u COMPOSE_PROFILES -u COMPOSE_FILE -u COMPOSE_PROJECT_NAME -u COMPOSE_ENV_FILES "$@"
}

# ── file_mode работает на этой ОС (GNU stat читал BSD-флаги как имя файла,
#    и проверка прав 600 вечно падала на корректном файле — ловится ТУТ,
#    потому что CI гоняет этот тест на Linux, а владелец — на macOS).
fail() { printf 'standby-lib self-check failed: %s\n' "$*" >&2; exit 1; }
# shellcheck source=deploy/standby-lib.sh
. "$ROOT/deploy/standby-lib.sh"
probe="$TMP/mode-probe"
touch "$probe"
chmod 600 "$probe"
[ "$(file_mode "$probe")" = 600 ] || fail "file_mode вернул '$(file_mode "$probe")' вместо 600"
chmod 644 "$probe"
[ "$(file_mode "$probe")" = 644 ] || fail "file_mode вернул '$(file_mode "$probe")' вместо 644"

ENV_FILE="$TMP/standby.env"
printf '%s\n' \
  'DATABASE_URL=postgresql://runtime-user:runtime-secret@db.example.test/postgres?sslmode=require' \
  'SERVICE_TOKEN=service-secret' \
  'DATABASE_ADMIN_URL=postgresql://admin:admin-secret@direct.example.test/postgres' \
  'POSTGRES_PASSWORD=local-db-secret' \
  'B2_APPLICATION_KEY=b2-secret' \
  'BACKUP_ENC_PASSPHRASE=backup-secret' \
  > "$ENV_FILE"
chmod 600 "$ENV_FILE"
ATT_DIR="$TMP/attachments"
mkdir -p "$ATT_DIR"
LLM_OUTBOX_DIR="$TMP/llm-close"
STANDBY_LLM_OUTBOX_DIR="$LLM_OUTBOX_DIR"
llm_outbox_init
[ "$(file_mode "$LLM_OUTBOX_DIR")" = 700 ] || fail "llm outbox root должен иметь права 700"
if (STANDBY_LLM_OUTBOX_DIR=/; llm_outbox_init) >"$TMP/unsafe-outbox.out" 2>&1; then
  fail "llm_outbox_init принял опасный корневой каталог"
fi
grep -q '.../llm-close' "$TMP/unsafe-outbox.out"
mkdir -p "$LLM_OUTBOX_DIR/bot/pending"
touch "$LLM_OUTBOX_DIR/bot/pending/test.json"
[ "$(llm_outbox_unfinished_count)" = 1 ] || fail "standby spool не видит pending запись"
rm "$LLM_OUTBOX_DIR/bot/pending/test.json"
(STANDBY_LLM_OUTBOX_DIR=/; [ "$(llm_outbox_unfinished_count)" = unknown ]) ||
  fail "read-only spool check принял опасный корневой каталог"

rendered=$(
  STANDBY_PANEL_BIND=127.0.0.1 STANDBY_ATTACHMENTS_DIR="$ATT_DIR" \
    STANDBY_LLM_OUTBOX_DIR="$LLM_OUTBOX_DIR" \
    run_clean docker compose -f "$COMPOSE_YML" --env-file "$ENV_FILE" config
)
printf '%s' "$rendered" | grep -q 'runtime-secret'
printf '%s' "$rendered" | grep -q 'service-secret'
for forbidden in admin-secret local-db-secret b2-secret backup-secret; do
  if printf '%s' "$rendered" | grep -q "$forbidden"; then
    printf 'standby leaked %s into a container\n' "$forbidden" >&2
    exit 1
  fi
done

rendered_json=$(
  STANDBY_PANEL_BIND=127.0.0.1 STANDBY_ATTACHMENTS_DIR="$ATT_DIR" \
    STANDBY_LLM_OUTBOX_DIR="$LLM_OUTBOX_DIR" \
    run_clean docker compose -f "$COMPOSE_YML" --env-file "$ENV_FILE" --profile workers \
      config --format json
)
printf '%s' "$rendered_json" | node -e '
  const fs = require("node:fs");
  const config = JSON.parse(fs.readFileSync(0, "utf8"));
  for (const service of ["core", "cc", "bot", "agents"]) {
    if (config.services[service]?.init !== true) {
      throw new Error(service + " must run behind Docker init");
    }
  }
  const expectedTargets = {
    core: ["/data/llm-close", true],
    cc: ["/data/llm-close/cc", false],
    bot: ["/data/llm-close/bot", false],
    agents: ["/data/llm-close", false],
  };
  for (const [service, [target, readOnly]] of Object.entries(expectedTargets)) {
    const mount = (config.services[service].volumes ?? []).find(volume => volume.target === target);
    if (!mount || Boolean(mount.read_only) !== readOnly) {
      throw new Error(service + " has unsafe/missing settlement outbox mount");
    }
  }
'

production_json=$(
  PANEL_BIND=127.0.0.1 \
    run_clean docker compose -f "$PRODUCTION_COMPOSE" --env-file "$ENV_FILE" \
      config --format json
)
printf '%s' "$production_json" | node -e '
  const fs = require("node:fs");
  const config = JSON.parse(fs.readFileSync(0, "utf8"));
  for (const service of ["mydon-core", "mydon-cc", "mydon-bot", "mydon-agents"]) {
    if (config.services[service]?.init !== true) {
      throw new Error(service + " must run behind Docker init");
    }
  }
'

# ── Паритет env-КЛЮЧЕЙ standby ↔ production. Блоки скопированы руками, и
#    новая переменная, добавленная только в production compose, молча не
#    доехала бы до standby — ровно тот класс дрейфа, что уже давал инцидент
#    с OURVEND-переменными (см. комментарий в docker-compose.yml).
printf '%s\n---SPLIT---\n%s' "$rendered_json" "$production_json" | node -e '
  const fs = require("node:fs");
  const [standbyRaw, prodRaw] = fs.readFileSync(0, "utf8").split("\n---SPLIT---\n");
  const standby = JSON.parse(standbyRaw).services;
  const prod = JSON.parse(prodRaw).services;
  const pairs = [["core", "mydon-core"], ["cc", "mydon-cc"], ["bot", "mydon-bot"], ["agents", "mydon-agents"]];
  // Осознанные расхождения перечислять ЗДЕСЬ (ключ + причина), не молча:
  const allowedProdOnly = { core: [], cc: [], bot: [], agents: [] };
  const allowedStandbyOnly = { core: [], cc: [], bot: [], agents: [] };
  for (const [s, p] of pairs) {
    const sKeys = new Set(Object.keys(standby[s].environment ?? {}));
    const pKeys = new Set(Object.keys(prod[p].environment ?? {}));
    const prodOnly = [...pKeys].filter(k => !sKeys.has(k) && !allowedProdOnly[s].includes(k));
    const standbyOnly = [...sKeys].filter(k => !pKeys.has(k) && !allowedStandbyOnly[s].includes(k));
    if (prodOnly.length || standbyOnly.length) {
      throw new Error(
        "env drift " + s + "/" + p + ": только в production=[" + prodOnly +
          "] только в standby=[" + standbyOnly + "]"
      );
    }
  }

  // Fresh primary и standby должны видеть один безопасный рабочий профиль:
  // OpenAI API + Sol + выключенный рубильник. Subscription не может снова
  // стать default только в одном compose-файле.
  for (const [services, coreName, agentsName, label] of [
    [standby, "core", "agents", "standby"],
    [prod, "mydon-core", "mydon-agents", "production"],
  ]) {
    const coreEnv = services[coreName].environment ?? {};
    const agentsEnv = services[agentsName].environment ?? {};
    for (const [name, env] of [[coreName, coreEnv], [agentsName, agentsEnv]]) {
      if (env.LLM_ENABLED !== "0" || env.LLM_ROUTE !== "openai-api" || env.LLM_MODEL !== "gpt-5.6-sol") {
        throw new Error(label + "/" + name + " has unsafe LLM defaults");
      }
      if (env.LLM_BASE_URL !== "https://api.openai.com/v1" || env.LLM_PRICE_PROVIDER_ID !== "openai") {
        throw new Error(label + "/" + name + " must bind the official OpenAI pricing route");
      }
    }
    if (agentsEnv.LLM_HTTP_BILLING_MODE !== "metered") {
      throw new Error(label + "/" + agentsName + " must use the Core metered ledger");
    }
    if (!("LLM_API_KEY" in agentsEnv)) {
      throw new Error(label + "/" + agentsName + " must receive the server-only LLM_API_KEY slot");
    }
    for (const name of Object.keys(services)) {
      if (name !== agentsName && "LLM_API_KEY" in (services[name].environment ?? {})) {
        throw new Error(label + "/" + name + " must not receive LLM_API_KEY");
      }
    }
    if (coreEnv.LLM_GLOBAL_DAILY_BUDGET_USD !== "" || coreEnv.LLM_MAX_RESERVATION_USD !== "3") {
      throw new Error(label + "/" + coreName + " must own the shared 10/3 USD ledger policy");
    }
    if ("LLM_GLOBAL_DAILY_BUDGET_USD" in agentsEnv || "LLM_MAX_RESERVATION_USD" in agentsEnv) {
      throw new Error(label + "/" + agentsName + " must not enforce a second global ledger policy");
    }
  }
'

default_services=$(
  STANDBY_PANEL_BIND=127.0.0.1 STANDBY_ATTACHMENTS_DIR="$ATT_DIR" \
    STANDBY_LLM_OUTBOX_DIR="$LLM_OUTBOX_DIR" \
    run_clean docker compose -f "$COMPOSE_YML" --env-file "$ENV_FILE" config --services | sort
)
[ "$default_services" = $'cc\ncore' ]
worker_services=$(
  STANDBY_PANEL_BIND=127.0.0.1 STANDBY_ATTACHMENTS_DIR="$ATT_DIR" \
    STANDBY_LLM_OUTBOX_DIR="$LLM_OUTBOX_DIR" \
    run_clean docker compose -f "$COMPOSE_YML" --env-file "$ENV_FILE" --profile workers \
      config --services | sort
)
[ "$worker_services" = $'agents\nbot\ncc\ncore' ]

MISSING_ENV="$TMP/missing.env"
printf 'SERVICE_TOKEN=still-not-enough\n' > "$MISSING_ENV"
if STANDBY_PANEL_BIND=127.0.0.1 STANDBY_ATTACHMENTS_DIR="$ATT_DIR" \
  STANDBY_LLM_OUTBOX_DIR="$LLM_OUTBOX_DIR" \
  run_clean docker compose -f "$COMPOSE_YML" --env-file "$MISSING_ENV" config --quiet \
  >"$TMP/missing.out" 2>&1; then
  printf 'standby accepted a missing DATABASE_URL\n' >&2
  exit 1
fi
grep -q 'DATABASE_URL is required' "$TMP/missing.out"

NO_TOKEN_ENV="$TMP/no-token.env"
printf 'DATABASE_URL=postgresql://runtime-user:runtime-secret@db.example.test/postgres\n' > "$NO_TOKEN_ENV"
if STANDBY_PANEL_BIND=127.0.0.1 STANDBY_ATTACHMENTS_DIR="$ATT_DIR" \
  STANDBY_LLM_OUTBOX_DIR="$LLM_OUTBOX_DIR" \
  run_clean docker compose -f "$COMPOSE_YML" --env-file "$NO_TOKEN_ENV" config --quiet \
  >"$TMP/no-token.out" 2>&1; then
  printf 'standby accepted an empty SERVICE_TOKEN (read-only control plane)\n' >&2
  exit 1
fi
grep -q 'SERVICE_TOKEN is required' "$TMP/no-token.out"

if run_clean "$ROOT/deploy/standby-promote.sh" "$ENV_FILE" >"$TMP/promote.out" 2>&1; then
  printf 'standby promotion accepted missing operator confirmation\n' >&2
  exit 1
fi
grep -q 'STANDBY_CONFIRM_PRODUCTION_DOWN=YES' "$TMP/promote.out"

# Даже С подтверждением promote на неподготовленной машине обязан отказать
# (нет tailscale/env-файла/образа — что именно, зависит от машины), а не
# дойти до docker compose up. Подтверждение доставляем ВНУТРИ run_clean:
# префиксное присваивание перед вызовом функции стёрлось бы её же `env -u`,
# и тест вакуумно проверял бы тот же первый гейт, что и предыдущий.
if run_clean env STANDBY_CONFIRM_PRODUCTION_DOWN=YES \
  "$ROOT/deploy/standby-promote.sh" "$TMP/definitely-missing.env" \
  >"$TMP/promote2.out" 2>&1; then
  printf 'standby promotion ran on an unprovisioned machine\n' >&2
  exit 1
fi
grep -q 'FAIL standby promotion' "$TMP/promote2.out"
# Доказательство, что первый гейт ПРОЙДЕН и отказ случился на пред-проверках:
if grep -q 'нужно STANDBY_CONFIRM_PRODUCTION_DOWN=YES' "$TMP/promote2.out"; then
  printf 'confirmation did not reach promote — negative test is vacuous\n' >&2
  exit 1
fi

printf 'standby-compose tests: ok\n'
