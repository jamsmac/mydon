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

# Переопределение — только для теста deploy/tests/watchdog-liveness.test.sh.
ENV_FILE="${WATCHDOG_ENV_FILE:-/etc/mydon-heartbeat.env}"
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

# `|| echo 000` давал «000000»: при сетевом сбое curl сам печатает 000 из -w
# И выходит ненулём. Перетираем код при ЛЮБОМ ненулевом выходе curl: transfer,
# оборвавшийся ПОСЛЕ заголовков (истёк --max-time на теле), печатает 200 при
# битом теле — это тоже «недоступен», а не валидный ответ.
if ! code="$(curl -sS -o "$body" -w '%{http_code}' \
  -H "Authorization: Bearer $HEARTBEAT_GH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  --max-time 20 \
  "https://api.github.com/gists/$HEARTBEAT_GIST_ID")"; then
  code=000
fi

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
raw = None
try:
    with open(body_path, encoding="utf-8") as f:
        files = (json.load(f) or {}).get("files") or {}
    raw = (files.get("watchdog.json") or {}).get("content")
    if raw:
        mark_ts = parse((json.loads(raw) or {}).get("ts"))
except Exception:
    pass

# Файл ЕСТЬ, но не разобрался (битый ответ/повреждённый gist): это не
# «отметки нет ни разу» — иначе один порченый ответ давал бы мгновенный
# ложный alert с возрастом от древнего since. Пропускаем прогон, state
# не трогаем: настоящая тишина сторожа догонит через возраст отметки.
if raw and mark_ts is None:
    print("skip|watchdog.json не разобрался|0")
    raise SystemExit

# Отметки нет вовсе — считаем возрастом наше собственное ожидание: так
# «сторож не отработал ни разу» тоже становится тревогой, а не вечной тишиной.
age_min = (now - (mark_ts if mark_ts is not None else since)) / 60.0
alive = age_min <= stale_min
seen = "отметка" if mark_ts is not None else "отметки нет ни разу, ждём"

# alerted_at здесь НЕ обновляется: раньше отметка ставилась ДО отправки, и
# сорвавшаяся тревога подавлялась на REMIND_H часов, а recovered терялся
# навсегда. Теперь доставку подтверждает bash (commit_state) — до неё state
# оставляет действие «должно случиться», и следующий тик повторяет попытку.
if alive:
    action = "recovered" if down else "ok"
    if action == "ok":
        state = {"since": since, "down": False, "alerted_at": 0}
    else:
        state = {"since": since, "down": True, "alerted_at": alerted_at}
else:
    repeat = down and (now - alerted_at) >= remind_h * 3600
    action = "alert" if (not down or repeat) else "quiet"
    state = {"since": since, "down": True, "alerted_at": alerted_at}

with open(state_path, "w", encoding="utf-8") as f:
    json.dump(state, f)

print(f"{action}|{seen}|{age_min:.0f}")
PY
)"

action="${verdict%%|*}"
rest="${verdict#*|}"
seen="${rest%%|*}"
age="${rest##*|}"

# Возврат 0 = сообщение реально доставлено хотя бы в один чат (или каналов
# нет вовсе — тогда журнал и есть канал). По нему commit_state фиксирует
# alerted_at/сброс down; без доставки state не меняется и следующий
# 15-минутный тик повторяет попытку.
send() {
  if [ -z "${WATCHDOG_BOT_TOKEN:-}" ] || [ -z "${WATCHDOG_CHAT_IDS:-}" ]; then
    echo "WATCHDOG_BOT_TOKEN/WATCHDOG_CHAT_IDS не заданы — тревога только в лог: $1"
    return 0
  fi
  local chat resp delivered=1
  IFS=',' read -ra chats <<< "$WATCHDOG_CHAT_IDS"
  for chat in "${chats[@]}"; do
    chat="$(echo "$chat" | tr -d '[:space:]')"
    [ -n "$chat" ] || continue
    # curl без -f не отличает HTTP 200 с телом {"ok":false,...} от настоящей
    # доставки: неверный токен бота Telegram отвечает 200/401/404, но curl
    # сам по себе на это не падает. Найдено на практике на соседнем скрипте
    # (heartbeat.sh) — та же ошибка молча превращала неудачу в «отправлено».
    # Поэтому проверяем поле "ok" в самом ответе, а не только код завершения.
    resp="$(curl -sS -X POST --max-time 15 \
      -H "Content-Type: application/json" \
      -d "$(python3 -c 'import json,sys; print(json.dumps({"chat_id": sys.argv[1], "text": sys.argv[2]}))' "$chat" "$1")" \
      "https://api.telegram.org/bot${WATCHDOG_BOT_TOKEN}/sendMessage")" || {
      echo "тревога не отправлена в $chat: сеть недоступна"
      continue
    }
    if printf '%s' "$resp" | python3 -c 'import json,sys; sys.exit(0 if json.load(sys.stdin).get("ok") else 1)' 2>/dev/null; then
      delivered=0
    else
      echo "тревога не отправлена в $chat: Telegram отклонил — $(printf '%s' "$resp" | head -c 200)"
    fi
  done
  return "$delivered"
}

# Фиксация доставленного действия в state — ПОСЛЕ подтверждения Telegram.
commit_state() {
  python3 - "$STATE_FILE" "$1" <<'PY'
import json, sys, time
path, op = sys.argv[1], sys.argv[2]
try:
    with open(path, encoding="utf-8") as f:
        state = json.load(f)
except Exception:
    state = {}
if op == "alert_sent":
    state["down"] = True
    state["alerted_at"] = time.time()
else:  # recovered_sent
    state["down"] = False
    state["alerted_at"] = 0
with open(path, "w", encoding="utf-8") as f:
    json.dump(state, f)
PY
}

case "$action" in
  skip)
    echo "gist отдал нечитаемый watchdog.json — проверку пропускаем, state не трогаем"
    ;;
  ok)
    echo "ok: сторож отработал ${age} мин назад (порог ${STALE_MIN})"
    ;;
  quiet)
    echo "сторож молчит ${age} мин, тревога уже отправлена — напомним через ${REMIND_H} ч"
    ;;
  recovered)
    if send "✅ Внешний сторож снова работает: отметка ${age} мин назад."; then
      commit_state recovered_sent
      echo "recovered: сторож снова отработал"
    else
      echo "recovered НЕ доставлен — повторим следующим тиком"
    fi
    ;;
  alert)
    if send "🚨 Внешний сторож MYDON молчит ${age} мин (порог ${STALE_MIN}, ${seen}).
Сервер жив — это пишет он сам. Некому проверять, если он ляжет.
Смотри GitHub → Actions → workflow «watchdog»: сломан запуск, отозван токен
или Actions отключил расписание за неактивность репозитория."; then
      commit_state alert_sent
      echo "alert: сторож молчит ${age} мин"
    else
      echo "тревога НЕ доставлена — повторим следующим тиком"
    fi
    ;;
  *)
    echo "неожиданный вердикт: $verdict"
    exit 1
    ;;
esac
