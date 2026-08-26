# П7 «Задачи» — дизайн (8 задач: подтверждение, уведомления, мост событие → задача)

Дата: 2026-08-26. База ветки — `origin/main` **b3b595d** (#217, «Хвосты
снек-контура»), рабочее дерево `~/Developer/mydon-p7`, ветка `feat/p7-tasks`.
Опись (SELECT-only, ничего не правилось):
`.superpowers/sdd/2026-08-26-sloy-p7-tasks/inventory.md`.
Рулинги контроллера R-P7-1…R-P7-5 — `.superpowers/sdd/2026-08-26-sloy-p7-tasks/progress.md`.

**Строка плана устарела и правится этим срезом.**
`docs/PLAN_STOCK_ABSORPTION.md:364` говорит «**В монорепо модуля задач нет**».
Это неверно с большим запасом: модуль есть и он на порядок богаче донора —
таблица `task` на 20 колонок (`packages/db/src/schema.ts:171-244`), спутник
`task_comment` (`:741-755`), 17 маршрутов Core
(`apps/core/src/tasks/tasks.controller.ts`), полный контур в боте (список,
карточка, «взял/выполнил/не смогу», мастер закрытия с отчётом и фото, дайджест
07:00, напоминания, возвраты на доработку), две страницы панели плюс `workload`,
исполнение задач агентами (`apps/agents/src/task-worker.ts`) и хук «закрыл
задачу ТО → запись в журнале обслуживания»
(`apps/core/src/tasks/tasks.service.ts:215-290`). Донорские `tasks`
(`/opt/mydon-stock/app/schema.sql:94-108`) — **0 строк за всю историю**:
переносить «проверенный практикой контур» неоткуда, он не проверен.
Настоящая проблема не в отсутствии модуля, а в том, что **его никто не кормит**:
в прод-БД 4 задачи за всё время и 0 комментариев, все четыре заведены владельцем
руками из панели.

## 1. Цель

Один вопрос на задачу — и на каждый сегодня нет ответа:

| # | Вопрос | Почему ответа нет |
|---|---|---|
| T1 | «Эту задачу приняли или она просто закрыта?» | статуса «подтверждено» нет: `quality` (`excellent/accepted/redo`) ставится только владельцем из панели (`apps/cc/src/app/tasks/actions.ts:96`), а задача остаётся `done` независимо от того, приняли её или нет |
| T2 | «Мне что-то поручили?» | назначенная из панели задача доходит только дайджестом 07:00 или напоминанием о сроке (раз в 30 мин); мгновенного пуша нет |
| T3 | «Кто-то доделал — надо принять?» | закрытие задачи не шлёт никому ничего; владелец узнаёт, открыв `/tasks` |
| T4 | «Автомат опустел — где задача?» | ни одно событие полевого контура задачей не становится: единственный автосоздатель — монитор ТО, и он в проде молчит (§2.4) |
| T5 | «Кому можно назначать и подтверждать?» | прав `tasks.assign`/`tasks.confirm` нет вовсе; в `PERMISSIONS` только `tasks.own`, и он в `BASELINE` — то есть у всех |
| T6 | «Что ждёт моего решения?» | ни экрана в боте, ни блока в панели: `/tasks` показывает только `open=1` (`apps/cc/src/app/tasks/page.tsx:19`), а `done` не показывает никто |
| T7 | «Почему просрочка не будит?» | правило `task.overdue` есть (`apps/core/src/rules/rules.ts:358-363`), **эмитента у события в коде нет** — тракт изображает работу |
| T8 | «Мост заработал или снова тишина?» | ровно эта тишина уже случилась с монитором ТО и была замечена через 20 дней только описью |

## 2. Инвентаризация (перепроверено в рабочем дереве, b3b595d)

### 2.1 Таблица и её ключи

| Факт | Где |
|---|---|
| `taskStatusEnum` = `todo`/`in_progress`/`done`/`cancelled` — **четыре** значения | `packages/db/src/schema.ts:29` |
| `taskQualityEnum` = `excellent`/`accepted`/`redo` | `packages/db/src/schema.ts:31` |
| `task`: 20 колонок, `ownerKind` human/agent, `ownerRef` NULL = свободная | `packages/db/src/schema.ts:172-244` |
| Индексы: `task_owner_idx`, `task_due_idx`, `task_entity_idx`, `task_client_key` UNIQUE | `packages/db/src/schema.ts:227-243` |
| **Частичный** уникальный `task_source_key(source) WHERE source ~ ':[0-9]{4}-[0-9]{2}-[0-9]{2}$'` | `packages/db/src/schema.ts:238-241`, миграция `packages/db/drizzle/0040_task_entity_photo_stage.sql` |
| `closed_by` (кто ФАКТИЧЕСКИ закрыл ≠ исполнитель) | `packages/db/src/schema.ts:214`, миграция `0054_task_closed_by.sql` |
| `task_comment(task_id, author_ref, body)`, `author_ref` = `owner`/`person:<id>`/`agent:<имя>` | `packages/db/src/schema.ts:741-755` |
| `person.roles` — массив, `person.role` — легаси-текст, `person.tgChatId` UNIQUE | `packages/db/src/schema.ts:145-164` |
| `notification_delivery.key` PRIMARY KEY — таблица одноразовых ключей | `packages/db/src/schema.ts:851-855` |
| Последняя миграция — **0071** (`0071_stock_count_retention_idx.sql`) | `packages/db/drizzle/` |

### 2.2 Core: что уже есть и переиспользуется

| Факт | Где |
|---|---|
| 17 маршрутов задач, без своих гвардов и без `@Throttle` | `apps/core/src/tasks/tasks.controller.ts:140-294` |
| `ListTasksDto` (`status/domain/ownerKind/ownerRef/open/unassigned`), ветка `unassigned==="1"` в контроллере | `apps/core/src/tasks/tasks.controller.ts:48-116`, `:204-213` |
| `SetQualityDto` — **только `quality`, поля `actor` нет**; контроллер зовёт `rate(id, dto.quality)` и актор всегда «owner» | `apps/core/src/tasks/tasks.controller.ts:123-126`, `:232-235` |
| `setStatus` — условие «статус ещё не такой» внутри UPDATE; `completedAt`/`closedBy` только при `done` | `apps/core/src/tasks/tasks.service.ts:172-224` |
| `rate()` требует `row.status !== "done"` → 400 | `apps/core/src/tasks/tasks.service.ts:508-510` |
| `ensureForDay` — `source = <ключ>:<dayKey>`, `onConflictDoNothing({ target: task.source })`, проверка «автомат в эксплуатации», `audit_log` | `apps/core/src/tasks/tasks.service.ts:352-399` |
| `machineIsOperationalCheck` через `machine_card.status` + `machineIsOperational` | `apps/core/src/tasks/tasks.service.ts:344-350`, `packages/shared/src/machine-status.ts:72` |
| Все мутации Core — под `ServiceTokenGuard`, fail-closed; GET открыт | `apps/core/src/common/service-token.guard.ts:8-40` |
| Именованные лимитеры `burst`/`sustained` (`default` не существует) | `apps/core/src/app.module.ts:42-45`, образец `apps/core/src/vending/vending.controller.ts:619` |
| Крон в Core — `croner`, поле `cron` + `onApplicationShutdown`, часовой пояс `TZ` | `apps/core/src/sales/sales.service.ts:160-172`, `apps/core/src/vending/retention.service.ts:131-146` |
| Сторож с ОДНИМ кроном и двумя проверками, каждая под своим `catch` | `apps/core/src/ourvend/sync-stale.service.ts:69-80` |
| Страж «крон останавливается на shutdown» — таблица сервисов | `apps/core/src/cron-shutdown.test.ts:17-30` |
| `EventsService.record()` / `.list({types, since, limit})` — фильтр типов В SQL, до лимита | `apps/core/src/events/events.service.ts:23-57` |
| Правила — **опрос, а не подписка**: бот тянет `/rules/pending`, `RULE_EVENT_TYPES` выводится из `RULES` | `apps/core/src/rules/rules.service.ts:88-110`, `apps/core/src/rules/rules.ts:601` |
| `RulesService.claim(key)` — атомарная одноразовая заявка через RETURNING | `apps/core/src/rules/rules.service.ts:56-73` |
| `RulesModule` экспортирует `RulesService`; `VendingModule` экспортирует `VendingService`; `TasksModule` не импортирует никто, кроме `app.module` | `apps/core/src/rules/rules.module.ts:7-12`, `apps/core/src/vending/vending.module.ts:35-59`, `apps/core/src/app.module.ts:76` |
| `VendingService.machineIndex()` публичен НАМЕРЕННО — одна карта «серийник → карточка» на всех потребителей | `apps/core/src/vending/vending.service.ts:1359-1370` |
| Лента действий читает ДОМЕННЫЕ таблицы, не `audit_log`; виды `task_done`/`task_created` | `apps/core/src/registry/actions.service.ts:20-56`, `:223-237`, `:325-328` |
| Брифинг считает просрочку задач | `apps/core/src/registry/registry.service.ts:200-203` |
| Настройки — `CONFIG_SPECS` (`key/label/kind/fallback/help/validate`), чтение `readIntSetting`, база важнее env | `apps/core/src/system/config-spec.ts:15-26`, `apps/core/src/system/settings.ts:16-47` |
| Образец `kind: "bool"` с `oneOf(["0","1"])` | `apps/core/src/system/config-spec.ts:109-116` (`AGENTS_SCHEDULES_PAUSED`) |

### 2.3 События-кандидаты: точные полезные нагрузки

| Событие | Payload (проверено) | Эмитент |
|---|---|---|
| `machine.low_stock` | `{ machine, serial, product, left }`, `source: "system"` | `apps/core/src/vending/shrinkage.service.ts:599-604` |
| `vending.shrinkage_alert` | `{ serial, name, product, lossUnits, lossValue, days }` | `apps/core/src/vending/shrinkage.service.ts:555-561` |
| `vending.refill_detected` | `{ eventId, serial, name, units, windowTo, recorded: false }` — пишется **только** по несопоставленным окнам старше `MATCH_PAD_MS` | `apps/core/src/vending/refill-events.service.ts:404-418`, отбор `:374-383` (`isNull(matchedRefillId)`) |
| `ourvend.sync_stale` | `{ hoursSinceSuccess, lastSuccessAt, lastRunStatus }`, дедуп «раз в ташкентские сутки» | `apps/core/src/ourvend/sync-stale.service.ts:149-156` |
| `ourvend.sync_failed_streak` | `{ streak, lastError, since }`, дедуп «раз в ташкентские сутки» | `apps/core/src/vending/vending.service.ts:3030-3043` |
| `task.overdue` | правило `immediate` есть, **эмитента нет** | `apps/core/src/rules/rules.ts:358-363` |

Потолки, которые автозадачи обязаны наследовать: `ALERT_MAX_EVENTS = 50` на
прогон алертов, `LOW_STOCK_REPEAT_MS = 3 суток`, `LOW_STOCK_FRESH_MS = 24 ч`
(`apps/core/src/vending/shrinkage.service.ts:62-79`), `RateLimiter` 20/мин на
чат и `OutRate` 1,1 с на чат в боте (`apps/bot/src/out-rate.ts:15-17`).

### 2.4 Почему мост нельзя вешать на HTTP-путь монитора ТО

В проде 77 нормативов обслуживания, все активные и все `auto_task=true`,
19 из них просрочены на автоматах в эксплуатации, — а задач с
`source LIKE 'maint:%'` **ноль** и событий `maintenance.overdue`/
`maintenance.unclaimed` **ноль за всю историю** таблицы `event` (опись §1.8).
Монитор живёт в `apps/agents` и ходит в Core по HTTP
(`apps/agents/src/maintenance-monitor.ts:161-174`), а ошибки собирает строками
в `result.errors` и отправляет в лог — то есть отказ `POST /tasks/ensure-for-day`
(например, 401 от `ServiceTokenGuard`) выглядит как «работ не подошло».
Починка этого — срез «Гигиена» (задача #16), **не П7** (Р5 описи).

**Вывод, определяющий T4:** мост живёт **внутри Core** и зовёт
`TasksService.ensureForDay` как метод, а не как маршрут. Механизм
идемпотентности тот же (частичный индекс `task_source_key`, проверен миграцией
0040), а транспорт — другой: ни HTTP, ни токена, ни `result.errors`. Плюс
каждый созданный ряд пишет событие `task.auto_created`, поэтому «тишина»
становится измеримой, а не гипотетической (T8).

### 2.5 Бот: каналы доставки, которые переиспользуются

| Факт | Где |
|---|---|
| Связь человек↔Telegram — `person.tgChatId`; карта строится из `deps.core.people()` | `apps/bot/src/index.ts:589`, `:685`, `apps/bot/src/weekly-delivery.ts:88-92` |
| Образец «доставили → отметили» (возвраты на доработку, 60 с) | `apps/bot/src/index.ts:676-707` |
| Образец «заняли ключ → отправили» (дайджест 07:00, недельная сводка) | `apps/bot/src/index.ts:519-524`, `apps/bot/src/weekly-delivery.ts:12-30` |
| `claimNotification(key)` — одноразовый ключ, переживает перезапуск бота | `apps/bot/src/index.ts:660-663` |
| `TelegramError.isUnreachable` → жалоба владельцу раз в сутки | `apps/bot/src/index.ts:615-620`, `:655-671` |
| `taskKeyboard` / `tasksKeyboard` / `parseTaskCallback`, префикс `t:` | `apps/bot/src/staff.ts:117-174` |
| Меню фильтруется правом ОДНИМ фильтром для кнопок, справки и текстовых триггеров | `apps/bot/src/menu.ts:148-155`, `:199` |
| Роли рассылки + **легаси-фолбэк** `role='владелец'`/`менеджер` | `apps/bot/src/weekly-digest.ts:56-87` |
| Отказ «получателей нет» → событие + строка в чаты владельца | `apps/bot/src/weekly-delivery.ts:114-131` |
| Мастер с состоянием в памяти и TTL 45 мин | `apps/bot/src/task-done.ts` |
| Зеркало `TaskRow` в боте — рукописное | `apps/bot/src/core-client.ts:61-74` |
| Зеркало `Task` в панели — рукописное | `apps/cc/src/lib/core.ts:1135-1154` |
| Панель `/tasks` берёт ТОЛЬКО `open=1`; группировка по срочности | `apps/cc/src/app/tasks/page.tsx:19`, `:27` |
| Серверные экшены задач панели | `apps/cc/src/app/tasks/actions.ts:80-140` |
| **Тихих часов в репозитории нет** — ни константы, ни настройки | поиск по `apps/bot/src` не даёт ни одного вхождения |

## 3. Рулинги

### R-P7-1…R-P7-5 (контроллер, обязательны)

Приняты как есть и определяют охват:

* **R-P7-1** — из донора переносим ровно две идеи (статус «подтверждено
  менеджером» и веер уведомлений по правам); модуль задач остаётся ОДИН для
  людей и агентов, `owner_kind` — канон, П7 модель не разделяет.
* **R-P7-2** — ключ дедупа моста `<источник>:<сущность>:<дата Ташкента>`,
  совместимый с `task_source_key`; одна задача на автомат в сутки, не на
  позицию; потолок автозадач на прогон — настройка со значением 20.
* **R-P7-3** — права `tasks.assign`/`tasks.confirm` = роли `owner|manager` из
  `person.roles` с фолбэком легаси `role='владелец'` (как в П5b); `tasks.own`
  остаётся у всех.
* **R-P7-4** — источники моста в этом срезе: `machine.low_stock`,
  `vending.refill_detected` без сопоставления, `ourvend.sync_stale` /
  `ourvend.sync_failed_streak`, `vending.shrinkage_alert`; `maintenance.due` —
  после починки моста в «Гигиене» (#16).
* **R-P7-5** — эмитент `task.overdue` заводим (утренний крон), мёртвое правило
  оживает; подтверждение менеджером — статус «подтверждено» + событие
  `task.confirmed` в ленту «Действия».

### R-P7-6 «Подтверждено» — КОЛОНКИ, а не пятое значение `task_status`

**Решение.** R-P7-5 реализуется парой колонок `task.confirmed_at` +
`task.confirmed_by` и **производным** состоянием `confirmed`, которое считает
общий пакет (`taskState()` в `@mydon/shared`) и показывают бот и панель.
Перечисление `task_status` остаётся **четырёхзначным**
(`packages/db/src/schema.ts:29`); в схему добавляется страж-тест, который это
фиксирует.

**Почему.** Пятое значение enum тихо меняет смысл десяти уже написанных
условий, и ни одно из них не сломается компилятором:

| Что сломалось бы | Где | Как именно |
|---|---|---|
| «Открытые» | `apps/core/src/tasks/tasks.service.ts:132-133` | `ne(status,"done")` пропускает `confirmed` → принятая задача снова висит открытой |
| Просроченное | `apps/core/src/tasks/tasks.service.ts:161` | то же — принятая задача попадает в просрочку |
| Свободный пул | `apps/core/src/tasks/tasks.service.ts:417-418` | принятую задачу можно «взять» заново |
| Возвраты на доработку | `apps/core/src/tasks/tasks.service.ts:549-551` | рассылка бьёт по принятым |
| Напоминания о сроке | `apps/core/src/tasks/tasks.service.ts:589-591` | принятая задача снова «скоро срок» |
| Просрочка в брифинге | `apps/core/src/registry/registry.service.ts:203` | число в брифинге растёт от принятых задач |
| **Лента действий** | `apps/core/src/registry/actions.service.ts:231` | `eq(status,"done")` — подтверждённая задача **исчезает** из ленты «✅ Закрыл задачу» |
| Оценка | `apps/core/src/tasks/tasks.service.ts:508-510` | `rate()` требует `status === "done"` → после подтверждения «Переделать» становится невозможным |
| Смена статуса | `apps/core/src/tasks/tasks.service.ts:183-190` | переход `confirmed → done` заново проставил бы `completedAt`/`closedBy` |
| Четыре рукописных зеркала союза | `tasks.controller.ts:6`, `tasks.service.ts:16`, `apps/bot/src/core-client.ts:68`, `apps/cc/src/lib/core.ts:1142` | добавить надо в четырёх местах, забыть — в трёх |

Колонки дают ровно то, чего просит R-P7-5 (отдельное явное состояние, событие,
строка в ленте), и не трогают ни одного из десяти условий. «Подтверждено» —
это не фаза жизненного цикла рядом с «отменено», а **отметка приёмки поверх
закрытия**, ровно как `quality` и `closed_by`, которые уже живут колонками.

**Чем платим, если ошиблись.** Производное состояние надо считать в трёх
местах (shared → бот, панель) вместо одного `status`; зато не платим списком
выше. Если когда-нибудь понадобится именно enum — миграция станет дороже на
десять условий, но эти десять условий придётся править В ЛЮБОМ случае, просто
сегодня их правит не молчаливое расширение, а осознанный срез.

### R-P7-7 Мост живёт в Core и зовёт `ensureForDay` методом

**Решение.** `TaskBridgeService` — провайдер `TasksModule`, один крон
`15 6 * * *` Asia/Tashkent, две работы под своими `catch` (мост T4 и эмитент
`task.overdue` T7). Задачи создаются вызовом `TasksService.ensureForDay(...)`,
не HTTP-маршрутом.

**Почему.** Единственный существующий мост «система → задача» в проде молчит
20 дней (§2.4), и причина, скорее всего, в HTTP-стыке, а не в БД. Вызов метода
убирает из цепочки токен, сеть и `result.errors`; частичный индекс
`task_source_key` при этом остаётся тем же (0040), а проверка «автомат вне
эксплуатации» и запись `audit_log` достаются даром
(`tasks.service.ts:363-399`). Один крон вместо двух — потому что страж
`cron-shutdown.test.ts` описывает сервис с ОДНИМ полем `cron`, а образец
«один таймер, две проверки, раздельные `catch`» уже написан и объяснён в
`apps/core/src/ourvend/sync-stale.service.ts:69-80`.

**Время 06:15 Ташкента.** После монитора ТО (06:00) — чтобы не спорить с ним за
одни и те же ключи; до дайджеста сотрудникам (07:00,
`apps/bot/src/index.ts:526-534`) — чтобы созданная утром задача попала в
сегодняшний дайджест, а не пролежала сутки; до брифинга владельца (07:30) —
чтобы сигнал `task.overdue` дошёл тем же утром.

**Чем платим, если ошиблись.** Мост становится частью процесса Core: его
падение видно в логах Core, а не агентов. Это и есть цель — у Core логи
читаются, у агентов контейнер перезапускается и логи прошлого контейнера
удаляются (опись §1.8).

### R-P7-8 Автозадача рождается СВОБОДНОЙ; `VENDING_ROUTE_ORDER` для назначения не годится

**Решение.** Полевые автозадачи (`machine.low_stock`,
`vending.refill_detected`, `vending.shrinkage_alert`) создаются
`ownerKind: "human"`, `ownerRef: null` — в общий пул. Инфраструктурные
(`ourvend.sync_stale`, `ourvend.sync_failed_streak`) назначаются **первому
активному человеку с правом `tasks.confirm`** (детерминированно: сортировка по
`person.created_at`, затем по `id`); если такого нет — тоже в пул, плюс громкий
`warn` и событие `tasks.no_confirmers`.

**Почему.** «Закрепления сотрудников за объектами нет — все работают по всему
парку, поэтому автосозданная задача рождается без исполнителя и её разбирают.
Это нормальное состояние, а не дефект настройки» — это не мнение спеки, это
докблок над самим пулом (`apps/core/src/tasks/tasks.service.ts:402-407`).
`VENDING_ROUTE_ORDER` назначением людей не является ни в одном месте кода: его
`help` говорит «Первый автомат маршрута получает закуп первым»
(`apps/core/src/system/config-spec.ts:187-193`) — это порядок обхода при
загрузке, а не маршрутный лист исполнителя. Использовать его как «кому
поручить» значило бы завести второй механизм назначения, который никто не
заводил.
Инфраструктурная задача исключение потому, что чинить сбор кабинета полевому
оператору нечем: в пуле она либо провисит, либо будет взята тем, кто не может
её закрыть, — а опись прямо возражает против превращения этих тревог в работу
сотрудника (§3 описи). Компромисс: задача заводится (владелец просил
интеграцию), но у неё есть адресат, который может её закрыть.

**Чем платим, если ошиблись.** Если ролей `owner`/`manager` в проде так и не
проставят (на 25.08 их нет ни у кого, `apps/bot/src/weekly-digest.ts:65-68`),
инфраструктурные задачи лягут в общий пул — и об этом скажет событие
`tasks.no_confirmers`, а не тишина.

### R-P7-9 Веер «выполнена — подтвердите» дедупится ПО ЧЕЛОВЕКУ и заявкой ДО отправки

**Решение.** Ключ `task-confirm:<taskId>:<personId>`, занимается через
`claimNotification` **перед** отправкой. Отправитель — бот, опрос раз в 60 с.
Из списка адресатов исключается тот, кто закрыл задачу (`task.closed_by ===
"person:<его id>"`).

**Почему.** Ключ на всю рассылку заставил бы сбой одного чата лишить
подтверждения всех — этот урок уже записан в `weeklyDigestKey`
(`apps/bot/src/weekly-digest.ts:177-183`). Заявка ДО отправки — потому что цена
дубля («подтвердите» пришло дважды пятерым) выше цены редкой потери: задача
никуда не девается, она видна на экране «ждут подтверждения» (T6) и в панели.
Ровно тот же размен зафиксирован у дайджеста (`apps/bot/src/index.ts:519-522`)
и у недельной сводки (`apps/bot/src/weekly-delivery.ts:20-24`).
Исключение закрывшего — поведение донора («кроме себя», `bot.py:1440-1660`) и
единственное, что мешает менеджеру подтверждать самому себе по пушу.

**Чем платим, если ошиблись.** Падение ровно между заявкой и отправкой стоит
одного непришедшего «подтвердите». Обнаруживается T6-экраном за один взгляд.

### R-P7-10 Пуш «тебе поручили» — своя колонка-отметка, и миграция гасит прошлое

**Решение.** Колонка `task.assign_notified_at`; маршруты
`GET /tasks/assign-unnotified` и `POST /tasks/:id/assign-notified` — зеркало
уже работающей пары `redo-unnotified` / `redo-notified`. Порядок: доставили →
отметили. Миграция **проставляет `assign_notified_at = created_at` всем
существующим строкам с непустым `owner_ref`**.

**Почему.** Без колонки бот не может спросить «кому ещё не сказали» иначе как
перебором всех задач. Пара маршрутов уже существует для возвратов
(`tasks.controller.ts:237-241`, `tasks.service.ts:544-568`) — вторая пара
повторяет проверенную форму, а не изобретает.
Бэкфилл обязателен: в проде есть задача, взятая сотрудником 21.08 и не
доведённая до конца (опись §1.8). Без бэкфилла первый же тик после деплоя
прислал бы ему «📌 Тебе поручили» по работе недельной давности — деплой
превратился бы в рассылку прошлого.

Отметка сбрасывается/ставится ровно в четырёх местах, и все четыре обязаны быть
в одном PR:
`create` с непустым `ownerRef` → NULL (пуш положен);
`edit` при смене `ownerRef` → NULL (новому исполнителю положен);
`claim` (взял сам) → `now()` (говорить человеку то, что он только что сделал,
незачем);
`release` → NULL (вернулась в пул, следующему положен).

**Чем платим, если ошиблись.** Падение между отправкой и отметкой даёт дубль
пуша — тот же размен, что у возвратов на доработку
(`apps/bot/src/index.ts:676-681`).

### R-P7-11 Тихие часы вводим ТОЛЬКО для двух новых пушей

**Решение.** Новый модуль бота `push-hours.ts`: константа
`PUSH_HOURS = { from: 7, to: 22 }` (Ташкент) и функция
`внутриРабочихЧасов(now)`. Ей подчиняются **только** T2 («тебе поручили») и T3
(«выполнена — подтвердите»). Существующие напоминания о сроке и возвраты на
доработку **не трогаются**.

**Почему.** Тихих часов в репозитории нет ни в каком виде (проверено поиском по
`apps/bot/src`) — «по существующим конвенциям» отвечать нечем, конвенцию надо
завести. Заводим её узко: T2 и T3 — это новые пуши по чужому действию (владелец
назначил в 23:40; сотрудник закрыл задачу в полночь), и разбудить ими человека
можно ни за что. Напоминания о сроке трогать нельзя из другой причины: их
поведение сегодня — часть приёмки прошлых срезов, и менять его в срезе про
подтверждение значит менять то, за чем никто не следит в этом PR.
Автозадачи моста под тихие часы не попадают по построению: они рождаются в
06:15 свободными, а свободные разносит дайджест 07:00.

**Чем платим, если ошиблись.** Срочное назначение в 23:00 доедет утром. Для
настоящей срочности есть звонок, а у задачи есть срок.

### R-P7-12 Права проверяются в Core по `actor`, а не только прячутся кнопкой

**Решение.** `tasks.assign` и `tasks.confirm` добавляются в `PERMISSIONS`
(`packages/shared/src/roles.ts:38-52`) и выдаются ролям `manager` и `owner`.
Легаси-фолбэк (`ЛЕГАСИ_РОЛИ`) переезжает из `apps/bot/src/weekly-digest.ts:74-87`
в `@mydon/shared` как `LEGACY_ROLE_MAP` + `effectiveRoles(person)`; бот
начинает звать общую функцию, поведение недельной сводки не меняется.
Core проверяет право по строке `actor` (`owner` | `person:<uuid>`): читает
карточку, считает `can(effectiveRoles(p), perm)`, при отказе — 403.

**Почему.** «Спрятанный кнопкой, но доступный запросом пункт сделал бы всю
модель прав косметикой» — это докблок фильтра меню
(`apps/bot/src/menu.ts:150-153`), и он же требование к Core. Легаси-фолбэк
обязан быть общим, иначе Core и бот разойдутся в ответе на вопрос «кто
менеджер»: на проде роли `owner`/`manager` не проставлены ни у кого, и весь
доступ сегодня держится ровно на легаси-строке `role='владелец'`
(`apps/bot/src/weekly-digest.ts:65-68`).
Честно о границе: `actor` приходит от держателя `SERVICE_TOKEN`, то есть Core
верит боту и панели. Это не сессия и не подпись — это защита от промаха и от
кнопки, а не от злоумышленника с токеном. Так и записываем в докблоке, чтобы
следующий читатель не принял её за аутентификацию.

**Чем платим, если ошиблись.** Пока ролей нет, `tasks.confirm` есть только у
актора `owner` (панель) — то есть ровно сегодняшнее поведение, ничего не
ломается. Как только владелец проставит роль `manager`, экран в боте появится
сам.

### R-P7-13 Мост кладёт потолок на прогон и **выключается настройкой, а не деплоем**

**Решение.** Две настройки в `config-spec.ts`:
`TASK_BRIDGE_ENABLED` (`bool`, fallback `"1"` — **включён**) и
`TASK_BRIDGE_MAX_PER_RUN` (`number`, fallback `"20"`, `inRange(1, 200)`).
Обе с русским `help`. Откат = переключить тумблер в панели, без выката.

**Почему включён по умолчанию.** Владелец просил интеграцию, а выключенный по
умолчанию мост повторил бы ровно ту историю, ради которой затевался срез:
код есть, задач нет, и никто не знает почему. Приёмка T8 без работающего моста
бессмысленна.
**Почему потолок.** Одна опустевшая планограмма даёт событие на КАЖДЫЙ товар:
это уже случалось, и поэтому у алертов стоит `ALERT_MAX_EVENTS = 50`
(`apps/core/src/vending/shrinkage.service.ts:63-72`). Агрегация «одна задача на
автомат в сутки» (R-P7-2) режет основную часть, потолок закрывает остаток.
Обрезка — громкая: `warn` в лог и `capped: true` в событии прогона.

**Чем платим, если ошиблись.** Включённый мост в первые сутки создаёт задачи
без предупреждения. Ожидаемый объём посчитан заранее (§9, шаг 6) и мал;
кнопка выключения — на расстоянии одного сохранения в панели.

## 4. Общие ограничения (действуют на все восемь задач)

* TypeScript strict, без `any`.
* Русский в UI, боте, тестах и документации; идентификаторы — английские.
  Экспортируемые имена общего слоя — латиницей.
* `now` — **параметр**, а не `new Date()` внутри. Существующие
  `overdue()` (`tasks.service.ts:161`) и `dueSoon()` (`:588`) берут стенные часы
  внутри; новые методы (`awaitingConfirmation`, `assignUnnotified`,
  `overdueForEmit`) обязаны принимать `now` — иначе их не проверить фикстурой,
  и мы повторим урок «фикстуры прячут масштаб».
* Время — только `packages/shared/src/tashkent-time.ts` (`tashkentDay`,
  `tashkentDayStartOf`, `TZ`); вторая копия смещения запрещена. Голые сутки —
  `YYYY-MM-DD`.
* Настройки — только через `apps/core/src/system/config-spec.ts` с русским
  `help`; чтение — `readIntSetting` / `settingValue`; база важнее env.
* `@Throttle` — только именованные лимитеры `burst`/`sustained`; `default` не
  существует.
* Мутации — под `ServiceTokenGuard`; чтения — без токена.
* Крон-сервис Core обязан иметь поле `cron`, `onApplicationShutdown` и строку в
  `apps/core/src/cron-shutdown.test.ts`.
* Документация правится ВНУТРИ той задачи, которой она нужна.
* Ноль ≠ «всё хорошо»: пустой список ждущих подтверждения рисуется третьим
  состоянием, а не зелёной галкой.
* Записей в прод нет, кроме миграции (её бэкфилл — часть миграции) и того, что
  мост создаст сам.

## 5. Дизайн по компонентам

Порядок = порядок выполнения. T1 и T5 идут первыми: на них опираются T3, T6, T4.

### T1 — Состояние «подтверждено менеджером» (S, R-P7-5, R-P7-6)

**`packages/db/src/schema.ts`** — две колонки в `task`, рядом с `closedBy`
(`:214`):

```ts
    /**
     * Когда менеджер ПРИНЯЛ работу. Не пятое значение `task_status`
     * НАМЕРЕННО (R-P7-6): десять условий вида `ne(status,"done")` считают
     * любой незнакомый статус открытым, а лента действий (`actions.service`)
     * ищет ровно `eq(status,"done")` — принятая задача исчезла бы из ленты.
     * Приёмка — отметка ПОВЕРХ закрытия, как `quality` и `closed_by`.
     */
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    /** Кто принял: `person:<id>` | `owner`. */
    confirmedBy: text("confirmed_by"),
```

**`packages/shared/src/tasks.ts`** — производное состояние, одно на бота и
панель:

```ts
export type TaskState = "todo" | "in_progress" | "done" | "confirmed" | "cancelled";

/** Что показать человеку. `confirmed` — не статус БД, а приёмка поверх `done`. */
export function taskState(t: { status: string; confirmedAt: string | null }): TaskState;

export const TASK_STATE_LABELS: Record<TaskState, string>; // «Подтверждено» и т.д.
```

**`apps/core/src/tasks/tasks.service.ts`**:

```ts
/**
 * Приёмка работы менеджером (R-P7-5).
 *
 * Идемпотентна: условие `confirmed_at IS NULL` стоит В САМОМ UPDATE — два
 * менеджера, нажавших «Принять» одновременно, дадут одну запись в журнал и
 * одно событие, а не два. Тот же приём, что у `setStatus` и `claim`.
 *
 * `quality` при этом ставится в `accepted`, если оценки ещё не было: у
 * владельца остаётся право поставить `excellent` отдельно, а «принято без
 * оценки» и «не смотрели» перестают выглядеть одинаково.
 */
async confirm(id: string, actorRef: string, now = new Date()): Promise<TaskRow>
```

Внутри одной транзакции: проверка права (T5), `status === "done"` иначе 400
(«Подтвердить можно только сделанную задачу» — тем же текстом, что у `rate`,
`:509`), UPDATE с `confirmed_at`/`confirmed_by`, `audit_log` `task.confirmed`,
`event` `task.confirmed` (см. §7).

**`apps/core/src/tasks/tasks.controller.ts`**:

```ts
export class ConfirmTaskDto {
  /** `owner` | `person:<uuid>` — от него зависит право (R-P7-12). */
  @IsOptional() @IsString() @MaxLength(128)
  actor?: string;
}

@Post(":id/confirm")
@Throttle({ burst: { limit: 12, ttl: 60_000 }, sustained: { limit: 12, ttl: 60_000 } })
confirm(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ConfirmTaskDto) {
  return this.tasks.confirm(id, dto.actor ?? "owner");
}
```

Заодно чинится соседний пробел: `SetQualityDto` (`:123-126`) получает
необязательное поле `actor`, и контроллер начинает его передавать
(`this.tasks.rate(id, dto.quality, dto.actor ?? "owner")`, `:234`). Сегодня
`rate()` умеет актора, но контроллер его не даёт — журнал приписывает владельцу
любую оценку, включая ту, что сделает менеджер из бота в T3.

**`GET /tasks`** — новый фильтр `awaiting=1`: `status='done'`,
`confirmed_at IS NULL`, `ownerKind='human'`, сортировка по `completedAt` вверх
(старейшее ждёт дольше), лимит 100. В контроллере ветка рядом с
`unassigned === "1"` (`:206-208`).

**Зеркала** (`apps/bot/src/core-client.ts:61-74`,
`apps/cc/src/lib/core.ts:1135-1154`) получают `confirmedAt`/`confirmedBy`.

**Бот:** кнопка «👌 Принять» появляется в T3/T6 (общий префикс `tc:`).

### T2 — Пуш «тебе поручили» (S, R-P7-10, R-P7-11)

**Схема:** `task.assignNotifiedAt: timestamp("assign_notified_at", { withTimezone: true })`
с докблоком «отметка ставится ПОСЛЕ доставки; NULL = пуш ещё положен».

**Core:**

```ts
/** Кому ещё не сказали, что на него повесили задачу. Зеркало `redoUnnotified`. */
assignUnnotified(limit = 50): Promise<TaskRow[]>
//  ownerKind='human' AND owner_ref IS NOT NULL
//  AND status IN ('todo','in_progress')
//  AND assign_notified_at IS NULL

async markAssignNotified(id: string, now = new Date()): Promise<void>
```
Маршруты `GET /tasks/assign-unnotified` и `POST /tasks/:id/assign-notified`
(рядом с `redo-unnotified`, `tasks.controller.ts:194-198`, `:237-241`).

Четыре точки сброса/установки (R-P7-10) — в `create`, `edit`, `claim`,
`release`. В `edit` условие точное: отметка гасится, **только если `ownerRef`
реально изменился** (`set.ownerRef !== row.ownerRef`), иначе правка срока
слала бы пуш заново.

**Бот** (`apps/bot/src/index.ts`, рядом с `sendRedoNotices`):

```ts
/**
 * «Тебе поручили»: задача назначена — исполнитель должен узнать сразу, а не
 * в 07:00 дайджестом и не через полчаса напоминанием о сроке.
 *
 * Порядок тот же, что у возвратов: сначала доставка, потом отметка. Вне
 * рабочих часов (R-P7-11) отметка НЕ ставится — пуш ждёт утра.
 */
async function sendAssignNotices(now = new Date()): Promise<void>
```
Текст: `📌 Тебе поручили: <title>` + `dueLabel(t.due)` + `taskKeyboard(t)`.
Недоступен (`TelegramError.isUnreachable`) → `reportUnreachable` + отметка,
чтобы цикл не долбил Telegram (образец `index.ts:695-700`).
Интервал `ASSIGN_NOTIFY_INTERVAL_MS ?? 60_000`.

### T3 — Пуш менеджерам «выполнена — подтвердите» (M, R-P7-9, R-P7-12)

**Core:** `GET /tasks?awaiting=1` (T1) — источник списка. Ничего больше не надо.

**`packages/shared/src/roles.ts`:** `effectiveRoles(p)` и `can(..., "tasks.confirm")`
(T5) дают список адресатов.

**Бот, `apps/bot/src/task-confirm.ts` (новый):**

```ts
/** Кому положено подтверждать: право `tasks.confirm`, активен, есть чат. */
export function confirmRecipients(people: readonly PersonRow[]): PersonRow[];

/** Ключ веера: по ЧЕЛОВЕКУ, а не на рассылку (R-P7-9). */
export function confirmKey(taskId: string, personId: string): string;

/** Текст и кнопки одного «подтвердите». */
export function formatConfirmRequest(t: TaskRow, closerName: string): StaffReply;

/** Разбор нажатия. Префикс `tc:` — своё пространство, `t:` не трогаем. */
export function parseConfirmCallback(
  data: string,
): { id: string; action: "ok" | "redo" } | null; // /^tc:([0-9a-f-]{36}):(ok|redo)$/
```

Текст (по донору, но поверх модели MYDON):

```
🟡 Выполнена: <title>
Закрыл: <имя> · <дата и время по Ташкенту>
Отчёт: <resultNote>
[👌 Принять] [↩ Вернуть в работу]
```

**Петля** в `index.ts` (интервал `CONFIRM_NOTIFY_INTERVAL_MS ?? 60_000`):
взять `awaiting`, взять `people`, для каждой задачи собрать адресатов минус
закрывший (`closed_by === "person:<id>"`), для каждого — `claimNotification`
ДО отправки, отправить.
Адресатов нет → одна строка в чаты владельца + событие `tasks.no_confirmers`
(payload `{ taskId, title }`) + `console.warn` — дословно урок
`weekly-delivery.ts:114-131`. Ключ этого запасного пути тоже занимается:
`task-confirm:<taskId>:owner-fallback`.

**Кнопка «👌 Принять»** → `POST /tasks/:id/confirm { actor: "person:<id>" }`;
отказ 403 → «Подтверждать может менеджер. Попроси владельца проставить роль.»;
успех → исполнителю (если у него есть чат) `✅ Задача принята: <title>. Спасибо!`.

**Кнопка «↩ Вернуть в работу»** → мастер на одну строку (состояние в памяти,
TTL 45 мин, как `task-done.ts`): «Напиши, что не так — исполнитель это увидит»
плюс кнопка «✖️ Отмена». Причина обязательна: `rate(redo)` пишет свой
комментарий «Возвращено на доработку. Прошлый отчёт: …»
(`tasks.service.ts:519-525`), но не объясняет **почему**, а рассылка возвратов
шлёт «детали в комментариях к задаче» (`index.ts:686`) — без причины эта строка
врёт. Затем `POST /tasks/:id/comments { author: "person:<id>", body }` и
`POST /tasks/:id/quality { quality: "redo", actor: "person:<id>" }` — именно в
таком порядке: комментарий должен уже лежать, когда рассылка возвратов (60 с)
позовёт исполнителя смотреть детали.

### T4 — Мост «событие → задача» (L, R-P7-2, R-P7-4, R-P7-7, R-P7-8, R-P7-13)

**`apps/core/src/tasks/task-bridge.service.ts` (новый).**

```ts
/** Тип события → как из него делается задача. Одна таблица — один источник правды. */
interface BridgeSource {
  /** Тип события в ленте. */
  type: string;
  /** Префикс ключа дедупа (R-P7-2): `<источник>:<сущность>:<дата Ташкента>`. */
  key: string;
  /** Что считается «сущностью»: серийник автомата или системный контур. */
  scope: "machine" | "system";
  priority: (payloads: readonly Payload[]) => TaskPriority;
  title: (name: string, payloads: readonly Payload[]) => string;
  description: (name: string, payloads: readonly Payload[]) => string;
  domain: Domain;
}

export const BRIDGE_SOURCES: readonly BridgeSource[] = [ /* пять строк, ниже */ ];
export const BRIDGE_EVENT_TYPES = BRIDGE_SOURCES.map((s) => s.type);

/** Окно чтения ленты: сутки плюс два часа нахлёста на пропущенный тик. */
export const BRIDGE_WINDOW_MS = 26 * 3_600_000;

/** Событие о созданной автозадаче — им же меряется приёмка (T8). */
export const AUTO_CREATED_EVENT = "task.auto_created";
```

**Пять источников (R-P7-4)** — заголовки и описания по-русски, `<Имя>` = имя
автомата из `machineIndex().nameBySerial`:

| Событие | Ключ | Заголовок | Приоритет |
|---|---|---|---|
| `machine.low_stock` | `low_stock:<серийник>:<день>` | `Пополнить <Имя>: заканчивается товар` | `high` |
| `vending.refill_detected` (`recorded === false`) | `refill_unconfirmed:<серийник>:<день>` | `Оформить заливку <Имя>` | `normal` |
| `vending.shrinkage_alert` | `shrinkage:<серийник>:<день>` | `Разобраться с недостачей: <Имя>` | `high` |
| `ourvend.sync_stale` | `sync_stale:system:<день>` | `Сбор OurVend не бежит` | `urgent`, если `hoursSinceSuccess === null`, иначе `high` |
| `ourvend.sync_failed_streak` | `sync_failed:system:<день>` | `Сбор OurVend падает подряд` | `high` |

Описания перечисляют агрегированные позиции, например:
`Заканчивается: Fanta 0,5 (осталось 1), Cola 0,33 (осталось 2). Проверь
планограмму и привези товар.` — не более десяти позиций, дальше `…и ещё N`.

**Дата в ключе — ташкентские сутки САМОГО СОБЫТИЯ**, а не прогона:
`tashkentDay(e.occurredAt)`. Событие в 23:50 попадёт в прогон следующего утра,
и ключ обязан назвать день факта — иначе окно нахлёста создало бы вторую
задачу про вчерашний вечер.

**Прогон:**

```ts
async run(now = new Date()): Promise<BridgeRun>

export interface BridgeRun {
  /** Событий прочитано под типы моста. */
  events: number;
  /** Задач создано (повторный прогон даёт 0). */
  created: number;
  /** Ключей пропущено, потому что задача уже была. */
  skipped: number;
  /** Прогон упёрся в потолок: показано не всё (R-P7-13). */
  capped: boolean;
  /** Выключен настройкой — прогона не было. */
  disabled: boolean;
}
```

Шаги:
1. `TASK_BRIDGE_ENABLED !== "1"` → `{ disabled: true }`, одна строка в лог, выход.
2. `events.list({ types: BRIDGE_EVENT_TYPES, since: now - BRIDGE_WINDOW_MS, limit: 500 })`.
   Лимит 500 безопасен: фильтр типов стоит В SQL, до лимита
   (`events.service.ts:36-43`), а пять типов дают единицы строк в сутки (§2.3).
3. Группировка в `Map<ключ, Payload[]>` — **одна задача на автомат в сутки, а
   не на позицию** (R-P7-2).
4. Резолв `серийник → entityId` через `VendingService.machineIndex()`
   (`firstIdBySerial`); нет карточки — задача создаётся **без** `entityId`, но
   создаётся: имя автомата остаётся в заголовке, и молчать о работе из-за
   дырки в реестре нельзя.
5. Сортировка ключей по приоритету (urgent → low), затем по ключу — чтобы
   потолок резал наименее срочное, а не случайное.
6. `TASK_BRIDGE_MAX_PER_RUN` (20) ключей на прогон; остаток → `capped: true`
   и `warn` со списком неотработанных ключей.
7. На каждый ключ — `tasks.ensureForDay({ ..., source: "<источник>:<сущность>",
   dayKey: "<день>", ownerKind: "human", createdBy: "task-bridge",
   due: следующееУтро(now), priority, entityId, domain })`.
   `null` в ответе = задача на этот день уже есть → `skipped += 1`.
8. Создалась → `events.record({ source: "task-bridge", type: AUTO_CREATED_EVENT,
   payload: { taskId, key, eventType, serial, entityId, day } })`.

**`следующееУтро(now)`** — завтрашние ташкентские сутки + 10 часов
(`tashkentDayStartOf(now) + 24 ч + 10 ч`). Отдельная экспортируемая функция:
её проверяет тест на границе суток, а не глазами.

**Что достаётся от `ensureForDay` даром** и почему это правильный вызов:
проверка «автомат вне эксплуатации» (`tasks.service.ts:363-375`) — списанному
автомату задачу не ставим; `onConflictDoNothing({ target: task.source })` —
ставку делает БД, а не select-then-insert; `audit_log` `task.create` с
`actorKind: "system"`.

**Регистрация:** `TasksModule` получает `imports: [MaintenanceModule,
EventsModule, RulesModule, VendingModule]` и провайдер `TaskBridgeService`.
Циклов нет: `TasksModule` не импортирует никто, кроме `app.module.ts:76`, а
`VendingModule` тянет только `ApprovalsModule` → `AuditModule` + `EventsModule`
(`apps/core/src/vending/vending.module.ts:35`,
`apps/core/src/approvals/approvals.module.ts:7-12`).

**Настройки** (`apps/core/src/system/config-spec.ts`, новый блок «Задачи»):

```ts
  // ── Задачи: мост «событие → задача» (П7, R-P7-13) ──
  {
    key: "TASK_BRIDGE_ENABLED",
    label: "Задачи: мост «событие → задача»",
    kind: "bool",
    fallback: "1",
    help: "1 — утром 06:15 события парка превращаются в задачи (заканчивается товар, "
      + "заливка без отчёта, недостача, сбор OurVend). 0 — мост молчит, задачи ставятся руками. "
      + "Это и есть откат: выключать деплоем не нужно.",
    validate: oneOf(["0", "1"]),
  },
  {
    key: "TASK_BRIDGE_MAX_PER_RUN",
    label: "Задачи: потолок автозадач за один прогон",
    kind: "number",
    fallback: "20",
    help: "Сколько задач мост создаёт за одно утро. Опустевшая планограмма даёт событие на КАЖДЫЙ "
      + "товар: без потолка одно утро родило бы сотню задач. Обрезка пишется в лог и в событие прогона.",
    validate: inRange(1, 200),
  },
```

`inRange` уже есть (`config-spec.ts:63-70`), `oneOf` — тоже (`:28-31`).
Булев тумблер читается явно:
`(await settingValue(db, "TASK_BRIDGE_ENABLED")).trim() === "1"` — потому что
`settingValue` возвращает `""` для неизвестного ключа, и «пусто = включено»
было бы ложью. Фолбэк `"1"` отдаёт сам резолвер (`resolveEffective`).

### T5 — Права `tasks.assign` / `tasks.confirm` (S, R-P7-3, R-P7-12)

**`packages/shared/src/roles.ts`:**

```ts
export const PERMISSIONS = [
  "tasks.own",
  "tasks.assign",   // назначать задачи другим и переназначать
  "tasks.confirm",  // принимать выполненное и возвращать в работу
  // …остальные без изменений
] as const;
```
`manager` и `owner` получают оба права; `BASELINE` остаётся `["tasks.own"]`.

Легаси-фолбэк переезжает сюда из бота:

```ts
/**
 * Легаси-поле `person.role` — свободный текст, которым владельца пометили ДО
 * появления массива `roles`. На проде (25.08.2026) ролей owner/manager нет ни
 * у кого, а владелец помечен ровно так: `role='владелец'`. Требовать один
 * `roles` значило бы не дать право подтверждения НИКОМУ.
 *
 * Живёт в общем пакете, а не в боте: по этой карте теперь считает и Core
 * (`POST /tasks/:id/confirm`), и разошедшиеся ответы на вопрос «кто менеджер»
 * дали бы кнопку, которую Core отвергает 403-м.
 */
export const LEGACY_ROLE_MAP: ReadonlyMap<string, StaffRole>;

/** Роли карточки: массив `roles` плюс легаси-текст `role`. */
export function effectiveRoles(p: { roles?: readonly string[] | null; role?: string | null }): StaffRole[];
```
`apps/bot/src/weekly-digest.ts:74-87` удаляет свои копии и зовёт общие —
поведение недельной сводки не меняется, что закрепляется её существующими
тестами (`apps/bot/src/weekly-digest.test.ts:173-201`).

**Core, `TasksService`:**

```ts
/**
 * Право актора на действие. `actor` приходит от держателя SERVICE_TOKEN, то
 * есть от бота или панели: это защита от промаха и от кнопки, а НЕ
 * аутентификация. Так и читать.
 */
private async assertCan(actorRef: string, perm: Permission): Promise<void>
```
`owner` — всегда можно; `person:<uuid>` — карточка + `can(effectiveRoles(p), perm)`;
карточки нет или `active !== "yes"` — `ForbiddenException`
(«Это может менеджер. Попроси владельца проставить роль.»).
Применяется в `confirm()` и `rate()` (право `tasks.confirm`) и в `edit()` —
**только когда меняется `ownerRef`** (право `tasks.assign`).

**Бот:** пункт меню «🧾 Ждут подтверждения» с `perm: "tasks.confirm"`
(T6) — фильтр `menuFor` прячет его сам (`menu.ts:154`), и текстовый триггер
прячется тем же фильтром (`:199`), поэтому «спрятано кнопкой, доступно словом»
не возникает.

**Панель:** блок «Ждут подтверждения» показывается всегда (панель = владелец),
экшены зовут Core как `actor: "owner"` — сегодняшнее поведение.

### T6 — Экран «ждут подтверждения» в боте и блок в панели (M)

**Бот.** Пункт меню в `STAFF_MENU` (`apps/bot/src/menu.ts`), ряд «редкое»:

```ts
  { id: "confirm", label: "🧾 Ждут подтверждения", perm: "tasks.confirm", ready: true,
    match: (t) => /^(ждут подтвер|подтвержд|на подтвержд|приёмк|приемк)/i.test(t.trim()) },
```
Значок «🧾», не «📋» и не «✅»: первый занят «Мои задачи» (`menu.ts:77`), второй
— кнопкой «Выполнил»; оператор сканирует меню по эмодзи, и один символ на два
пункта провоцирует промах (правило уже записано у «🧮» и «🍫», `menu.ts:129`,
`:137-141`).

Экран: `GET /tasks?awaiting=1` → нумерованный список (заголовок, кто закрыл,
когда, первая строка отчёта), клавиатура по образцу `tasksKeyboard`
(`staff.ts:145-159`), у каждой строки — пара `tc:<id>:ok` / `tc:<id>:redo`.
Пусто → третье состояние: «Ничего не ждёт приёмки. Как только кто-то закроет
задачу, она появится здесь.»

**Панель.** `apps/cc/src/app/tasks/page.tsx` тянет второй список:

```ts
const [open, awaiting, people, agents] = await Promise.all([
  core.tasks({ open: "1" }),
  core.tasks({ awaiting: "1" }),
  core.people(),
  core.agents(),
]);
```
Блок «Ждут подтверждения» рисуется **над** группами срочности (это то, что
требует решения сейчас), с счётчиком и парой кнопок в строке. Новый серверный
экшен рядом с `rateTask` (`apps/cc/src/app/tasks/actions.ts:96`):

```ts
/** Приёмка работы. «Переделать» живёт отдельно — это rateTask(id, "redo"). */
export async function confirmTask(id: string): Promise<ActionResult>
```
с `revalidatePath("/tasks")`, `/tasks/${id}`, `/team`.
Кнопки — не форма, поэтому конвенция мутирующих форм (CLAUDE.md) применяется в
её сути: вызов в `startTransition`, при `res.ok` — `router.refresh()`, при
отказе — `setError(res.message)`.
Карточка `apps/cc/src/app/tasks/[id]/page.tsx` печатает строку
«Принято: <кто>, <когда>» когда `confirmedAt` есть.

### T7 — Эмитент `task.overdue` (S, R-P7-5)

Живёт во второй половине `TaskBridgeService.run` — своей работой под своим
`catch` (образец `sync-stale.service.ts:74-80`):

```ts
/**
 * Просрочка → событие `task.overdue`, раз в ташкентские сутки на задачу.
 *
 * ПОЧЕМУ СО ВТОРОГО ДНЯ. Бот уже шлёт владельцу «⏰ Просрочено» один раз на
 * задачу (`index.ts:625-634`, отметка `reminded_at` ставится навсегда).
 * Эмитить с первого дня значило бы дать владельцу два сообщения об одном и
 * том же в одно утро. Граница — `due < начало сегодняшних ташкентских суток`:
 * первый день просрочки принадлежит боту, второй и дальше — правилу.
 *
 * ПОТОЛОК. Правило `task.overdue` — `immediate` (`rules.ts:358`), то есть
 * каждое событие превращается в отдельное сообщение владельцу. Двадцати
 * хватает, чтобы понять масштаб; двадцать первое читать уже не будут.
 */
export const OVERDUE_MAX_EVENTS = 20;

async emitOverdue(now = new Date()): Promise<{ emitted: number; capped: boolean }>
```

Выборка: `due IS NOT NULL AND due < tashkentDayStartOf(now) AND status NOT IN
('done','cancelled')`, сортировка по `due` вверх (старейшее первым), лимит
`OVERDUE_MAX_EVENTS + 1` — чтобы `capped` был фактом, а не догадкой.
Дедуп — `RulesService.claim("task-overdue:<день>:<taskId>")`: атомарная заявка
через уникальный ключ `notification_delivery` (`rules.service.ts:56-73`),
а не скан ленты. Скан ленты в Core уже есть у алертов и сторожей, но там дедуп
идёт по составному payload; здесь ключ известен заранее, и RETURNING точнее.
Payload события: `{ taskId, title, due, ownerRef, daysOverdue }` — `title`
обязателен, его печатает правило (`rules.ts:362`).

Правило `task.overdue` **не трогаем**: оно уже написано, уже в
`RULE_EVENT_TYPES` (выводится из `RULES`, `rules.ts:601`) и с сегодняшнего дня
перестаёт быть мёртвым.

**Строка в брифинге.** `GET /registry/briefing` уже считает `overdueTasks`
(`registry.service.ts:200-208`) и бот её печатает — менять ничего не нужно;
в приёмке проверяем, что число и поток сигналов сходятся.

### T8 — Контрольный замер в проде (S, только чек-лист)

Кода нет. Это пункт §9 (шаг 8) и условие приёмки среза: если через трое суток в
`task` нет ни одной строки с автосозданным `source` при непустой ленте событий
— срез **не принят**, и разбирается он как дефект, а не как «работ не подошло».
Прямая страховка от повторения §2.4.

## 6. Данные и миграции

* **Одна миграция, номер — СЛЕДУЮЩИЙ СВОБОДНЫЙ.** На момент письма последняя в
  `packages/db/drizzle/` — `0071_stock_count_retention_idx.sql`, то есть номер
  `0072`. Срез П6 идёт параллельно и может занять `0072` первым — тогда наш
  файл называется `0073`. Перед `pnpm db:generate` обязателен
  `ls packages/db/drizzle | tail -3`; при коллизии номер чинится
  **переименованием нашего файла и перегенерацией снапшота**, а не правкой чужого.
  Страж на это уже есть в CI: миграции прогоняются против настоящего Postgres в
  smoke-цепочке, и дубль номера в `meta/_journal.json` уронит шаг `migrate.js`
  до тестов.

  Содержимое (`0072_task_confirmation.sql`, имя от смысла, не от номера):

  ```sql
  ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "confirmed_at" timestamp with time zone;
  ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "confirmed_by" text;
  ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "assign_notified_at" timestamp with time zone;

  -- Бэкфилл (R-P7-10): у ВСЕХ существующих назначенных задач пуш «тебе
  -- поручили» считается уже сделанным. Без этой строки первый тик после
  -- деплоя разошлёт людям работу недельной давности как новую.
  UPDATE "task"
     SET "assign_notified_at" = "created_at"
   WHERE "owner_ref" IS NOT NULL
     AND "assign_notified_at" IS NULL;

  -- Индекс под опрос «кому ещё не сказали»: частичный, потому что строк с
  -- NULL всегда единицы, а таблица растёт автозадачами.
  CREATE INDEX IF NOT EXISTS "task_assign_pending_idx"
      ON "task" ("owner_ref")
   WHERE "assign_notified_at" IS NULL AND "owner_ref" IS NOT NULL;

  -- Индекс под «ждут подтверждения»: тот же приём.
  CREATE INDEX IF NOT EXISTS "task_awaiting_idx"
      ON "task" ("completed_at")
   WHERE "confirmed_at" IS NULL;
  ```

  `IF NOT EXISTS` — защитный паттерн 0067/0069/0070/0071.
  `CONCURRENTLY` не используется: мигратор идёт в транзакции, и `CONCURRENTLY`
  в ней запрещён — он повесил бы автодеплой молча (объяснение уже записано в
  `packages/db/drizzle/0070_retention_time_idx.sql`).
  Оба индекса регистрируются в `packages/db/src/schema.ts` в списке индексов
  `task` (`:227-243`), снапшот обновляется `pnpm db:generate`.

* **Перечисления не меняются.** `taskStatusEnum` остаётся четырёхзначным
  (R-P7-6) — и это закрепляется стражем в
  `packages/db/src/schema.test.ts` (блок «Перечисления схемы и словари», `:152`):

  ```ts
  it("СТРАЖ: task_status остаётся ЧЕТЫРЁХЗНАЧНЫМ (R-P7-6)", () => {
    assert.deepEqual([...mod.taskStatusEnum.enumValues].sort(),
      ["cancelled", "done", "in_progress", "todo"]);
  });
  ```
  Докблок теста перечисляет десять условий из таблицы R-P7-6 — чтобы тот, кто
  придёт добавлять пятое значение, увидел цену до, а не после.

* **Записей в прод руками нет.** Бэкфилл — внутри миграции, её применяет
  автодеплой. Всё остальное создаёт мост сам.

## 7. События и правила

| Тип | Кто пишет | Правило | Почему так |
|---|---|---|---|
| `task.confirmed` | `TasksService.confirm` | **нет** | приёмка — не тревога; исполнителю о ней говорит бот адресно (T3), владельцу видно в ленте «Действия». Правило `immediate` превратило бы каждое «👌 Принять» в сообщение владельцу о его же решении |
| `task.auto_created` | `TaskBridgeService` | **нет** | свободные задачи уже разносит дайджест 07:00 (`staff-digest.ts`), и правило дало бы второе оповещение о том же |
| `task.overdue` | `TaskBridgeService.emitOverdue` (T7) | **есть, существующее** `rules.ts:358-363`, `immediate` | правило было написано без эмитента; срез его оживляет, а не заводит новое |
| `tasks.no_confirmers` | бот, `task-confirm.ts` | **новое**, `immediate` | зеркало `weekly-digest.no_recipients`: отказ рассылки виден только тому, кто читает логи контейнера, — то есть никому |

Правило-новичок:

```ts
  {
    id: "tasks.no_confirmers",
    eventType: "tasks.no_confirmers",
    urgency: "immediate",
    format: (c) =>
      `🟡 Задача «${str(c.payload.title)}» выполнена, но подтвердить её некому: ` +
      `ни у кого нет роли «Менеджер» или «Владелец» с привязанным Telegram. ` +
      `Проставь роль в карточке сотрудника.`,
  },
```
Запись в `RULE_EVENT_TYPES` руками не нужна — список выводится из `RULES`
(`rules.ts:601`); урок П5b N5 («правило без записи не подберётся
`/rules/pending`») здесь закрыт по построению, но проверяется тестом.

**Лента «Действия»** (`apps/core/src/registry/actions.service.ts`): новый вид
`task_confirmed`.

```ts
// рядом с выборкой `done` (:223-233)
.select({ at: task.confirmedAt, by: task.confirmedBy, title: task.title })
.where(and(isNotNull(task.confirmedAt), gte(task.confirmedAt, lo), lt(task.confirmedAt, hi)))
// …
push(r.at, "task_confirmed", personIdOf(r.by), `👌 Принял работу: ${r.title}`);
```
Существующая выборка `task_done` (`:231`, `eq(task.status, "done")`) **не
меняется** — и это прямое следствие R-P7-6: подтверждённая задача остаётся
`done`, поэтому её закрытие из ленты не исчезает.

## 8. Тесты

Стиль по пакетам: Core — `node:test` + `assert`, стабы БД в самом файле; бот —
`node:test`; панель — `vitest` + Testing Library; shared —
`packages/shared/src/*.test.ts`. Имена — по-русски.

### T1
`apps/core/src/tasks/tasks.test.ts`:
* «подтвердить можно только сделанную задачу — у `todo` отказ 400»;
* «повторное подтверждение не создаёт второй записи в журнале» (условие
  `confirmed_at IS NULL` внутри UPDATE);
* «подтверждение НЕ меняет `status` — задача остаётся `done`» (прямая проверка
  R-P7-6);
* «подтверждение проставляет `quality=accepted`, если оценки не было, и не
  затирает `excellent`»;
* «`POST /tasks/:id/quality` передаёт актора в журнал» (регрессия на
  `tasks.controller.ts:234`);
* «`awaiting=1` отдаёт только `done` без `confirmed_at`, старейшее первым».

`packages/shared/src/tasks.test.ts`:
* «`taskState`: `done` + `confirmedAt` = `confirmed`, `done` без него = `done`»;
* «`taskState` не выдумывает состояний для `cancelled`».

`packages/db/src/schema.test.ts`:
* «СТРАЖ: `task_status` остаётся четырёхзначным (R-P7-6)»;
* «у `task` есть `confirmed_at`, `confirmed_by`, `assign_notified_at`».

### T2
`apps/core/src/tasks/tasks.test.ts`:
* «назначенная задача попадает в `assign-unnotified`, свободная — нет»;
* «`claim` гасит пуш: взял сам — рассказывать нечего»;
* «`edit` со сменой исполнителя сбрасывает отметку, `edit` со сменой срока — нет»;
* «`release` возвращает отметку в NULL».

`apps/bot/src/tasks-push.test.ts` (новый):
* «доставили → отметили; при сбое Telegram отметки нет»;
* «заблокировал бота: жалоба владельцу и отметка, чтобы цикл не долбил»;
* «вне рабочих часов пуш не уходит и отметка не ставится» (R-P7-11).

### T3
`apps/bot/src/task-confirm.test.ts` (новый):
* «адресаты: роль `manager`/`owner` ИЛИ легаси `role='владелец'`, активен, есть чат»;
* «закрывший задачу себе «подтвердите» не получает»;
* «ключ веера — по человеку: сбой одного чата не лишает остальных»;
* «адресатов нет — уходит событие `tasks.no_confirmers` и строка владельцу»;
* «`parseConfirmCallback`: чужой префикс и битый uuid отвергаются»;
* «возврат в работу без причины не отправляется — мастер ждёт строку».

### T4
`apps/core/src/tasks/task-bridge.test.ts` (новый):
* «три события `machine.low_stock` по одному автомату за сутки дают ОДНУ задачу»
  (R-P7-2);
* «два автомата — две задачи»;
* «повторный прогон по тем же событиям создаёт 0 задач» (идемпотентность через
  `task_source_key`);
* «ключ берёт ташкентские сутки СОБЫТИЯ: событие 23:50 и прогон в 06:15 дают
  вчерашний день»;
* «потолок 20: двадцать первый ключ не создаётся, `capped: true`, в логе — список»;
* «`TASK_BRIDGE_ENABLED=0` — прогона нет, `disabled: true`»;
* «автомат вне эксплуатации задачи не получает» (через `ensureForDay`);
* «нет карточки реестра по серийнику — задача создаётся без `entityId`, но
  создаётся»;
* «`ourvend.sync_stale` с `hoursSinceSuccess: null` даёт `urgent`»;
* «инфраструктурная задача уходит первому менеджеру; менеджеров нет — в пул +
  предупреждение»;
* «`следующееУтро`: прогон 26.08 06:15 даёт срок 27.08 10:00 по Ташкенту»;
* «на каждую созданную задачу пишется `task.auto_created`».

`apps/core/src/system/config-spec.test.ts`:
* «`TASK_BRIDGE_MAX_PER_RUN`: 0 и 201 отвергаются, 20 принимается»;
* «`TASK_BRIDGE_ENABLED`: только 0 и 1».

`apps/core/src/cron-shutdown.test.ts`: строка
`["task-bridge", () => new TaskBridgeService(…)]` — крон останавливается и
освобождает event loop.

### T5
`packages/shared/src/roles.test.ts`:
* «`manager` может назначать и подтверждать, `operator` — нет»;
* «`tasks.own` остаётся у сотрудника без ролей»;
* «`effectiveRoles`: легаси `role='владелец'` даёт `owner`, мусор — ничего».

`apps/core/src/tasks/tasks.test.ts`:
* «`confirm` от оператора — 403»;
* «`confirm` от `owner` — можно»;
* «`edit` со сменой исполнителя от оператора — 403, без смены — можно».

`apps/bot/src/menu.test.ts`:
* «пункт «Ждут подтверждения» не виден оператору ни кнопкой, ни словом».

`apps/bot/src/weekly-digest.test.ts` — существующие тесты получателей должны
остаться зелёными БЕЗ правок: это и есть доказательство, что переезд
легаси-карты в `@mydon/shared` поведения не изменил.

### T6
`apps/cc/src/components/awaiting-block.test.tsx` (по месту компонента):
* «блок «Ждут подтверждения» показывает задачу и обе кнопки»;
* «пусто — третье состояние, а не зелёная галка»;
* «отказ Core оставляет текст ошибки и не гасит список».

`apps/bot/src/task-confirm.test.ts`:
* «экран печатает нумерованный список и пару кнопок на строку»;
* «пустой экран говорит «ничего не ждёт приёмки»».

### T7
`apps/core/src/tasks/task-bridge.test.ts`:
* «задача, просроченная СЕГОДНЯ, события не даёт — первый день за ботом»;
* «задача, просроченная вчера, даёт событие один раз в сутки»;
* «повторный прогон в те же сутки события не даёт (ключ занят)»;
* «двадцать первая просрочка не эмитится, `capped: true`»;
* «`done` и `cancelled` не эмитятся».

`apps/core/src/rules/rules.test.ts`:
* «`task.overdue` и `tasks.no_confirmers` есть в `RULE_EVENT_TYPES`» — иначе
  `/rules/pending` их не подберёт (урок П5b N5).

### Дымовые
`tools/smoke-core.mjs`:
* существующий шаг `"/tasks"` (`:481`) дополняется проверкой, что у строки
  есть ключи `confirmedAt` и `assignNotifiedAt` — форма ответа должна доехать
  до зеркал;
* новые шаги `GET /tasks?awaiting=1` и `GET /tasks/assign-unnotified` — оба
  обязаны отдавать массив (на засеянной базе пустой).

`tools/smoke-panel.mjs`: шаг `{ path: "/tasks", должно: "Ждут подтверждения" }`.

**Полный прогон перед PR:** `pnpm -s lint && pnpm -s typecheck && pnpm -s build && pnpm -s test`;
smoke на scratch-БД: `createdb → migrate.js → seed.js → seed-vending.js →
smoke-core.mjs → smoke-panel.mjs → dropdb`. Миграция обязана пройти на базе,
где `task` НЕ пуста, — иначе бэкфилл `assign_notified_at` не проверен ничем.

## 9. Выкатка и чек-лист

1. Ветка `feat/p7-tasks` от свежего `main`. Первой командой после переключения
   на `main` — создание ветки: фолбэк вида `|| git push` молча отправляет `main`
   в прод, а автодеплой ходит каждые 2 минуты.
2. Перед `db:generate` — `ls packages/db/drizzle | tail -3`. Номер занят П6 →
   переименовать свой файл и перегенерировать снапшот.
3. PR → CI зелёный (lint, typecheck, build, test, smoke-цепочка) →
   adversarial-ревью → squash-мерж.
4. Дождаться деплоя и сверить, что выкачено ИМЕННО это: `GET /health` → `commit`
   совпадает с мержем (каталог обновляется за секунды, образ собирается минуты).
   Миграция применяется автодеплоем.
5. Сразу после деплоя (до первого крона в 06:15) — проверить бэкфилл:
   ```sql
   select count(*) from task where owner_ref is not null and assign_notified_at is null;
   ```
   Должен быть **0**. Не ноль — миграция не доехала, и утром люди получат пуши
   по старым задачам; чинить до наступления следующего утра.
6. **Ожидаемый объём первых суток.** По 14-суточному замеру ленты (опись §3):
   `machine.low_stock` 3 события / 14 сут, `vending.refill_detected` 7 / 14,
   `vending.shrinkage_alert` 0, `ourvend.sync_stale` 0,
   `ourvend.sync_failed_streak` 0. После агрегации «одна задача на автомат в
   сутки» это **0–3 автозадачи в первое утро**, наиболее вероятно 1–2.
   Ноль в первое утро — законный результат (события идут не каждый день), и
   поводом для тревоги он становится только вместе с шагом 8.
   Потолки сверху: 20 задач на прогон (`TASK_BRIDGE_MAX_PER_RUN`) и «одна на
   автомат в сутки» — то есть даже полная авария сбора даёт не больше
   «автоматы со свежей планограммой + 2».
   Больше 20 в первое же утро = обрезка (`capped: true`), и это сигнал
   разбираться, а не поднимать потолок.
7. Проверка витрин в тот же день:
   * `GET /tasks?awaiting=1` — массив (пустой законен);
   * панель `/tasks` — блок «Ждут подтверждения» на месте, кнопки работают;
   * бот у владельца — пункт «🧾 Ждут подтверждения» виден; у оператора — нет;
   * назначить себе тестовую задачу из панели → в течение минуты приходит
     «📌 Тебе поручили»;
   * закрыть её в боте → приходит «🟡 Выполнена … подтвердите» → «👌 Принять»
     → в ленте `/team/actions` появляется «👌 Принял работу».
8. **T8 — контрольный замер через 3 суток (только чтение, Р5 описи).**
   ```sql
   select split_part(source, ':', 1) as источник, count(*)
     from task
    where source ~ ':[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      and source not like 'maint:%'
    group by 1 order by 2 desc;

   select count(*) from event where type = 'task.auto_created';

   select count(*) filter (where confirmed_at is not null)::float
        / nullif(count(*), 0) as доля_подтверждённых
     from task where status = 'done';
   ```
   Приёмка: если `task.auto_created` **ноль**, а события источников за эти трое
   суток в ленте **есть**, — срез не принят, разбираем как дефект (это ровно
   §2.4, повторённая на новом мосту). Если событий-источников тоже ноль —
   мост исправен, а парк молчит: это отдельный вопрос к сбору, не к П7.
   Доля подтверждённых меряется как база: на четырёх ручных задачах она
   бессмысленна, но следующий замер будет с чем сравнивать.
9. Память и план: `docs/PLAN_STOCK_ABSORPTION.md` §П7 (`:363-368`) —
   переписать: модуль задач ЕСТЬ, донор пуст, срез достроил мост и
   подтверждение; «Гигиена» (#16) остаётся отдельной строкой про монитор ТО.

**Документация — внутри задач, которым она нужна:**
* `docs/DATA_SOURCES.md` — новый абзац «Задачи из событий»: пять источников,
  ключ `<источник>:<сущность>:<дата Ташкента>`, крон 06:15, обе настройки, где
  смотреть (`task.source`, событие `task.auto_created`).
* `docs/DEPLOY.md` — шаг 5 (проверка бэкфилла) и абзац «Откат моста задач»:
  тумблер `TASK_BRIDGE_ENABLED=0` в панели настроек, деплой не нужен.
* **`docs/AGENTS.md` в репозитории НЕТ** (проверено: есть только
  `docs/AGENTS_ACTIVATION.md`). Рунбук про новые кроны и петли бота пишем в
  `docs/AGENTS_ACTIVATION.md` — разделы «Кроны Core» (06:15 мост + просрочка) и
  «Петли бота» (пуш назначения, веер подтверждения, их интервалы). Заводить
  второй файл-рунбук ради одного среза не будем.

## 10. Вне охвата

| Пункт | Почему |
|---|---|
| Починка монитора графиков ТО | «Гигиена», задача #16 (Р5 описи); П7 на неё ссылается и строит свой мост НЕ поверх её HTTP-пути (R-P7-7) |
| `maintenance.due` как источник моста | R-P7-4: после починки «Гигиены», иначе продублируем `ensure-for-day` монитора |
| `machine.idle` / `machine.offline` | не в списке R-P7-4; за 14 суток 0 событий, правила `immediate` уже есть — трогать без данных незачем |
| Задачи вокруг инкассации | у `collection` свой двухшаговый контур `collected → received` с `manager_ref`; задача его продублирует и разведёт учёт (Р6 описи) |
| Задачи из плана закупа по расписанию | `GET /vending/plan` живёт по запросу владельца, крона нет; еженедельная задача — отдельное решение |
| Тип задачи (`kind` донора) | избыточно при `domain` + `entity_id` + `source`; группировка сознательно сделана по объекту (`staff-digest.ts`) |
| EAV-конструктор полей задач | П6 и только при доказанной потребности |
| Гранулярные права сверх двух (`tasks.assign`, `tasks.confirm`) | R-P7-3 называет ровно два; третье право без третьего сотрудника — косметика |
| Перенос таблицы `tasks` донора и её веб-формы | 0 строк за всю историю, панель MYDON сильнее (R-P7-1, Р6 описи) |
| Флаги `can_tasks`/`daily_report`/`weekly_report` колонками | у MYDON роли; второй механизм прав плодить нельзя |
| Тихие часы для существующих напоминаний и возвратов | R-P7-11: их поведение — приёмка прошлых срезов, меняется отдельно |
| Схлопывание рукописных зеркал `TaskRow`/`Task` в `@mydon/shared` | правильно и напрашивается, но это правка бота, панели и Core разом ради формы, а не ради вопроса владельца; в П7 зеркала просто получают новые поля |
| Read-token для GET | П8 п. 3–5, вместе с гашением `STOCK_DATABASE_URL` |

## 11. Открытые вопросы

Нет. Все восемь задач закрываются кодом, не требуют решений владельца и
опираются на факты, перепроверенные в рабочем дереве на `origin/main` b3b595d.
Единственная зависимость от владельца — проставить роль «Менеджер» хоть кому-то,
и она **не блокирует срез**: до тех пор подтверждает владелец из панели
(легаси-фолбэк `role='владелец'`, R-P7-12), а отсутствие адресатов веера
говорит о себе событием `tasks.no_confirmers`, а не тишиной.
