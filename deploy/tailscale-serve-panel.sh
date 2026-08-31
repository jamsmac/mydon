#!/usr/bin/env bash
# Ставит веб-панель MYDON (mydon-cc, порт 3002) ЗА `tailscale serve` вместо
# прямого bind на Tailscale-IP. Запускать НА СЕРВЕРЕ mydon-os от root.
# Идемпотентно. Пункт 5 аудита P5 (R-P5-1, R-P5-2, R-P5-6).
#
# ЗАЧЕМ (модель доверия serve↔CC↔Core):
#   Сейчас панель published прямо на Tailscale-IP (`PANEL_BIND=100.x:3002`).
#   Любой узел tailnet, дотянувшийся до :3002, может ПОДДЕЛАТЬ заголовок
#   `Tailscale-User-Login` и стать «владельцем» — identity ничем не подтверждена.
#   `tailscale serve` терминирует HTTPS В САМОМ tailscaled, СРЕЗАЕТ любые входящие
#   `Tailscale-*` заголовки клиента и проставляет СВОИ, доверенные, по тому, кто
#   аутентифицирован в tailnet. Панель тогда обязана слушать ТОЛЬКО loopback
#   (`PANEL_BIND=127.0.0.1`), чтобы :3002 нельзя было дёрнуть в обход serve —
#   иначе R-P5-2 нарушен (заголовок снова подделываем прямым запросом).
#
#   Core этому заголовку НЕ доверяет вовсе (R-P5-2): его читает только CC (за
#   serve). Owner-only операции CC подтверждает Core отдельным секретом
#   OWNER_ACTION_TOKEN, которого нет у Bot/Agents. Прямой запрос к Core с
#   поддельным Tailscale-User-Login доступа не даёт — Core смотрит на токен, а
#   не на заголовок.
#
# ВАЖНО (R-P5-6): сам по себе serve НЕ включает ужесточение. Enforcement живёт
#   в env-флагах (OWNER_IDENTITY_ENFORCED / OWNER_READS_ENFORCED), по умолчанию 0.
#   Порядок безопасной выкатки — в docs/DEPLOY.md, раздел «Панель за tailscale
#   serve». Здесь только механика serve; флаги не трогаются.
#
# Использование (на сервере, от root, из каталога репозитория рядом с .env):
#   ./deploy/tailscale-serve-panel.sh probe   # доказать инъекцию заголовка на
#                                             # выброшенном порту, НЕ трогая панель
#   ./deploy/tailscale-serve-panel.sh up      # поднять serve → 127.0.0.1:3002
#   ./deploy/tailscale-serve-panel.sh status  # показать текущий serve-конфиг
#   ./deploy/tailscale-serve-panel.sh check   # проверить, что панель открывается
#   ./deploy/tailscale-serve-panel.sh down    # снять serve (аварийный откат)
set -euo pipefail

CC_PORT="${CC_PORT:-3002}"
PROBE_PORT="${PROBE_PORT:-3009}"
ENV_FILE="${ENV_FILE:-./.env}"

log() { printf '%s\n' "$*" >&2; }
die() { printf 'ОШИБКА: %s\n' "$*" >&2; exit 1; }

command -v tailscale >/dev/null 2>&1 || die "tailscale не найден в PATH."

# DNS-имя узла в tailnet (для ссылок и curl-проверки). Хвостовая точка срезается.
node_dnsname() {
  tailscale status --json 2>/dev/null \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))' 2>/dev/null \
    || true
}

# Разбор PANEL_BIND ИЗ .env ПО ПРАВИЛАМ compose (как deploy.sh / auto-deploy.sh):
# принимаем `export PANEL_BIND=…` и пробелы вокруг `=`, срезаем кавычки и CR.
panel_bind_value() {
  [ -f "$ENV_FILE" ] || { printf '' ; return; }
  grep -E '^[[:space:]]*(export[[:space:]]+)?PANEL_BIND[[:space:]]*=' "$ENV_FILE" 2>/dev/null \
    | tail -1 | cut -d= -f2- | tr -d "'\"[:space:]" || true
}

# loopback ли текущий bind панели (пусто → compose-дефолт 127.0.0.1 = loopback).
panel_is_loopback() {
  local pb
  pb="$(panel_bind_value)"
  [ -z "$pb" ] || [ "$pb" = "127.0.0.1" ]
}

warn_bind_not_loopback() {
  panel_is_loopback && return 0
  local pb
  pb="$(panel_bind_value)"
  log ""
  log "  ВНИМАНИЕ (R-P5-2): PANEL_BIND='$pb' — панель ещё published на этом"
  log "  адресе НАПРЯМУЮ, в обход serve. Пока это так, :$CC_PORT доступен без"
  log "  serve и заголовок Tailscale-User-Login подделываем прямым запросом."
  log "  Это допустимо ТОЛЬКО транзитно во время катовера. Финальный шаг —"
  log "  PANEL_BIND=127.0.0.1 + пересоздать mydon-cc, чтобы :$CC_PORT остался"
  log "  ТОЛЬКО на loopback (туда ходит serve). См. docs/DEPLOY.md."
  log ""
}

cmd_probe() {
  # Доказательство БЕЗ риска для живой панели: временно вешаем serve на
  # выброшенный порт с крошечным python-эхо, которое печатает полученные
  # заголовки. Так владелец своими глазами видит, что serve проставил
  # Tailscale-User-Login, ещё НЕ трогая панель и не закрывая прямой доступ.
  command -v python3 >/dev/null 2>&1 || die "нужен python3 для probe."
  local dns
  dns="$(node_dnsname)"
  local probe_py resp_file pid
  resp_file="$(mktemp)"
  probe_py="$(mktemp --suffix=.py)"
  # shellcheck disable=SC2064
  trap "rm -f '$probe_py' '$resp_file'; tailscale serve reset >/dev/null 2>&1 || true" EXIT
  cat >"$probe_py" <<PY
import http.server, socketserver
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        login = self.headers.get("Tailscale-User-Login", "<НЕТ>")
        name  = self.headers.get("Tailscale-User-Name", "<НЕТ>")
        body = ("Tailscale-User-Login: %s\nTailscale-User-Name: %s\n" % (login, name)).encode()
        self.send_response(200); self.send_header("Content-Type","text/plain"); self.end_headers()
        self.wfile.write(body)
        with open("${resp_file}", "wb") as f:
            f.write(body)
    def log_message(self, *a): pass
socketserver.TCPServer(("127.0.0.1", ${PROBE_PORT}), H).serve_forever()
PY
  log "Поднимаю эхо-сервер на 127.0.0.1:${PROBE_PORT} и serve → него…"
  python3 "$probe_py" &
  pid=$!
  # shellcheck disable=SC2064
  trap "kill $pid >/dev/null 2>&1 || true; rm -f '$probe_py' '$resp_file'; tailscale serve reset >/dev/null 2>&1 || true" EXIT
  sleep 1
  tailscale serve --bg --https=443 "http://127.0.0.1:${PROBE_PORT}" \
    || die "не удалось поднять serve (включены ли HTTPS-сертификаты в tailnet?)."
  log ""
  log "Готово. С ДРУГОГО устройства tailnet выполните:"
  log "    curl https://${dns:-<tailnet-хост>}/"
  log "Ответ должен показать ВАШ Tailscale-User-Login. Затем нажмите Enter здесь"
  log "для снятия пробы (serve reset, эхо-сервер остановится)."
  # Ждём подтверждения оператора, чтобы он успел сходить curl-ом.
  read -r _ || true
  if [ -s "$resp_file" ]; then
    log "Последний ответ эхо-серверу:"
    sed 's/^/    /' "$resp_file" >&2
  else
    log "Эхо-сервер запросов не получил — проверьте, что curl шёл на https://${dns:-…}/"
  fi
  log "Проба снята."
}

cmd_up() {
  warn_bind_not_loopback
  log "Поднимаю tailscale serve: https://<tailnet-хост>/ → http://127.0.0.1:${CC_PORT}"
  tailscale serve --bg --https=443 "http://127.0.0.1:${CC_PORT}" \
    || die "serve не поднялся (включены ли HTTPS-сертификаты в tailnet? см. DEPLOY.md)."
  cmd_status
}

cmd_status() {
  log "=== tailscale serve status ==="
  tailscale serve status || true
}

cmd_check() {
  local dns rc
  dns="$(node_dnsname)"
  [ -n "$dns" ] || die "не удалось определить DNS-имя узла (tailscale up?)."
  log "Проверяю доступность панели: https://${dns}/"
  rc="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "https://${dns}/" || echo 000)"
  log "  HTTP ${rc}"
  case "$rc" in
    2*|3*) log "  Панель отвечает через serve." ;;
    000)   die "нет ответа — serve не поднят или HTTPS-сертификат не выпущен." ;;
    *)     log "  Неожиданный код — проверьте логи mydon-cc." ;;
  esac
  log ""
  log "Проверка, что :$CC_PORT НЕ доступен напрямую в обход serve (R-P5-2):"
  if panel_is_loopback; then
    log "  PANEL_BIND=loopback — :$CC_PORT только на 127.0.0.1, прямой tailnet-доступ закрыт. OK."
  else
    warn_bind_not_loopback
  fi
  log ""
  log "Проверка, что заголовок ДОЕЗЖАЕТ до приложения и резолвер узнаёт владельца —"
  log "через identity-роут CC (см. волну CC, напр. GET /api/whoami) ИЛИ логи"
  log "mydon-cc. Делать ДО включения OWNER_IDENTITY_ENFORCED=1 (R-P5-6)."
}

cmd_down() {
  log "Снимаю tailscale serve (аварийный откат механики serve)…"
  tailscale serve reset || die "serve reset не выполнился."
  log "serve снят. НАПОМИНАНИЕ: пока PANEL_BIND=127.0.0.1, панель доступна ТОЛЬКО"
  log "с самого хоста. Чтобы вернуть прямой доступ с устройств tailnet — верните"
  log "PANEL_BIND=<Tailscale-IP> в .env и пересоздайте mydon-cc. Флаги enforcement"
  log "к serve отношения не имеют: их откат — OWNER_*_ENFORCED=0 (см. DEPLOY.md)."
}

case "${1:-}" in
  probe)  cmd_probe ;;
  up)     cmd_up ;;
  status) cmd_status ;;
  check)  cmd_check ;;
  down)   cmd_down ;;
  *)
    log "Использование: $0 {probe|up|status|check|down}"
    log "  probe  — доказать инъекцию Tailscale-User-Login на выброшенном порту"
    log "  up     — поднять serve → 127.0.0.1:${CC_PORT}"
    log "  status — показать serve-конфиг"
    log "  check  — проверить доступность панели и loopback-bind"
    log "  down   — снять serve (откат)"
    exit 2
    ;;
esac
