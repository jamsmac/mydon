#!/usr/bin/env bash
# Подмена crontab для deploy/tests/setup-guards.test.sh: расписание хранится в
# обычном файле FAKE_CRONTAB_FILE, настоящий crontab пользователя не трогается.
#
# Поведение повторяет настоящий crontab, включая различие двух состояний:
# файла нет — «no crontab for user», код 1; файл есть, но пуст — пустой вывод и
# код 0. Установщик обязан останавливаться в обоих случаях, но по разным причинам.
set -euo pipefail
f=${FAKE_CRONTAB_FILE:?FAKE_CRONTAB_FILE не задан}
case "${1:-}" in
  -l) [ -f "$f" ] || { echo "no crontab for fixture" >&2; exit 1; }; cat "$f" ;;
  -)  cat > "$f" ;;
  "") echo "fake-crontab: нужен -l, - или файл" >&2; exit 2 ;;
  *)  cat "$1" > "$f" ;;   # `crontab <файл>` — восстановление из бэкапа
esac
