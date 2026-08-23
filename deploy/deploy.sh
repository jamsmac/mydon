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

say() { printf "\n\033[1;34m▸ %s\033[0m\n" "$1"; }
resume_autodeploy() {
  if [ "$AUTODEPLOY_TIMER_WAS_ACTIVE" -eq 1 ]; then
    ssh "$HOST" 'systemctl start mydon-autodeploy.timer' >/dev/null 2>&1 ||
      printf 'ВНИМАНИЕ: не удалось снова запустить mydon-autodeploy.timer\n' >&2
  fi
}
trap resume_autodeploy EXIT

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
DATABASE_URL=postgresql://mydon:\$POSTGRES_PASSWORD@mydon-db:5432/mydon
INGEST_KEY=\$INGEST_KEY
SERVICE_TOKEN=\$SERVICE_TOKEN
INVITE_PEPPER=\$INVITE_PEPPER
CORE_API_URL=http://mydon-core:3001
AGENT_AUTONOMY_MAX=T0
AGENTS_SCHEDULES_PAUSED=1
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
  install -o root -g root -m 700 deploy/guards/backup_extra.sh /opt/backups/backup_extra.sh
  install -o root -g root -m 700 deploy/restore_test_mydon.sh /opt/backups/restore_test_mydon.sh
  echo '  cron-скрипты backup/restore синхронизированы'
"

say "4/8 Сборка нового образа и запуск PostgreSQL"
# Старый контур продолжает отвечать во время сборки. На первой установке
# поднимается только БД: новый Core нельзя запускать до новой схемы.
ssh "$HOST" "
  set -e
  cd '$REMOTE_DIR'
  export GIT_SHA='$GIT_SHA'
  docker compose -f deploy/docker-compose.yml --env-file .env build mydon-core
  docker compose -f deploy/docker-compose.yml --env-file .env up -d mydon-db
"

say "5/8 Применение схемы БД новым образом"
# node dist/migrate.js, а не drizzle-kit: последний при отказе SQL молчит и
# выходит кодом 1 — отладить такой деплой нечем (см. комментарий в auto-deploy.sh).
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
  docker compose -f deploy/docker-compose.yml --env-file .env up -d
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

say "Готово"
echo "Дальше: заполнить TELEGRAM_BOT_TOKEN и TELEGRAM_ALLOWED_CHAT_IDS в $REMOTE_DIR/.env"
echo "и перезапустить бота: docker compose -f deploy/docker-compose.yml --env-file .env up -d mydon-bot"
