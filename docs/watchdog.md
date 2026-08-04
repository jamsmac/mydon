# Внешний сторож MYDON (обязателен по ТЗ §6)

Сервер mydon-os наружу ничего не открывает (всё на 127.0.0.1/Tailscale),
поэтому сторож работает по схеме **dead-man switch**: сервер сам каждые
2 минуты пишет отметку «я жив» в приватный GitHub Gist, а GitHub Actions
(другой провайдер, чем Hetzner) каждые ~10 минут проверяет её свежесть.
Отметка протухла → тревога в **отдельный** Telegram-бот: общий бот при
падении сервера лежал бы вместе с ним.

```
mydon-os ──(каждые 2 мин, PATCH gist)──▶ GitHub Gist heartbeat.json
GitHub Actions ──(каждые ~10 мин)──▶ свежесть отметки ──▶ 🚨 Telegram
```

## Настройка (один раз, ~10 минут)

1. **Gist**: https://gist.github.com → приватный gist, файл `heartbeat.json`,
   содержимое `{}`. Запомни id из адреса (`gist.github.com/jamsmac/<id>`).

2. **Токены** (github.com → Settings → Developer settings → Fine-grained tokens):
   создай **два** токена с единственным правом **Gists**:
   - для сервера — Read and write;
   - для сторожа — Read-only (хватит и первого, но узкий безопаснее).

3. **Отдельный Telegram-бот**: @BotFather → `/newbot` → токен.
   Напиши новому боту `/start` и узнай свой chat_id (например, ботом @userinfobot).

4. **Сервер**:
   ```bash
   ssh root@100.81.197.68
   cat > /etc/mydon-heartbeat.env << 'EOF'
   HEARTBEAT_GIST_ID=<id из шага 1>
   HEARTBEAT_GH_TOKEN=<токен Read and write>
   EOF
   cd /opt/mydon-app && ./deploy/setup-heartbeat.sh
   ```
   Скрипт поставит systemd-таймер (2 мин) и сразу отправит пробную отметку.

5. **Секреты Actions** (репозиторий → Settings → Secrets and variables →
   Actions → New repository secret):
   - `WATCHDOG_GIST_ID` — id gist;
   - `WATCHDOG_GH_TOKEN` — токен Read-only;
   - `WATCHDOG_BOT_TOKEN` — токен бота из шага 3;
   - `WATCHDOG_CHAT_IDS` — chat_id (через запятую, если несколько);
   - `WATCHDOG_STALE_MINUTES` — необязательно, порог (по умолчанию 10).

6. **Проверка**: Actions → workflow «watchdog» → Run workflow. В логе —
   «ok: heartbeat N мин назад». Потом останови таймер на сервере
   (`systemctl stop mydon-heartbeat.timer`), запусти workflow ещё раз —
   придёт 🚨; включи таймер обратно — следующий запуск пришлёт ✅.

## Как это ведёт себя

- Тревога — при переходе «жив → лежит», напоминание — каждый запуск, пока
  лежит, «✅ снова жив» — один раз при восстановлении (состояние между
  запусками — в кэше Actions).
- В тревоге — последняя отметка: время, свободный диск, статусы контейнеров —
  видно, что умирало последним.
- Расписание Actions плавает (реально 10–15 мин) — это сторож «сервер лежит»,
  а не секундный мониторинг. Посекундная доступность — не его задача.
- `apps/watchdog` (HTTP-пуллер) остаётся в репо: пригодится, если появится
  публичный healthz-endpoint или второй VPS для сторожа.
