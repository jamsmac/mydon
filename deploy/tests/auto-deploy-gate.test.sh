#!/usr/bin/env bash
# Гейт-логика auto-deploy.sh на git-фикстуре, без docker и сервера:
# «ничего нового» решает маркер успешного деплоя, сбой ретраится с кулдауном,
# новый пуш кулдаун не ждёт. Дальше первого шага (бэкап) прогоны не идут —
# DB_HELPER указывает в пустоту, и деплой честно останавливается.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fail() { printf 'auto-deploy-gate: FAIL %s\n' "$*" >&2; exit 1; }

# macOS без flock (на сервере и CI-Linux он есть): для локального прогона
# достаточно шима — замок не предмет этого теста.
mkdir -p "$TMP/bin"
if ! command -v flock >/dev/null 2>&1; then
  printf '#!/bin/sh\nexit 0\n' > "$TMP/bin/flock"
  chmod +x "$TMP/bin/flock"
fi
export PATH="$TMP/bin:$PATH"

git init -q --bare -b main "$TMP/origin.git"
git clone -q "$TMP/origin.git" "$TMP/app"
git -C "$TMP/app" -c user.email=t@t -c user.name=t commit -q --allow-empty -m seed
git -C "$TMP/app" push -q origin main
SHA=$(git -C "$TMP/app" rev-parse HEAD)
BACKUP="$TMP/backup"
mkdir -p "$BACKUP"

run() {
  AUTODEPLOY_APP_DIR="$TMP/app" \
  AUTODEPLOY_BACKUP_DIR="$BACKUP" \
  AUTODEPLOY_DB_HELPER="$TMP/no-such-helper" \
  AUTODEPLOY_LOCK_FILE="$TMP/autodeploy.lock" \
  AUTODEPLOY_RETRY_COOLDOWN_SEC=600 \
  AUTODEPLOY_ALERT_ENV="$TMP/no-such-alert.env" \
    bash "$ROOT/deploy/auto-deploy.sh"
}
# AUTODEPLOY_ALERT_ENV указывает в пустоту НАМЕРЕННО: без этого прогон теста
# на сервере (с настоящим /etc/mydon-heartbeat.env) слал бы НАСТОЯЩИЕ
# Telegram-алерты о сбоях фикстуры.

# 1. Успешно задеплоенный HEAD == origin/main → тихий выход без единой строки.
printf '%s\n' "$SHA" > "$BACKUP/.last-ok-sha"
out=$(run) || fail "тихий тик вышел ненулём"
[ -z "$out" ] || fail "тихий тик что-то напечатал: $out"

# 2. Маркер отстал (прошлый деплой упал) → повторный деплой, который
#    останавливается на бэкапе; сбой записан для кулдауна, алерт недоставлен
#    (каналов в фикстуре нет) и потому НЕ помечен отправленным.
rm "$BACKUP/.last-ok-sha"
set +e; out=$(run 2>&1); rc=$?; set -e
[ "$rc" -ne 0 ] || fail "деплой без маркера успеха обязан был пойти и упасть на бэкапе"
printf '%s' "$out" | grep -q 'маркер успешного деплоя' || fail "нет причины повтора в логе: $out"
printf '%s' "$out" | grep -q 'бэкап базы не удался' || fail "ожидалась остановка на бэкапе: $out"
[ "$(cat "$BACKUP/.fail-sha")" = "$SHA" ] || fail "сбой не записан в .fail-sha"
[ ! -f "$BACKUP/.alerted-sha" ] || fail "недоставленный алерт помечен отправленным"

# 3. Немедленный повтор → кулдаун: выход 0 и «ретрай через», без новой попытки.
out=$(run 2>&1) || fail "тик в кулдауне обязан выходить нулём"
printf '%s' "$out" | grep -q 'ретрай через' || fail "нет сообщения кулдауна: $out"
printf '%s' "$out" | grep -q 'бэкап' && fail "кулдаун не удержал повторную попытку"

# 4. Кулдаун истёк → честный ретрай той же вершины (и снова стоп на бэкапе).
printf '%s\n' "$(( $(date +%s) - 700 ))" > "$BACKUP/.fail-at"
set +e; out=$(run 2>&1); rc=$?; set -e
[ "$rc" -ne 0 ] || fail "ретрай после кулдауна обязан был пойти и упасть"
printf '%s' "$out" | grep -q 'повторяю деплой' || fail "нет сообщения ретрая: $out"

# 5. Новый пуш в main НЕ ждёт кулдаун упавшей вершины.
date +%s > "$BACKUP/.fail-at"
git -C "$TMP/app" -c user.email=t@t -c user.name=t commit -q --allow-empty -m next
git -C "$TMP/app" push -q origin main
git -C "$TMP/app" reset -q --hard "$SHA"   # локальный HEAD отстаёт, как на сервере
set +e; out=$(run 2>&1); rc=$?; set -e
[ "$rc" -ne 0 ] || fail "деплой нового коммита обязан был пойти и упасть на бэкапе"
printf '%s' "$out" | grep -q 'новый main' || fail "новый коммит не начал деплой: $out"
printf '%s' "$out" | grep -q 'ретрай через' && fail "новый коммит зря ждал кулдаун: $out"

# 6. Сбой ДО git reset (упавший бэкап нового пуша) тоже уходит в кулдаун:
#    HEAD всё ещё отстаёт, но повторный тик не имеет права долбить pg_dump
#    каждые 30 секунд.
out=$(run 2>&1) || fail "тик после сбоя нового пуша обязан выходить нулём (кулдаун)"
printf '%s' "$out" | grep -q 'ретрай через' || fail "сбой до git reset не ушёл в кулдаун: $out"
printf '%s' "$out" | grep -q 'бэкап' && fail "кулдаун не удержал повторный дамп: $out"

# 7. ЗАСТАВА ПУБЛИКАЦИИ ПАНЕЛИ стоит в РАБОЧЕМ пути и ДО переключения
#    контейнеров (статическая проверка порядка: иначе застава могла бы снова
#    остаться только в ручном deploy.sh, которым по документации пользуются
#    как исключением). Переключение — поэтапный rollout, поэтому сверяем с
#    ПЕРВЫМ `up -d`: любой из них уже трогает контейнеры.
gate_line=$(grep -n "^panel_bind=" "$ROOT/deploy/auto-deploy.sh" | head -1 | cut -d: -f1)
# shellcheck disable=SC2016  # ${COMPOSE[@]} тут ИСКОМЫЙ ТЕКСТ, не подстановка
up_line=$(grep -n '^"\${COMPOSE\[@\]}" up -d' "$ROOT/deploy/auto-deploy.sh" | head -1 | cut -d: -f1)
[ -n "$gate_line" ] || fail "в auto-deploy.sh нет заставы PANEL_BIND"
[ -n "$up_line" ] || fail "в auto-deploy.sh не найден шаг переключения контейнеров"
[ "$gate_line" -lt "$up_line" ] || fail "застава PANEL_BIND стоит ПОСЛЕ up -d — порт уже опубликован"
grep -q 'деплой остановлен (панель ушла бы в интернет)' "$ROOT/deploy/auto-deploy.sh" \
  || fail "застава PANEL_BIND не объясняет причину отказа"

# 8. Застава ЖИВЬЁМ: она стоит до бэкапа, и фикстура до неё доходит. Разбор
#    .env обязан совпадать с compose (проверено на docker 28.3.3): compose
#    принимает `export KEY=…`/пробелы вокруг `=` и срезает кавычки/CR.
# 8а. Fail-open класс: `export PANEL_BIND=0.0.0.0` compose видит (панель ушла
#     бы в интернет), а узкий grep '^PANEL_BIND=' — нет: застава молча
#     пропускала. Обязана остановить деплой, причём ДО бэкапа (дешёвый отказ:
#     агенты живы, pg_dump не молотится).
printf 'export PANEL_BIND=0.0.0.0\n' > "$TMP/app/.env"
printf '%s\n' "$(( $(date +%s) - 700 ))" > "$BACKUP/.fail-at"
set +e; out=$(run 2>&1); rc=$?; set -e
[ "$rc" -ne 0 ] || fail "застава пропустила export PANEL_BIND=0.0.0.0"
printf '%s' "$out" | grep -q 'панель ушла бы в интернет' || fail "нет отказа заставы: $out"
printf '%s' "$out" | grep -q 'бэкап' && fail "застава сработала ПОСЛЕ бэкапа — отказ дороже необходимого: $out"

# 8б. Fail-closed класс: значение в кавычках и с CRLF легитимно (compose их
#     срезает — так панель на проде и работает). Застава обязана пропустить,
#     прогон честно идёт дальше и падает на бэкапе.
printf 'PANEL_BIND="100.81.197.68"\r\n' > "$TMP/app/.env"
printf '%s\n' "$(( $(date +%s) - 700 ))" > "$BACKUP/.fail-at"
set +e; out=$(run 2>&1); rc=$?; set -e
[ "$rc" -ne 0 ] || fail "прогон 8б обязан дойти до бэкапа и упасть там"
printf '%s' "$out" | grep -q 'панель ушла бы в интернет' \
  && fail "застава заблокировала легитимный Tailscale-адрес в кавычках: $out"
printf '%s' "$out" | grep -q 'бэкап базы не удался' || fail "прогон 8б не дошёл до бэкапа: $out"
rm -f "$TMP/app/.env"

printf 'auto-deploy-gate tests: ok\n'
