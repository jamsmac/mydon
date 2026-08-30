#!/usr/bin/env bash
# Promote a prepared cold standby. Workers remain opt-in to prevent split brain.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COMPOSE_FILE="$ROOT/deploy/docker-compose.standby.yml"
ENV_FILE="${1:-${STANDBY_ENV_FILE:-$HOME/.config/mydon/standby-production.env}}"
CORE_PORT="${STANDBY_CORE_PORT:-3101}"
PANEL_PORT="${STANDBY_PANEL_PORT:-3102}"
# При пересоздании primary на новом Tailscale-IP значение обязано быть
# обновлено (см. docs/DATABASE_DR.md): проверка по мёртвому адресу вечно
# отвечает 000 и ничего не доказывает.
PRIMARY_PANEL_URL="${PRIMARY_PANEL_URL:-http://100.81.197.68:3002/}"
# Порог сторожа (watchdog): heartbeat пишется каждые 2 минуты, протухание — 10.
HEARTBEAT_FRESH_SECONDS="${HEARTBEAT_FRESH_SECONDS:-600}"

fail() { printf 'FAIL standby promotion: %s\n' "$*" >&2; exit 1; }
# shellcheck source=deploy/standby-lib.sh
. "$ROOT/deploy/standby-lib.sh"

[ "${STANDBY_CONFIRM_PRODUCTION_DOWN:-}" = YES ] ||
  fail "нужно STANDBY_CONFIRM_PRODUCTION_DOWN=YES"
# Порог — операторская ручка, задаваемая посреди аварии. `[ -lt ]` с
# нечисловым операндом («10m») вернул бы статус 2, который elif читает как
# «ложь» — и гейт молча инвертировался бы в пользу promote против живого
# primary. Поэтому только целые секунды, и проверяем это ДО использования.
case "$HEARTBEAT_FRESH_SECONDS" in
  '' | *[!0-9]*) fail "HEARTBEAT_FRESH_SECONDS должен быть целым числом секунд, получено: '$HEARTBEAT_FRESH_SECONDS'" ;;
esac
command -v docker >/dev/null 2>&1 || fail "docker не установлен"
command -v tailscale >/dev/null 2>&1 || fail "tailscale не установлен"
command -v curl >/dev/null 2>&1 || fail "curl не установлен"
ENV_FILE=$(require_env_file "$ENV_FILE")
docker image inspect mydon:standby >/dev/null 2>&1 ||
  fail "образ mydon:standby не подготовлен; сначала standby-drill.sh"

# ── Доказательства жизни primary ─────────────────────────────────────────────
# «Панель недоступна» НЕ доказывает «workers остановлены»: бот primary поллит
# api.telegram.org через публичный интернет и переживает упавший CC, зависший
# tailscaled и смену tailnet-IP. Поэтому проверок две, независимые:
#   1) панель через tailnet (как раньше);
#   2) heartbeat-gist — primary сам пишет отметку каждые 2 минуты, и свежая
#      отметка доказывает живое приложение с живой БД БЕЗ участия tailnet.
# ЛЮБОЕ доказательство жизни означает отказ. Отсутствие доказательств смерти
# не доказывает — если есть хоть какой-то доступ к primary (ssh, консоль
# провайдера), сначала остановить контейнеры там (docs/DATABASE_DR.md).
if [ "${STANDBY_ALLOW_SPLIT_BRAIN:-0}" != 1 ]; then
  primary_status=$(curl -sS -L -o /dev/null -w '%{http_code}' --max-time 10 \
    "$PRIMARY_PANEL_URL" || true)
  [ "$primary_status" != 200 ] ||
    fail "production CC отвечает HTTP 200; standby запускать нельзя"
  if [ "${STANDBY_START_WORKERS:-0}" = 1 ] && [ "$primary_status" != 000 ]; then
    fail "production CC отвечает HTTP $primary_status; нельзя доказать остановку primary workers"
  fi

  # Heartbeat-гейт ОБЯЗАТЕЛЕН: без него единственным «доказательством» смерти
  # остаётся curl 000 на, возможно, устаревший tailnet-адрес — исходный
  # сценарий сплит-брейна. unknown = отказ (fail-closed), осознанный обход —
  # тем же STANDBY_ALLOW_SPLIT_BRAIN=1, что и для остальных проверок.
  hb_age=$(heartbeat_age_seconds "$ENV_FILE")
  if [ "$hb_age" = unknown ]; then
    fail "heartbeat primary не проверен: нет HEARTBEAT_GIST_ID в env-файле, gist недоступен или нет python3 (см. docs/DATABASE_DR.md, «Standby env»). Без этого канала недоступность панели ничего не доказывает. Осознанный обход: STANDBY_ALLOW_SPLIT_BRAIN=1"
  elif [ "$hb_age" -lt "$HEARTBEAT_FRESH_SECONDS" ]; then
    fail "primary ЖИВ: heartbeat записан ${hb_age}с назад (порог ${HEARTBEAT_FRESH_SECONDS}с). Панель при этом недоступна — чините связь, а не запускайте второй контур"
  else
    printf 'heartbeat primary устарел (%sс назад): Core не отвечал дольше порога. ВНИМАНИЕ: это НЕ доказывает остановку бота/агентов — они переживают смерть Core. Если есть любой доступ к primary (ssh, консоль Hetzner) — сначала остановите контейнеры там.\n' "$hb_age"
  fi
fi

# Бот не сможет работать без валидного токена и сети до Telegram — проверяем
# ДО старта: контейнер с мёртвым токеном остаётся Running (ловит ошибку и ждёт),
# и прежняя проверка «Running + переменные непусты» сертифицировала бы мёртвый
# failover как успешный.
BOT_TOKEN=""
if [ "${STANDBY_START_WORKERS:-0}" = 1 ]; then
  BOT_TOKEN=$(env_file_value "$ENV_FILE" TELEGRAM_BOT_TOKEN)
  [ -n "$BOT_TOKEN" ] || fail "TELEGRAM_BOT_TOKEN пуст в env-файле — воркеры не поднять"
  [ -n "$(env_file_value "$ENV_FILE" TELEGRAM_ALLOWED_CHAT_IDS)" ] ||
    fail "TELEGRAM_ALLOWED_CHAT_IDS пуст в env-файле — бот никого не пустит"
  # Транзиентный сбой сети посреди аварии не должен валить promote с первой
  # попытки — ретраим; 401/404 (мёртвый токен) окончательны сразу.
  getme=000
  for _ in 1 2 3; do
    getme=$(telegram_getme_probe "$BOT_TOKEN")
    case "$getme" in
      200) break ;;
      401 | 404) fail "TELEGRAM_BOT_TOKEN недействителен (getMe HTTP $getme)" ;;
      *) sleep 5 ;;
    esac
  done
  [ "$getme" = 200 ] ||
    fail "Telegram недоступен со standby (getMe HTTP $getme, 3 попытки) — бот работать не сможет"
fi

attachments_init
llm_outbox_init
export STANDBY_CORE_PORT="$CORE_PORT"
export STANDBY_PANEL_PORT="$PANEL_PORT"
export STANDBY_PANEL_BIND="${STANDBY_PANEL_BIND:-$(tailscale ip -4 | head -1)}"
[ -n "$STANDBY_PANEL_BIND" ] || fail "не найден Tailscale IPv4"
GIT_SHA=$(repo_git_sha "$ROOT")
export GIT_SHA
require_image_matches_repo "$ROOT" mydon:standby
compose_init "$COMPOSE_FILE" "$ENV_FILE"

cleanup_failed_promotion() {
  "${COMPOSE[@]}" --profile workers stop agents bot cc core >/dev/null 2>&1 || true
}
trap cleanup_failed_promotion EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

"${COMPOSE[@]}" up -d core cc
wait_core_health "$CORE_PORT"
wait_panel_200 "http://${STANDBY_PANEL_BIND}:${PANEL_PORT}/"
require_service_token_works "$CORE_PORT" "$ENV_FILE"

workers=stopped
if [ "${STANDBY_START_WORKERS:-0}" = 1 ]; then
  "${COMPOSE[@]}" --profile workers up -d bot agents
  # compose stop не удаляет контейнеры, а up -d переиспользует остановленный —
  # `docker logs` без --since отдал бы ВСЮ историю прошлых запусков: старый
  # «БОТ НЕ ЗАПУСТИЛСЯ» валил бы здоровый promote, а старый «Bot запущен»
  # сертифицировал бы мёртвый. Режем логи по времени старта ЭТОГО запуска.
  bot_since=$(docker inspect -f '{{.State.StartedAt}}' mydon-standby-bot)
  # «MYDON Bot запущен» печатается после getMe (таймаут 15с) — один срез в
  # 12с давал ложный отказ на медленной сети. Ждём до 60с, отрицательные
  # маркеры валят сразу (только `if grep; then fail; fi`: форма `grep && fail`
  # при НЕсовпадении вернула бы 1 списку, и set -e убил бы скрипт на здоровом
  # боте).
  bot_ok=0
  for _ in $(seq 1 12); do
    sleep 5
    for container in mydon-standby-bot mydon-standby-agents; do
      [ "$(docker inspect -f '{{.State.Running}}' "$container")" = true ] ||
        fail "$container не остался запущен"
    done
    bot_logs=$(docker logs --since "$bot_since" mydon-standby-bot 2>&1 || true)
    if printf '%s' "$bot_logs" | grep -q 'БОТ НЕ ЗАПУСТИЛСЯ'; then
      fail "бот сообщил «БОТ НЕ ЗАПУСТИЛСЯ» — см. docker logs mydon-standby-bot"
    fi
    if printf '%s' "$bot_logs" | grep -q 'режиме скелета'; then
      fail "бот стартовал без токена (режим скелета) — env не дошёл до контейнера"
    fi
    if printf '%s' "$bot_logs" | grep -q 'TELEGRAM_ALLOWED_CHAT_IDS пуст'; then
      fail "внутри контейнера бота allowlist пуст — доступ закрыт для всех"
    fi
    if printf '%s' "$bot_logs" | grep -q 'Bot запущен'; then
      bot_ok=1
      break
    fi
  done
  poll_errors=$(printf '%s' "${bot_logs:-}" | grep -c 'Ошибка опроса Telegram' || true)
  [ "$bot_ok" = 1 ] ||
    fail "за 60с в логах бота нет отметки о запуске (ошибок опроса: ${poll_errors}) — см. docker logs mydon-standby-bot"
  [ "$poll_errors" -lt 3 ] ||
    fail "бот не может опрашивать Telegram (${poll_errors} ошибок) — см. docker logs mydon-standby-bot"
  workers=running
fi
trap - EXIT INT TERM
printf 'STANDBY_PROMOTED panel=http://%s:%s workers=%s\n' \
  "$STANDBY_PANEL_BIND" "$PANEL_PORT" "$workers"
# Предупреждение безусловное: старые вложения primary не реплицируются
# НЕЗАВИСИМО от содержимого локального каталога.
printf 'ВНИМАНИЕ: вложения primary (/opt/mydon-data/attachments) сюда не реплицируются — старые фото/чеки будут отвечать 404 до failback. Новые файлы копятся в %s; после возврата primary перенесите их (docs/DATABASE_DR.md).\n' \
  "$STANDBY_ATTACHMENTS_DIR"
if [ -n "$(ls -A "$STANDBY_ATTACHMENTS_DIR" 2>/dev/null)" ]; then
  printf 'В каталоге вложений уже есть файлы с прошлого failover — они всё ещё ждут rsync на primary.\n'
fi
