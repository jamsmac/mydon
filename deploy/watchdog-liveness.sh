#!/usr/bin/env bash
# Сторож за сторожем — проверка, что внешний сторож вообще работает.
#
# ЗАЧЕМ. Схема dead-man switch односторонняя: сторож видит, что сервер лежит,
# но что сторож сам умер, не видит никто. А умирает он тихо — сломанный
# workflow, отозванный токен, отключённое GitHub расписание (Actions
# выключает cron в репозитории после 60 дней без коммитов). Тишина при этом
# читается как «всё хорошо» ровно в тот момент, когда проверять стало некому.
# Так уже было: сторож падал на checkout и не проверил ни одного heartbeat.
#
# КАК. Сторож на каждом прогоне пишет отметку в тот же приватный gist
# (tools/watchdog-check.mjs → watchdog.json). Этот скрипт читает её с сервера
# и бьёт тревогу в Telegram, если отметка протухла. Получается взаимная
# слежка: сторож следит за сервером, сервер — за сторожем. Оба лежат
# одновременно — не заметит никто, но это уже требует третьей площадки.
#
# Настройка: те же /etc/mydon-heartbeat.env + токен бота тревог:
#   HEARTBEAT_GIST_ID=...        # тот же gist, что у heartbeat
#   HEARTBEAT_GH_TOKEN=...       # Gists: read (write уже есть у heartbeat)
#   WATCHDOG_BOT_TOKEN=...       # тот же бот, что у Actions-сторожа
#   WATCHDOG_CHAT_IDS=...        # chat_id через запятую
#   [WATCHDOG_LIVENESS_STALE_MINUTES=45]
#   [WATCHDOG_LIVENESS_REMIND_HOURS=6]
# См. docs/watchdog.md.
set -euo pipefail

ENV_FILE="/etc/mydon-heartbeat.env"
[ -f "$ENV_FILE" ] || { echo "нет $ENV_FILE — сторож за сторожем не настроен"; exit 1; }
# shellcheck disable=SC1090
. "$ENV_FILE"
: "${HEARTBEAT_GIST_ID:?HEARTBEAT_GIST_ID не задан}"
: "${HEARTBEAT_GH_TOKEN:?HEARTBEAT_GH_TOKEN не задан}"

# Порог 6 часов — по ИЗМЕРЕННОМУ расписанию, а не по заявленному.
#
# В workflow стоит cron */10, но GitHub его не соблюдает и близко. Замер по
# истории запусков за сутки: 83, 80, 65, 58, 82, 196, 166 минут между
# соседними прогонами. Планировщик Actions отдаёт scheduled-запуски по
# остаточному принципу и молча пропускает большинство тиков.
#
# Отсюда и порог: 6 часов держат худший наблюдённый промежуток (196 мин) с
# двукратным запасом. Всё, что меньше трёх часов, превратило бы сторожа за
# сторожем в генератор ложных тревог — то есть в то же слепое пятно, только
# шумное: на такие сообщения перестают смотреть за день.
#
# Плата за это честная: смерть сторожа замечается за часы, а не за минуты.
# Меньше и не нужно — реальный отказ, ради которого всё делалось, длился
# сутками.
STALE_MIN="${WATCHDOG_LIVENESS_STALE_MINUTES:-360}"
# Повтор тревоги, пока сторож молчит. Не каждый прогон: молчащий сторож —
# не авария, а слепое пятно, и напоминание каждые 15 минут приучает
# пролистывать. Но и одного сообщения в 03:00 мало — его просто не увидят.
REMIND_H="${WATCHDOG_LIVENESS_REMIND_HOURS:-12}"
STATE_FILE="${WATCHDOG_LIVENESS_STATE_FILE:-/var/lib/mydon/watchdog-liveness.json}"
mkdir -p "$(dirname "$STATE_FILE")"

body="$(mktemp)"
trap 'rm -f "$body"' EXIT

code="$(curl -sS -o "$body" -w '%{http_code}' \
  -H "Authorization: Bearer $HEARTBEAT_GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  --max-time 20 \
  "https://api.github.com/gists/$HEARTBEAT_GIST_ID" || echo "000")"

# Свой отказ сети — не повод объявлять сторожа мёртвым: снаружи он в этот
# момент, скорее всего, жив, а вот наш heartbeat перестанет уходить, и
# тревогу поднимет он же. Молчим и пишем в лог.
if [ "$code" != "200" ]; then
  echo "gist недоступен (HTTP $code) — проверку пропускаем, тревогу не поднимаем"
  exit 0
fi

verdict="$(python3 - "$body" "$STATE_FILE" "$STALE_MIN" "$REMIND_H" <<'PY'
import json, sys, time
from datetime import datetime, timezone

body_path, state_path, stale_min, remind_h = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
now = time.time()

try:
    with open(state_path, encoding="utf-8") as f:
        state = json.load(f)
except Exception:
    state = {}
# Первый прогон: с этого момента и отсчитывается ожидание первой отметки —
# на свежей установке сторож ещё не отработал, и это не авария.
since = float(state.get("since") or now)
down = bool(state.get("down"))
alerted_at = float(state.get("alerted_at") or 0)

def parse(ts):
    try:
        return datetime.fromisoformat(str(ts).replace("Z", "+00:00")).timestamp()
    except Exception:
        return None

mark_ts = None
try:
    with open(body_path, encoding="utf-8") as f:
        files = (json.load(f) or {}).get("files") or {}
    raw = (files.get("watchdog.json") or {}).get("content")
    if raw:
        mark_ts = parse((json.loads(raw) or {}).get("ts"))
except Exception:
    pass

# Отметки нет вовсе — считаем возрастом наше собственное ожидание: так
# «сторож не отработал ни разу» тоже становится тревогой, а не вечной тишиной.
age_min = (now - (mark_ts if mark_ts is not None else since)) / 60.0
alive = age_min <= stale_min
seen = "отметка" if mark_ts is not None else "отметки нет ни разу, ждём"

if alive:
    action = "recovered" if down else "ok"
    state = {"since": since, "down": False, "alerted_at": 0}
else:
    repeat = down and (now - alerted_at) >= remind_h * 3600
    action = "alert" if (not down or repeat) else "quiet"
    state = {
        "since": since,
        "down": True,
        "alerted_at": now if action == "alert" else alerted_at,
    }

with open(state_path, "w", encoding="utf-8") as f:
    json.dump(state, f)

print(f"{action}|{seen}|{age_min:.0f}")
PY
)"

action="${verdict%%|*}"
rest="${verdict#*|}"
seen="${rest%%|*}"
age="${rest##*|}"

send() {
  [ -n "${WATCHDOG_BOT_TOKEN:-}" ] && [ -n "${WATCHDOG_CHAT_IDS:-}" ] || {
    echo "WATCHDOG_BOT_TOKEN/WATCHDOG_CHAT_IDS не заданы — тревога только в лог: $1"
    return 0
  }
  local chat
  IFS=',' read -ra chats <<< "$WATCHDOG_CHAT_IDS"
  for chat in "${chats[@]}"; do
    chat="$(echo "$chat" | tr -d '[:space:]')"
    [ -n "$chat" ] || continue
    curl -sS -X POST --max-time 15 \
      -H "Content-Type: application/json" \
      -d "$(python3 -c 'import json,sys; print(json.dumps({"chat_id": sys.argv[1], "text": sys.argv[2]}))' "$chat" "$1")" \
      "https://api.telegram.org/bot${WATCHDOG_BOT_TOKEN}/sendMessage" >/dev/null || \
      echo "тревога не отправлена в $chat"
  done
}

case "$action" in
  ok)
    echo "ok: сторож отработал ${age} мин назад (порог ${STALE_MIN})"
    ;;
  quiet)
    echo "сторож молчит ${age} мин, тревога уже отправлена — напомним через ${REMIND_H} ч"
    ;;
  recovered)
    send "✅ Внешний сторож снова работает: отметка ${age} мин назад."
    echo "recovered: сторож снова отработал"
    ;;
  alert)
    send "🚨 Внешний сторож MYDON молчит ${age} мин (порог ${STALE_MIN}, ${seen}).
Сервер жив — это пишет он сам. Некому проверять, если он ляжет.
Смотри GitHub → Actions → workflow «watchdog»: сломан запуск, отозван токен
или Actions отключил расписание за неактивность репозитория."
    echo "alert: сторож молчит ${age} мин"
    ;;
  *)
    echo "неожиданный вердикт: $verdict"
    exit 1
    ;;
esac
