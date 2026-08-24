#!/usr/bin/env bash
# Установщик сторожей на подменённом crontab: dry-run ничего не пишет, apply
# переводит ТОЛЬКО строки сторожей mydon, строки склада и посторонние строки
# доживают до конца, повторный запуск — no-op, пустой crontab не перезаписывается.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
fail() { printf 'setup-guards: FAIL %s\n' "$*" >&2; exit 1; }

CRON="$TMP/crontab.txt"
GUARDS="$TMP/backups"
STOCK="$TMP/stock"

# Слепок боевого расписания (снят с сервера 24.08): сторожа mydon вперемешку
# со строками склада и посторонней уборкой docker.
cat > "$CRON" <<CRONTAB
0 22 * * * $STOCK/backup_offsite.sh >> /opt/backups/backup.log 2>&1
30 22 * * 0 docker builder prune -af --filter until=168h >/dev/null 2>&1 && docker image prune -f >/dev/null 2>&1
0 6 * * * $STOCK/disk_guard.sh >/dev/null 2>&1
*/5 * * * * $STOCK/healthz_guard.sh >/dev/null 2>&1

# Бэкап того, что не покрывал ночной скрипт
15 22 * * * /opt/backups/backup_extra.sh >> /opt/backups/backup.log 2>&1
30 3 * * 1 $STOCK/restore_test.sh >> /opt/backups/restore_test.log 2>&1
45 3 * * 1 /opt/backups/restore_test_mydon.sh >> /opt/backups/restore_test.log 2>&1
CRONTAB
ORIG=$(cat "$CRON")

run() {
  GUARD_DIR="$GUARDS" \
  OLD_GUARD_DIR="$STOCK" \
  CRONTAB_CMD="$ROOT/deploy/tests/fake-crontab.sh" \
  FAKE_CRONTAB_FILE="$CRON" \
    bash "$ROOT/deploy/setup-guards.sh" "$@"
}

# 1. dry-run: показывает diff и НЕ трогает ни crontab, ни файлы.
out=$(run --dry-run) || fail "dry-run вышел ненулём"
printf '%s' "$out" | grep -q 'dry-run: crontab не изменён' || fail "нет пометки dry-run: $out"
printf '%s' "$out" | grep -q -- "-0 6 \* \* \* $STOCK/disk_guard.sh" || fail "в diff нет старой строки: $out"
printf '%s' "$out" | grep -q -- "+0 6 \* \* \* $GUARDS/disk_guard.sh" || fail "в diff нет новой строки: $out"
[ "$(cat "$CRON")" = "$ORIG" ] || fail "dry-run изменил crontab"
[ ! -e "$GUARDS/disk_guard.sh" ] || fail "dry-run установил файлы"

# 2. apply: строки сторожей переехали, всё остальное — байт в байт.
out=$(run) || fail "apply вышел ненулём"
grep -q "^0 6 \* \* \* $GUARDS/disk_guard.sh >/dev/null 2>&1$" "$CRON" || fail "disk_guard не переехал"
grep -q "^\*/5 \* \* \* \* $GUARDS/healthz_guard.sh >/dev/null 2>&1$" "$CRON" || fail "healthz_guard не переехал"
grep -q "^0 22 \* \* \* $STOCK/backup_offsite.sh " "$CRON" || fail "потеряна строка бэкапа склада"
grep -q "^30 3 \* \* 1 $STOCK/restore_test.sh " "$CRON" || fail "потеряна проверка восстановления склада"
grep -q '^30 22 \* \* 0 docker builder prune' "$CRON" || fail "потеряна посторонняя строка уборки docker"
grep -q '^# Бэкап того, что не покрывал ночной скрипт$' "$CRON" || fail "потерян комментарий"
[ "$(grep -c . "$CRON")" = "$(printf '%s\n' "$ORIG" | grep -c .)" ] || fail "изменилось число строк"
grep -q "$STOCK/disk_guard.sh" "$CRON" && fail "в crontab остался старый путь сторожа"

# 3. Файлы установлены и исполняемы, права 700.
for g in disk_guard.sh healthz_guard.sh; do
  [ -x "$GUARDS/$g" ] || fail "$g не установлен"
  cmp -s "$ROOT/deploy/guards/$g" "$GUARDS/$g" || fail "$g отличается от исходника"
  mode=$(stat -c '%a' "$GUARDS/$g" 2>/dev/null || stat -f '%OLp' "$GUARDS/$g")
  [ "$mode" = "700" ] || fail "$g установлен с правами $mode вместо 700"
done

# 4. Бэкап прежнего расписания — ровно то, что было до правки.
backups=("$GUARDS"/crontab_pre_guards_*)
[ "${#backups[@]}" -eq 1 ] || fail "ожидался один бэкап crontab, найдено ${#backups[@]}"
[ "$(cat "${backups[0]}")" = "$ORIG" ] || fail "бэкап crontab не совпадает с исходным"

# 5. Повторный запуск — no-op: ни новой правки, ни второго бэкапа.
out=$(run) || fail "повторный запуск вышел ненулём"
printf '%s' "$out" | grep -q 'менять нечего' || fail "нет пометки идемпотентности: $out"
backups=("$GUARDS"/crontab_pre_guards_*)
[ "${#backups[@]}" -eq 1 ] || fail "повторный запуск создал лишний бэкап"

# 6. Пустой crontab НЕ перезаписывается: расписание сервера уже существует, и
#    молчание `crontab -l` означает «смотрим не туда», а не «можно писать с нуля».
: > "$CRON"
set +e; out=$(run 2>&1); rc=$?; set -e
[ "$rc" -ne 0 ] || fail "пустой crontab обязан останавливать установщик"
printf '%s' "$out" | grep -qi 'ничего не меняю' || fail "нет причины остановки: $out"
[ ! -s "$CRON" ] || fail "установщик записал crontab с нуля"

# 7. Неизвестный аргумент — отказ, а не молчаливый apply.
set +e; run --апплай >/dev/null 2>&1; rc=$?; set -e
[ "$rc" -eq 2 ] || fail "неизвестный аргумент не отклонён (код $rc)"

printf 'setup-guards tests: ok\n'
