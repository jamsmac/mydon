#!/usr/bin/env bash
# Одноразовая настройка heartbeat на сервере mydon-os. Идемпотентна.
#
# Предпосылки (см. docs/watchdog.md):
#   1) создан ПРИВАТНЫЙ gist с файлом heartbeat.json (любым содержимым);
#   2) создан fine-grained token с единственным правом Gists: Read and write;
#   3) на сервере создан /etc/mydon-heartbeat.env:
#        HEARTBEAT_GIST_ID=...
#        HEARTBEAT_GH_TOKEN=...
#
# Запуск: ./deploy/setup-heartbeat.sh   (на сервере, от root)
set -euo pipefail

APP_DIR="/opt/mydon-app"
cd "$APP_DIR"

[ -f /etc/mydon-heartbeat.env ] || {
  echo "✗ Нет /etc/mydon-heartbeat.env — сначала создай его (HEARTBEAT_GIST_ID, HEARTBEAT_GH_TOKEN)."
  exit 1
}
chmod 600 /etc/mydon-heartbeat.env

chmod +x deploy/heartbeat.sh
cp deploy/systemd/mydon-heartbeat.service /etc/systemd/system/
cp deploy/systemd/mydon-heartbeat.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now mydon-heartbeat.timer

echo "▸ Пробная отправка:"
./deploy/heartbeat.sh
echo "▸ Готово. Таймер:"
systemctl status mydon-heartbeat.timer --no-pager | head -4 || true
