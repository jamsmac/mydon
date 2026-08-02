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
# Копия больше не нужна после завершения — убираем и при ошибке тоже.
trap 'rm -f "$AUTODEPLOY_COPY"' EXIT

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
  # ВАЖНО: без -t. TTY подмешивает CR в бинарный поток дампа и портит его —
  # архив создаётся «успешно», но не восстанавливается. -i держит STDIN без TTY.
  # Целостность gzip сразу проверяем: битый бэкап хуже отсутствующего.
  dump="$BACKUP_DIR/pre_${stamp}.sql.gz"
  if docker exec -i mydon-db pg_dump -U mydon mydon | gzip > "$dump" && gunzip -t "$dump"; then
    log "бэкап базы: $dump"
  else
    log "ВНИМАНИЕ: бэкап базы не удался или повреждён — деплой останавливаю"
    rm -f "$dump"
    exit 1
  fi
  # держим последние 10 бэкапов
  ls -1t "$BACKUP_DIR"/pre_*.sql.gz 2>/dev/null | tail -n +11 | xargs -r rm -f
fi

# 2. Обновляем код до origin/main. git reset --hard НЕ удаляет untracked —
#    подчищаем явно (кроме .env: секреты не в git, их трогать нельзя). Раньше
#    на сервере годами копился незакоммиченный prod-роут, отвечавший 200 и
#    попадавший в образ, хотя в коммите его не было (найдено внешним
#    аудитом, P1) — воспроизвести такой билд для отладки было невозможно.
git reset --hard "$REMOTE"
git clean -fd -e '.env*' # вся .env-семья (.env, .env.local, ...) — как в .gitignore

# 3. Собираем новые образы, НЕ трогая работающие контейнеры — старый контур
#    продолжает отвечать, пока не пройдут миграции и health-check ниже.
"${COMPOSE[@]}" build

# 4. Миграции схемы — одноразовым контейнером из НОВОГО образа, ДО
#    переключения работающих контейнеров на новый код. Раньше `up -d --build`
#    сразу заменял контейнеры новым образом, а миграции гонялись ПОСЛЕ —
#    новый код мог получить запрос против ещё не мигрированной схемы (найдено
#    внешним аудитом, P1). --name с суффиксом: у mydon-core фиксированный
#    container_name в docker-compose.yml, а старый контейнер с этим именем
#    ещё работает (шаг 5 его не заменил) — без суффикса `run` уткнулся бы в
#    конфликт имён (найдено ревью).
"${COMPOSE[@]}" run --rm --name mydon-core-migrate mydon-core sh -c 'cd packages/db && npx drizzle-kit migrate'

# 5. Переключаем контейнеры на собранный образ.
"${COMPOSE[@]}" up -d

# 6. Проверка здоровья Core. Провал — деплой считается неуспешным (ненулевой
#    код завершения), а не тихим предупреждением: раньше systemd показывал
#    "успешный" запуск таймера даже при нездоровом приложении, и это некому
#    было заметить (найдено внешним аудитом, P1). Контейнеры к этому моменту
#    уже переключены — при провале нужна ручная проверка/откат.
if "${COMPOSE[@]}" exec -T mydon-core node -e \
  'fetch("http://127.0.0.1:3001/health").then(r=>r.json()).then(d=>process.exit(d.status==="ok"?0:1)).catch(()=>process.exit(1))'; then
  log "деплой ok: $REMOTE"
else
  log "ОШИБКА: health не ok после деплоя $REMOTE — контейнеры уже переключены, нужна ручная проверка"
  exit 1
fi

# 7. Уборка висячих слоёв, чтобы диск не кончился.
docker image prune -f >/dev/null 2>&1 || true
docker builder prune -f --keep-storage 1GB >/dev/null 2>&1 || true
log "готово"
