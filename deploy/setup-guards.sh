#!/usr/bin/env bash
# Переселение сторожей mydon с путей склада на пути mydon. Идемпотентен.
#
# Зачем. Сторожа диска и здоровья лежали в /opt/mydon-stock/ и запускались
# оттуда по cron. Каталог принадлежит чужому проекту: деплой mydon его не
# обновляет (хостовая копия disk_guard.sh отстала от git на месяц), а переезд
# склада (П8 плана поглощения) унёс бы сторожей вместе с собой. Скрипт ставит
# сторожей в /opt/backups — туда же, где живут backup_extra.sh и
# restore_test_mydon.sh, — и переводит на них расписание.
#
# Что НЕ трогает. Строки cron склада (`backup_offsite.sh`, `restore_test.sh`)
# и любые посторонние строки остаются как есть: backup_offsite.sh дампит БД
# СКЛАДА через `docker compose` из его каталога, это его бэкап, и он уходит
# вместе с ним в П8. Здесь меняются только пути сторожей mydon.
#
# Запуск на сервере от root:
#   /opt/mydon-app/deploy/setup-guards.sh --dry-run   # показать diff crontab
#   /opt/mydon-app/deploy/setup-guards.sh             # применить
set -euo pipefail

SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
# Пути переопределяемы ТОЛЬКО ради тестов (deploy/tests/setup-guards.test.sh):
# на сервере переменные не выставляются и действуют боевые значения.
GUARD_DIR=${GUARD_DIR:-/opt/backups}
OLD_GUARD_DIR=${OLD_GUARD_DIR:-/opt/mydon-stock}
CRONTAB_CMD=${CRONTAB_CMD:-crontab}

# Сторожа mydon, которые обязаны запускаться с путей mydon.
GUARDS=(disk_guard.sh healthz_guard.sh)

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    # Справка — это шапка файла: одно место вместо двух расходящихся.
    -h|--help) awk 'NR>1 && /^#/ {print; next} NR>1 {exit}' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "Неизвестный аргумент: $arg (см. --help)" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }

# Живая строка расписания — не комментарий и действительно строка cron.
# `# 0 6 * * * /opt/backups/disk_guard.sh` выглядит в `crontab -l` как рабочая
# и не выполняется никогда; `PATH=/opt/backups/...` — тем более. Оба обязаны
# считаться отсутствием сторожа, иначе установщик отрапортует успех о тишине.
scheduled() {  # scheduled <текст crontab> <путь>
  printf '%s\n' "$1" |
    grep -v '^[[:space:]]*#' |
    grep -E '^[[:space:]]*(@[a-z]+|[^[:space:]]+([[:space:]]+[^[:space:]]+){4})[[:space:]]' |
    grep -qF -- "$2"
}

# --- 1. Установка исполняемых копий (тот же механизм, что в deploy.sh) ---
if [ "$DRY_RUN" -eq 0 ]; then
  own=()
  if [ "$(id -u)" -eq 0 ]; then
    own=(-o root -g root)
  else
    say "⚠ Запуск не от root: владелец файлов останется текущим пользователем."
  fi
  install -d "${own[@]}" -m 700 "$GUARD_DIR"
  for g in "${GUARDS[@]}"; do
    [ -f "$SRC_DIR/deploy/guards/$g" ] || { echo "Нет исходника deploy/guards/$g" >&2; exit 1; }
    install "${own[@]}" -m 700 "$SRC_DIR/deploy/guards/$g" "$GUARD_DIR/$g"
  done
  say "▸ Сторожа установлены: ${GUARDS[*]} → $GUARD_DIR"
fi

# --- 2. Пересчёт crontab ---
# Пустой crontab не создаём: расписание на сервере уже есть, и если `crontab -l`
# молчит, значит мы смотрим не туда. Записать вместо него две строки — потерять
# бэкапы склада и обе проверки восстановления.
if ! current=$("$CRONTAB_CMD" -l 2>/dev/null); then
  echo "Не удалось прочитать crontab (${CRONTAB_CMD} -l). Ничего не меняю." >&2
  exit 1
fi
[ -n "$current" ] || { echo "crontab пуст — ничего не меняю." >&2; exit 1; }

# Замена — подстановкой bash по ФИКСИРОВАННОЙ строке, а не sed: в пути живут
# точки (метасимвол регулярки), а `#` сломал бы ещё и разделитель s###.
updated=""
while IFS= read -r line; do
  for g in "${GUARDS[@]}"; do
    line=${line//"${OLD_GUARD_DIR}/${g}"/"${GUARD_DIR}/${g}"}
  done
  updated+="$line"$'\n'
done <<< "$current"
updated=${updated%$'\n'}

if [ "$current" = "$updated" ]; then
  # Совпадение значит одно из двух: сторожа уже переехали ИЛИ их в расписании
  # нет вовсе. Разница принципиальная — во втором случае «менять нечего»
  # означало бы «сторожей нет, и я доложил об успехе».
  missing=""
  for g in "${GUARDS[@]}"; do
    scheduled "$current" "$GUARD_DIR/$g" || missing="$missing $g"
  done
  if [ -n "$missing" ]; then
    echo "ОШИБКА: в crontab нет живой строки запуска для:${missing}." >&2
    echo "  Старых путей ${OLD_GUARD_DIR}/… там тоже нет — расписание сторожей потеряно." >&2
    echo "  Добавьте строки вручную (см. docs/BACKUPS.md, «Сторожа mydon: пути, cron, env»)." >&2
    exit 1
  fi
  say "▸ cron уже указывает на пути mydon — менять нечего."
  exit 0
fi

say "▸ Изменения в crontab:"
diff -u -L 'crontab (сейчас)' -L 'crontab (после)' \
  <(printf '%s\n' "$current") <(printf '%s\n' "$updated") || true

if [ "$DRY_RUN" -eq 1 ]; then
  say "▸ Это dry-run: crontab не изменён."
  exit 0
fi

# --- 3. Fail-closed: не переводим расписание на то, чего нет ---
# Строка cron, указывающая в пустоту, выглядит в `crontab -l` совершенно
# нормально и молча не делает ничего — сторож считался бы живым.
for g in "${GUARDS[@]}"; do
  [ -x "$GUARD_DIR/$g" ] || { echo "Нет исполняемого $GUARD_DIR/$g — расписание не трогаю." >&2; exit 1; }
done

# --- 4. Бэкап старого crontab ---
backup="$GUARD_DIR/crontab_pre_guards_$(date +%F)"
[ -e "$backup" ] && backup="$GUARD_DIR/crontab_pre_guards_$(date +%F_%H%M%S)"
printf '%s\n' "$current" > "$backup"
chmod 600 "$backup"
say "▸ Прежний crontab сохранён: $backup"

# --- 5. Применение и проверка ---
printf '%s\n' "$updated" | "$CRONTAB_CMD" -
after=$("$CRONTAB_CMD" -l 2>/dev/null || true)
for g in "${GUARDS[@]}"; do
  if scheduled "$after" "${OLD_GUARD_DIR}/${g}"; then
    echo "ОШИБКА: в crontab остался ${OLD_GUARD_DIR}/${g}. Откат: ${CRONTAB_CMD} $backup" >&2
    exit 1
  fi
  scheduled "$after" "${GUARD_DIR}/${g}" ||
    { echo "ОШИБКА: в crontab нет живой строки ${GUARD_DIR}/${g}. Откат: ${CRONTAB_CMD} $backup" >&2; exit 1; }
done

say "▸ Готово. Расписание сторожей mydon:"
for g in "${GUARDS[@]}"; do
  printf '%s\n' "$after" | grep -v '^[[:space:]]*#' | grep -F -- "${GUARD_DIR}/${g}" || true
done
say "▸ Строки склада (backup_offsite.sh, restore_test.sh) не изменялись — они уходят в П8."
