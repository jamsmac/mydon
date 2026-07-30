#!/usr/bin/env bash
# Одноразовая настройка автодеплоя на сервере mydon-os. Идемпотентна.
#
# Что делает:
#  1) создаёт read-only deploy-ключ (если нет) и печатает публичную часть —
#     её нужно один раз добавить в GitHub → Settings → Deploy keys (read-only);
#  2) превращает /opt/mydon-app в git-репозиторий, следящий за origin/main
#     (файл .env не трогается — он untracked);
#  3) ставит и включает systemd-таймер mydon-autodeploy (каждые 2 минуты).
#
# Запуск: ./deploy/setup-autodeploy.sh   (на сервере, от root)
set -euo pipefail

APP_DIR="/opt/mydon-app"
KEY="/root/.ssh/mydon_deploy"
REPO_SSH="git@github.com:jamsmac/mydon.git"

# 1. Deploy-ключ.
if [ ! -f "$KEY" ]; then
  install -d -m 700 "$(dirname "$KEY")"
  ssh-keygen -t ed25519 -f "$KEY" -N "" -C "mydon-os auto-deploy" >/dev/null
  echo "▸ Создан deploy-ключ. Добавь ПУБЛИЧНУЮ часть в GitHub (read-only):"
  echo "──────────────────────────────────────────────────────────────────"
  cat "$KEY.pub"
  echo "──────────────────────────────────────────────────────────────────"
fi
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"

# 2. Git-трекинг main в /opt/mydon-app.
cd "$APP_DIR"
[ -f .env ] && cp -a .env .env.autodeploy-bak   # страховка перед git-операциями
if [ ! -d .git ]; then
  git init -q
  git remote add origin "$REPO_SSH"
fi
git remote set-url origin "$REPO_SSH"
git fetch -q origin
git checkout -B main origin/main
git branch --set-upstream-to=origin/main main >/dev/null 2>&1 || true

# 3. systemd-таймер.
chmod +x deploy/auto-deploy.sh
cp deploy/systemd/mydon-autodeploy.service /etc/systemd/system/
cp deploy/systemd/mydon-autodeploy.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now mydon-autodeploy.timer

echo "▸ Готово. Таймер:"
systemctl status mydon-autodeploy.timer --no-pager | head -4 || true
