#!/usr/bin/env bash
# apply.sh — перенос пакета agentic-os-starter в рабочее дерево репозитория MYDON.
#
# Запуск из корня репо:   bash docs/agentic-os-starter/apply.sh
# Что делает:
#   1) проверяет, что мы в корне mydon и не на ветке main;
#   2) бэкапит текущий CLAUDE.md в docs/agentic-os-starter/_backup/;
#   3) копирует новые файлы БЕЗ перезаписи существующих: routers/, memory/, claude-skills/ → .claude/skills/
#      (в пакете каталог без точки: удалённые инструменты не пишут в .claude — копирует только этот скрипт),
#      engine/{autonomy.yaml,eval-rubric.md}, apps/agents/shared/;
#   4) заменяет CLAUDE.md (единственный перезаписываемый файл; AGENTS.md — симлинк, не трогаем);
#   5) прогоняет verify-paths.mjs и показывает git status.
# Ничего не коммитит. Откат: git checkout -- CLAUDE.md && git clean -n (посмотреть) / git clean -fd routers memory …
set -euo pipefail

if [[ ! -f package.json ]] || ! grep -q '"name": "mydon"' package.json; then
  echo "Запускать из корня репозитория mydon" >&2; exit 1
fi
branch=$(git rev-parse --abbrev-ref HEAD)
if [[ "$branch" == "main" ]]; then
  echo "Вы на main. Сначала: git checkout -b feat/agentic-os-starter" >&2; exit 1
fi

PKG=docs/agentic-os-starter
STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$PKG/_backup"
cp CLAUDE.md "$PKG/_backup/CLAUDE.md.$STAMP"
echo "Бэкап CLAUDE.md → $PKG/_backup/CLAUDE.md.$STAMP"

copy_tree() { # copy_tree <src-dir-in-pkg> <dst-dir>
  local src="$PKG/$1" dst="$2"
  [[ -d "$src" ]] || return 0
  mkdir -p "$dst"
  # -n: существующие файлы не трогаем — сообщаем о них отдельно
  while IFS= read -r -d '' f; do
    rel="${f#$src/}"
    if [[ -e "$dst/$rel" ]]; then
      echo "  пропущен (уже есть): $dst/$rel"
    else
      mkdir -p "$(dirname "$dst/$rel")"
      cp "$f" "$dst/$rel"
      echo "  + $dst/$rel"
    fi
  done < <(find "$src" -type f -print0)
}

echo "Копирую новые файлы…"
copy_tree routers routers
copy_tree memory memory
copy_tree claude-skills .claude/skills
copy_tree engine engine
copy_tree apps/agents/shared apps/agents/shared

echo "Заменяю CLAUDE.md…"
cp "$PKG/CLAUDE.md" CLAUDE.md
echo "  ~ CLAUDE.md"

echo "Проверяю ссылки…"
node "$PKG/verify-paths.mjs" || { echo "Есть битые ссылки — см. выше" >&2; exit 1; }

echo
git status --short
echo
echo "Готово. Дальше: просмотреть diff CLAUDE.md, при необходимости поправить «Цели», затем PR."
