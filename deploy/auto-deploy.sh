#!/usr/bin/env bash
# Автодеплой MYDON — сервер сам подтягивает main из GitHub и пересобирается.
#
# Запускается systemd-таймером каждые 30 секунд (см. deploy/systemd/).
# Работает ТОЛЬКО на сервере mydon-os. Наружу ничего не открывает,
# секреты (.env) остаются на месте. Тянет приватный репозиторий по
# read-only deploy-ключу /root/.ssh/mydon_deploy.
#
# Безопасность:
#  • flock — два деплоя разом не пойдут;
#  • «ничего нового» решает МАРКЕР последнего успешного деплоя, а не HEAD:
#    git reset двигает HEAD до сборки, и упавший после него деплой был
#    неотличим от успешного — следующий тик молча выходил, сбрасывал
#    failed-статус systemd, и сервер навсегда оставался на старом образе;
#  • упавший коммит ретраится с кулдауном (не каждые 30с — сборка дорогая),
#    новый пуш в main деплоится сразу; о сбое уходит алерт (Core ingest,
#    фолбэк Telegram) — один на sha, о восстановлении тоже;
#  • pg_dump ДО миграций — на случай плохой миграции из будущего PR;
#  • .env не трогается (untracked, git reset --hard его не удаляет, git clean
#    его явно исключает) — остальные untracked-файлы подчищаются: иначе на
#    сервере годами копится код, которого нет в коммите;
#  • миграции — ДО переключения контейнеров на новый образ, не после;
#  • неудачный health-check после переключения — ненулевой код деплоя
#    (systemd/мониторинг это увидят), а не тихое предупреждение в лог;
#  • работаем с копии себя — см. перезапуск ниже.
set -euo pipefail

# Деплой обновляет и сам этот файл (`git reset --hard` ниже), а bash дочитывает
# скрипт с диска по смещению В БАЙТАХ, уже после запуска. Если файл вырос или
# сжался, продолжение читается с середины чужой строки: остаток деплоя не
# выполняется, а следующий тик таймера видит HEAD == origin/main и молча
# выходит как «ничего нового» — сервер навсегда остаётся на старом образе.
# Поэтому сразу перезапускаемся с копии, которую `git reset` тронуть не может.
if [ -z "${AUTODEPLOY_COPY:-}" ]; then
  self_copy="$(mktemp /tmp/mydon-autodeploy.XXXXXX)"
  cat "$0" > "$self_copy"
  AUTODEPLOY_COPY="$self_copy" exec bash "$self_copy" "$@"
fi

# Пути переопределяемы ТОЛЬКО ради тестов (deploy/tests/auto-deploy-gate.test.sh):
# на сервере переменные не выставляются и действуют боевые значения.
APP_DIR="${AUTODEPLOY_APP_DIR:-/opt/mydon-app}"
BACKUP_DIR="${AUTODEPLOY_BACKUP_DIR:-/opt/backups/mydon-autodeploy}"
KEY="/root/.ssh/mydon_deploy"
DB_HELPER="${AUTODEPLOY_DB_HELPER:-/opt/backups/db_access.sh}"
LOCK_FILE="${AUTODEPLOY_LOCK_FILE:-/var/lock/mydon-autodeploy.lock}"
# Кулдаун ретрая упавшего коммита: сборка стоит ~7 минут CPU, гонять её
# каждые 30 секунд по кругу нельзя. Новый пуш в main кулдаун не ждёт.
RETRY_COOLDOWN="${AUTODEPLOY_RETRY_COOLDOWN_SEC:-600}"
# Повтор алерта при затяжном сбое: «один на sha навсегда» превращал
# многодневную поломку в единственное сообщение недельной давности.
REALERT_SEC="${AUTODEPLOY_REALERT_SEC:-21600}"
# Фолбэк-канал тревог — выделенный аварийный бот сторожа (тот же, что у
# watchdog-liveness), а НЕ бот склада из /opt/mydon-stock: тащить алерты
# деплоя через чужой проект — связь, которая молча умрёт при его переезде.
ALERT_ENV="${AUTODEPLOY_ALERT_ENV:-/etc/mydon-heartbeat.env}"
OK_MARKER="$BACKUP_DIR/.last-ok-sha"
FAIL_SHA_F="$BACKUP_DIR/.fail-sha"
FAIL_AT_F="$BACKUP_DIR/.fail-at"          # время ПОСЛЕДНЕГО сбоя — от него кулдаун
FAIL_FIRST_F="$BACKUP_DIR/.fail-first-at" # время ПЕРВОГО сбоя серии — окно pre-fetch
ALERTED_F="$BACKUP_DIR/.alerted-sha"
ALERTED_AT_F="$BACKUP_DIR/.alerted-at"
COMPOSE=(docker compose -f deploy/docker-compose.yml --env-file .env)

# umask: pre-деплойные дампы и файлы состояния не должны рождаться 644.
umask 077
# StrictHostKeyChecking=yes: ключи github.com пинует setup-autodeploy.sh из
# api.github.com/meta; accept-new доверял бы любому, кто ответил на 22 порт
# при чистом known_hosts (TOFU при root-исполнении main — лишний риск).
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"

log() { echo "$(date '+%F %T') $*"; }

# Алерт о сбое: сначала событие в Core (старый контур обычно ещё жив — деплой
# упал ДО переключения; правило infra.deploy_failed в rules.ts обязано
# существовать, иначе событие ляжет в таблицу молча), фолбэк — Telegram-бот
# склада, как в backup_extra.sh. Возврат 0 только при реальной доставке.
# `|| true` на присваиваниях ОБЯЗАТЕЛЕН: без него отсутствие ключа в .env
# под pipefail убивало бы скрипт из mark_success прямо на успешном деплое.
notify_deploy_failed() {
  ingest_key="$(grep '^INGEST_KEY=' "$APP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  if [ -n "$ingest_key" ] &&
    curl -sf -m 15 -X POST "http://127.0.0.1:3001/ingest/${ingest_key}" \
      -H "Content-Type: application/json" \
      -d "{\"type\":\"infra.deploy_failed\",\"source\":\"auto-deploy\",\"payload\":{\"commit\":\"$1\",\"detail\":\"ретраи автоматические; journalctl -u mydon-autodeploy.service\"}}" \
      >/dev/null 2>&1; then
    return 0
  fi
  BT="$(grep '^WATCHDOG_BOT_TOKEN=' "$ALERT_ENV" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  CHATS="$(grep '^WATCHDOG_CHAT_IDS=' "$ALERT_ENV" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  if [ -n "$BT" ] && [ -n "$CHATS" ]; then
    delivered=""
    for chat in ${CHATS//,/ }; do
      chat="$(printf '%s' "$chat" | tr -d '[:space:]')"
      [ -n "$chat" ] || continue
      # Telegram отвечает 200 и на {"ok":false,...} — доставку подтверждает
      # только поле ok (тот же урок, что в watchdog-liveness.sh).
      tg_resp="$(curl -sS -m 30 -F chat_id="$chat" \
        -F text="❌ Автодеплой MYDON упал на $1. Ретраи автоматические. journalctl -u mydon-autodeploy.service" \
        -K- <<< "url = \"https://api.telegram.org/bot${BT}/sendMessage\"" 2>/dev/null || true)"
      if printf '%s' "$tg_resp" | grep -q '"ok":true'; then
        delivered=1
      fi
    done
    if [ -n "$delivered" ]; then
      return 0
    fi
  fi
  log "алерт о сбое деплоя НЕ доставлен (нет INGEST_KEY/аварийного бота или сеть) — только журнал"
  return 1
}

notify_deploy_recovered() {
  ingest_key="$(grep '^INGEST_KEY=' "$APP_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
  [ -n "$ingest_key" ] || return 0
  curl -sf -m 15 -X POST "http://127.0.0.1:3001/ingest/${ingest_key}" \
    -H "Content-Type: application/json" \
    -d "{\"type\":\"infra.deploy_ok\",\"source\":\"auto-deploy\",\"payload\":{\"commit\":\"$1\",\"detail\":\"деплой восстановился после сбоя\"}}" \
    >/dev/null 2>&1 || true
}

# Успех: маркер пишется ПОСЛЕДНИМ действием деплоя — только он делает
# «ничего нового» законным. Файлы сбоя снимаются ДО уведомления: упади
# notify — состояние уже чистое, и хвосты не переживут успех.
mark_success() {
  printf '%s\n' "$REMOTE" > "$OK_MARKER.tmp" && mv "$OK_MARKER.tmp" "$OK_MARKER"
  was_alerted=""
  if [ -f "$ALERTED_F" ]; then was_alerted=1; fi
  rm -f "$FAIL_SHA_F" "$FAIL_AT_F" "$FAIL_FIRST_F" "$ALERTED_F" "$ALERTED_AT_F"
  if [ -n "$was_alerted" ]; then
    log "деплой восстановился после сбоя — снимаю тревогу"
    notify_deploy_recovered "$REMOTE"
  fi
}

# Учёт сбоя — на ЛЮБОМ ненулевом выходе, не только на ERR: явные `exit 1`
# (битый бэкап, нездоровый health) ERR-trap не проходят. Без записи сбоя
# следующий тик снова счёл бы «ничего нового». 130/143 — операторский
# Ctrl-C/стоп таймера, не сбой деплоя.
on_exit() {
  rc="$1"
  rm -f "$AUTODEPLOY_COPY"
  case "$rc" in 0 | 130 | 143) return 0 ;; esac
  mkdir -p "$BACKUP_DIR" 2>/dev/null || return 0
  sha="${REMOTE:-pre-fetch}"
  now="$(date +%s)"
  prev_sha="$(cat "$FAIL_SHA_F" 2>/dev/null || true)"
  printf '%s\n' "$sha" > "$FAIL_SHA_F"
  printf '%s\n' "$now" > "$FAIL_AT_F"
  # Начало серии сбоев: обновляем только при смене sha — от него считается
  # окно тишины pre-fetch (единичный блип git fetch при тике каждые 30с —
  # норма сети, тревога только если fetch падает дольше кулдауна подряд).
  if [ "$prev_sha" != "$sha" ] || [ ! -f "$FAIL_FIRST_F" ]; then
    printf '%s\n' "$now" > "$FAIL_FIRST_F"
  fi
  first_at="$(cat "$FAIL_FIRST_F" 2>/dev/null || printf '%s' "$now")"
  want_alert=1
  if [ "$sha" = pre-fetch ] && [ $(( now - first_at )) -lt "$RETRY_COOLDOWN" ]; then
    want_alert=0
  fi
  # Дедуп: один алерт на sha, но затяжной сбой напоминает раз в REALERT_SEC —
  # «упал неделю назад» не должно быть последним словом контура.
  alerted="$(cat "$ALERTED_F" 2>/dev/null || true)"
  alerted_at="$(cat "$ALERTED_AT_F" 2>/dev/null || printf 0)"
  if [ "$alerted" = "$sha" ] && [ $(( now - alerted_at )) -lt "$REALERT_SEC" ]; then
    want_alert=0
  fi
  if [ "$want_alert" = 1 ]; then
    if notify_deploy_failed "$sha"; then
      printf '%s\n' "$sha" > "$ALERTED_F"
      printf '%s\n' "$now" > "$ALERTED_AT_F"
    fi
  fi
}
trap 'on_exit $?' EXIT

dump_note="бэкап на этом прогоне не снимался"
trap 'log "ОШИБКА (строка $LINENO). ${dump_note}. Деплой прерван."' ERR

cd "$APP_DIR"

# Замок: если деплой уже идёт (долгая сборка) — просто выходим.
exec 9>"$LOCK_FILE"
flock -n 9 || { log "деплой уже идёт — пропускаю тик"; exit 0; }

git fetch --quiet origin main
# Fetch удался — сбои класса pre-fetch (сеть/ключ до fetch) исцелились:
# снимаем их учёт, иначе залипший .alerted-sha=pre-fetch навсегда глушил бы
# алерт о НАСТОЯЩЕЙ будущей поломке fetch (отозванный ключ, DNS).
if [ "$(cat "$FAIL_SHA_F" 2>/dev/null || true)" = pre-fetch ]; then
  rm -f "$FAIL_SHA_F" "$FAIL_AT_F" "$FAIL_FIRST_F"
  if [ "$(cat "$ALERTED_F" 2>/dev/null || true)" = pre-fetch ]; then
    rm -f "$ALERTED_F" "$ALERTED_AT_F"
  fi
fi
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"
last_ok="$(cat "$OK_MARKER" 2>/dev/null || true)"
# «Ничего нового» = origin/main УСПЕШНО задеплоен, а не просто HEAD совпал:
# HEAD двигается git reset-ом до сборки, и по нему сбой неотличим от успеха.
[ "$LOCAL" = "$REMOTE" ] && [ "$last_ok" = "$REMOTE" ] && exit 0
# Кулдаун — по sha УПАВШЕГО коммита, независимо от положения HEAD: сбой до
# git reset (весь шаг бэкапа) оставляет HEAD старым, и проверка «только при
# LOCAL==REMOTE» позволяла долбить полный pg_dump каждые 30 секунд.
fail_sha="$(cat "$FAIL_SHA_F" 2>/dev/null || true)"
if [ "$REMOTE" = "$fail_sha" ]; then
  fail_at="$(cat "$FAIL_AT_F" 2>/dev/null || printf 0)"
  now="$(date +%s)"
  elapsed=$(( now - fail_at ))
  if [ "$elapsed" -lt "$RETRY_COOLDOWN" ]; then
    log "деплой $REMOTE упал ${elapsed}с назад — ретрай через $(( RETRY_COOLDOWN - elapsed ))с"
    exit 0
  fi
  log "повторяю деплой $REMOTE после сбоя (кулдаун ${RETRY_COOLDOWN}с прошёл)"
elif [ "$LOCAL" = "$REMOTE" ]; then
  log "маркер успешного деплоя (${last_ok:-нет}) отстал от HEAD — деплою $REMOTE заново"
else
  log "новый main $REMOTE (было $LOCAL) — начинаю деплой"
fi
DEPLOY_ID="${REMOTE:0:12}-$$"

# 0. Что вообще изменилось. Данные (сиды, выгрузки) приезжают в контейнер
#    томом, документация в образ не попадает вовсе — для таких коммитов
#    сборка, миграции и рестарт не нужны: хватает git reset (шаг 2).
#    Правило намеренно узкое: любой файл вне списка → полный деплой.
CHANGED="$(git diff --name-only "$LOCAL" "$REMOTE" || true)"
# Пустой список — это не «ничего не изменилось» (сюда мы попали только потому,
# что HEAD разошёлся с origin/main), а сбой git diff. Такой случай идёт полным
# деплоем: пропустить сборку по неизвестному диффу опаснее лишней сборки.
if [ -z "${CHANGED//[[:space:]]/}" ]; then
  DATA_ONLY=""
  log "ВНИМАНИЕ: список изменений пуст — иду полным деплоем"
else
  DATA_ONLY="да"
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    case "$f" in
      data/*|docs/*|*.md) ;;
      *) DATA_ONLY=""; break ;;
    esac
  done <<< "$CHANGED"
fi

# 1. Бэкап базы ДО обновления кода и миграций. Для коммита «только данные»
#    схема не меняется и код не переключается — дампу неоткуда пострадать.
mkdir -p "$BACKUP_DIR"
if [ -z "$DATA_ONLY" ]; then
  stamp="$(date '+%Y%m%d_%H%M%S')"
  # ВАЖНО: без -t. TTY подмешивает CR в бинарный поток дампа и портит его —
  # архив создаётся «успешно», но не восстанавливается. -i держит STDIN без TTY.
  # Целостность gzip сразу проверяем: битый бэкап хуже отсутствующего.
  dump="$BACKUP_DIR/pre_${stamp}.sql.gz"
  if [ -x "$DB_HELPER" ] && "$DB_HELPER" dump | gzip > "$dump" &&
      gunzip -t "$dump" && gunzip -c "$dump" | tail -10 | grep -q 'dump complete'; then
    log "бэкап базы: $dump"
    # ERR-trap раньше всегда писал «база — в бэкапе», даже когда дамп не
    # снимался (ранний сбой, data-only): оператор искал несуществующий файл.
    dump_note="база — в бэкапе $dump"
  else
    log "ВНИМАНИЕ: бэкап базы не удался или повреждён — деплой останавливаю"
    rm -f "$dump"
    exit 1
  fi
  # держим последние 10 бэкапов
  mapfile -t backups < <(printf '%s\n' "$BACKUP_DIR"/pre_*.sql.gz | sort -r)
  for ((i = 10; i < ${#backups[@]}; i++)); do
    rm -f -- "${backups[$i]}"
  done
fi

# 2. Обновляем код до origin/main. git reset --hard НЕ удаляет untracked —
#    подчищаем явно (кроме .env: секреты не в git, их трогать нельзя). Раньше
#    на сервере годами копился незакоммиченный prod-роут, отвечавший 200 и
#    попадавший в образ, хотя в коммите его не было (найдено внешним
#    аудитом, P1) — воспроизвести такой билд для отладки было невозможно.
git reset --hard "$REMOTE"
git clean -fd -e '.env*' # вся .env-семья (.env, .env.local, ...) — как в .gitignore

# 2а. Cron обращается к стабильным путям в /opt/backups, поэтому одного
# обновления git-копии недостаточно. Синхронизируем исполняемые версии до
# раннего выхода для data/docs-only commit и до любых миграций.
install -d -o root -g root -m 700 /opt/backups
install -o root -g root -m 700 deploy/guards/db_access.sh /opt/backups/db_access.sh
install -o root -g root -m 700 deploy/guards/backup_extra.sh /opt/backups/backup_extra.sh
install -o root -g root -m 700 deploy/guards/b2_offsite.sh /opt/backups/b2_offsite.sh
install -o root -g root -m 700 deploy/restore_test_mydon.sh /opt/backups/restore_test_mydon.sh
# Сторожа диска и здоровья (П8.2 плана поглощения): раньше их хостовые копии
# лежали в /opt/mydon-stock и обновлялись руками — одна отстала от git на месяц.
# Теперь они обновляются каждым деплоем, как остальные cron-скрипты. Перевод
# самого расписания на эти пути — разовый deploy/setup-guards.sh.
install -o root -g root -m 700 deploy/guards/disk_guard.sh /opt/backups/disk_guard.sh
install -o root -g root -m 700 deploy/guards/healthz_guard.sh /opt/backups/healthz_guard.sh
# Корневой сертификат Supabase для verify-full в admin-пути (#205): без него
# db_access.sh с sslmode=verify-* падал бы — cert ставил только ручной
# deploy.sh, а прод обновляется автодеплоем.
if [ -f deploy/certs/supabase-prod-ca-2021.crt ]; then
  install -o root -g root -m 644 deploy/certs/supabase-prod-ca-2021.crt /opt/backups/supabase-ca.crt
fi
# Systemd-юниты автодеплоя тоже самообновляются: иначе OnFailure-крюк и любые
# будущие правки юнитов жили бы только в git и никогда не доехали до сервера.
for unit in mydon-autodeploy.service mydon-deploy-alert.service; do
  if [ -f "deploy/systemd/$unit" ] && ! cmp -s "deploy/systemd/$unit" "/etc/systemd/system/$unit"; then
    install -o root -g root -m 644 "deploy/systemd/$unit" "/etc/systemd/system/$unit"
    systemctl daemon-reload
    log "обновлён systemd-юнит $unit"
  fi
done
chmod +x deploy/deploy-failure-alert.sh 2>/dev/null || true

# 2б. Изменились только данные и документы — контейнеры уже видят новые файлы
#     через том, пересобирать и перезапускать нечего.
if [ -n "$DATA_ONLY" ]; then
  mark_success
  log "деплой ok: $REMOTE (только данные/документы — сборка и рестарт не нужны)"
  exit 0
fi

# 3. Собираем новые образы, НЕ трогая работающие контейнеры — старый контур
#    продолжает отвечать, пока не пройдут миграции и health-check ниже.
# Коммит попадает в образ, чтобы /health отвечал, ЧТО РАБОТАЕТ, а не что лежит
# в каталоге. Экспорт нужен здесь: compose подставляет ${GIT_SHA} из окружения.
GIT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
export GIT_SHA
"${COMPOSE[@]}" build

# 4. Миграции схемы — одноразовым контейнером из НОВОГО образа, ДО
#    переключения работающих контейнеров на новый код. Раньше `up -d --build`
#    сразу заменял контейнеры новым образом, а миграции гонялись ПОСЛЕ —
#    новый код мог получить запрос против ещё не мигрированной схемы (найдено
#    внешним аудитом, P1). --name с суффиксом: у mydon-core фиксированный
#    container_name в docker-compose.yml, а старый контейнер с этим именем
#    ещё работает (шаг 5 его не заменил) — без суффикса `run` уткнулся бы в
#    конфликт имён (найдено ревью).
#
#    НЕ `drizzle-kit migrate`: при отказе SQL он выходит кодом 1 и не печатает
#    ничего (спиннер затирает строку, исключение теряется). Полевой контур
#    из-за этого три дня не разворачивался, а в журнале было только «ОШИБКА
#    (строка 128)». Свой скрипт печатает сообщение постгреса и сам запрос.
"${COMPOSE[@]}" run --rm --name "mydon-core-migrate-$DEPLOY_ID" mydon-core node packages/db/dist/migrate.js

# 4а. Структурный сид идемпотентен и заводит только направления. Он должен
#     пройти до переключения: новый код не должен стартовать без нового org.
"${COMPOSE[@]}" run --rm --name "mydon-core-seed-$DEPLOY_ID" mydon-core node packages/db/dist/seed.js

# 5. Переключаем контейнеры на собранный образ.
"${COMPOSE[@]}" up -d

# Interrupted Compose replacement can leave a healthy service under a
# temporary name such as <id>_mydon-core. Compose still resolves exec by
# labels, but cron/guards deliberately address the fixed production names.
# Repair only the affected service, then require the exact name and state.
for service in mydon-db mydon-core mydon-bot mydon-agents mydon-cc; do
  state="$(docker inspect -f '{{.Name}}|{{.State.Status}}' "$service" 2>/dev/null || true)"
  if [ "$state" != "/$service|running" ]; then
    log "восстанавливаю production-имя $service (было: ${state:-нет контейнера})"
    "${COMPOSE[@]}" up -d --no-deps --force-recreate "$service"
  fi
done
for service in mydon-db mydon-core mydon-bot mydon-agents mydon-cc; do
  state="$(docker inspect -f '{{.Name}}|{{.State.Status}}' "$service" 2>/dev/null || true)"
  if [ "$state" != "/$service|running" ]; then
    log "ОШИБКА: контейнер $service не запущен под точным production-именем (${state:-не найден})"
    exit 1
  fi
done

# 6. Проверка здоровья Core. Провал — деплой считается неуспешным (ненулевой
#    код завершения), а не тихим предупреждением: раньше systemd показывал
#    "успешный" запуск таймера даже при нездоровом приложении, и это некому
#    было заметить (найдено внешним аудитом, P1). Контейнеры к этому моменту
#    уже переключены — при провале нужна ручная проверка/откат.
#
#    С РЕТРАЯМИ: NestJS поднимается несколько секунд, а раньше проверка шла
#    в ту же секунду, что и `up -d` — живой деплой 07946da получил ложное
#    «health не ok», хотя Core отвечал уже через пару секунд (2026-08-04).
#    До 30 попыток раз в 2 секунды — минута на подъём, потом честный провал.
health_ok=""
for attempt in $(seq 1 30); do
  if "${COMPOSE[@]}" exec -T mydon-core node -e \
    'fetch("http://127.0.0.1:3001/health").then(r=>r.json()).then(d=>process.exit(d.status==="ok"?0:1)).catch(()=>process.exit(1))' 2>/dev/null; then
    health_ok="да"
    break
  fi
  sleep 2
done
if [ -n "$health_ok" ]; then
  mark_success
  log "деплой ok: $REMOTE (health поднялся с попытки $attempt)"
else
  log "ОШИБКА: health не ok спустя минуту после деплоя $REMOTE — контейнеры уже переключены, нужна ручная проверка"
  exit 1
fi

# 7. Уборка висячих слоёв, чтобы диск не кончился.
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -f --keep-storage 1GB >/dev/null 2>&1 || true
log "готово"
