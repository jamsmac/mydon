#!/usr/bin/env bash
# Одноразовая настройка сторожевого контура на сервере mydon-os. Идемпотентна.
#
# Ставит ОБЕ половины взаимной слежки:
#   heartbeat          — сервер отмечается «я жив», это читает внешний сторож;
#   watchdog-liveness  — сервер читает отметку сторожа и бьёт тревогу, если
#                        сторож замолчал (иначе его смерть никто не заметит).
#
# Предпосылки (см. docs/watchdog.md):
#   1) создан ПРИВАТНЫЙ gist с файлом heartbeat.json (любым содержимым);
#   2) создан fine-grained token с единственным правом Gists: Read and write;
#   3) на сервере создан /etc/mydon-heartbeat.env:
#        HEARTBEAT_GIST_ID=...
#        HEARTBEAT_GH_TOKEN=...
#        WATCHDOG_BOT_TOKEN=...   # тот же бот тревог, что у Actions-сторожа
#        WATCHDOG_CHAT_IDS=...    # без них тревога о смерти сторожа уйдёт в лог
#
# Запуск: ./deploy/setup-heartbeat.sh   (на сервере, от root)
set -euo pipefail

APP_DIR="/opt/mydon-app"
cd "$APP_DIR"

ENV_FILE="/etc/mydon-heartbeat.env"
[ -f "$ENV_FILE" ] || {
  echo "✗ Нет $ENV_FILE — сначала создай его (HEARTBEAT_GIST_ID, HEARTBEAT_GH_TOKEN)."
  exit 1
}
chmod 600 "$ENV_FILE"

grep -q '^WATCHDOG_BOT_TOKEN=' "$ENV_FILE" ||
  echo "⚠ В $ENV_FILE нет WATCHDOG_BOT_TOKEN/WATCHDOG_CHAT_IDS — тревога о смерти сторожа уйдёт только в лог journalctl."

chmod +x deploy/heartbeat.sh deploy/watchdog-liveness.sh
cp deploy/systemd/mydon-heartbeat.service         /etc/systemd/system/
cp deploy/systemd/mydon-heartbeat.timer           /etc/systemd/system/
cp deploy/systemd/mydon-watchdog-liveness.service /etc/systemd/system/
cp deploy/systemd/mydon-watchdog-liveness.timer   /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now mydon-heartbeat.timer
systemctl enable --now mydon-watchdog-liveness.timer
# enable --now для уже включённого таймера — no-op: новые интервалы из
# .timer-файлов без рестарта не применяются до перезагрузки.
systemctl restart mydon-heartbeat.timer mydon-watchdog-liveness.timer

echo "▸ Пробная отправка heartbeat:"
./deploy/heartbeat.sh
echo "▸ Пробная проверка сторожа:"
./deploy/watchdog-liveness.sh || true
echo "▸ Готово. Таймеры:"
systemctl list-timers 'mydon-heartbeat*' 'mydon-watchdog-liveness*' --no-pager || true
