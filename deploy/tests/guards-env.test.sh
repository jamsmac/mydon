#!/usr/bin/env bash
# Сторожа mydon берут ключи ТОЛЬКО из окружения mydon и не молчат без него.
#
# Проверяется ровно то, что ломалось в бою: хостовые копии читали бота СКЛАДА,
# поэтому переезд склада тихо унёс бы канал тревог, а сторож продолжал бы
# выходить с кодом 0 — «работает».
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fail() { printf 'guards-env: FAIL %s\n' "$*" >&2; exit 1; }

mkdir -p "$TMP/bin"

# curl-фикстура: всё недоступно, кроме Telegram (его отличает флаг -K-, через
# который в настоящем скрипте уходит URL с токеном — он не должен попадать в argv).
cat > "$TMP/bin/curl" <<'FAKE'
#!/usr/bin/env bash
set -u
tg=0
for a in "$@"; do [ "$a" = "-K-" ] && tg=1; done
{
  printf 'ARGS %s\n' "$*"
  if [ "$tg" -eq 1 ]; then printf 'STDIN '; cat; printf '\n'; fi
} >> "$FAKE_CURL_LOG"
[ "$tg" -eq 1 ] && exit "${FAKE_CURL_TG_RC:-0}"
case "$*" in
  */healthz*) exit "${FAKE_CURL_HEALTHZ_RC:-7}" ;;
esac
exit "${FAKE_CURL_RC:-7}"
FAKE
# df-фикстура: диск в красной зоне, иначе сторож честно вышел бы молча.
cat > "$TMP/bin/df" <<'FAKE'
#!/bin/sh
[ "${FAKE_DF_FAIL:-0}" = 1 ] && exit 1
echo 'Filesystem 1024-blocks   Used Available Capacity Mounted on'
echo "/dev/fixture   1000000 910000     90000      ${FAKE_DF_PCT:-91}% /"
FAKE
# docker-фикстура: контейнера нет, здоровье неизвестно.
printf '#!/bin/sh\nexit 1\n' > "$TMP/bin/docker"
chmod +x "$TMP/bin/curl" "$TMP/bin/df" "$TMP/bin/docker"

MYDON_ENV="$TMP/mydon.env"
ALERT_ENV="$TMP/heartbeat.env"
STOCK_ENV="$TMP/stock.env"
LOG="$TMP/guard.log"
CURL_LOG="$TMP/curl.log"

printf '%s\n' 'BOT_TOKEN=stock-secret-token' 'TG_BACKUP_CHAT_ID=9001' \
  'ADMIN_TG_IDS=9002' 'WEB_PORT=10.0.0.9:9999' > "$STOCK_ENV"
printf '%s\n' 'WATCHDOG_BOT_TOKEN=fixture-watchdog-token' \
  'WATCHDOG_CHAT_IDS=5551,5552' > "$ALERT_ENV"

reset_logs() { : > "$LOG"; : > "$CURL_LOG"; rm -f "$TMP/.healthz_fails"; }

guard() {  # guard <disk|healthz> [доп. переменные окружения через env]
  local name=$1; shift
  # Переданные вызовом переменные идут ПОСЛЕ значений по умолчанию: env
  # применяет присваивания слева направо, и побеждает последнее.
  env \
    GUARD_PATH_PREFIX="$TMP/bin" \
    MYDON_ENV_FILE="$MYDON_ENV" \
    WATCHDOG_ENV_FILE="$ALERT_ENV" \
    STOCK_ENV_FILE="$STOCK_ENV" \
    GUARD_LOG_FILE="$LOG" \
    HEALTHZ_STATE_FILE="$TMP/.healthz_fails" \
    CORE_INGEST_URL="http://core.fixture/ingest" \
    FAKE_CURL_LOG="$CURL_LOG" \
    "$@" \
    bash "$ROOT/deploy/guards/${name}_guard.sh"
}

# ── 1. Нет env mydon вообще: осмысленная ошибка в журнал и ненулевой код ──
for g in disk healthz; do
  reset_logs
  rm -f "$MYDON_ENV"
  set +e; guard "$g" >/dev/null 2>&1; rc=$?; set -e
  [ "$rc" -ne 0 ] || fail "${g}_guard без env вышел нулём"
  grep -q "не читается env mydon" "$LOG" || fail "${g}_guard не объяснил отсутствие env: $(cat "$LOG")"
  grep -q "$MYDON_ENV" "$LOG" || fail "${g}_guard не назвал путь env"
done

# ── 2. Env есть, но ключей в нём нет, и аварийного бота тоже нет ──
: > "$MYDON_ENV"
EMPTY_ALERT="$TMP/empty-heartbeat.env"
: > "$EMPTY_ALERT"
for g in disk healthz; do
  reset_logs
  set +e; guard "$g" WATCHDOG_ENV_FILE="$EMPTY_ALERT" >/dev/null 2>&1; rc=$?; set -e
  [ "$rc" -ne 0 ] || fail "${g}_guard без ключей вышел нулём"
  grep -q "сказать будет некому" "$LOG" || fail "${g}_guard не объяснил отсутствие ключей: $(cat "$LOG")"
done

# ── 3. Диск 91%, Core недоступен → тревога уходит аварийным ботом сторожа ──
printf '%s\n' 'INGEST_KEY=fixture-ingest' > "$MYDON_ENV"
reset_logs
guard disk >/dev/null 2>&1 || fail "disk_guard с полным конфигом вышел ненулём"
grep -q 'ARGS .*core.fixture/ingest/fixture-ingest' "$CURL_LOG" || fail "disk_guard не попробовал Core: $(cat "$CURL_LOG")"
grep -q 'botfixture-watchdog-token' "$CURL_LOG" || fail "disk_guard не ушёл аварийным ботом: $(cat "$CURL_LOG")"
grep -q 'chat_id=5551' "$CURL_LOG" || fail "disk_guard взял не первый чат из списка"
grep -q 'stock-secret-token' "$CURL_LOG" && fail "disk_guard использовал бота склада"
grep -q 'Диск Hetzner заполнен на 91%' "$CURL_LOG" || fail "в тревоге нет процента заполнения"

# ── 4. Свои TG_BACKUP_* в env mydon имеют приоритет над аварийным ботом ──
printf '%s\n' 'INGEST_KEY=fixture-ingest' 'TG_BACKUP_BOT_TOKEN=fixture-own-token' \
  'TG_BACKUP_CHAT_ID=7001' > "$MYDON_ENV"
reset_logs
guard disk >/dev/null 2>&1 || fail "disk_guard со своим ботом вышел ненулём"
grep -q 'botfixture-own-token' "$CURL_LOG" || fail "disk_guard не предпочёл свой бот: $(cat "$CURL_LOG")"
grep -q 'chat_id=7001' "$CURL_LOG" || fail "disk_guard взял не свой чат"

# ── 5. Диск ниже порога: сторож молчит, но конфигурацию уже проверил ──
reset_logs
guard disk FAKE_DF_PCT=42 >/dev/null 2>&1 || fail "disk_guard на здоровом диске вышел ненулём"
[ ! -s "$CURL_LOG" ] || fail "disk_guard на 42% кого-то дёрнул: $(cat "$CURL_LOG")"

# ── 6. healthz: адрес цели берётся из WEB_PORT склада, канал тревог — mydon ──
printf '%s\n' 'INGEST_KEY=fixture-ingest' > "$MYDON_ENV"
reset_logs
guard healthz >/dev/null 2>&1 || fail "healthz_guard (1-й провал) вышел ненулём"
grep -q 'ARGS .*http://10.0.0.9:9999/healthz' "$CURL_LOG" || fail "healthz_guard не взял адрес из WEB_PORT: $(cat "$CURL_LOG")"
[ "$(cat "$TMP/.healthz_fails")" = "1" ] || fail "не посчитан первый провал"
grep -q 'botfixture-watchdog-token' "$CURL_LOG" && fail "тревога ушла уже на первом провале"

: > "$CURL_LOG"
guard healthz >/dev/null 2>&1 || fail "healthz_guard (2-й провал) вышел ненулём"
grep -q 'botfixture-watchdog-token' "$CURL_LOG" || fail "на 2-м провале тревога не ушла: $(cat "$CURL_LOG")"
grep -q 'chat_id=5551' "$CURL_LOG" || fail "healthz_guard взял не первый чат из списка"
grep -q 'stock-secret-token' "$CURL_LOG" && fail "healthz_guard использовал бота склада"
grep -q 'docker health: unknown' "$CURL_LOG" || fail "в тревоге нет состояния контейнера"

# ── 7. HEALTHZ_TARGET в env mydon снимает зависимость от .env склада ──
printf '%s\n' 'INGEST_KEY=fixture-ingest' 'HEALTHZ_TARGET=127.0.0.1:3999' > "$MYDON_ENV"
reset_logs
guard healthz >/dev/null 2>&1 || fail "healthz_guard с HEALTHZ_TARGET вышел ненулём"
grep -q 'ARGS .*http://127.0.0.1:3999/healthz' "$CURL_LOG" || fail "HEALTHZ_TARGET не победил WEB_PORT: $(cat "$CURL_LOG")"

# ── 8. df не дал процент: сторож падает, а не докладывает «диск свободен» ──
# Пустой USED уходил в Core как usedPercent: 0 с кодом возврата 0.
printf '%s\n' 'INGEST_KEY=fixture-ingest' > "$MYDON_ENV"
reset_logs
set +e; guard disk FAKE_DF_FAIL=1 >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -ne 0 ] || fail "disk_guard при сбое df вышел нулём"
grep -q 'df не дал процент заполнения' "$LOG" || fail "disk_guard не объяснил сбой df: $(cat "$LOG")"
[ ! -s "$CURL_LOG" ] || fail "disk_guard при сбое df что-то отправил: $(cat "$CURL_LOG")"

# ── 9. healthz без цели не проверяет 127.0.0.1 «на всякий случай» ──
# Прежний фолбэк давал бы ложную тревогу каждые 5 минут: панель слушает
# Tailscale-адрес, локальный порт не отвечает никогда.
NO_TARGET="$TMP/no-target.env"
printf '%s\n' 'BOT_TOKEN=stock-secret-token' > "$NO_TARGET"
reset_logs
set +e; guard healthz STOCK_ENV_FILE="$NO_TARGET" >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -ne 0 ] || fail "healthz_guard без цели вышел нулём"
grep -q 'цель не задана' "$LOG" || fail "healthz_guard не объяснил отсутствие цели: $(cat "$LOG")"
[ ! -s "$CURL_LOG" ] || fail "healthz_guard без цели кого-то дёрнул: $(cat "$CURL_LOG")"

# ── 10. Оба канала отказали: тревога и отбой не исчезают бесследно ──
reset_logs
guard healthz FAKE_CURL_TG_RC=1 >/dev/null 2>&1 || fail "healthz_guard (1-й провал) вышел ненулём"
guard healthz FAKE_CURL_TG_RC=1 >/dev/null 2>&1 || fail "healthz_guard (2-й провал) вышел ненулём"
grep -q 'тревога о mydon-stock не ушла ни в Core, ни в Telegram' "$LOG" ||
  fail "потерянная тревога не попала в журнал: $(cat "$LOG")"

# Отбой: сервис ответил после трёх провалов, но ни Core, ни Telegram не приняли.
reset_logs
echo 3 > "$TMP/.healthz_fails"
guard healthz FAKE_CURL_HEALTHZ_RC=0 FAKE_CURL_TG_RC=1 >/dev/null 2>&1 ||
  fail "healthz_guard на восстановлении вышел ненулём"
grep -q 'отбой по mydon-stock не ушёл ни в Core, ни в Telegram' "$LOG" ||
  fail "потерянный отбой не попал в журнал: $(cat "$LOG")"
[ ! -e "$TMP/.healthz_fails" ] || fail "счётчик провалов не сброшен после восстановления"

printf 'guards-env tests: ok\n'
