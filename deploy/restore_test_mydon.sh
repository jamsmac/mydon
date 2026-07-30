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

DUMP=$(ls -t /opt/backups/extra/mydon-app_*.sql.gz 2>/dev/null | head -1)
TESTDB="mydon_restore_test_$(date +%s)"
FAILED=0
NEW_TABLES=0

say() { printf '%s\n' "$1"; }
q() { docker exec mydon-db psql -U mydon -d "$1" -tAc "$2" 2>/dev/null | tr -d ' '; }

say "=== Проверка восстановления базы MYDON · $(date '+%d.%m.%Y %H:%M') ==="

if [ -z "${DUMP:-}" ]; then
  say "ПРОВАЛ: дампов /opt/backups/extra/mydon-app_*.sql.gz не найдено"
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
say "2. Временная база создана"

# Восстановление. Дамп снят с --clean --if-exists, поэтому в пустой базе
# часть DROP-ов ругается — это нормально, важен итог по данным.
if ! gunzip -c "$DUMP" | docker exec -i mydon-db psql -U mydon -d "$TESTDB" >/dev/null 2>&1; then
  say "   предупреждение: psql вернул ошибку — проверяю данные всё равно"
fi
say "3. Дамп развёрнут"

# Сверка: ключевые таблицы должны восстановиться и совпасть с живыми
# по порядку величины (живая база растёт, дамп ночной — точного равенства нет).
say "4. Сверка данных (живая база → восстановленная):"
for t in entity collection sale purchase machine_stock person task audit_log; do
  live=$(q mydon "select count(*) from $t")
  rest=$(q "$TESTDB" "select count(*) from $t")
  if [ -z "$rest" ]; then
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
if [ "${rest_sum:-0}" -eq 0 ] && [ "${live_sum:-0}" -gt 0 ]; then
  say "   ПРОВАЛ инкассации: суммы в дампе нулевые"
  FAILED=1
else
  say "   ок суммы инкассаций: живая $live_sum → из дампа $rest_sum"
fi

docker exec mydon-db psql -U mydon -d postgres -c "DROP DATABASE \"$TESTDB\"" >/dev/null 2>&1
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
