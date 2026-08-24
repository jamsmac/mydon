# Production database и disaster recovery

Состояние на 2026-08-24. Цель контура: отказ Hetzner-хоста не должен означать
потерю рабочей базы. Compute остаётся в Tailscale, а primary PostgreSQL вынесен
к независимому managed-провайдеру.

## Топология

| Роль | Размещение | Назначение |
|---|---|---|
| Primary PostgreSQL 17 | Supabase, Frankfurt | Единственная активная БД приложения |
| Runtime connection | Supabase session pooler, TLS | `DATABASE_URL` только для Core |
| Administrative connection | прямой endpoint, TLS | `DATABASE_ADMIN_URL` только для host scripts |
| Recovery PostgreSQL 17 | `mydon-db` на Hetzner | не реплика; цель восстановления и cutover rollback |
| Offsite | Telegram + Backblaze B2 | независимые ежедневные дампы и секреты |

Проект Supabase: `MYDON Production`, ref `ftwvgzwpjdxywadkphdq`, регион
`eu-central-1`. Пароли в git и документации отсутствуют. Внешние credentials
хранятся только в production `.env` (`600`) и в отдельной локальной recovery
записи владельца (`600`).

## Production env

```dotenv
DATABASE_MODE=external
DATABASE_URL=postgresql://<pooler-user>:<password>@<session-pooler>:5432/postgres?sslmode=require
DATABASE_ADMIN_URL=postgresql://postgres:<password>@<direct-host>:5432/postgres?sslmode=require
DATABASE_SIZE_WARN_MB=400
```

`DATABASE_URL` попадает в контейнер Core. `DATABASE_ADMIN_URL` compose не
передаёт ни одному приложению: его читает `/opt/backups/db_access.sh` с хоста.
Helper принимает только `sslmode=require`, `verify-ca` или `verify-full`, создаёт
временный `pgpass` с правами `600` и всегда удаляет его через trap.

Проверка без вывода URL:

```bash
/opt/backups/db_access.sh describe
/opt/backups/db_access.sh ping
```

## Нормальная эксплуатация

- Deploy применяет migration/seed к `DATABASE_URL` до переключения сервисов.
- Pre-deploy и ночной backup снимают активную БД через `db_access.sh`.
- Dump ограничен MYDON-схемами `public` и `drizzle` и не включает extensions
  или глобальные event triggers провайдера; все app tables/data входят полностью.
- Ночной backup измеряет размер. При `>=400 МБ` весь job становится красным,
  но уже созданный дамп всё равно отправляется в оба offsite.
- По понедельникам дамп реально разворачивается в PostgreSQL 17 с
  `network=none` и `tmpfs`, сверяется и полностью удаляется.
- Supabase Free не заменяет собственный backup: provider-side автоматические
  backups на этом плане не считаются частью recovery-контура.

## Отказ compute-хоста

Данные продолжают жить в Supabase. Целевой RPO для БД равен нулю, пока managed
БД доступна; RTO зависит только от готовности нового Docker/Tailscale-хоста.

1. Поднять Debian/Ubuntu host с Docker Compose и Tailscale.
2. Клонировать `main` в `/opt/mydon-app`.
3. Восстановить production `.env` из зашифрованного B2/Telegram архива.
4. Установить `PANEL_BIND` в Tailscale IP нового хоста.
5. Запустить `./deploy/deploy.sh root@<tailscale-ip>`.
6. Проверить `/health`, CC HTTP 200, Telegram и `restart=0` всех контейнеров.

Bot и Agents нельзя держать активно запущенными одновременно на двух хостах:
Telegram long polling и расписания должны иметь ровно одного владельца.

## Отказ managed-БД

Если доступен direct endpoint, сначала снять самый свежий dump. Если провайдер
недоступен, взять последний проверенный B2 dump. Это определяет фактический RPO.

1. Остановить writers: `mydon-core`, `mydon-bot`, `mydon-agents`, `mydon-cc`.
2. Проверить `gunzip -t` и финальный маркер `dump complete`.
3. Восстановить дамп в чистый PostgreSQL 17 с `ON_ERROR_STOP=1` и одной
   транзакцией.
4. Сверить migration count, 70 app tables, ключевые counts и сумму collection.
5. Атомарно заменить `DATABASE_URL`/`DATABASE_ADMIN_URL`, сохранив предыдущий
   `.env` с правами `600`.
6. Выполнить migration/seed, запустить сервисы и пройти production gates.
7. Сразу снять новый offsite backup и выполнить restore-test.

## Правило отката

Локальная `mydon-db` не получает записи после перехода на Supabase. Поэтому
переключиться на неё без восстановления можно только во время cutover, пока
новый primary ещё не принимал production-трафик. Позже такой откат потеряет
все новые данные: сначала обязателен свежий dump/restore и только затем смена
`DATABASE_URL`.

Перед любым переключением сохранять:

```text
/opt/backups/supabase-cutover/.env.pre-supabase
/opt/backups/supabase-cutover/final.dump
```

Ни один runbook не удаляет старый volume автоматически. Его удаление возможно
только отдельным решением после нескольких успешных offsite restore drills.
После cutover подготовлен `deploy_mydon-db-data-v17` из portable production
dump. Предыдущий PG16 volume `deploy_mydon-db-data` сохранён вне Compose как
дополнительный исторический snapshot и автоматическим deploy не удаляется.

## Остаточный риск compute

В tailnet нет второго Linux-сервера, но Mac владельца используется как
бесплатный cold-standby. `deploy/docker-compose.standby.yml` не содержит
PostgreSQL и stock-network: Core подключается к managed primary. Обычный drill
поднимает только Core+CC, проверяет их и снова останавливает. Bot/Agents входят
в отдельный профиль `workers` и не могут стартовать от обычного `up`.

```bash
# Подготовка/проверка без split brain; после успеха контейнеры остановлены.
./deploy/standby-drill.sh

# Только при подтверждённой недоступности production:
STANDBY_CONFIRM_PRODUCTION_DOWN=YES STANDBY_START_WORKERS=1 \
  ./deploy/standby-promote.sh

# После возврата primary сначала остановить standby workers:
./deploy/standby-stop.sh
```

### Standby env (`~/.config/mydon/standby-production.env`)

Все три скрипта требуют этот файл с правами `600`. Источник значений — тот же
зашифрованный B2/Telegram-архив production `.env` (см. «Отказ compute-хоста»,
шаг 3): распаковать и перенести НУЖНОЕ ПОДМНОЖЕСТВО ключей, не весь файл.

Обязательные ключи: `DATABASE_URL` (session pooler, `sslmode=require`),
`SERVICE_TOKEN` (без него после promote вся панель read-only — мутации 401;
значение — без кавычек и бэкслешей), `HEARTBEAT_GIST_ID` — по нему promote
проверяет живость primary независимо от tailnet и БЕЗ него отказывает
(обход — `STANDBY_ALLOW_SPLIT_BRAIN=1`). Источник значения —
`/etc/mydon-heartbeat.env` на primary: скопируйте его при ПОДГОТОВКЕ
standby-env, не во время аварии (drill напоминает об этом заранее).
Чтение идёт через raw-эндпоинт гиста (анонимный api.github.com за
провайдерским CGNAT постоянно упирается в общий лимит 60 запросов/час);
владелец гиста по умолчанию `jamsmac`, переопределяется ключом
`HEARTBEAT_GIST_OWNER`.
Для профиля workers: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_CHAT_IDS`.
Рекомендуемые: `INGEST_KEY`, `INVITE_PEPPER`, `TELEGRAM_BOT_USERNAME`,
LLM/Notion/OURVEND-ключи — по мере надобности их функций.

Требования к standby-машине: Docker Engine ≥ 25 (Docker Desktop ≥ 4.27) и
Compose ≥ 2.20.2 — иначе `start_interval` в healthcheck игнорируется или
отвергается; плюс `python3` для проверки heartbeat. Значения из env-файла
всегда побеждают переменные окружения шелла: скрипты сами вычищают из
окружения каждый ключ, определённый в файле (экспортированный в шелле
DATABASE_URL не подменит боевой).

НЕ переносить: `DATABASE_ADMIN_URL`, `POSTGRES_PASSWORD`,
`B2_APPLICATION_KEY`, `BACKUP_ENC_PASSPHRASE` — админ-доступ и бэкап-секреты
не нужны контейнерам standby, и тест `standby-compose.test.sh` проверяет, что
они не утекают в конфигурацию.

Если primary пересоздан на новом Tailscale-IP, обновить `PRIMARY_PANEL_URL`
(переменной окружения при запуске promote): проверка по мёртвому адресу вечно
отвечает 000 и ничего не доказывает.

### Что и как проверяется

Promotion отказывается при ЛЮБОМ доказательстве жизни primary: CC отвечает по
Tailscale, или heartbeat-gist (пишется каждые 2 минуты) свежее 10 минут.
Heartbeat-проверка ОБЯЗАТЕЛЬНА: без `HEARTBEAT_GIST_ID` (или при недоступном
gist / отсутствующем python3) promote отказывает, потому что «curl 000 на
tailnet-адрес» сам по себе ничего не доказывает. Протухший heartbeat
доказывает лишь нездоровье Core ≥ 10 минут: бот и агенты переживают смерть
Core, поэтому при живом доступе к primary (ssh, консоль Hetzner) сначала
остановить контейнеры там. Обход `STANDBY_ALLOW_SPLIT_BRAIN=1` оставлен
только для случая отказа самих проверок при отдельно доказанной остановке
primary.

Перед стартом workers promote проверяет токен бота через `getMe` (с ретраями
на транзиентные сбои сети), а после старта до 60 секунд ждёт в логах бота
отметку о запуске, срезая логи по времени старта текущего контейнера
(маркеры «БОТ НЕ ЗАПУСТИЛСЯ», «режим скелета», пустой allowlist, повторные
ошибки опроса валят promote): контейнер с мёртвым токеном остаётся Running,
и проверка одного лишь состояния контейнера сертифицировала бы мёртвый
failover. Drill и promote также проверяют мутационный путь Core
аутентифицированным запросом — `/health` зелёный и при пустом
`SERVICE_TOKEN`, когда все записи отбиваются 401. Гейт свежести образа
отвергает непроверяемый возраст (`unknown`): нужен git-чекаут и образ из
`standby-drill.sh`. `standby-stop.sh` — аварийный рубильник без предусловий:
останавливает контейнеры по именам напрямую, не требуя env-файла.

### Вложения при failover

Вложения primary (`/opt/mydon-data/attachments`) на standby НЕ реплицируются:
S3 не настроен, файлы живут на хосте. После promote старые фото/чеки отвечают
404 — это ожидаемо. Новые файлы, загруженные за время аварии, копятся в
`~/.local/state/mydon-standby/attachments` (или `STANDBY_ATTACHMENTS_DIR`);
при failback перенести их на primary ДО возобновления работы:

```bash
rsync -av ~/.local/state/mydon-standby/attachments/ \
  root@<primary-tailscale-ip>:/opt/mydon-data/attachments/
```

Drill 2026-08-24 подтвердил managed DB (`dbOk=true`), CC HTTP 200 и чистую
остановку Core/CC. Отдельная проверка профиля workers подтвердила завершение
Core, CC, Bot и Agents без `SIGKILL`/кода `137`; все Node-сервисы запускаются
через Docker init и получают `SIGTERM` корректно.

Это даёт бесплатный cold failover, пока Mac включён и подключён к интернету;
постоянный облачный HA всё ещё требует второй always-on VPS.
