#!/usr/bin/env bash
# Развёртывание MYDON на MYDON/OS (Hetzner + Tailscale).
#
# Идемпотентно: повторный запуск не ломает уже развёрнутое.
# Ничего не удаляет и не трогает чужие контейнеры.
#
# Использование:  ./deploy/deploy.sh [хост]
set -euo pipefail

HOST="${1:-root@100.81.197.68}"
REMOTE_DIR="/opt/mydon-app"  # НЕ /opt/mydon — там живёт инфраструктура MYDON/OS
LOCAL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf "\n\033[1;34m▸ %s\033[0m\n" "$1"; }

say "1/7 Проверка связи и предпосылок"
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

say "2/7 Копирование кода (без node_modules, dist, .git)"
# --delete НЕ используем осознанно: он удаляет в приёмнике всё, чего нет в источнике.
rsync -az \
  --exclude node_modules --exclude dist --exclude .next --exclude .turbo \
  --exclude .git --exclude '.env' --exclude '*.tsbuildinfo' \
  "$LOCAL_DIR/" "$HOST:$REMOTE_DIR/"

say "3/7 Настройка окружения на сервере (секреты генерируются ТАМ)"
ssh "$HOST" "
  set -e
  cd $REMOTE_DIR
  if [ ! -f .env ]; then
    POSTGRES_PASSWORD=\$(openssl rand -base64 32 | tr -d '/+=' | head -c 40)
    INGEST_KEY=\$(openssl rand -hex 24)
    # Без него Core поднимется fail-closed и отклонит любую запись из панели,
    # бота и агентов — генерируем сразу, как остальные секреты.
    SERVICE_TOKEN=\$(openssl rand -hex 32)
    cat > .env <<EOF
NODE_ENV=production
TZ=Asia/Tashkent
POSTGRES_USER=mydon
POSTGRES_PASSWORD=\$POSTGRES_PASSWORD
POSTGRES_DB=mydon
DATABASE_URL=postgresql://mydon:\$POSTGRES_PASSWORD@mydon-db:5432/mydon
INGEST_KEY=\$INGEST_KEY
SERVICE_TOKEN=\$SERVICE_TOKEN
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
    echo '  .env уже есть — не трогаем'
  fi
"

say "4/7 Сборка образа и запуск"
ssh "$HOST" "cd $REMOTE_DIR && docker compose -f deploy/docker-compose.yml --env-file .env up -d --build"

say "5/7 Применение схемы БД"
ssh "$HOST" "
  cd $REMOTE_DIR
  docker compose -f deploy/docker-compose.yml --env-file .env exec -T mydon-core \
    sh -c 'cd packages/db && npx drizzle-kit migrate'
"

say "6/7 Структурный сид (только 5 направлений, без бизнес-данных)"
ssh "$HOST" "
  cd $REMOTE_DIR
  docker compose -f deploy/docker-compose.yml --env-file .env exec -T mydon-core \
    node packages/db/dist/seed.js
"

say "6.5/7 Уборка: старые слои и кэш сборки"
# Каждый пересбор оставляет висячие слои — без уборки диск кончается за день.
# Удаляется ТОЛЬКО неиспользуемое: работающие и остановленные контейнеры целы.
ssh "$HOST" "docker image prune -f >/dev/null 2>&1; docker builder prune -f --keep-storage 1GB >/dev/null 2>&1; df -BG --output=avail / | tail -1 | xargs echo '  свободно после уборки:'"

say "7/7 Проверка"
ssh "$HOST" "
  cd $REMOTE_DIR
  echo '  --- health ---'
  docker compose -f deploy/docker-compose.yml --env-file .env exec -T mydon-core \
    node -e 'fetch(\"http://127.0.0.1:3001/health\").then(r=>r.json()).then(d=>console.log(\"  \",JSON.stringify(d)))'
  echo '  --- контейнеры MYDON ---'
  docker ps --filter name=mydon- --format '  {{.Names}}: {{.Status}}'
  echo '  --- диск после сборки ---'
  df -h / | tail -1 | awk '{print \"   занято \"\$3\" из \"\$2\" (\"\$5\")\"}'
"

say "Готово"
echo "Дальше: заполнить TELEGRAM_BOT_TOKEN и TELEGRAM_ALLOWED_CHAT_IDS в $REMOTE_DIR/.env"
echo "и перезапустить бота: docker compose -f deploy/docker-compose.yml --env-file .env up -d mydon-bot"
