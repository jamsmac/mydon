#!/usr/bin/env bash
# Развёртывание MYDON на MYDON/OS (Hetzner + Tailscale).
#
# Идемпотентно: повторный запуск не ломает уже развёрнутое.
# Ничего не удаляет и не трогает чужие контейнеры.
#
# Использование:  ./deploy/deploy.sh [хост]
# REMOTE_DIR намеренно подставляется локально в SSH-команды: это фиксированный
# путь из этого скрипта, а не переменная удалённого окружения.
# shellcheck disable=SC2029
set -euo pipefail

HOST="${1:-root@100.81.197.68}"
REMOTE_DIR="/opt/mydon-app"  # НЕ /opt/mydon — там живёт инфраструктура MYDON/OS
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GIT_SHA="$(git -C "$LOCAL_DIR" rev-parse --short HEAD 2>/dev/null || printf 'unknown')"
if [ -n "$(git -C "$LOCAL_DIR" status --porcelain --untracked-files=normal 2>/dev/null)" ]; then
  GIT_SHA="${GIT_SHA}-dirty"
fi
DEPLOY_ID="${GIT_SHA//[^a-zA-Z0-9_.-]/-}-$$"
AUTODEPLOY_TIMER_WAS_ACTIVE=0
AGENTS_STOPPED_FOR_ROLLOUT=0
AGENTS_WAS_RUNNING=0
MIGRATION_STARTED=0

say() { printf "\n\033[1;34m▸ %s\033[0m\n" "$1"; }
resume_autodeploy() {
  if [ "$AUTODEPLOY_TIMER_WAS_ACTIVE" -eq 1 ]; then
    ssh "$HOST" 'systemctl start mydon-autodeploy.timer' >/dev/null 2>&1 ||
      printf 'ВНИМАНИЕ: не удалось снова запустить mydon-autodeploy.timer\n' >&2
  fi
}
rollout_cleanup() {
  rc="$1"
  if [ "$rc" -ne 0 ] && [ "$AGENTS_STOPPED_FOR_ROLLOUT" -eq 1 ]; then
    if [ "$MIGRATION_STARTED" -eq 0 ] && [ "$AGENTS_WAS_RUNNING" -eq 1 ]; then
      # Resume the stopped container itself: unlike `compose up`, this keeps the
      # exact old image id after the shared mydon:latest tag has been rebuilt.
      # This is allowed only before the first migration invocation.
      if ssh "$HOST" 'docker start mydon-agents >/dev/null 2>&1'; then
        printf 'Выкатка прервана до migration attempt: вернут старый container mydon-agents.\n' >&2
      else
        printf 'ВНИМАНИЕ: не удалось вернуть старый mydon-agents.\n' >&2
      fi
    else
      # Once migration was invoked, its result may be ambiguous (for example
      # SSH can drop after PostgreSQL committed). Fail closed, including a late
      # failure after new Agents was already started.
      if ssh "$HOST" "cd '$REMOTE_DIR' && docker compose -f deploy/docker-compose.yml --env-file .env stop mydon-agents >/dev/null 2>&1"; then
        printf 'Выкатка прервана после migration start/commit: контейнер mydon-agents оставлен остановленным.\n' >&2
      else
        printf 'ВНИМАНИЕ: не удалось остановить mydon-agents после сбоя rollout.\n' >&2
      fi
    fi
  fi
  resume_autodeploy
}
trap 'rollout_cleanup $?' EXIT

say "1/8 Проверка связи и предпосылок"
ssh -o BatchMode=yes -o ConnectTimeout=10 "$HOST" '
  set -e
  free_gb=$(df -BG --output=avail / | tail -1 | tr -dc "0-9")
  echo "  свободно на диске: ${free_gb} ГБ"
  [ "$free_gb" -ge 3 ] || { echo "  МАЛО МЕСТА (нужно ≥3 ГБ)"; exit 1; }
  docker compose version >/dev/null 2>&1 || { echo "  нет docker compose v2"; exit 1; }
  for n in mydon-core mydon-db mydon-bot mydon-agents; do
    if docker ps -a --format "{{.Names}}" | grep -qx "$n"; then
      echo "  контейнер $n уже есть — будет пересоздан"
    fi
  done
'

# Manual deploy и systemd auto-deploy используют один Docker daemon и один
# тег mydon:latest. Одновременная сборка уже приводила к конфликту одноразовых
# migration-контейнеров. На время ручного прогона останавливаем только таймер;
# уже начатую service не убиваем, а ждём её честного завершения. EXIT-trap
# вернёт таймер даже при ошибке ниже.
if ssh "$HOST" 'systemctl is-active --quiet mydon-autodeploy.timer'; then
  AUTODEPLOY_TIMER_WAS_ACTIVE=1
  say "Пауза auto-deploy на время ручного прогона"
  ssh "$HOST" 'systemctl stop mydon-autodeploy.timer'
fi
ssh "$HOST" '
  set -e
  for _ in $(seq 1 900); do
    systemctl is-active --quiet mydon-autodeploy.service || exit 0
    sleep 1
  done
  echo "auto-deploy не завершился за 15 минут" >&2
  exit 1
'

say "2/8 Копирование кода (без node_modules, dist, .git)"
# --delete НЕ используем осознанно: он удаляет в приёмнике всё, чего нет в источнике.
rsync -az \
  --exclude node_modules --exclude dist --exclude .next --exclude .turbo \
  --exclude .git --exclude '.env' --exclude '*.tsbuildinfo' \
  "$LOCAL_DIR/" "$HOST:$REMOTE_DIR/"

say "3/8 Настройка окружения и cron-скриптов на сервере"
ssh "$HOST" "
  set -e
  cd '$REMOTE_DIR'
  if [ ! -f .env ]; then
    POSTGRES_PASSWORD=\$(openssl rand -base64 32 | tr -d '/+=' | head -c 40)
    INGEST_KEY=\$(openssl rand -hex 24)
    # Без него Core поднимется fail-closed и отклонит любую запись из панели,
    # бота и агентов — генерируем сразу, как остальные секреты.
    SERVICE_TOKEN=\$(openssl rand -hex 32)
    # Перец приглашений. Генерируем на сервере, как остальные секреты: пустой
    # перец не роняет Core, поэтому забытая переменная тихо оставила бы хеши
    # приглашений открытыми для радужной таблицы.
    INVITE_PEPPER=\$(openssl rand -hex 32)
    cat > .env <<EOF
NODE_ENV=production
TZ=Asia/Tashkent
POSTGRES_USER=mydon
POSTGRES_PASSWORD=\$POSTGRES_PASSWORD
POSTGRES_DB=mydon
DATABASE_MODE=local
DATABASE_URL=postgresql://mydon:\$POSTGRES_PASSWORD@mydon-db:5432/mydon
DATABASE_ADMIN_URL=
DATABASE_SIZE_WARN_MB=400
INGEST_KEY=\$INGEST_KEY
SERVICE_TOKEN=\$SERVICE_TOKEN
INVITE_PEPPER=\$INVITE_PEPPER
CORE_API_URL=http://mydon-core:3001
AGENT_AUTONOMY_MAX=T0
AGENTS_SCHEDULES_PAUSED=1
AGENTS_TASKS_PAUSED=1
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_CHAT_IDS=
# LLM помощника: подписка Claude (claude setup-token) и/или API-ключ.
CLAUDE_CODE_OAUTH_TOKEN=
ANTHROPIC_API_KEY=
MYDON_ASSISTANT_MODEL=
EOF
    chmod 600 .env
    echo '  .env создан, секреты сгенерированы на сервере (значения не выводятся)'
  else
    # Существующее .env не переписываем. Единственное исключение — недостающий
    # перец: пустой не роняет Core, поэтому сервер, обновлённый со старым .env,
    # молча хешировал бы приглашения без перца. Дописываем только отсутствующее
    # или пустое значение; заполненное не трогаем — смена перца гасит выданные
    # приглашения, и делать это на каждом деплое нельзя.
    if grep -q '^INVITE_PEPPER=.' .env; then
      echo '  .env уже есть — не трогаем'
    else
      sed -i '/^INVITE_PEPPER=\$/d' .env
      printf 'INVITE_PEPPER=%s\n' \"\$(openssl rand -hex 32)\" >> .env
      echo '  .env уже есть — дописан недостающий INVITE_PEPPER'
    fi
  fi
  # Cron запускает стабильные копии из /opt/backups, а не файлы рабочей
  # директории. Обновляем их каждым deploy, иначе исправление backup/restore
  # останется только в git и никогда не попадёт в фактическое расписание.
  install -d -o root -g root -m 700 /opt/backups
  install -o root -g root -m 700 deploy/guards/db_access.sh /opt/backups/db_access.sh
  install -o root -g root -m 700 deploy/guards/backup_extra.sh /opt/backups/backup_extra.sh
  install -o root -g root -m 700 deploy/guards/b2_offsite.sh /opt/backups/b2_offsite.sh
  install -o root -g root -m 700 deploy/restore_test_mydon.sh /opt/backups/restore_test_mydon.sh
  # Сторожа диска и здоровья — тем же механизмом (П8.2 плана поглощения):
  # их хостовые копии жили в /opt/mydon-stock и деплоем не обновлялись.
  install -o root -g root -m 700 deploy/guards/disk_guard.sh /opt/backups/disk_guard.sh
  install -o root -g root -m 700 deploy/guards/healthz_guard.sh /opt/backups/healthz_guard.sh
  # Durable producer-side LLM accounting: явно создаём частные
  # host-каталоги до compose, а не полагаемся на bind-mount mkdir.
  install -d -o root -g root -m 700 /opt/mydon-data/llm-close \
    /opt/mydon-data/llm-close/agents /opt/mydon-data/llm-close/bot \
    /opt/mydon-data/llm-close/cc
  # Корневой сертификат Supabase — для sslmode=verify-full в admin-пути
  # (db_access.sh монтирует его в клиентский контейнер). Публичный сертификат,
  # пин сверен по двум независимым сетевым путям 2026-08-24.
  install -o root -g root -m 644 deploy/certs/supabase-prod-ca-2021.crt /opt/backups/supabase-ca.crt
  echo '  cron-скрипты backup/restore и сторожа синхронизированы'
"

say "4/8 Сборка нового образа и запуск rollback PostgreSQL"
# Старый контур продолжает отвечать во время сборки. На первой установке
# поднимается только БД: новый Core нельзя запускать до новой схемы.
ssh "$HOST" "
  set -e
  cd '$REMOTE_DIR'
  export GIT_SHA='$GIT_SHA'
  docker compose -f deploy/docker-compose.yml --env-file .env build mydon-core
  docker compose -f deploy/docker-compose.yml --env-file .env up -d mydon-db
"

say "4.5/8 Бэкап активной БД перед миграциями"
# auto-deploy снимает дамп до миграций всегда; ручной путь его не имел вовсе —
# после выноса прод-БД на managed провайдера плохая миграция при ручном
# прогоне оставляла откат только на последний ночной дамп (RPO до 24 ч).
# Режим решает DATABASE_MODE (как в db_access.sh, НЕ наличие admin-URL:
# external без DATABASE_ADMIN_URL — это ошибка конфига, а не local). Дамп
# снимается и в local-режиме (db_access.sh умеет docker exec). Единственный
# законный пропуск — первая установка, распознаётся по отсутствию журнала
# миграций: защищать в пустой базе ещё нечего.
ssh "$HOST" "
  set -e
  cd '$REMOTE_DIR'
  umask 077
  if [ ! -x /opt/backups/db_access.sh ]; then
    echo '  ВНИМАНИЕ: db_access.sh ещё не установлен — деплой без pre-migration дампа (первая установка)'
    exit 0
  fi
  mode=\$(grep '^DATABASE_MODE=' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)
  mode=\${mode:-local}
  if [ \"\$mode\" = external ] && ! grep -q '^DATABASE_ADMIN_URL=.' .env 2>/dev/null; then
    echo '  DATABASE_MODE=external без DATABASE_ADMIN_URL — мигрировать managed-БД без бэкапа запрещено' >&2
    exit 1
  fi
  ready=''
  for _ in \$(seq 1 10); do
    if /opt/backups/db_access.sh ping >/dev/null 2>&1; then ready=1; break; fi
    sleep 3
  done
  if [ -z \"\$ready\" ]; then
    echo '  БД не отвечает на ping за 30с — деплой остановлен (миграции без бэкапа запрещены)' >&2
    echo '  конфигурация подключения (без секретов):' >&2
    /opt/backups/db_access.sh describe >&2 || true
    exit 1
  fi
  journal=\$(/opt/backups/db_access.sh query 'select count(*) from drizzle.__drizzle_migrations' 2>/dev/null | tr -d '[:space:]' || true)
  case \"\$journal\" in
    '' | *[!0-9]*)
      echo '  журнала миграций ещё нет — первая установка, дампить нечего'
      exit 0
      ;;
  esac
  mkdir -p /opt/backups/mydon-autodeploy
  stamp=\$(date '+%Y%m%d_%H%M%S')
  # Штамп ПЕРВЫМ: ретеншен auto-deploy сортирует pre_*.sql.gz по имени, и
  # pre_manual_* (буква > цифры) навсегда вытеснял бы авто-дампы из keep-10.
  dump=/opt/backups/mydon-autodeploy/pre_\${stamp}_manual.sql.gz
  if /opt/backups/db_access.sh dump | gzip > \"\$dump\" &&
      gunzip -t \"\$dump\" && gunzip -c \"\$dump\" | tail -10 | grep -q 'dump complete'; then
    echo \"  бэкап перед миграциями: \$dump\"
  else
    rm -f \"\$dump\"
    echo '  бэкап перед миграциями не удался или повреждён — деплой остановлен' >&2
    exit 1
  fi
"

say "5/8 Применение схемы БД новым образом"
# Agents stops before migration while the old Core/Bot/CC remain available.
# Only a failure before the first migration attempt may resume this exact
# stopped container (and therefore its immutable old image id). From invocation
# onward an ambiguous result is fail-closed and leaves Agents stopped.
if [ "$(ssh "$HOST" "docker inspect -f '{{.State.Running}}' mydon-agents 2>/dev/null || true")" = "true" ]; then
  AGENTS_WAS_RUNNING=1
fi
AGENTS_STOPPED_FOR_ROLLOUT=1
ssh "$HOST" "
  set -e
  cd '$REMOTE_DIR'
  docker compose -f deploy/docker-compose.yml --env-file .env stop mydon-agents
"
# node dist/migrate.js, а не drizzle-kit: последний при отказе SQL молчит и
# выходит кодом 1 — отладить такой деплой нечем (см. комментарий в auto-deploy.sh).
# Fence before the SSH invocation: a transport failure can hide a committed DB
# transaction, so any attempted migration must keep Agents stopped.
MIGRATION_STARTED=1
ssh "$HOST" "
  set -e
  cd '$REMOTE_DIR'
  docker compose -f deploy/docker-compose.yml --env-file .env run --rm --name 'mydon-core-migrate-$DEPLOY_ID' mydon-core \
    node packages/db/dist/migrate.js
"

say "6/8 Структурный сид (только 5 направлений, без бизнес-данных)"
ssh "$HOST" "
  set -e
  cd '$REMOTE_DIR'
  docker compose -f deploy/docker-compose.yml --env-file .env run --rm --name 'mydon-core-seed-$DEPLOY_ID' mydon-core \
    node packages/db/dist/seed.js
"

say "7/8 Переключение сервисов и проверка health"
ssh "$HOST" "
  set -e
  cd '$REMOTE_DIR'
  # PANEL_BIND обязан быть localhost или Tailscale (100.64.0.0/10): опечатка
  # 0.0.0.0 молча опубликовала бы панель в интернет, причём docker-proxy
  # обходит ufw (ТЗ §6).
  pb=\$(grep '^PANEL_BIND=' .env 2>/dev/null | tail -1 | cut -d= -f2- || true)
  if [ -n \"\$pb\" ]; then
    case \"\$pb\" in
      127.0.0.1) ;;
      100.6[4-9].*|100.7[0-9].*|100.8[0-9].*|100.9[0-9].*|100.1[01][0-9].*|100.12[0-7].*) ;;
      *)
        echo \"  PANEL_BIND='\$pb' не localhost и не Tailscale-адрес — деплой остановлен (панель ушла бы в интернет)\" >&2
        exit 1
        ;;
    esac
  fi
  # Core switches alone. Agents remains stopped until the new Core passes its
  # API health fence; Compose depends_on guarantees only process start.
  docker compose -f deploy/docker-compose.yml --env-file .env up -d --no-deps mydon-core
  # Interrupted Compose replacement can leave a healthy service under a
  # temporary name such as <id>_mydon-core. Compose still resolves exec by
  # labels, but cron/guards deliberately address the fixed production names.
  # Repair only the affected service, then require the exact name and state.
  for service in mydon-core; do
    state=\$(docker inspect -f '{{.Name}}|{{.State.Status}}' \"\$service\" 2>/dev/null || true)
    if [ \"\$state\" != \"/\$service|running\" ]; then
      echo \"  восстанавливаю production-имя \$service (было: \${state:-нет контейнера})\"
      docker compose -f deploy/docker-compose.yml --env-file .env \
        up -d --no-deps --force-recreate \"\$service\"
    fi
  done
  for service in mydon-core; do
    state=\$(docker inspect -f '{{.Name}}|{{.State.Status}}' \"\$service\" 2>/dev/null || true)
    [ \"\$state\" = \"/\$service|running\" ] || {
      echo \"Контейнер \$service не запущен под точным production-именем (\${state:-не найден})\" >&2
      exit 1
    }
  done
  health_ok=''
  for attempt in \$(seq 1 30); do
    if docker compose -f deploy/docker-compose.yml --env-file .env exec -T mydon-core \
      node -e 'fetch(\"http://127.0.0.1:3001/health\").then(async r=>{const d=await r.json(); console.log(JSON.stringify(d)); process.exit(r.ok&&d.status===\"ok\"?0:1)}).catch(()=>process.exit(1))' 2>/dev/null; then
      health_ok=1
      break
    fi
    sleep 2
  done
  [ -n \"\$health_ok\" ] || { echo 'Core не стал healthy за 60 секунд'; exit 1; }

  # All other clients switch before Agents. Repairs stay inside their phase,
  # preserving the invariant that no later service starts after Agents.
  for service in mydon-bot mydon-cc; do
    docker compose -f deploy/docker-compose.yml --env-file .env up -d --no-deps \"\$service\"
    state=\$(docker inspect -f '{{.Name}}|{{.State.Status}}' \"\$service\" 2>/dev/null || true)
    if [ \"\$state\" != \"/\$service|running\" ]; then
      echo \"  восстанавливаю production-имя \$service (было: \${state:-нет контейнера})\"
      docker compose -f deploy/docker-compose.yml --env-file .env \
        up -d --no-deps --force-recreate \"\$service\"
    fi
    state=\$(docker inspect -f '{{.Name}}|{{.State.Status}}' \"\$service\" 2>/dev/null || true)
    [ \"\$state\" = \"/\$service|running\" ] || {
      echo \"Контейнер \$service не запущен под production-именем (\${state:-не найден})\" >&2
      exit 1
    }
  done

  docker compose -f deploy/docker-compose.yml --env-file .env up -d --no-deps mydon-agents
  agents_state=\$(docker inspect -f '{{.Name}}|{{.State.Status}}' mydon-agents 2>/dev/null || true)
  if [ \"\$agents_state\" != '/mydon-agents|running' ]; then
    echo \"  восстанавливаю production-имя mydon-agents (было: \${agents_state:-нет контейнера})\"
    docker compose -f deploy/docker-compose.yml --env-file .env \
      up -d --no-deps --force-recreate mydon-agents
  fi

  for service in mydon-db mydon-core mydon-bot mydon-cc mydon-agents; do
    state=\$(docker inspect -f '{{.Name}}|{{.State.Status}}' \"\$service\" 2>/dev/null || true)
    [ \"\$state\" = \"/\$service|running\" ] || {
      echo \"Контейнер \$service не запущен под точным production-именем (\${state:-не найден})\" >&2
      exit 1
    }
  done
"

say "7.5/8 Уборка: старые слои и кэш сборки"
# Каждый пересбор оставляет висячие слои — без уборки диск кончается за день.
# Удаляется ТОЛЬКО неиспользуемое: работающие и остановленные контейнеры целы.
ssh "$HOST" "docker image prune -f >/dev/null 2>&1; docker builder prune -f --keep-storage 1GB >/dev/null 2>&1; df -BG --output=avail / | tail -1 | xargs echo '  свободно после уборки:'"

say "8/8 Итоговое состояние"
ssh "$HOST" "
  cd '$REMOTE_DIR'
  echo '  --- контейнеры MYDON ---'
  docker ps --filter name=mydon- --format '  {{.Names}}: {{.Status}}'
  echo '  --- диск после сборки ---'
  df -h / | tail -1 | awk '{print \"   занято \"\$3\" из \"\$2\" (\"\$5\")\"}'
"

say "Синхронизация с автодеплоем"
# Успешный ручной прогон снимает fail-состояние автодеплоя: иначе после
# «починки руками» таймер продолжал бы ретраить упавший sha каждые ~10 минут
# (7-мин сборка + возможный флап контейнеров), причём с подавленным алертом.
# Маркер успеха пишем ТОЛЬКО для чистого коммита, совпадающего с origin/main
# на сервере: пометить «задеплоенным» dirty-код значило бы соврать контуру.
LOCAL_FULL_SHA="$(git -C "$LOCAL_DIR" rev-parse HEAD 2>/dev/null || printf unknown)"
if [[ "$GIT_SHA" == *-dirty ]] || [ "$LOCAL_FULL_SHA" = unknown ]; then
  echo "  дерево грязное/без git — маркер автодеплоя не трогаю (следующий пуш в main перезапишет это состояние)"
else
  ssh "$HOST" "
    set -e
    mkdir -p /opt/backups/mydon-autodeploy
    rm -f /opt/backups/mydon-autodeploy/.fail-sha /opt/backups/mydon-autodeploy/.fail-at \
      /opt/backups/mydon-autodeploy/.fail-first-at /opt/backups/mydon-autodeploy/.alerted-sha \
      /opt/backups/mydon-autodeploy/.alerted-at
    remote_main=\$(git -C '$REMOTE_DIR' rev-parse origin/main 2>/dev/null || printf none)
    if [ \"\$remote_main\" = '$LOCAL_FULL_SHA' ]; then
      printf '%s\n' '$LOCAL_FULL_SHA' > /opt/backups/mydon-autodeploy/.last-ok-sha.tmp
      mv /opt/backups/mydon-autodeploy/.last-ok-sha.tmp /opt/backups/mydon-autodeploy/.last-ok-sha
      echo '  маркер успешного деплоя записан — автодеплой не будет передеплоивать этот коммит'
    else
      echo '  задеплоенный коммит не совпадает с origin/main на сервере — следующий тик автодеплоя приведёт сервер к origin/main'
    fi
  "
fi

say "Готово"
echo "Дальше: заполнить TELEGRAM_BOT_TOKEN и TELEGRAM_ALLOWED_CHAT_IDS в $REMOTE_DIR/.env"
echo "и перезапустить бота: docker compose -f deploy/docker-compose.yml --env-file .env up -d mydon-bot"
