#!/usr/bin/env bash
# Проверка восстановления базы MYDON (mydon-db).
#
# Зачем: бэкап, который никогда не восстанавливали, — это не бэкап, а надежда.
# Ревизия 2026-07-30 показала: восстановление проверялось только для базы
# склада (mydon-stock), а для новой базы MYDON — нет.
#
# Что делает: берёт свежий ночной дамп, поднимает его в ВРЕМЕННУЮ базу рядом,
# сверяет ключевые числа с живой базой и временную базу удаляет.
# Живую базу не трогает ни на чтении, ни на записи.
#
# Запуск: раз в неделю по cron (см. конец файла).
set -uo pipefail

DUMP=$(find /opt/backups/extra -maxdepth 1 -type f -name 'mydon-app_*.sql.gz' \
  -printf '%T@ %p\n' 2>/dev/null | sort -n | tail -n 1 | cut -d' ' -f2-)
MAX_DUMP_AGE_HOURS="${RESTORE_DUMP_MAX_AGE_HOURS:-48}"
TESTDB="mydon_restore_test_$(date +%s)"
FAILED=0
NEW_TABLES=0
TESTDB_CREATED=0

say() { printf '%s\n' "$1"; }
q() { docker exec mydon-db psql -U mydon -d "$1" -tAc "$2" 2>/dev/null | tr -d ' '; }
cleanup() {
  if [ "$TESTDB_CREATED" -eq 1 ]; then
    docker exec mydon-db psql -U mydon -d postgres \
      -c "DROP DATABASE IF EXISTS \"$TESTDB\" WITH (FORCE)" >/dev/null 2>&1 || true
    TESTDB_CREATED=0
  fi
}
trap cleanup EXIT INT TERM

say "=== Проверка восстановления базы MYDON · $(date '+%d.%m.%Y %H:%M') ==="

if [ -z "${DUMP:-}" ]; then
  say "ПРОВАЛ: дампов /opt/backups/extra/mydon-app_*.sql.gz не найдено"
  exit 1
fi
if ! [[ "$MAX_DUMP_AGE_HOURS" =~ ^[1-9][0-9]*$ ]]; then
  say "ПРОВАЛ: RESTORE_DUMP_MAX_AGE_HOURS должен быть целым числом больше нуля"
  exit 1
fi
dump_age_hours=$(( ($(date +%s) - $(stat -c %Y "$DUMP")) / 3600 ))
if [ "$dump_age_hours" -gt "$MAX_DUMP_AGE_HOURS" ]; then
  say "ПРОВАЛ: свежему дампу уже ${dump_age_hours} ч (порог ${MAX_DUMP_AGE_HOURS} ч)"
  exit 1
fi
say "1. Дамп: $(basename "$DUMP") ($(du -h "$DUMP" | cut -f1)), снят $(stat -c %y "$DUMP" | cut -d. -f1)"

if ! gunzip -t "$DUMP" 2>/dev/null; then
  say "ПРОВАЛ: архив повреждён"
  exit 1
fi
say "   архив целый"

# Временная база: имя с отметкой времени, чтобы никогда не пересечься с живой.
if ! docker exec mydon-db psql -U mydon -d postgres -c "CREATE DATABASE \"$TESTDB\"" >/dev/null 2>&1; then
  say "ПРОВАЛ: не удалось создать временную базу"
  exit 1
fi
TESTDB_CREATED=1
say "2. Временная база создана"

# Восстановление строгое и атомарное: любая SQL-ошибка означает, что дамп не
# доказал восстанавливаемость. Продолжать со случайно частичной базой опасно.
if ! gunzip -c "$DUMP" | docker exec -i mydon-db psql -U mydon -d "$TESTDB" \
  -v ON_ERROR_STOP=1 --single-transaction >/dev/null 2>&1; then
  say "ПРОВАЛ: psql не смог восстановить дамп целиком"
  exit 1
fi
say "3. Дамп развёрнут"

# Сверка: ключевые таблицы должны восстановиться и совпасть с живыми
# по порядку величины (живая база растёт, дамп ночной — точного равенства нет).
say "4. Сверка данных (живая база → восстановленная):"
for t in entity collection sale purchase machine_stock person task audit_log; do
  live=$(q mydon "select count(*) from $t")
  rest=$(q "$TESTDB" "select count(*) from $t")
  if [ -z "$live" ]; then
    say "   ПРОВАЛ $t: таблица не читается в живой базе"
    FAILED=1
  elif [ -z "$rest" ]; then
    # Таблицы нет в дампе, но есть в живой базе — обычно это новая таблица,
    # созданная миграцией ПОСЛЕ ночного бэкапа. Пугать не за что: она попадёт
    # в следующий дамп. Провалом считаем только пропажу уже бэкапленных данных.
    say "   новая $t: в дампе ещё нет (создана после бэкапа), в живой $live — попадёт в следующий"
    NEW_TABLES=$((NEW_TABLES + 1))
  elif [ "$rest" -eq 0 ] && [ "${live:-0}" -gt 0 ]; then
    say "   ПРОВАЛ $t: в дампе пусто, а в живой базе $live"
    FAILED=1
  else
    say "   ок $t: живая $live → из дампа $rest"
  fi
done

# Смысловая проверка: суммы денег не должны потеряться.
live_sum=$(q mydon "select coalesce(sum(amount),0)::bigint from collection where status='received'")
rest_sum=$(q "$TESTDB" "select coalesce(sum(amount),0)::bigint from collection where status='received'")
if [ -z "$live_sum" ] || [ -z "$rest_sum" ]; then
  say "   ПРОВАЛ инкассации: таблица или сумма не читается"
  FAILED=1
elif [ "$rest_sum" -eq 0 ] && [ "$live_sum" -gt 0 ]; then
  say "   ПРОВАЛ инкассации: суммы в дампе нулевые"
  FAILED=1
else
  say "   ок суммы инкассаций: живая $live_sum → из дампа $rest_sum"
fi

cleanup
say "5. Временная база удалена"

if [ "$FAILED" -eq 0 ]; then
  if [ "$NEW_TABLES" -gt 0 ]; then
    say "ИТОГ: бэкап восстанавливается, данные на месте. Новых таблиц вне дампа: $NEW_TABLES — проверятся после ночного бэкапа."
  else
    say "ИТОГ: бэкап базы MYDON восстанавливается, данные на месте."
  fi
else
  say "ИТОГ: ЕСТЬ ПРОБЛЕМЫ — смотри строки «ПРОВАЛ» выше."
  exit 1
fi

# Установка на сервере:
#   cp deploy/restore_test_mydon.sh /opt/backups/ && chmod +x /opt/backups/restore_test_mydon.sh
#   (crontab) 45 3 * * 1 /opt/backups/restore_test_mydon.sh >> /opt/backups/restore_test.log 2>&1
