#!/usr/bin/env bash
# Автодеплой MYDON — сервер сам подтягивает main из GitHub и пересобирается.
#
# Запускается systemd-таймером каждые 2 минуты (см. deploy/systemd/).
# Работает ТОЛЬКО на сервере mydon-os. Наружу ничего не открывает,
# секреты (.env) остаются на месте. Тянет приватный репозиторий по
# read-only deploy-ключу /root/.ssh/mydon_deploy.
#
# Безопасность:
#  • flock — два деплоя разом не пойдут;
#  • если в main ничего нового — тихо выходим (без пересборки);
#  • pg_dump ДО миграций — на случай плохой миграции из будущего PR;
#  • .env не трогается (untracked, git reset --hard его не удаляет).
set -euo pipefail

APP_DIR="/opt/mydon-app"
BACKUP_DIR="/opt/backups/mydon-autodeploy"
KEY="/root/.ssh/mydon_deploy"
COMPOSE=(docker compose -f deploy/docker-compose.yml --env-file .env)

export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

log() { echo "$(date '+%F %T') $*"; }
trap 'log "ОШИБКА (строка $LINENO). База — в бэкапе $BACKUP_DIR. Деплой прерван."' ERR

cd "$APP_DIR"

# Замок: если деплой уже идёт (долгая сборка) — просто выходим.
exec 9>/var/lock/mydon-autodeploy.lock
flock -n 9 || { log "деплой уже идёт — пропускаю тик"; exit 0; }

git fetch --quiet origin main
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"
[ "$LOCAL" = "$REMOTE" ] && exit 0   # ничего нового

log "новый main $REMOTE (было $LOCAL) — начинаю деплой"

# 1. Бэкап базы ДО обновления кода и миграций.
mkdir -p "$BACKUP_DIR"
if docker ps --format '{{.Names}}' | grep -qx mydon-db; then
  stamp="$(date '+%Y%m%d_%H%M%S')"
  if docker exec -t mydon-db pg_dump -U mydon mydon | gzip > "$BACKUP_DIR/pre_${stamp}.sql.gz"; then
    log "бэкап базы: $BACKUP_DIR/pre_${stamp}.sql.gz"
  else
    log "ВНИМАНИЕ: бэкап базы не удался — деплой останавливаю"; exit 1
  fi
  # держим последние 10 бэкапов
  ls -1t "$BACKUP_DIR"/pre_*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
fi

# 2. Обновляем код до origin/main (untracked .env остаётся на месте).
git reset --hard "$REMOTE"

# 3. Сборка и запуск. Если сборка упадёт — старые контейнеры продолжают работать.
"${COMPOSE[@]}" up -d --build

# 4. Миграции схемы (drizzle-kit применяет только новые).
"${COMPOSE[@]}" exec -T mydon-core sh -c 'cd packages/db && npx drizzle-kit migrate'

# 5. Проверка здоровья Core.
if "${COMPOSE[@]}" exec -T mydon-core node -e \
  'fetch("http://127.0.0.1:3001/health").then(r=>r.json()).then(d=>process.exit(d.status==="ok"?0:1)).catch(()=>process.exit(1))'; then
  log "деплой ok: $REMOTE"
else
  log "ВНИМАНИЕ: health не ok после деплоя $REMOTE — проверить вручную"
fi

# 6. Уборка висячих слоёв, чтобы диск не кончился.
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -f --keep-storage 1GB >/dev/null 2>&1 || true
log "готово"
