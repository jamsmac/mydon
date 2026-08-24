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
| Recovery PostgreSQL | `mydon-db` на Hetzner | не реплика; цель восстановления и cutover rollback |
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

## Остаточный риск compute

В текущей tailnet нет второго Linux-хоста: видны только production, Mac и
телефон. Managed PostgreSQL устраняет единый DB failure domain, но постоянный
compute failover потребует ещё одной машины. До её появления репозиторий,
зашифрованный `.env`, внешняя БД и этот runbook дают cold recovery, а не HA.
