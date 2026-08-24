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
# Пин официальных SSH-ключей github.com (api.github.com/meta) вместо TOFU:
# accept-new при чистом known_hosts доверял бы любому DNS/BGP-перехвату,
# а всё из origin/main исполняется от root каждые 30 секунд.
install -d -m 700 /root/.ssh
if curl -sf --max-time 20 https://api.github.com/meta |
  python3 -c 'import json,sys
for k in json.load(sys.stdin)["ssh_keys"]:
    print("github.com " + k)' >> /root/.ssh/known_hosts 2>/dev/null; then
  sort -u /root/.ssh/known_hosts -o /root/.ssh/known_hosts
  echo "▸ Ключи github.com запинованы в known_hosts"
else
  echo "⚠ Не удалось получить ключи github.com — первый fetch провалится, пока их не добавят" >&2
fi
export GIT_SSH_COMMAND="ssh -i $KEY -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes"

# 2. Git-трекинг main в /opt/mydon-app.
cd "$APP_DIR"
[ -f .env ] && cp -a .env .env.autodeploy-bak   # страховка перед git-операциями
# Каталог пришёл через rsync (владелец — чужой UID), поэтому доверяем явно.
# Нужно и для автодеплоя под systemd от root.
git config --global --add safe.directory "$APP_DIR"
if [ ! -d .git ]; then
  git init -q -b main
fi
git remote add origin "$REPO_SSH" 2>/dev/null || git remote set-url origin "$REPO_SSH"
git fetch -q origin
# reset (а не checkout): каталог уже полон файлов от rsync — checkout бы отказался,
# reset их перезапишет версией из main, а untracked .env оставит на месте.
git reset --hard origin/main
git branch --set-upstream-to=origin/main main >/dev/null 2>&1 || true

# 3. systemd-таймер и OnFailure-крюк.
chmod +x deploy/auto-deploy.sh deploy/deploy-failure-alert.sh
cp deploy/systemd/mydon-autodeploy.service /etc/systemd/system/
cp deploy/systemd/mydon-autodeploy.timer   /etc/systemd/system/
cp deploy/systemd/mydon-deploy-alert.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now mydon-autodeploy.timer

echo "▸ Готово. Таймер:"
systemctl status mydon-autodeploy.timer --no-pager | head -4 || true
