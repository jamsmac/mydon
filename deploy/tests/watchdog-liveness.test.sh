#!/usr/bin/env bash
# State-машина watchdog-liveness.sh на фейковом curl: тревога и recovered
# фиксируются в state ТОЛЬКО после подтверждённой доставки — сорвавшаяся
# отправка повторяется следующим тиком, а не молчит REMIND_H часов.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fail() { printf 'watchdog-liveness: FAIL %s\n' "$*" >&2; exit 1; }

mkdir -p "$TMP/bin"
cat > "$TMP/bin/curl" <<'FAKE'
#!/usr/bin/env bash
# Фейковый curl: gist отдаёт заготовленное тело, Telegram — режим из env.
out=""
prev=""
for a in "$@"; do
  [ "$prev" = "-o" ] && out="$a"
  prev="$a"
done
case "$*" in
  *api.github.com/gists*)
    cat "$FAKE_GIST_BODY" > "$out"
    printf '200'
    exit 0
    ;;
  *api.telegram.org*)
    case "${FAKE_TG_MODE:-ok}" in
      ok) printf '{"ok":true,"result":{}}' ;;
      reject) printf '{"ok":false,"description":"Unauthorized"}' ;;
      net) exit 6 ;;
    esac
    exit 0
    ;;
esac
echo "fake-curl: неожиданный вызов: $*" >&2
exit 9
FAKE
chmod +x "$TMP/bin/curl"

ENVF="$TMP/heartbeat.env"
printf '%s\n' \
  'HEARTBEAT_GIST_ID=fixture' \
  'HEARTBEAT_GH_TOKEN=fixture' \
  'WATCHDOG_BOT_TOKEN=fixture-bot' \
  'WATCHDOG_CHAT_IDS=1001' \
  > "$ENVF"
STATE="$TMP/state.json"

gist_with_ts() {
  python3 - "$1" > "$TMP/gist.json" <<'PY'
import json, sys
print(json.dumps({"files": {"watchdog.json": {"content": json.dumps({"ts": sys.argv[1]})}}}))
PY
}
state_get() {
  python3 - "$STATE" "$1" <<'PY'
import json, sys
with open(sys.argv[1], encoding="utf-8") as f:
    v = json.load(f).get(sys.argv[2])
# Числа нормализуем (0.0 -> 0): bash сравнивает строки. bool — раньше int!
if isinstance(v, bool):
    print(v)
elif isinstance(v, (int, float)):
    print(int(v))
else:
    print(v)
PY
}
run() {
  PATH="$TMP/bin:$PATH" \
  WATCHDOG_ENV_FILE="$ENVF" \
  WATCHDOG_LIVENESS_STATE_FILE="$STATE" \
  FAKE_GIST_BODY="$TMP/gist.json" \
  FAKE_TG_MODE="$1" \
    bash "$ROOT/deploy/watchdog-liveness.sh"
}

# Сторож «молчит»: древняя отметка.
gist_with_ts "2020-01-01T00:00:00Z"

# 1. Telegram отклоняет → тревога НЕ считается отправленной (alerted_at = 0).
out=$(run reject) || fail "прогон 1 упал"
printf '%s' "$out" | grep -q 'тревога НЕ доставлена' || fail "нет пометки о недоставке: $out"
[ "$(state_get down)" = "True" ] || fail "down не выставлен"
[ "$(state_get alerted_at)" = "0" ] || fail "недоставленная тревога записала alerted_at"

# 1б. Сетевой отказ curl к Telegram — тот же исход: ретрай, не тишина.
out=$(run net) || fail "прогон 1б упал"
printf '%s' "$out" | grep -q 'сеть недоступна' || fail "нет пометки о сетевом сбое: $out"
printf '%s' "$out" | grep -q 'тревога НЕ доставлена' || fail "сетевой сбой засчитан доставкой: $out"
[ "$(state_get alerted_at)" = "0" ] || fail "сетевой сбой записал alerted_at"

# 2. Следующий тик ПОВТОРЯЕТ тревогу (раньше молчал бы REMIND_H часов).
out=$(run reject) || fail "прогон 2 упал"
printf '%s' "$out" | grep -q 'тревога НЕ доставлена' || fail "ретрая не случилось: $out"

# 3. Доставка удалась → alerted_at зафиксирован.
out=$(run ok) || fail "прогон 3 упал"
printf '%s' "$out" | grep -q '^alert:' || fail "нет alert при доставке: $out"
[ "$(state_get alerted_at)" != "0" ] || fail "доставленная тревога не записала alerted_at"

# 4. Дальше — quiet до REMIND_H.
out=$(run ok) || fail "прогон 4 упал"
printf '%s' "$out" | grep -q 'тревога уже отправлена' || fail "нет quiet после доставки: $out"

# 5. Сторож ожил, но recovered не доставлен → состояние «down» сохраняется.
gist_with_ts "$(python3 -c 'import datetime; print(datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"))')"
out=$(run reject) || fail "прогон 5 упал"
printf '%s' "$out" | grep -q 'recovered НЕ доставлен' || fail "нет пометки о недоставке recovered: $out"
[ "$(state_get down)" = "True" ] || fail "down сброшен без доставки recovered"

# 6. Recovered доставлен → состояние очищено.
out=$(run ok) || fail "прогон 6 упал"
printf '%s' "$out" | grep -q '^recovered:' || fail "нет recovered при доставке: $out"
[ "$(state_get down)" = "False" ] || fail "down не сброшен после доставки"
[ "$(state_get alerted_at)" = "0" ] || fail "alerted_at не сброшен после recovered"

# 7. Битый watchdog.json (файл есть, не парсится) → пропуск прогона, а не
#    мгновенный ложный alert от древнего since; state не тронут.
printf '%s' '{"files":{"watchdog.json":{"content":"мусор"}}}' > "$TMP/gist.json"
out=$(run ok) || fail "прогон 7 упал"
printf '%s' "$out" | grep -q 'нечитаемый watchdog.json' || fail "битый JSON не распознан: $out"
[ "$(state_get down)" = "False" ] || fail "битый JSON изменил state"

printf 'watchdog-liveness tests: ok\n'
