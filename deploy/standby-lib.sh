# shellcheck shell=bash
# Общий код standby-скриптов (drill / promote / stop). Только функции —
# скрипт-хозяин обязан заранее определить fail() со своим префиксом.
#
# Почему отдельный файл: три копии одинаковых проверок уже разъехались бы при
# первой правке (env-файл, права, health-циклы, sha-гейт), а DR-код читают
# в худший момент — он обязан быть один.

# Права файла БЕЗ ведущего нуля: 600, 644…
# Порядок проб важен: GNU `stat -c` на BSD честно падает (идём в fallback),
# а вот BSD `stat -f %Lp` на GNU «успешно» печатает статус ФАЙЛОВОЙ СИСТЕМЫ —
# начинать надо с варианта, который на чужой ОС падает, а не молча врёт.
file_mode() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }

# Env-файл существует, закрыт правами 600; печатает абсолютный путь.
require_env_file() {
  [ -f "$1" ] || fail "не найден $1 (см. docs/DATABASE_DR.md, раздел «Standby env»)"
  [ "$(file_mode "$1")" = 600 ] || fail "$1 должен иметь права 600"
  printf '%s/%s\n' "$(cd "$(dirname "$1")" && pwd)" "$(basename "$1")"
}

# Значение ключа из dotenv-файла (последнее вхождение, без кавычек и CR).
# Значение НЕ печатать в логи и НЕ передавать аргументом внешним процессам.
env_file_value() {
  sed -n "s/^$2=//p" "$1" | tail -1 | tr -d '\r' |
    sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

# Собирает глобальный массив COMPOSE так, чтобы env-файл ВСЕГДА побеждал:
# docker compose даёт переменным окружения приоритет над --env-file, и
# экспортированный в шелле оператора DATABASE_URL (после source дев-.env)
# молча поднял бы standby против чужой БД с зелёным dbOk. Стираем из
# окружения каждый ключ, который определяет сам env-файл, плюс COMPOSE_*
# (экспортированный COMPOSE_PROFILES=workers запустил бы воркеров из drill).
# Наши собственные экспорты (STANDBY_*, GIT_SHA) в env-файле не живут — целы.
compose_init() {
  # $1 = compose-файл, $2 = env-файл (абсолютный)
  scrub=(-u COMPOSE_PROFILES -u COMPOSE_FILE -u COMPOSE_PROJECT_NAME -u COMPOSE_ENV_FILES)
  while IFS= read -r key; do
    scrub+=(-u "$key")
  done < <(sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' "$2" | sort -u)
  # shellcheck disable=SC2034  # COMPOSE — массив скрипта-хозяина ("${COMPOSE[@]}")
  COMPOSE=(env "${scrub[@]}" docker compose -f "$1" --env-file "$2")
}

# Каталог вложений standby: bind-mount вместо анонимного тома, чтобы файлы,
# загруженные ЗА ВРЕМЯ аварии, пережили пересоздание контейнеров и были видны
# оператору для последующего rsync на вернувшийся primary.
attachments_init() {
  STANDBY_ATTACHMENTS_DIR="${STANDBY_ATTACHMENTS_DIR:-$HOME/.local/state/mydon-standby/attachments}"
  mkdir -p "$STANDBY_ATTACHMENTS_DIR" || fail "не создать $STANDBY_ATTACHMENTS_DIR"
  export STANDBY_ATTACHMENTS_DIR
}

# `docker ps` с честной ошибкой: раньше `docker ps | grep -c … || true`
# превращал упавший docker-демон в «0 контейнеров», и финальная проверка
# «всё остановлено» проходила вакуумно.
docker_ps_names() {
  docker ps --format '{{.Names}}' || fail "docker ps не отвечает — состояние контейнеров неизвестно"
}

repo_git_sha() { git -C "$1" rev-parse --short HEAD 2>/dev/null || printf unknown; }

image_git_sha() {
  docker image inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null |
    sed -n 's/^GIT_SHA=//p' | head -1
}

# Гейт свежести образа. `unknown == unknown` больше не проходит: гейт создан
# после реального инцидента со старым образом (2026-08-08), и непроверяемый
# возраст — это отказ гейта, а не его успех.
require_image_matches_repo() {
  repo_sha=$(repo_git_sha "$1")
  # `|| true` обязателен: без него отсутствие образа роняет присваивание под
  # set -e ДО ветки -z, и скрипт умирает молча — без сообщения и без обхода.
  image_sha=$(image_git_sha "$2" || true)
  if [ "$repo_sha" = unknown ] || [ -z "$image_sha" ] || [ "$image_sha" = unknown ]; then
    [ "${STANDBY_ALLOW_UNKNOWN_SHA:-0}" = 1 ] ||
      fail "возраст образа непроверяем (репозиторий: $repo_sha, образ: ${image_sha:-пусто/отсутствует}); нужен git-чекаут и образ из standby-drill.sh (обход: STANDBY_ALLOW_UNKNOWN_SHA=1)"
    printf 'ВНИМАНИЕ: sha-гейт пропущен по STANDBY_ALLOW_UNKNOWN_SHA=1\n' >&2
    return 0
  fi
  [ "$image_sha" = "$repo_sha" ] ||
    fail "образ собран из $image_sha, репозиторий на $repo_sha; пересоберите (standby-drill.sh без STANDBY_SKIP_BUILD) или верните репозиторий на коммит образа: git checkout $image_sha"
}

# Ждёт здоровый Core: status=ok И dbOk=true.
wait_core_health() {
  health=""
  for _ in $(seq 1 60); do
    health=$(curl -sf --max-time 5 "http://127.0.0.1:$1/health" || true)
    if printf '%s' "$health" | grep -q '"status":"ok"'; then break; fi
    sleep 2
  done
  printf '%s' "$health" | grep -q '"status":"ok"' || fail "Core standby не стал healthy"
  printf '%s' "$health" | grep -q '"dbOk":true' || fail "Core standby не видит managed DB"
}

wait_panel_200() {
  panel_status=000
  for _ in $(seq 1 60); do
    panel_status=$(curl -sS -L -o /dev/null -w '%{http_code}' --max-time 10 "$1" || true)
    [ "$panel_status" = 200 ] && break
    sleep 2
  done
  [ "$panel_status" = 200 ] || fail "CC standby не вернул HTTP 200"
}

# Мутационный путь Core работает: POST {} на guard-защищённый маршрут отвечает
# 401 без токена и 400 (валидация DTO, ДО контроллера — без побочных эффектов)
# с токеном. Пустой SERVICE_TOKEN — fail-closed 401 на ВСЕ мутации: /health
# этого не видит, и раньше drill сертифицировал read-only панель как готовую.
require_service_token_works() {
  # $1 = порт Core, $2 = env-файл
  token=$(env_file_value "$2" SERVICE_TOKEN)
  [ -n "$token" ] || fail "SERVICE_TOKEN пуст в env-файле: после promote вся панель будет read-only (мутации 401)"
  url="http://127.0.0.1:$1/coffee/orders"
  no_auth=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 \
    -X POST -H 'Content-Type: application/json' -d '{}' "$url" || true)
  [ "${no_auth:-000}" = 401 ] ||
    fail "guard мутаций не работает: POST без токена дал HTTP ${no_auth:-000} вместо 401"
  # Токен передаём заголовком через файл конфигурации curl со stdin:
  # в аргументах команды он был бы виден любому через `ps`. Кавычки и
  # бэкслеши внутри двойных кавычек curl-конфига — escape-последовательности,
  # поэтому экранируем (иначе такой токен молча даст ложный 401).
  esc_token=$(printf '%s' "$token" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  with_auth=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --config - \
    -X POST -H 'Content-Type: application/json' -d '{}' "$url" <<EOF || true
header = "x-service-token: $esc_token"
EOF
  )
  # Ожидаем РОВНО 400 (валидация DTO до контроллера, побочных эффектов нет).
  # 2xx означал бы, что пробник ЗАПИСАЛ что-то в production-БД — контракт
  # маршрута изменился, расследовать до повторного запуска.
  case "${with_auth:-000}" in
    400) ;;
    401 | 403) fail "SERVICE_TOKEN из env-файла не принят Core (HTTP $with_auth): проверьте значение (без кавычек/бэкслешей)" ;;
    000 | '') fail "Core не ответил на аутентифицированную мутацию" ;;
    2*) fail "пробник токена получил HTTP $with_auth — ЗАПИСЬ прошла в production-БД, контракт POST /coffee/orders изменился; расследуйте до повторного запуска" ;;
    *) fail "пробник токена получил неожиданный HTTP $with_auth вместо 400" ;;
  esac
}

# Пробник Telegram getMe: побочных эффектов нет (в отличие от getUpdates,
# который прервал бы чужой long poll). Печатает HTTP-код: 200 — токен рабочий
# и Telegram достижим; 401/404 — токен недействителен; 000 — сети до Telegram
# нет. Токен уходит только в URL через config-stdin, не в аргументы команды
# (те видны любому через `ps`).
telegram_getme_probe() {
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 --config - <<EOF || true
url = "https://api.telegram.org/bot$1/getMe"
EOF
  )
  printf '%s' "${code:-000}"
}

# Свежий heartbeat primary в GitHub Gist = приложение с живой БД писало отметку
# в последние 10 минут (порог сторожа). Это доказательство ЖИЗНИ, независимое
# от tailnet: панель может быть недоступна при живом боте. Печатает возраст в
# секундах или "unknown", если gist не задан/недоступен/не разобран.
heartbeat_age_seconds() {
  gist_id=$(env_file_value "$1" HEARTBEAT_GIST_ID)
  [ -n "$gist_id" ] || { printf 'unknown'; return 0; }
  # Явная проверка python3: на голом macOS это заглушка xcode-select, чей
  # отказ иначе маскируется под «gist недоступен» с ложной причиной.
  command -v python3 >/dev/null 2>&1 || { printf 'unknown'; return 0; }
  payload=$(curl -sS --max-time 15 "https://api.github.com/gists/$gist_id" 2>/dev/null || true)
  [ -n "$payload" ] || { printf 'unknown'; return 0; }
  age=$(printf '%s' "$payload" | python3 -c '
import json, sys, datetime
try:
    gist = json.load(sys.stdin)
    hb = json.loads(gist["files"]["heartbeat.json"]["content"])
    ts = datetime.datetime.fromisoformat(hb["ts"].replace("Z", "+00:00"))
    now = datetime.datetime.now(datetime.timezone.utc)
    print(int((now - ts).total_seconds()))
except Exception:
    print("unknown")
' 2>/dev/null || true)
  printf '%s' "${age:-unknown}"
}
