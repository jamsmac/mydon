# П7 «Задачи» — план реализации (8 задач: подтверждение, уведомления, мост событие → задача)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Модуль задач перестаёт быть пустым: у восьми вопросов владельца из §1 спеки появляется ответ в коде, а не в голове. «Приняли или просто закрыли» становится отметкой `confirmed_at`/`confirmed_by` и событием в ленте «Действия»; назначенная задача доходит пушем в минуту, а не дайджестом в 07:00; закрытая — веером менеджерам с кнопками «Принять» и «Вернуть в работу»; пять типов событий парка каждое утро в 06:15 превращаются в задачи вызовом `TasksService.ensureForDay` внутри Core (а не HTTP-стыком, на котором молчит монитор ТО); мёртвое правило `task.overdue` получает эмитента; права `tasks.assign`/`tasks.confirm` появляются в матрице и проверяются в Core по актору, а не прячутся кнопкой; «ждут подтверждения» получает экран в боте и блок в панели; и всё это меряется в проде через трое суток запросом, который либо показывает автозадачи, либо объявляет срез непринятым.

**Architecture:** Ничего нового там, где есть готовое. «Подтверждено» — ДВЕ КОЛОНКИ поверх `done`, а не пятое значение `task_status` (R-P7-6): десять существующих условий вида `ne(status,"done")` и `eq(status,"done")` остаются нетронутыми, а производное состояние считает одна функция `taskState()` в `@mydon/shared`. Мост живёт провайдером `TasksModule` и зовёт `ensureForDay` МЕТОДОМ — идемпотентность даёт тот же частичный индекс `task_source_key` (0040), проверку «автомат вне эксплуатации» и запись в `audit_log` он получает даром, а из цепочки уходят токен, сеть и `result.errors`. Крон один (`15 6 * * *`, `croner`, `timezone: TZ`), работ в нём две, каждая под своим `catch` — образец `sync-stale.service.ts:69-80`. Пуш «тебе поручили» — зеркало уже работающей пары `redo-unnotified`/`redo-notified` со своей колонкой-отметкой и бэкфиллом в миграции. Веер «подтвердите» дедупится ключом ПО ЧЕЛОВЕКУ через `claimNotification`, занятый ДО отправки (урок `weeklyDigestKey`). Легаси-карта ролей переезжает из бота в `@mydon/shared`, чтобы Core и бот отвечали одинаково на вопрос «кто менеджер».

**Tech Stack:** TypeScript strict, NestJS + class-validator, Drizzle/Postgres (**одна миграция — три колонки, два частичных индекса и бэкфилл**), `croner` с `timezone: TZ`, `node:test` по dist (core/bot/db/shared) + vitest (cc), Testing Library, `tools/smoke-core.mjs` против живого Postgres и `tools/smoke-panel.mjs` против поднятой панели, Telegram-бот, Next.js App Router.

**Spec:** `docs/superpowers/specs/2026-08-26-p7-tasks-design.md` (рулинги R-P7-1…R-P7-13)
**Опись:** `.superpowers/sdd/2026-08-26-sloy-p7-tasks/inventory.md` — каталог `.superpowers/` не версионируется; в worktree `mydon-p7` он есть только как незакоммиченный каталог, опись читается оттуда.

**База ветки:** `feat/p7-tasks` = `origin/main` **b3b595d** (#217, «Хвосты снек-контура») + коммит спеки **112612d**. Все цитаты строк ниже сверены в ЭТОМ дереве.

## Порядок и параллельные волны

План рассчитан на параллельных исполнителей. Порядок задач — НЕ порядок §5 спеки: сначала кладутся общие контракты (права T5, колонки T1), потом их потребители. Внутри волны файлы не пересекаются ни разу — матрица пересечений в «Самопроверке».

| Волна | Задачи | Почему вместе / почему не раньше |
|---|---|---|
| 1 | **Task 1 (T5)** | Права — общий слой. `PERMISSIONS` с `tasks.confirm` нужны и мосту (T4 назначает инфраструктурную задачу первому менеджеру), и `confirm()` (T1), и вееру (T3), и меню (T6). Одна задача — одна волна. |
| 2 | **Task 2 (T1)** ‖ **Task 3 (T4)** | T1 — миграция и колонки (контракт БД для T2/T3/T6). T4 — мост, ему из T1 не нужно ничего, а из T5 нужен только `can(..., "tasks.confirm")`. Файлы дизъюнктны. |
| 3 | **Task 4 (T2)** ‖ **Task 5 (T7)** | T2 — пуш назначения (нужна колонка `assign_notified_at` из T1). T7 — эмитент просрочки во второй половине `TaskBridgeService` (нужен сам сервис из T4). Файлы дизъюнктны. |
| 4 | **Task 6 (T3)** | Веер живёт в `bot/index.ts` и `bot/core-client.ts`, которые правит T2, и подчиняется `push-hours.ts`, который T2 заводит. |
| 5 | **Task 7 (T6)** | Экран в боте дописывает `task-confirm.ts` (T3), панель зовёт `POST /tasks/:id/confirm` (T1). |
| 6 | **Task 8 (T8)** | Рунбуки описывают ВСЕ кроны и петли среза — писать их можно только когда все они есть. |

## Global Constraints

Копия §4 спеки плюс рулинги, связывающие несколько задач. Нарушение здесь — не стилевая правка: срез трогает единственную таблицу, по которой владелец судит о работе людей, и заводит две петли, которые пишут людям в Telegram сами.

- **R-P7-1 Охват.** Ровно восемь задач спеки. Явно ВНЕ: починка монитора графиков ТО («Гигиена», #16), `maintenance.due` как источник моста, `machine.idle`/`machine.offline`, задачи вокруг инкассации, тип задачи `kind`, EAV-поля, третье право, перенос таблицы `tasks` донора, схлопывание рукописных зеркал `TaskRow`/`Task` в shared, read-token для GET (П8 пп. 3–5).
- **R-P7-6 «Подтверждено» — КОЛОНКИ.** `taskStatusEnum` остаётся ЧЕТЫРЁХЗНАЧНЫМ (`packages/db/src/schema.ts:29`). Пятое значение молча меняет смысл десяти условий, и ни одно не сломается компилятором: `ne(status,"done")` в `list`/`overdue`/`unassigned`/`redoUnnotified`/`dueSoon` (`tasks.service.ts:132-133`, `:161`, `:417-418`, `:549-550`, `:590-591`), `ne(status,"done")` в брифинге (`registry.service.ts:203`), **`eq(status,"done")` в ленте действий** (`actions.service.ts:231` — подтверждённая задача ИСЧЕЗЛА бы из «✅ Закрыл задачу»), `row.status !== "done"` в `rate()` (`:508-511`), `ne(task.status, status)` в `setStatus` (`:183-190`) и четыре рукописных зеркала союза (`tasks.controller.ts:6`, `tasks.service.ts:16`, `apps/bot/src/core-client.ts:68`, `apps/cc/src/lib/core.ts:1142`). Страж-тест в `schema.test.ts` фиксирует четыре значения и перечисляет цену пятого.
- **R-P7-7 Мост — внутри Core, вызовом метода.** `TaskBridgeService` — провайдер `TasksModule`, один крон `15 6 * * *` Asia/Tashkent, две работы под своими `catch`. Задачи создаются `TasksService.ensureForDay(...)`, НЕ маршрутом `POST /tasks/ensure-for-day`: единственный существующий мост «система → задача» молчит в проде 20 дней, и HTTP-стык — самая вероятная причина (§2.4 спеки).
- **R-P7-2 Ключ дедупа моста** — `<источник>:<сущность>:<дата Ташкента СОБЫТИЯ>`, совместимый с частичным `task_source_key`. Одна задача на автомат в сутки, а не на позицию. Дата берётся у события (`tashkentDay(e.occurredAt)`), а не у прогона: событие в 23:50 попадёт в утренний прогон, и ключ обязан назвать день факта — иначе окно нахлёста создало бы вторую задачу про вчерашний вечер.
- **R-P7-8 Автозадача рождается СВОБОДНОЙ.** Полевые (`machine.low_stock`, `vending.refill_detected`, `vending.shrinkage_alert`) — `ownerKind:"human"`, `ownerRef:null`, в общий пул (докблок пула, `tasks.service.ts:401-406`). Инфраструктурные (`ourvend.sync_stale`, `ourvend.sync_failed_streak`) — первому активному человеку с правом `tasks.confirm` (сортировка `created_at`, затем `id`); нет такого — тоже в пул плюс `warn` и событие `tasks.no_confirmers`. `VENDING_ROUTE_ORDER` назначением людей НЕ является: его `help` — «первый автомат маршрута получает закуп первым» (`config-spec.ts:187-193`).
- **R-P7-9 Веер дедупится ПО ЧЕЛОВЕКУ и заявкой ДО отправки.** Ключ `task-confirm:<taskId>:<personId>`; ключ на всю рассылку заставил бы сбой одного чата лишить подтверждения всех (урок `weeklyDigestKey`, `weekly-digest.ts:177-183`). Из адресатов исключается закрывший (`closed_by === "person:<его id>"`).
- **R-P7-10 Отметка `assign_notified_at` ставится ПОСЛЕ доставки** и гасится/ставится ровно в четырёх местах: `create` (NULL по умолчанию колонки), `edit` при РЕАЛЬНОЙ смене `ownerRef` → NULL, `claim` → `now()`, `release` → NULL. Миграция проставляет `assign_notified_at = created_at` всем строкам с непустым `owner_ref`: без бэкфилла первый тик после деплоя разослал бы людям работу недельной давности как новую.
- **R-P7-11 Тихие часы — ТОЛЬКО для T2 и T3.** `PUSH_HOURS = { from: 7, to: 22 }` по Ташкенту. Существующие напоминания о сроке (`index.ts:625-634`) и возвраты на доработку (`index.ts:676-707`) НЕ трогаются: их поведение — приёмка прошлых срезов.
- **R-P7-12 Права проверяются в Core по `actor`.** `assertCan(actorRef, perm)`: `owner` — всегда можно; `person:<uuid>` — карточка + `can(effectiveRoles(p), perm)`; карточки нет или `active !== "yes"` — `ForbiddenException`. Честно о границе: `actor` приходит от держателя `SERVICE_TOKEN`, то есть Core верит боту и панели, — это защита от промаха и от кнопки, а НЕ аутентификация. Так и записывается в докблоке.
- **R-P7-13 Мост выключается настройкой, а не деплоем.** `TASK_BRIDGE_ENABLED` (`bool`, fallback `"1"` — ВКЛЮЧЁН) и `TASK_BRIDGE_MAX_PER_RUN` (`number`, fallback `"20"`, `inRange(1, 200)`). Обрезка громкая: `warn` со списком неотработанных ключей и `capped: true` в событии прогона.
- **`now` — параметр, а не `new Date()` внутри** у ВСЕХ новых методов, где время участвует в решении: `confirm(id, actor, now)`, `markAssignNotified(id, now)`, `run(now)`, `emitOverdue(now)`, `nextMorning(now)`, `внутриРабочихЧасов(now)`, `sendAssignNotices(now)`, `sendConfirmRequests(now)`. Существующие `overdue()` (`:161`) и `dueSoon()` (`:581`) берут стенные часы внутри и в этом срезе НЕ трогаются.
- **Время — только `packages/shared/src/tashkent-time.ts`** (`tashkentDay`, `tashkentDayStartOf`, `tashkentHour`, `TZ`). Вторая копия смещения запрещена (R-FW-11): именно поэтому `tashkentHour` заводится в общем модуле, а не в боте (см. «Отклонения» №3). Голые сутки — `YYYY-MM-DD`.
- **Настройки — только через `apps/core/src/system/config-spec.ts`** с русским `help`; чтение — `readIntSetting`/`settingValue` (`apps/core/src/system/settings.ts:16-47`); база важнее env. Булев тумблер читается явно `(await settingValue(db, KEY)).trim() === "1"`: `settingValue` возвращает `""` для неизвестного ключа, и «пусто = включено» было бы ложью.
- **`@Throttle` — только именованные лимитеры `burst`/`sustained`** (`app.module.ts:42-45`); `default` ThrottlerGuard не читает. Образец — `vending.controller.ts:619`.
- **Мутации — под `ServiceTokenGuard`** (`common/service-token.guard.ts:8-40`, fail-closed); GET открыты и такими остаются.
- **Крон-сервис Core обязан иметь поле `cron`, `onApplicationShutdown` и строку в `apps/core/src/cron-shutdown.test.ts`** (`:17-30`).
- **TS strict, без `any`.** Русский в UI, боте, тестах и документации; идентификаторы английские, экспортируемые имена общего слоя — латиницей.
- **Ноль ≠ «всё хорошо».** Пустой список ждущих подтверждения рисуется ТРЕТЬИМ состоянием («ничего не ждёт приёмки» + что случится дальше), а не зелёной галкой — и в боте, и в панели.
- **Тесты по dist:** `pnpm --filter @mydon/shared build` ПЕРЕД `pnpm --filter core test` / `pnpm --filter bot test` / `pnpm --filter @mydon/db test`; `pnpm --filter cc test` — vitest. Существующие наборы остаются зелёными; `apps/bot/src/weekly-digest.test.ts` в T5 НЕ правится вовсе — это и есть доказательство, что переезд легаси-карты поведения не изменил.
- **Записей в прод из задач плана — НИ ОДНОЙ.** Единственная запись среза — бэкфилл ВНУТРИ миграции, её применяет автодеплой. Всё остальное создаёт мост сам.
- **Коммиты в общем worktree.** Ветка `feat/p7-tasks` (от `main@b3b595d` + спека `112612d`). Коммитим ТОЛЬКО свои пути: `git commit -m "…" -- <путь> <путь>`; `git add -A` / `git commit -a` утащат чужие несохранённые правки (Codex работает на тех же репозиториях — перед правкой дерева сверять `mtime`). Conventional Commits + трейлеры `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` и `Claude-Session: …`. Push только в свою ветку: после `git checkout main` ПЕРВОЙ командой `git checkout -b` — фолбэк вида `|| git push` молча отправляет `main` в прод, а автодеплой ходит каждые 2 минуты.

### Отклонения от буквы спеки, зафиксированные кодом

Шесть — каждое проверено в дереве, каждое уходит в аддендум спеки шагом Task 8.

1. **`SetQualityDto.actor` и передача актора в `rate()` переезжают из T1 в Task 1 (T5).** Спека чинит «соседний пробел» внутри T1, но право `tasks.confirm` T5 накладывает именно на `rate()` — а `rate()` до этой правки получает актора всегда `"owner"` (`tasks.controller.ts:234`). Оставь правку в T1 — и проверка права в T5 неделю проверяла бы строку `"owner"`, то есть не проверяла бы ничего. Смысл рулинга не меняется, меняется адрес правки.
2. **`awaitingConfirmation()` и `assignUnnotified()` НЕ принимают `now`.** §4 спеки перечисляет их среди методов, обязанных брать момент параметром, но ни в одном из двух запросов НЕТ временнóго предиката: `awaiting` — это `status='done' AND confirmed_at IS NULL`, `assign-unnotified` — `assign_notified_at IS NULL`. Неиспользуемый параметр в сигнатуре — ложь о том, от чего зависит ответ, и `noUnusedParameters` на него ругается. Момент берут те, кто его действительно тратит: `confirm(id, actor, now)`, `markAssignNotified(id, now)`, `emitOverdue(now)`, `run(now)`.
3. **`tashkentHour(at)` заводится в `packages/shared/src/tashkent-time.ts`, а не в боте.** R-P7-11 просит функцию «внутри рабочих часов» в `apps/bot/src/push-hours.ts`, но получить ташкентский час без второй копии смещения оттуда нечем: в `tashkent-time.ts` есть `tashkentDay`/`tashkentDayStartOf`, часа нет. Вторая константа зоны запрещена прямым уроком (`tashkent-time.ts:53-61`, R-FW-11), поэтому час отдаёт общий модуль, а `push-hours.ts` остаётся тем, чем его задумали, — порогом и решением.
4. **Событие `task.confirmed` пишется ВСТАВКОЙ в `event` внутри транзакции `confirm()`, а не через `EventsService.record`.** Причин две. Атомарность: `record()` — отдельный запрос вне транзакции, и откат подтверждения оставил бы событие в ленте. Дизъюнктность волны: `TasksModule` получает `EventsModule` в Task 3 (T4), которая идёт ПАРАЛЛЕЛЬНО с Task 2 (T1) — зависимость T1 от чужой правки модуля столкнула бы две задачи одной волны на одном файле. Тот же приём уже применён у сторожа застоя (`sync-stale.service.ts:149-156`).
5. **Тест «`task.overdue` и `tasks.no_confirmers` есть в `RULE_EVENT_TYPES`» живёт в Task 6 (T3), а не в T7.** §8 спеки помещает его под T7, но файл `apps/core/src/rules/rules.test.ts` правит T3 (она добавляет само правило `tasks.no_confirmers`). Две задачи, дописывающие один тестовый файл, — либо конфликт, либо лишняя волна; утверждение при этом не меняется ни на слово и проверяет ОБА типа сразу.
6. **Рунбуки (`docs/DEPLOY.md`, `docs/AGENTS_ACTIVATION.md`, `docs/PLAN_STOCK_ABSORPTION.md`) правятся в Task 8, а не «внутри задачи, которой нужны».** Правило §4 остаётся в силе для доков, описывающих ОДИН механизм: `docs/DATA_SOURCES.md` («Задачи из событий») правит Task 3 (T4), потому что это описание её источников. Три рунбука описывают срез ЦЕЛИКОМ — порядок выкатки, откат, инвентарь кронов и петель, — и их правили бы четыре задачи в трёх волнах на одних и тех же абзацах. Собраны в финальную задачу, которая по спеке и так «только чек-лист».

## Карта файлов

| Файл | Задача | Роль |
|---|---|---|
| `packages/shared/src/roles.ts` (+`roles.test.ts`) | T5 | `tasks.assign`/`tasks.confirm` в `PERMISSIONS`, `LEGACY_ROLE_MAP`, `effectiveRoles` |
| `packages/shared/src/tasks.ts` (+`tasks.test.ts`) | T1 | `TaskState`, `taskState()`, `TASK_STATE_LABELS` |
| `packages/shared/src/tashkent-time.ts` (+test) | T2 | `tashkentHour` — единственный источник ташкентского часа |
| `packages/db/src/schema.ts` (+`schema.test.ts`) | T1 | `confirmed_at`/`confirmed_by`/`assign_notified_at`, два частичных индекса, страж четырёхзначного `task_status` |
| `packages/db/drizzle/0072_task_confirmation.sql` + `meta/` | T1 | единственная миграция среза: три колонки, бэкфилл, два индекса |
| `packages/db/src/migrations.test.ts` | T1 | страж цепочки: файл ↔ журнал, номера уникальны и без дыр |
| `apps/core/src/tasks/tasks.service.ts` | T5·T1·T2 | `assertCan` (T5), `confirm`/`awaitingConfirmation` (T1), `assignUnnotified`/`markAssignNotified` + четыре точки отметки (T2) |
| `apps/core/src/tasks/tasks.controller.ts` | T5·T1·T2 | `actor` в `SetQualityDto` (T5), `ConfirmTaskDto` + `awaiting=1` (T1), пара маршрутов отметки (T2) |
| `apps/core/src/tasks/tasks.test.ts` | T5·T1·T2 | права, приёмка, `awaiting`, четыре точки отметки |
| `apps/core/src/tasks/task-bridge.service.ts` (+test) | T4·T7 | мост (T4) и эмитент `task.overdue` (T7) — один крон, две работы |
| `apps/core/src/tasks/tasks.module.ts` | T4·T7 | `EventsModule`+`VendingModule`+провайдер (T4), `RulesModule` (T7) |
| `apps/core/src/system/config-spec.ts` (+test) | T4 | `TASK_BRIDGE_ENABLED`, `TASK_BRIDGE_MAX_PER_RUN` |
| `apps/core/src/cron-shutdown.test.ts` | T4·T7 | строка `task-bridge` и её арность |
| `apps/core/src/registry/actions.service.ts` (+test) | T1 | вид `task_confirmed` в ленте «Действия» |
| `apps/core/src/rules/rules.ts` (+`rules.test.ts`) | T3 | правило `tasks.no_confirmers`, страж `RULE_EVENT_TYPES` |
| `apps/bot/src/core-client.ts` | T1·T2·T3 | зеркало `TaskRow` (T1), отметка назначения (T2), веер и приёмка (T3) |
| `apps/bot/src/push-hours.ts` (+test) | T2 | `PUSH_HOURS`, `внутриРабочихЧасов` |
| `apps/bot/src/tasks-push.ts` (+test) | T2 | `доставитьНазначения`: доставка → отметка, недоступность, тихие часы |
| `apps/bot/src/task-confirm.ts` (+test) | T3·T6 | адресаты, ключ, текст, разбор `tc:` (T3); экран «ждут подтверждения» (T6) |
| `apps/bot/src/index.ts` | T2·T3 | петли `sendAssignNotices` и `sendConfirmRequests` |
| `apps/bot/src/staff.ts` | T3·T6 | разбор `tc:` в `handleStaffCallback` (T3), `case "confirm"` в `startMenuItem` (T6) |
| `apps/bot/src/menu.ts` (+`menu.test.ts`) | T6 | пункт «🧾 Ждут подтверждения» с `perm: "tasks.confirm"` |
| `apps/bot/src/weekly-digest.ts` | T5 | легаси-карта удаляется, зовётся общая `effectiveRoles` |
| `apps/cc/src/lib/core.ts` | T1·T6 | зеркало `Task` (T1), клиент `confirmTask` (T6) |
| `apps/cc/src/components/awaiting-block.tsx` (+test) | T6 | блок «Ждут подтверждения» над группами срочности |
| `apps/cc/src/app/tasks/page.tsx`, `actions.ts`, `[id]/page.tsx` | T6 | второй список, экшен `confirmTask`, строка «Принято» |
| `tools/smoke-core.mjs` | T1·T2 | форма ответа `/tasks`, окна `awaiting=1` и `assign-unnotified` |
| `tools/smoke-panel.mjs` | T6 | шаг `/tasks` → «Ждут подтверждения» |
| `docs/DATA_SOURCES.md` | T4 | абзац «Задачи из событий»: пять источников, ключ, крон, обе настройки |
| `docs/DEPLOY.md` · `docs/AGENTS_ACTIVATION.md` · `docs/PLAN_STOCK_ABSORPTION.md` | T8 | проверка бэкфилла, откат моста, кроны и петли, переписанная строка §П7 |

---

### Task 1 (спека T5) · ВОЛНА 1 — Права `tasks.assign` / `tasks.confirm`: общий слой и проверка в Core

**Files:** Modify `packages/shared/src/roles.ts` (`PERMISSIONS` стр. 38–51, `ROLE_PERMISSIONS.manager` стр. 83–95, конец файла после `rolesLabel` стр. 132), `packages/shared/src/roles.test.ts` (набор «Матрица прав», стр. 25+); `apps/bot/src/weekly-digest.ts` (`ЛЕГАСИ_РОЛИ` стр. 74–80, `ролиРассылки` стр. 82–87, импорт из `@mydon/shared` в шапке); `apps/core/src/tasks/tasks.service.ts` (импорты стр. 1–6, `rate()` стр. 504, `edit()` стр. 284–320); `apps/core/src/tasks/tasks.controller.ts` (`SetQualityDto` стр. 123–126, вызов `rate` стр. 232–235); `apps/core/src/tasks/tasks.test.ts` (конец файла). Create — нет. **`apps/bot/src/weekly-digest.test.ts` НЕ ПРАВИТСЯ** — его зелень и есть доказательство, что переезд карты поведения не изменил.

**Interfaces (consumes):** `can(roles, perm)` / `normalizeRoles` / `BASELINE` (`packages/shared/src/roles.ts:100`, `:122`, `:62`), `person` (`packages/db/src/schema.ts:141-168`, поля `roles`/`role`/`active`), `ForbiddenException` (`@nestjs/common`), `WEEKLY_ROLES` (`apps/bot/src/weekly-digest.ts:56`).

**Interfaces (produces):**
```ts
/** packages/shared/src/roles.ts */
export const PERMISSIONS = [
  "tasks.own",      // свои задачи: смотреть, брать, закрывать
  "tasks.assign",   // назначать задачи другим и переназначать
  "tasks.confirm",  // принимать выполненное и возвращать в работу
  "maintenance.view",
  // …остальные без изменений
] as const;

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

/** apps/core/src/tasks/tasks.service.ts */
/**
 * Право актора на действие. `actor` приходит от держателя SERVICE_TOKEN, то
 * есть от бота или панели: это защита от промаха и от кнопки, а НЕ
 * аутентификация. Так и читать.
 */
private async assertCan(actorRef: string, perm: Permission): Promise<void>;

async rate(id: string, quality: "excellent" | "accepted" | "redo", actorRef = "owner"): Promise<TaskRow>; // + assertCan("tasks.confirm")

/** apps/core/src/tasks/tasks.controller.ts */
export class SetQualityDto {
  @IsIn(["excellent", "accepted", "redo"]) quality!: "excellent" | "accepted" | "redo";
  /** `owner` | `person:<uuid>` — от него зависит право (R-P7-12). */
  @IsOptional() @IsString() @MaxLength(128) actor?: string;
}
```

Что обязана делать реализация:
- `manager` получает ОБА права; `owner` — через существующий `[...PERMISSIONS]`, руками ничего не дописывается. `BASELINE` остаётся `["tasks.own"]`: право подтверждения не должно достаться всем по умолчанию, иначе матрица снова станет косметикой.
- `effectiveRoles` чистит массив существующим `normalizeRoles` (мусорная роль не даёт прав и не создаёт вид, что доступ настроен) и ДОБАВЛЯЕТ легаси-роль, а не заменяет ею список.
- `assertCan` в `edit()` спрашивается ТОЛЬКО когда `ownerRef` реально меняется: правка срока или приоритета права назначения не требует. Для сравнения `edit()` получает чтение строки ДО транзакции (`this.byId(id)`), и это же чтение переиспользует T2 для гашения отметки.
- Текст отказа один на оба права: «Это может менеджер. Попроси владельца проставить роль.» — сотрудник должен понять, что чинится это ролью, а не повтором нажатия.

- [x] **Step 1: Тесты RED.**
```ts
// packages/shared/src/roles.test.ts — новый набор в конец файла
describe("Права на назначение и приёмку задач (П7, R-P7-3)", () => {
  it("менеджер может назначать и подтверждать, оператор — нет", () => {
    assert.equal(can(["manager"], "tasks.assign"), true);
    assert.equal(can(["manager"], "tasks.confirm"), true);
    assert.equal(can(["operator"], "tasks.assign"), false);
    assert.equal(can(["operator"], "tasks.confirm"), false);
    assert.equal(can(["owner"], "tasks.confirm"), true, "владелец получает права списком PERMISSIONS");
  });

  it("`tasks.own` остаётся у сотрудника без ролей — новые права его не заперли", () => {
    // BASELINE — это про «карточка есть, роли проставить не успели»: бот
    // обязан работать. Право подтверждения в BASELINE не попадает НАМЕРЕННО.
    assert.equal(can([], "tasks.own"), true);
    assert.equal(can([], "tasks.confirm"), false);
    assert.deepEqual([...BASELINE], ["tasks.own"]);
  });

  it("effectiveRoles: легаси `role='владелец'` даёт owner, мусор — ничего", () => {
    // На проде 25.08.2026 массив `roles` у владельца пуст, а легаси-строка
    // заполнена: без неё право подтверждения не досталось бы никому.
    assert.deepEqual(effectiveRoles({ roles: [], role: "владелец" }), ["owner"]);
    assert.deepEqual(effectiveRoles({ roles: null, role: "Менеджер" }), ["manager"]);
    assert.deepEqual(effectiveRoles({ roles: ["operator"], role: "кладовщик" }), ["operator"]);
    assert.deepEqual(effectiveRoles({ roles: ["operator"], role: null }), ["operator"]);
    assert.deepEqual(effectiveRoles({ roles: ["выдумка"], role: "" }), []);
  });

  it("effectiveRoles не задваивает роль, если она есть и в массиве, и в легаси", () => {
    assert.deepEqual(effectiveRoles({ roles: ["owner"], role: "владелец" }), ["owner"]);
  });

  it("LEGACY_ROLE_MAP отдаёт только owner и manager — правами это поле не управляет шире", () => {
    // Цена описки здесь — лишний получатель сводки и лишняя кнопка приёмки,
    // а не лишний доступ к деньгам или настройкам.
    assert.deepEqual([...new Set(LEGACY_ROLE_MAP.values())].sort(), ["manager", "owner"]);
  });
});
```
```ts
// apps/core/src/tasks/tasks.test.ts — новый набор в конец файла
describe("Права актора на приёмку и назначение (П7, R-P7-12)", () => {
  const OPERATOR = "22222222-2222-4222-8222-222222222222";
  const MANAGER = "33333333-3333-4333-8333-333333333333";

  /**
   * Заглушка прав. `верхние` — ОЧЕРЕДЬ ответов на `db.select()` вне
   * транзакции, по одному элементу на вызов: `edit()` сначала читает задачу
   * (`byId`), потом карточку (`assertCan`), а `rate()` — только карточку.
   * Очередь, а не один ответ: иначе оба чтения видели бы одну строку и тест
   * зеленел бы на порядке, которого в коде нет.
   */
  function правовойStub(верхние: Row[][], задача: Row) {
    const очередь = [...верхние];
    const tx = {
      select: () => ({ from: () => ({ where: async () => [задача] }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [задача] }) }) }),
      insert: () => ({ values: async () => [] }),
    };
    return {
      // assertCan читает `person` мимо транзакции: эта таблица апдейтом задачи
      // не блокируется, а второе чтение внутри tx потребовало бы тащить тип
      // транзакции в приватный метод ради одной выборки.
      select: () => ({ from: () => ({ where: () => ({ limit: async () => очередь.shift() ?? [] }) }) }),
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never;
  }

  it("оценка от оператора — 403, и текст объясняет, что чинится ролью", async () => {
    const db = правовойStub(
      [[{ id: OPERATOR, roles: ["operator"], role: null, active: "yes" }]],
      { id: "t1", status: "done", quality: null, resultNote: "готово" },
    );
    await assert.rejects(
      () => makeTasks(db).rate("t1", "redo", `person:${OPERATOR}`),
      /Это может менеджер/,
    );
  });

  it("оценка от менеджера проходит — роль из массива", async () => {
    const db = правовойStub(
      [[{ id: MANAGER, roles: ["manager"], role: null, active: "yes" }]],
      { id: "t1", status: "done", quality: null, resultNote: "готово" },
    );
    const t = await makeTasks(db).rate("t1", "accepted", `person:${MANAGER}`);
    assert.equal(t.id, "t1");
  });

  it("оценка от владельца проходит без похода в карточку", async () => {
    // `owner` — не person: карточки у него нет вовсе, и запрос за ней вернул
    // бы пусто. Сегодняшнее поведение панели обязано остаться прежним.
    const db = правовойStub([], { id: "t1", status: "done", quality: null, resultNote: "готово" });
    assert.equal((await makeTasks(db).rate("t1", "excellent")).id, "t1");
  });

  it("уволенный менеджер прав не имеет — карточка осталась, доступ нет", async () => {
    const db = правовойStub(
      [[{ id: MANAGER, roles: ["manager"], role: null, active: "no" }]],
      { id: "t1", status: "done", quality: null, resultNote: "готово" },
    );
    await assert.rejects(() => makeTasks(db).rate("t1", "accepted", `person:${MANAGER}`), /Это может менеджер/);
  });

  it("актор не в форме `person:<uuid>` отвергается, а не считается владельцем", async () => {
    // Строка приходит снаружи (бот, панель): «менеджер», «person:xxx» или
    // пустое не должны молча получать права owner.
    const db = правовойStub([], { id: "t1", status: "done", quality: null, resultNote: "г" });
    await assert.rejects(() => makeTasks(db).rate("t1", "accepted", "менеджер"), /Это может менеджер/);
  });

  it("правка срока прав назначения не требует, смена исполнителя — требует", async () => {
    const задача = { id: "t1", ownerKind: "human", ownerRef: OPERATOR, priority: "normal", due: null };
    // Право не спрашивается вовсе — очередь верхних чтений содержит только
    // саму задачу (`byId`), карточку никто не запросит.
    const срок = правовойStub([[задача]], задача);
    // due меняем от лица оператора — это его собственная задача, право assign
    // тут ни при чём.
    const t = await makeTasks(срок).edit("t1", { due: new Date("2026-08-27T05:00:00Z") }, `person:${OPERATOR}`);
    assert.equal(t.id, "t1");

    const смена = правовойStub(
      [[задача], [{ id: OPERATOR, roles: ["operator"], role: null, active: "yes" }]],
      задача,
    );
    await assert.rejects(
      () => makeTasks(смена).edit("t1", { ownerRef: MANAGER }, `person:${OPERATOR}`),
      /Это может менеджер/,
    );
  });

  it("переназначение на того же человека права не требует — смены нет", async () => {
    // Панель шлёт исполнителя в патче всегда; требовать право на «оставил как
    // было» значило бы запереть правку заголовка за правом назначения.
    const задача = { id: "t1", ownerKind: "human", ownerRef: OPERATOR, priority: "normal" };
    const db = правовойStub([[задача]], задача);
    assert.equal((await makeTasks(db).edit("t1", { ownerRef: OPERATOR }, `person:${OPERATOR}`)).id, "t1");
  });
});
```
- [x] **Step 2:** `pnpm --filter @mydon/shared build && pnpm --filter @mydon/shared test` → RED (`effectiveRoles`/`LEGACY_ROLE_MAP` не экспортируются, `can(["manager"], "tasks.assign")` = false). `pnpm --filter core build && pnpm --filter core test` → RED (`rate` четвёртого поведения не знает, `edit` актора не проверяет).
- [x] **Step 3: Общий слой.** `packages/shared/src/roles.ts`:
```ts
export const PERMISSIONS = [
  "tasks.own", // свои задачи: смотреть, брать, закрывать
  // Два права П7 (R-P7-3). Ровно два, а не гранулярная россыпь: третье право
  // без третьего сотрудника — косметика, и матрица снова начала бы врать.
  "tasks.assign", // назначать задачи другим и переназначать
  "tasks.confirm", // принимать выполненное и возвращать в работу
  "maintenance.view", // графики и осмотры
  // …остальное без изменений
] as const;
```
в `ROLE_PERMISSIONS.manager` — `"tasks.assign", "tasks.confirm"` сразу после `"tasks.own"`; `owner` не трогаем (`[...PERMISSIONS]` уже включает оба). В конец файла — `LEGACY_ROLE_MAP` и `effectiveRoles` с докблоками из «Interfaces (produces)»:
```ts
export const LEGACY_ROLE_MAP: ReadonlyMap<string, StaffRole> = new Map<string, StaffRole>([
  ["владелец", "owner"],
  ["собственник", "owner"],
  ["owner", "owner"],
  ["менеджер", "manager"],
  ["manager", "manager"],
]);

export function effectiveRoles(p: { roles?: readonly string[] | null; role?: string | null }): StaffRole[] {
  const known = normalizeRoles(p.roles ?? []);
  const legacy = LEGACY_ROLE_MAP.get((p.role ?? "").trim().toLowerCase());
  return legacy && !known.includes(legacy) ? [...known, legacy] : known;
}
```
- [x] **Step 4: Бот перестаёт держать свою копию.** `apps/bot/src/weekly-digest.ts`: удалить блок `ЛЕГАСИ_РОЛИ` (`:74-80`) вместе с его комментарием, добавить `effectiveRoles` в существующий импорт из `@mydon/shared`, и переписать `ролиРассылки`:
```ts
/**
 * Роль рассылки у карточки: массив `roles` или легаси-текст `role`.
 *
 * Карту легаси-ролей держит `@mydon/shared` (П7, R-P7-12): по ней теперь
 * считает и Core, проверяя право `tasks.confirm`, а две копии ответа на
 * вопрос «кто менеджер» дали бы кнопку, которую Core отвергает 403-м.
 */
function ролиРассылки(p: PersonRow): boolean {
  return effectiveRoles(p).some((r) => РОЛИ_РАССЫЛКИ.has(r));
}
```
`WEEKLY_ROLES` и `РОЛИ_РАССЫЛКИ` остаются как есть: множество получателей сводки — вопрос рассылки, а не прав.
- [x] **Step 5: Проверка права в Core.** `apps/core/src/tasks/tasks.service.ts`: в импорты — `ForbiddenException` из `@nestjs/common`, `person` из `@mydon/db`, `can, effectiveRoles, type Permission` из `@mydon/shared`. Рядом с `machineIsOperationalCheck` (`:344`):
```ts
  /** Актор с правами: панель ходит от владельца, бот — от карточки сотрудника. */
  private static readonly ACTOR_PERSON = /^person:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

  /**
   * Право актора на действие (R-P7-12).
   *
   * ЧТО ЭТО НЕ ЕСТЬ. `actor` приходит в теле запроса от держателя
   * SERVICE_TOKEN — то есть Core верит боту и панели на слово. Это не сессия и
   * не подпись: защита от промаха и от кнопки, а не от злоумышленника с
   * токеном. Записано здесь, чтобы следующий читатель не принял её за
   * аутентификацию и не построил на ней ничего денежного.
   *
   * ЗАЧЕМ ВООБЩЕ. Спрятанный кнопкой, но доступный запросом пункт сделал бы
   * всю модель прав косметикой — это докблок фильтра меню бота
   * (`apps/bot/src/menu.ts:150-153`), и он же требование к Core.
   *
   * Легаси-строка `person.role` учитывается общим `effectiveRoles`: на проде
   * ролей owner/manager нет ни у кого, и без неё право подтверждения не
   * досталось бы никому, кроме актора `owner`.
   */
  private async assertCan(actorRef: string, perm: Permission): Promise<void> {
    if (actorRef === "owner") return;
    const ОТКАЗ = "Это может менеджер. Попроси владельца проставить роль.";
    const m = TasksService.ACTOR_PERSON.exec(actorRef);
    if (!m) throw new ForbiddenException(ОТКАЗ);
    const [p] = await this.db
      .select({ roles: person.roles, role: person.role, active: person.active })
      .from(person)
      .where(eq(person.id, m[1]!))
      .limit(1);
    if (!p || p.active !== "yes") throw new ForbiddenException(ОТКАЗ);
    if (!can(effectiveRoles(p), perm)) throw new ForbiddenException(ОТКАЗ);
  }
```
- [x] **Step 6: Применение права.** `rate()` — первой строкой тела `await this.assertCan(actorRef, "tasks.confirm");` (до транзакции: отказ не должен открывать транзакцию). `edit()` — перед `return this.db.transaction(...)`:
```ts
    // Строку читаем ДО транзакции: право `tasks.assign` требуется только при
    // РЕАЛЬНОЙ смене исполнителя, а правка срока или приоритета к назначению
    // отношения не имеет. Окно между чтением и апдейтом стоит максимум
    // проверки права против устаревшего исполнителя — при одном владельце и
    // одной панели это цена, а не риск. Тем же чтением П7 гасит отметку
    // «тебе поручили» (R-P7-10).
    const before = await this.byId(id);
    if (set.ownerRef !== undefined && set.ownerRef !== before.ownerRef) {
      await this.assertCan(actorRef, "tasks.assign");
    }
```
`byId` уже кидает `NotFoundException` для отсутствующей задачи — прежнее поведение `edit()` сохраняется.
- [x] **Step 7: Контроллер даёт актора оценке.** `apps/core/src/tasks/tasks.controller.ts`: в `SetQualityDto` — поле `actor` из «Interfaces (produces)»; в обработчике (`:232-235`):
```ts
  /**
   * Оценка сделанной задачи. «Переделать» возвращает её в работу.
   *
   * `actor` обязателен по смыслу, а не по валидатору: без него журнал
   * приписывал бы владельцу ЛЮБУЮ оценку, включая ту, что ставит менеджер
   * кнопкой из бота, — и право `tasks.confirm` проверялось бы против строки
   * «owner», то есть не проверялось бы вовсе.
   */
  @Post(":id/quality")
  rate(@Param("id", ParseUUIDPipe) id: string, @Body() dto: SetQualityDto) {
    return this.tasks.rate(id, dto.quality, dto.actor ?? "owner");
  }
```
- [x] **Step 8:** `pnpm --filter @mydon/shared build && pnpm --filter @mydon/shared test && pnpm --filter core build && pnpm --filter core test && pnpm --filter bot build && pnpm --filter bot test` → GREEN. Отдельно убедиться, что `apps/bot/src/weekly-digest.test.ts` зелёный БЕЗ правок (`git diff --name-only` его не показывает): это и есть доказательство, что переезд карты поведения не изменил. `pnpm -s typecheck`.
- [x] **Step 9:** `git commit -m "feat(shared,core,bot): права tasks.assign и tasks.confirm, легаси-карта ролей переезжает в @mydon/shared (П7, R-P7-3/R-P7-12)" -- packages/shared/src/roles.ts packages/shared/src/roles.test.ts apps/bot/src/weekly-digest.ts apps/core/src/tasks/tasks.service.ts apps/core/src/tasks/tasks.controller.ts apps/core/src/tasks/tasks.test.ts`

---

### Task 2 (спека T1) · ВОЛНА 2 — «Подтверждено менеджером»: колонки, миграция, приёмка и `awaiting=1`

Эта задача кладёт **контракт БД для всего среза**: одна миграция несёт ВСЕ ТРИ колонки (в том числе `assign_notified_at`, которой пользуется Task 4) — вторую миграцию в одном срезе заводить нельзя, иначе автодеплой применит половину контракта.

**Files:** Create `packages/db/drizzle/0072_task_confirmation.sql` (**номер — следующий свободный**, см. Step 4), `packages/db/src/migrations.test.ts`. Modify `packages/db/src/schema.ts` (`task`: колонки после `closedBy` стр. 214, список индексов стр. 227–243), `packages/db/src/schema.test.ts` (набор «Перечисления схемы и словари», стр. 152+), `packages/db/drizzle/meta/_journal.json` и `meta/<номер>_snapshot.json` (генерируются `db:generate`), `packages/shared/src/tasks.ts` (конец файла после `priorityLabel` стр. 156), `packages/shared/src/tasks.test.ts` (конец файла), `apps/core/src/tasks/tasks.service.ts` (импорты стр. 1–6, `TaskRow`/`Status` стр. 14–16, новые методы после `release()` стр. 460–483), `apps/core/src/tasks/tasks.controller.ts` (`ListTasksDto` стр. 48–68, новый `ConfirmTaskDto` после `SetQualityDto` стр. 126, ветка `list()` стр. 204–213, новый `@Post(":id/confirm")` рядом с `:id/quality` стр. 232), `apps/core/src/tasks/tasks.test.ts` (конец файла), `apps/core/src/registry/actions.service.ts` (союз `kind` стр. 39–51, деструктуризация стр. 93–105, выборка `done` стр. 222–233, разбор стр. 316–326), `apps/core/src/registry/actions.service.test.ts`, `apps/bot/src/core-client.ts` (`TaskRow` стр. 61–74), `apps/cc/src/lib/core.ts` (`Task` стр. 1134–1154), `tools/smoke-core.mjs` (шаг `"/tasks"` стр. 481).

**Interfaces (consumes):** `task` (`packages/db/src/schema.ts:172-244`), `auditLog`, `event` (`packages/db/src/schema.ts`, поля `source/type/payload/occurredAt`), `assertCan` (Task 1), `taskStatusEnum` (`:29`), `uniqueIndex`/`index`/`.where(sql\`…\`)` (образец `:238-241`, `:2549-2551`), `@Throttle` c именами `burst`/`sustained` (`app.module.ts:42-45`), `personIdOf` (`actions.service.ts`).

**Interfaces (produces):**
```ts
/** packages/db/src/schema.ts — три колонки в `task`, сразу за `closedBy` */
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
    /**
     * Когда исполнителю сказали «тебе поручили» (R-P7-10). Отметка ставится
     * ПОСЛЕ доставки; NULL = пуш ещё положен. Миграция проставила её всем
     * существующим назначенным задачам: без бэкфилла первый тик после деплоя
     * разослал бы людям работу недельной давности как новую.
     */
    assignNotifiedAt: timestamp("assign_notified_at", { withTimezone: true }),

/** packages/shared/src/tasks.ts */
export type TaskState = "todo" | "in_progress" | "done" | "confirmed" | "cancelled";
/** Что показать человеку. `confirmed` — не статус БД, а приёмка поверх `done`. */
export function taskState(t: { status: string; confirmedAt: string | null }): TaskState;
export const TASK_STATE_LABELS: Record<TaskState, string>;

/** apps/core/src/tasks/tasks.service.ts */
/** Сколько «ждущих приёмки» отдаём разом: экран бота и блок панели читают один список. */
static readonly AWAITING_LIMIT = 100;
async confirm(id: string, actorRef: string, now?: Date): Promise<TaskRow>;
awaitingConfirmation(limit?: number): Promise<TaskRow[]>;

/** apps/core/src/tasks/tasks.controller.ts */
export class ConfirmTaskDto {
  /** `owner` | `person:<uuid>` — от него зависит право (R-P7-12). */
  @IsOptional() @IsString() @MaxLength(128) actor?: string;
}
// ListTasksDto: /** "1" — сделанные, но ещё не принятые. */ awaiting?: "1";

/** apps/bot/src/core-client.ts — зеркало TaskRow прирастает пятью полями */
export interface TaskRow {
  /* …существующие… */
  quality: "excellent" | "accepted" | "redo" | null;
  completedAt: string | null;
  /** Кто ФАКТИЧЕСКИ закрыл: `person:<id>` | `owner`. Веер исключает его из адресатов. */
  closedBy: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  assignNotifiedAt: string | null;
}

/** apps/cc/src/lib/core.ts — зеркало Task прирастает четырьмя полями */
  closedBy: string | null;
  confirmedAt: string | null;
  confirmedBy: string | null;
  assignNotifiedAt: string | null;
```

Что обязана делать реализация:
- Миграция ОДНА и с бэкфиллом внутри: `IF NOT EXISTS` на всех операторах (защитный паттерн 0067/0069/0070/0071), `CONCURRENTLY` НЕ используется — мигратор идёт в транзакции, и `CONCURRENTLY` в ней запрещён (объяснение уже записано в `0070_retention_time_idx.sql`).
- `confirm()` идемпотентен УСЛОВИЕМ В САМОМ UPDATE (`confirmed_at IS NULL`), а не проверкой перед ним: двое менеджеров, нажавших «Принять» одновременно, дают одну запись в журнал и одно событие. Тот же приём, что у `setStatus` (`:183-190`) и `claim` (`:435-437`).
- `confirm()` НЕ меняет `status`: задача остаётся `done`, поэтому её закрытие не исчезает из ленты «✅ Закрыл задачу» и `rate("redo")` после приёмки остаётся возможным.
- `quality` ставится в `accepted`, только если оценки ещё НЕ было: у владельца остаётся право поставить `excellent` отдельно, а «принято без оценки» и «не смотрели» перестают выглядеть одинаково.
- Событие `task.confirmed` пишется вставкой в `event` ВНУТРИ транзакции (см. «Отклонения» №4). Правила у него нет и не будет: приёмка — не тревога, а `immediate` превратило бы каждое «👌 Принять» в сообщение владельцу о его же решении (§7 спеки).
- В ленте действий выборка `task_done` (`:231`, `eq(task.status,"done")`) **не меняется ни на байт** — это прямое следствие R-P7-6.

- [x] **Step 1: Тесты RED — схема и цепочка миграций.**
```ts
// packages/db/src/schema.test.ts — в набор «Перечисления схемы и словари»
  /**
   * СТРАЖ ЧЕТЫРЁХЗНАЧНОГО СТАТУСА (П7, R-P7-6).
   *
   * Пятое значение (`confirmed`) молча меняет смысл десяти уже написанных
   * условий, и ни одно не сломается компилятором:
   *   1. `list(openOnly)`      — `ne(status,"done")`  → принятая задача снова открыта;
   *   2. `overdue()`           — то же                → принятая попадает в просрочку;
   *   3. `unassigned()`        — то же                → принятую можно «взять» заново;
   *   4. `redoUnnotified()`    — то же                → рассылка бьёт по принятым;
   *   5. `dueSoon()`           — то же                → принятая снова «скоро срок»;
   *   6. брифинг владельца     — то же                → число просрочки растёт от принятых;
   *   7. лента «Действия»      — `eq(status,"done")`  → подтверждённая ИСЧЕЗАЕТ из ленты;
   *   8. `rate()`              — `status !== "done"`  → «Переделать» после приёмки невозможно;
   *   9. `setStatus()`         — `ne(status, status)` → переход confirmed→done заново ставит completedAt;
   *  10. четыре рукописных зеркала союза (контроллер, сервис, бот, панель).
   * Приёмка — отметка ПОВЕРХ закрытия (колонки `confirmed_at`/`confirmed_by`),
   * а не фаза жизненного цикла рядом с «отменено». Цена пятого значения —
   * этот список; читай его ДО правки, а не после.
   */
  it("СТРАЖ: task_status остаётся ЧЕТЫРЁХЗНАЧНЫМ (R-P7-6)", () => {
    assert.deepEqual(
      [...mod.taskStatusEnum.enumValues].sort(),
      ["cancelled", "done", "in_progress", "todo"],
    );
  });

  it("у `task` есть confirmed_at, confirmed_by и assign_notified_at", () => {
    const колонки = Object.keys(schema.task);
    for (const c of ["confirmedAt", "confirmedBy", "assignNotifiedAt"]) {
      assert.ok(колонки.includes(c), `в task нет ${c} — миграция и схема разошлись`);
    }
  });
```
```ts
// packages/db/src/migrations.test.ts — новый файл
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Страж ЦЕПОЧКИ миграций.
 *
 * Зачем. Номер следующей миграции — «следующий свободный», и параллельные
 * срезы (П6, «Инкассации», П7) выбирают его каждый у себя. Два файла с одним
 * номером или файл без записи в журнале роняют `migrate.js` НА ПРОДЕ, а не в
 * тестах: автодеплой применяет миграции первым шагом, и упавший шаг вешает
 * выкат молча. Тест стоит копейки и ловит ровно эту коллизию до PR.
 *
 * Читается из dist: `path.resolve(__dirname, "..", "drizzle")` — тот же приём,
 * что у `migrate.ts:29`.
 */
const ПАПКА = path.resolve(__dirname, "..", "drizzle");

interface Journal {
  entries: { idx: number; tag: string }[];
}

describe("Цепочка миграций Drizzle", () => {
  const файлы = readdirSync(ПАПКА)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const журнал = JSON.parse(readFileSync(path.join(ПАПКА, "meta", "_journal.json"), "utf8")) as Journal;

  it("у каждого .sql есть запись в журнале, и наоборот", () => {
    const теги = журнал.entries.map((e) => e.tag).sort();
    assert.deepEqual(
      файлы.map((f) => f.replace(/\.sql$/, "")),
      теги,
      "файл без записи не применится, запись без файла уронит мигратор",
    );
  });

  it("номера уникальны — два среза не могут занять один", () => {
    const номера = файлы.map((f) => f.slice(0, 4));
    assert.deepEqual([...new Set(номера)], номера, `дубль номера: ${номера.join(",")}`);
  });

  it("idx журнала уникальны и идут без дыр от нуля", () => {
    const idx = журнал.entries.map((e) => e.idx).sort((a, b) => a - b);
    assert.deepEqual(idx, [...idx.keys()], "мигратор идёт по порядку idx: дыра пропустит миграцию");
  });

  it("имя файла начинается с четырёх цифр и его номер совпадает с idx записи", () => {
    for (const e of журнал.entries) {
      assert.match(e.tag, /^\d{4}_/, `${e.tag}: имя без четырёхзначного номера`);
      assert.equal(Number(e.tag.slice(0, 4)), e.idx, `${e.tag}: номер файла разошёлся с idx журнала`);
    }
  });
});
```
- [x] **Step 2: Тесты RED — общий слой и Core.**
```ts
// packages/shared/src/tasks.test.ts — новый набор в конец файла
describe("Производное состояние задачи (П7, R-P7-6)", () => {
  it("`done` + отметка приёмки = confirmed, `done` без неё = done", () => {
    assert.equal(taskState({ status: "done", confirmedAt: "2026-08-26T05:00:00.000Z" }), "confirmed");
    assert.equal(taskState({ status: "done", confirmedAt: null }), "done");
  });

  it("не выдумывает состояний для cancelled и in_progress", () => {
    // Отметка приёмки на отменённой задаче — данные из прошлого (её могли
    // принять, а потом отменить). Показывать «Подтверждено» вместо «Отменена»
    // значило бы соврать про то, что с задачей сейчас.
    assert.equal(taskState({ status: "cancelled", confirmedAt: "2026-08-26T05:00:00.000Z" }), "cancelled");
    assert.equal(taskState({ status: "in_progress", confirmedAt: null }), "in_progress");
    assert.equal(taskState({ status: "todo", confirmedAt: null }), "todo");
  });

  it("у каждого состояния есть русская подпись", () => {
    for (const s of ["todo", "in_progress", "done", "confirmed", "cancelled"] as const) {
      assert.ok(TASK_STATE_LABELS[s], `${s} без подписи`);
    }
    assert.equal(TASK_STATE_LABELS.confirmed, "Подтверждено");
  });
});
```
```ts
// apps/core/src/tasks/tasks.test.ts — новый набор в конец файла
describe("Приёмка работы менеджером (П7, R-P7-5/R-P7-6)", () => {
  const СЕЙЧАС = new Date("2026-08-26T10:00:00+05:00");

  /** Стенд приёмки: строка задачи, захват патча и всех вставок. */
  function приёмочныйStub(задача: Row, обновление: Row | null = null) {
    const патчи: Record<string, unknown>[] = [];
    const вставки: Row[] = [];
    const tx = {
      select: () => ({ from: () => ({ where: async () => [задача] }) }),
      update: () => ({
        set: (p: Record<string, unknown>) => {
          патчи.push(p);
          return { where: () => ({ returning: async () => (обновление === null ? [] : [{ ...задача, ...p }]) }) };
        },
      }),
      insert: () => ({ values: async (v: Row) => { вставки.push(v); return []; } }),
    };
    const db = {
      // assertCan: актор `owner` до карточки не доходит вовсе.
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never;
    return { db, патчи, вставки };
  }

  it("подтвердить можно только сделанную задачу — у todo отказ 400", async () => {
    const { db } = приёмочныйStub({ id: "t1", status: "todo", quality: null, confirmedAt: null });
    await assert.rejects(() => makeTasks(db).confirm("t1", "owner", СЕЙЧАС), /только сделанную/);
  });

  it("подтверждение НЕ меняет статус — задача остаётся done", async () => {
    // Прямая проверка R-P7-6: смени здесь статус — и подтверждённая задача
    // исчезнет из ленты «✅ Закрыл задачу» (`actions.service` ищет ровно
    // `eq(status,"done")`), а «Переделать» станет невозможным.
    const { db, патчи } = приёмочныйStub(
      { id: "t1", status: "done", quality: null, confirmedAt: null },
      { id: "t1" },
    );
    const t = await makeTasks(db).confirm("t1", "owner", СЕЙЧАС);
    assert.equal(t.status, "done");
    assert.equal("status" in патчи[0]!, false, "статус трогать нельзя");
    assert.equal(патчи[0]!.confirmedAt, СЕЙЧАС);
    assert.equal(патчи[0]!.confirmedBy, "owner");
  });

  it("ставит quality=accepted, если оценки не было, и не затирает excellent", async () => {
    const без = приёмочныйStub({ id: "t1", status: "done", quality: null, confirmedAt: null }, { id: "t1" });
    await makeTasks(без.db).confirm("t1", "owner", СЕЙЧАС);
    assert.equal(без.патчи[0]!.quality, "accepted", "«принято без оценки» ≠ «не смотрели»");

    const с = приёмочныйStub({ id: "t1", status: "done", quality: "excellent", confirmedAt: null }, { id: "t1" });
    await makeTasks(с.db).confirm("t1", "owner", СЕЙЧАС);
    assert.equal("quality" in с.патчи[0]!, false, "оценку владельца приёмка не понижает");
  });

  it("повторное подтверждение не создаёт второй записи в журнале и второго события", async () => {
    // UPDATE ... WHERE confirmed_at IS NULL не вернул строк: успел другой
    // менеджер. Это не ошибка — задача уже принята, отвечаем ею же.
    const { db, вставки } = приёмочныйStub({ id: "t1", status: "done", quality: "accepted", confirmedAt: "2026-08-26T04:00:00.000Z" });
    const t = await makeTasks(db).confirm("t1", "owner", СЕЙЧАС);
    assert.equal(t.id, "t1");
    assert.deepEqual(вставки, [], "ни строки в audit_log, ни события");
  });

  it("успешная приёмка пишет и журнал, и событие task.confirmed", async () => {
    const { db, вставки } = приёмочныйStub(
      { id: "t1", title: "Пополнить Olma", status: "done", quality: null, confirmedAt: null },
      { id: "t1" },
    );
    await makeTasks(db).confirm("t1", "owner", СЕЙЧАС);
    assert.ok(вставки.some((v) => v.action === "task.confirmed"), "журнал аудита");
    const событие = вставки.find((v) => v.type === "task.confirmed");
    assert.ok(событие, "событие ленты");
    assert.equal((событие!.payload as Record<string, unknown>).title, "Пополнить Olma");
    assert.equal(событие!.occurredAt, СЕЙЧАС, "момент — параметр, а не часы процесса");
  });
});

describe("Список «ждут подтверждения» (П7, T1)", () => {
  it("отдаёт только done без отметки приёмки, старейшее первым", async () => {
    const запросы: string[] = [];
    const строки: Row[] = [
      { id: "t1", status: "done", completedAt: "2026-08-20T05:00:00.000Z", confirmedAt: null },
      { id: "t2", status: "done", completedAt: "2026-08-25T05:00:00.000Z", confirmedAt: null },
    ];
    const db = {
      select: () => ({
        from: () => ({
          where: (w: unknown) => {
            запросы.push(String(w));
            return { orderBy: () => ({ limit: async () => строки }) };
          },
        }),
      }),
    } as never;
    const о = await makeTasks(db).awaitingConfirmation();
    assert.deepEqual(о.map((r) => r.id), ["t1", "t2"], "старейшее ждёт дольше — оно первое");
    // Заглушка SQL не исполняет: утверждаем состав условия, а сам порядок и
    // работу индекса проверяет дымовой прогон против настоящего Postgres.
    assert.match(запросы[0]!, /confirmed_at/);
  });
});
```
```ts
// apps/core/src/registry/actions.service.test.ts — новый набор
describe("Лента действий: приёмка работы (П7)", () => {
  it("вид task_confirmed объявлен рядом с task_done, а не вместо него", () => {
    // Подтверждённая задача остаётся `done` (R-P7-6), поэтому «✅ Закрыл
    // задачу» из ленты не исчезает, а «👌 Принял работу» встаёт отдельной
    // строкой: закрыл и принял — разные люди и разные моменты.
    const виды: ActionRow["kind"][] = ["task_done", "task_confirmed"];
    assert.equal(new Set(виды).size, 2);
  });

  it("автор приёмки разбирается тем же personIdOf: owner в полевую ленту не идёт", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    assert.equal(personIdOf(`person:${id}`), id);
    assert.equal(personIdOf("owner"), null, "приёмка владельца — не действие сотрудника");
  });
});
```
- [x] **Step 3:** `pnpm --filter @mydon/db build && pnpm --filter @mydon/db test` → RED (`confirmedAt` в схеме нет, `migrations.test.js` не существует); `pnpm --filter @mydon/shared build && pnpm --filter @mydon/shared test` → RED (`taskState` не экспортируется); `pnpm --filter core build && pnpm --filter core test` → RED (`confirm`/`awaitingConfirmation` не существуют).
- [x] **Step 4: Номер миграции и SQL.** СНАЧАЛА `ls packages/db/drizzle | tail -3`. На момент письма последняя — `0071_stock_count_retention_idx.sql`, то есть свободен `0072`; **П6 и «Инкассации» идут параллельно и могут занять его первыми** — тогда берётся следующий свободный, а файл переименовывается ВМЕСТЕ с записью в `meta/_journal.json` и снапшотом (перегенерацией), чужой файл не трогается. Содержимое (имя — от смысла, не от номера):
```sql
-- Приёмка задачи менеджером и отметка «тебе поручили» (срез П7, R-P7-6/R-P7-10).
--
-- ПОЧЕМУ КОЛОНКИ, А НЕ ПЯТОЕ ЗНАЧЕНИЕ `task_status`. Десять условий вида
-- `status <> 'done'` считают любой незнакомый статус ОТКРЫТЫМ, а лента
-- действий ищет ровно `status = 'done'` — принятая задача исчезла бы из неё.
-- Приёмка — отметка поверх закрытия, как `quality` и `closed_by`.
--
-- IF NOT EXISTS — защитный паттерн 0067/0069/0070/0071: автодеплой применяет
-- миграции без отката, и каждый оператор обязан быть безопасен на повторе.
-- CONCURRENTLY НЕ используется: мигратор идёт в транзакции, а CONCURRENTLY в
-- ней запрещён — оператор упал бы и повесил автодеплой молча (0070).

ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "confirmed_at" timestamp with time zone;
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "confirmed_by" text;
ALTER TABLE "task" ADD COLUMN IF NOT EXISTS "assign_notified_at" timestamp with time zone;

-- Бэкфилл (R-P7-10): у ВСЕХ существующих назначенных задач пуш «тебе
-- поручили» считается уже сделанным. Без этой строки первый же тик после
-- деплоя разошлёт людям работу недельной давности как новую — в проде есть
-- задача, взятая сотрудником 21.08 и не доведённая до конца.
UPDATE "task"
   SET "assign_notified_at" = "created_at"
 WHERE "owner_ref" IS NOT NULL
   AND "assign_notified_at" IS NULL;

-- Индекс под опрос «кому ещё не сказали»: частичный, потому что строк с NULL
-- всегда единицы, а таблица растёт автозадачами моста.
CREATE INDEX IF NOT EXISTS "task_assign_pending_idx"
    ON "task" ("owner_ref")
 WHERE "assign_notified_at" IS NULL AND "owner_ref" IS NOT NULL;

-- Индекс под «ждут подтверждения»: тот же приём. Сортировка списка идёт по
-- `completed_at`, поэтому он и ведущий.
CREATE INDEX IF NOT EXISTS "task_awaiting_idx"
    ON "task" ("completed_at")
 WHERE "confirmed_at" IS NULL;
```
- [x] **Step 5: Схема.** `packages/db/src/schema.ts`, `task`: три колонки из «Interfaces (produces)» сразу за `closedBy` (`:214`); в список индексов (`:227-243`), после `task_client_key`:
```ts
    // Оба индекса ЧАСТИЧНЫЕ и зеркалят миграцию П7: расхождение схемы и SQL
    // приводит к тому, что следующая генерация попыталась бы создать их заново.
    index("task_assign_pending_idx")
      .on(t.ownerRef)
      .where(sql`assign_notified_at is null and owner_ref is not null`),
    index("task_awaiting_idx").on(t.completedAt).where(sql`confirmed_at is null`),
```
Затем `pnpm --filter @mydon/db db:generate` — снапшот обязан лечь в коммит ВМЕСТЕ с файлом миграции; повторный `db:generate` после коммита должен сказать «No schema changes».
- [x] **Step 6: Общий слой.** `packages/shared/src/tasks.ts`, в конец файла:
```ts
/**
 * Что показать человеку. Пять состояний против четырёх в БД: `confirmed` —
 * НЕ статус, а приёмка поверх `done` (R-P7-6). Считается здесь, а не в боте и
 * панели по отдельности: две копии правила разошлись бы в первый же день,
 * когда одна из них начнёт учитывать `quality`.
 */
export type TaskState = "todo" | "in_progress" | "done" | "confirmed" | "cancelled";

const СОСТОЯНИЯ_БД = new Set(["todo", "in_progress", "done", "cancelled"]);

export function taskState(t: { status: string; confirmedAt: string | null }): TaskState {
  if (t.status === "done" && t.confirmedAt !== null) return "confirmed";
  // Отметка приёмки на отменённой задаче — след прошлого; показывать по ней
  // «Подтверждено» значило бы соврать про то, что с задачей сейчас.
  // Незнакомый статус в БД невозможен (страж в `schema.test.ts`), но врать
  // «подтверждено» на нём тем более нельзя — отвечаем самым безобидным.
  return СОСТОЯНИЯ_БД.has(t.status) ? (t.status as TaskState) : "todo";
}

export const TASK_STATE_LABELS: Record<TaskState, string> = {
  todo: "Не начата",
  in_progress: "В работе",
  done: "Выполнена",
  confirmed: "Подтверждено",
  cancelled: "Отменена",
};
```
- [x] **Step 7: Core — приёмка и список.** `apps/core/src/tasks/tasks.service.ts`: в импорт из `@mydon/db` добавить `event`; после `release()` (`:483`):
```ts
  /** Сколько «ждущих приёмки» отдаём разом: экран бота и блок панели читают один список. */
  static readonly AWAITING_LIMIT = 100;

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
   *
   * Статус НЕ меняется (R-P7-6). Событие пишется вставкой в `event` внутри
   * ТОЙ ЖЕ транзакции, а не через EventsService: откат приёмки не должен
   * оставлять в ленте строку о ней.
   */
  async confirm(id: string, actorRef: string, now = new Date()): Promise<TaskRow> {
    await this.assertCan(actorRef, "tasks.confirm");
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(task).where(eq(task.id, id));
      if (!row) throw new NotFoundException(`Задача ${id} не найдена`);
      if (row.status !== "done") {
        throw new BadRequestException("Подтвердить можно только сделанную задачу");
      }

      const patch: Record<string, unknown> = { confirmedAt: now, confirmedBy: actorRef };
      if (row.quality === null) patch.quality = "accepted";

      const [updated] = await tx
        .update(task)
        .set(patch)
        .where(and(eq(task.id, id), isNull(task.confirmedAt)))
        .returning();
      if (!updated) return row; // уже приняли — повторное нажатие не ошибка

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "task.confirmed",
        target: id,
        before: row,
        after: updated,
      });
      await tx.insert(event).values({
        source: "tasks",
        type: "task.confirmed",
        occurredAt: now,
        payload: {
          taskId: id,
          title: updated.title,
          ownerRef: updated.ownerRef,
          confirmedBy: actorRef,
          quality: updated.quality,
        },
      });
      return updated;
    });
  }

  /**
   * Сделанные, но ещё не принятые. Старейшее первым: оно ждёт дольше всех.
   *
   * Момента здесь нет и быть не может — в условии нет ни одного временнóго
   * предиката, и параметр `now` соврал бы о том, от чего зависит ответ.
   * Только `ownerKind='human'`: работа агента приёмки менеджером не требует.
   */
  awaitingConfirmation(limit = TasksService.AWAITING_LIMIT): Promise<TaskRow[]> {
    return this.db
      .select()
      .from(task)
      .where(and(eq(task.status, "done"), isNull(task.confirmedAt), eq(task.ownerKind, "human")))
      .orderBy(asc(task.completedAt))
      .limit(limit);
  }
```
- [x] **Step 8: Маршруты.** `apps/core/src/tasks/tasks.controller.ts`: в `ListTasksDto` — `/** "1" — сделанные, но ещё не принятые. */ @IsOptional() @IsIn(["1"]) awaiting?: string;`; после `SetQualityDto` — `ConfirmTaskDto`; в `list()` (`:206`) ветка ПЕРЕД `unassigned`:
```ts
    // «Ждут приёмки» — отдельная выборка по той же причине, что и свободные:
    // «не принято» это `confirmed_at IS NULL`, а не значение статуса, и через
    // общий фильтр по равенству его не выразить (R-P7-6).
    if (filter.awaiting === "1") return this.tasks.awaitingConfirmation();
```
и рядом с `:id/quality`:
```ts
  /**
   * Приёмка работы менеджером (П7).
   *
   * Свой троттл, как у отчётов: маршрут ходит из бота по кнопке под каждой
   * строкой экрана «ждут подтверждения», и общего потолка хватило бы, чтобы
   * пачка нажатий выглядела атакой.
   */
  @Throttle({ burst: { limit: 12, ttl: 60_000 }, sustained: { limit: 12, ttl: 60_000 } })
  @Post(":id/confirm")
  confirm(@Param("id", ParseUUIDPipe) id: string, @Body() dto: ConfirmTaskDto) {
    return this.tasks.confirm(id, dto.actor ?? "owner");
  }
```
(`Throttle` добавляется в импорт из `@nestjs/throttler`.)
- [x] **Step 9: Лента «Действия».** `apps/core/src/registry/actions.service.ts`: в союз `kind` (`:39-51`) — `| "task_confirmed"` сразу за `"task_done"`; в деструктуризацию (`:93-105`) — `confirmed` сразу за `done`; в `Promise.all` тем же местом — выборка:
```ts
      // Приёмка работы. Отдельной строкой, а не заменой «Закрыл задачу»:
      // закрыл и принял — разные люди и разные моменты, и владельцу нужно
      // видеть оба. Выборка `done` выше НЕ меняется — подтверждённая задача
      // остаётся `done` (R-P7-6).
      this.db
        .select({ at: task.confirmedAt, by: task.confirmedBy, title: task.title })
        .from(task)
        .where(and(isNotNull(task.confirmedAt), gte(task.confirmedAt, lo), lt(task.confirmedAt, hi))),
```
и в разбор, сразу за циклом `done` (`:316-326`):
```ts
    for (const r of confirmed) {
      push(r.at, "task_confirmed", personIdOf(r.by), `👌 Принял работу: ${r.title}`);
    }
```
- [x] **Step 10: Зеркала и смоук.** `apps/bot/src/core-client.ts` (`TaskRow`, `:61-74`) и `apps/cc/src/lib/core.ts` (`Task`, `:1134-1154`) получают поля из «Interfaces (produces)» с докблоками (`closedBy` обязан объяснить, зачем он вееру: из адресатов «подтвердите» исключается тот, кто закрыл). `tools/smoke-core.mjs`, шаг `"/tasks"` (`:481`) превращается в объект и рядом встают два новых:
```js
  {
    path: "/tasks",
    проверить: (ответ) => {
      if (!Array.isArray(ответ)) throw new Error("ожидали массив задач");
      // Засеянная база задач не содержит — проверяем форму, только если
      // строки есть. Пустой список тоже законен: молча зеленеть на нём
      // безопасно, потому что окна ниже проверяют сами запросы.
      const строка = ответ[0];
      if (строка) {
        for (const key of ["confirmedAt", "confirmedBy", "assignNotifiedAt", "closedBy"]) {
          if (!(key in строка)) throw new Error(`в строке задачи нет ${key} — зеркала не увидят приёмку`);
        }
      }
    },
  },
  // Окно «ждут подтверждения» (П7): SQL с `confirmed_at IS NULL` и сортировкой
  // по `completed_at` заглушка БД не исполняет — только живой Postgres.
  {
    path: "/tasks?awaiting=1",
    проверить: (ответ) => {
      if (!Array.isArray(ответ)) throw new Error("ожидали массив ждущих приёмки");
    },
  },
```
- [x] **Step 11:** `pnpm --filter @mydon/db build && pnpm --filter @mydon/db test && pnpm --filter @mydon/shared build && pnpm --filter @mydon/shared test && pnpm --filter core build && pnpm --filter core test && pnpm --filter bot build && pnpm --filter cc test` → GREEN; `pnpm -s typecheck`. На scratch-БД: `node packages/db/dist/migrate.js` ДВАЖДЫ подряд — второй прогон no-op (`IF NOT EXISTS`); `pnpm --filter @mydon/db db:generate` → «No schema changes»; `node tools/smoke-core.mjs` — шаги `/tasks` и `/tasks?awaiting=1` зелёные. Отдельно: миграция обязана пройти на базе, где `task` НЕ пуста, — иначе бэкфилл `assign_notified_at` не проверен ничем; перед `migrate.js` вставить в scratch-БД пару задач с `owner_ref` и убедиться, что после миграции `select count(*) from task where owner_ref is not null and assign_notified_at is null` = 0.
- [x] **Step 12:** `git commit -m "feat(db,core,shared): состояние «подтверждено менеджером» колонками, приёмка задачи и окно awaiting=1 (П7, R-P7-5/R-P7-6)" -- packages/db/src/schema.ts packages/db/src/schema.test.ts packages/db/src/migrations.test.ts packages/db/drizzle packages/shared/src/tasks.ts packages/shared/src/tasks.test.ts apps/core/src/tasks/tasks.service.ts apps/core/src/tasks/tasks.controller.ts apps/core/src/tasks/tasks.test.ts apps/core/src/registry/actions.service.ts apps/core/src/registry/actions.service.test.ts apps/bot/src/core-client.ts apps/cc/src/lib/core.ts tools/smoke-core.mjs`

---

### Task 3 (спека T4) · ВОЛНА 2 — Мост «событие → задача»: пять источников, крон 06:15, два тумблера

Идёт **параллельно с Task 2**: файлы не пересекаются ни одним путём. Из Task 1 нужен только `can(..., "tasks.confirm")` — назначение инфраструктурной задачи.

**Files:** Create `apps/core/src/tasks/task-bridge.service.ts`, `apps/core/src/tasks/task-bridge.test.ts`. Modify `apps/core/src/tasks/tasks.module.ts` (весь файл, 13 строк), `apps/core/src/system/config-spec.ts` (новый блок «Задачи» после блока «Вендинг: полевой контур», рядом с `SHRINK_ALERT_UZS` стр. 195), `apps/core/src/system/config-spec.test.ts` (конец файла), `apps/core/src/cron-shutdown.test.ts` (таблица сервисов стр. 17–29), `docs/DATA_SOURCES.md` (новый раздел после «История склада вендинга» стр. 976–1093).

**Interfaces (consumes):** `TasksService.ensureForDay(input & { dayKey })` (`tasks.service.ts:353`, `onConflictDoNothing({ target: task.source })`, проверка «автомат в эксплуатации» `:363-375`, `audit_log` `:392-398`), `EventsService.list({types, since, limit})` / `.record()` (`events/events.service.ts:23`, `:45` — фильтр типов В SQL, до лимита), `VendingService.machineIndex()` → `{ idBySerial, nameBySerial, firstIdBySerial }` (`vending.service.ts:1359-1370`, форма `:565-572`), `settingValue` / `readIntSetting` (`system/settings.ts:16`, `:40`), `oneOf` / `inRange` (`system/config-spec.ts:28-31`, `:63-70`), `tashkentDay` / `tashkentDayStartOf` / `TZ` (`@mydon/shared`), `can` / `effectiveRoles` (Task 1), `person` (`packages/db/src/schema.ts:141`), `Cron` из `croner` (образец `ourvend/sync-stale.service.ts:69-80`), типы событий `LOW_STOCK_EVENT` / `SHRINK_EVENT` (`vending/shrinkage.service.ts:82-83`), `REFILL_DETECTED_EVENT` (`vending/refill-events.service.ts:43`), `SYNC_STALE_EVENT` (`ourvend/sync-stale.service.ts:23`).

**Interfaces (produces):**
```ts
/** apps/core/src/tasks/task-bridge.service.ts */
type Payload = Record<string, unknown>;

/** Тип события → как из него делается задача. Одна таблица — один источник правды. */
export interface BridgeSource {
  /** Тип события в ленте. */
  type: string;
  /** Префикс ключа дедупа (R-P7-2): `<источник>:<сущность>:<дата Ташкента>`. */
  key: string;
  /** Что считается «сущностью»: серийник автомата или системный контур. */
  scope: "machine" | "system";
  /** Отбор внутри типа: `refill_detected` берёт только несопоставленные окна. */
  accept?: (p: Payload) => boolean;
  priority: (payloads: readonly Payload[]) => TaskPriority;
  title: (name: string, payloads: readonly Payload[]) => string;
  description: (name: string, payloads: readonly Payload[]) => string;
}

export const BRIDGE_SOURCES: readonly BridgeSource[];
export const BRIDGE_EVENT_TYPES: readonly string[];
/** Окно чтения ленты: сутки плюс два часа нахлёста на пропущенный тик. */
export const BRIDGE_WINDOW_MS = 26 * 3_600_000;
/** Потолок чтения ленты. Безопасен: фильтр типов стоит В SQL, до лимита. */
export const BRIDGE_EVENTS_LIMIT = 500;
/** Событие о созданной автозадаче — им же меряется приёмка (T8). */
export const AUTO_CREATED_EVENT = "task.auto_created";
/** Событие прогона. Пишется ТОЛЬКО при обрезке: тихое утро строк не плодит. */
export const BRIDGE_RUN_EVENT = "task.bridge_run";
export const TASK_BRIDGE_MAX_PER_RUN_FALLBACK = 20;

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

/** Срок автозадачи: следующее ташкентское утро, 10:00. */
export function nextMorning(now: Date): Date;

@Injectable()
export class TaskBridgeService implements OnModuleInit, OnApplicationShutdown {
  async run(now?: Date): Promise<BridgeRun>;
}
```

**Пять источников (R-P7-4).** `<Имя>` — имя автомата из `machineIndex().nameBySerial`, при отсутствии карточки — сам серийник.

| Событие | Ключ | Заголовок | Приоритет |
|---|---|---|---|
| `machine.low_stock` | `low_stock:<серийник>:<день>` | `Пополнить <Имя>: заканчивается товар` | `high` |
| `vending.refill_detected` (`recorded === false`) | `refill_unconfirmed:<серийник>:<день>` | `Оформить заливку <Имя>` | `normal` |
| `vending.shrinkage_alert` | `shrinkage:<серийник>:<день>` | `Разобраться с недостачей: <Имя>` | `high` |
| `ourvend.sync_stale` | `sync_stale:system:<день>` | `Сбор OurVend не бежит` | `urgent`, если `hoursSinceSuccess === null`, иначе `high` |
| `ourvend.sync_failed_streak` | `sync_failed:system:<день>` | `Сбор OurVend падает подряд` | `high` |

Что обязана делать реализация:
- **Дата в ключе — ташкентские сутки САМОГО СОБЫТИЯ** (`tashkentDay(e.occurredAt)`), а не прогона: событие в 23:50 попадёт в прогон следующего утра, и ключ обязан назвать день факта — иначе окно нахлёста создало бы вторую задачу про вчерашний вечер.
- **Одна задача на автомат в сутки, а не на позицию** (R-P7-2): группировка в `Map<ключ, Payload[]>` до единого `ensureForDay`. Опустевшая планограмма даёт событие на КАЖДЫЙ товар — это уже случалось, и поэтому у алертов стоит `ALERT_MAX_EVENTS = 50`.
- **Нет карточки реестра по серийнику — задача создаётся БЕЗ `entityId`, но создаётся**: имя автомата остаётся в заголовке, и молчать о работе из-за дырки в реестре нельзя. Побочный эффект осознан: без `entityId` не сработает проверка «автомат вне эксплуатации» — но её и не на чем делать.
- **Сортировка ключей по приоритету (urgent → low), затем по ключу**: потолок должен резать наименее срочное, а не случайное. Обрезка — `warn` со СПИСКОМ неотработанных ключей плюс событие `task.bridge_run` с `capped: true`; тихий прогон событий не пишет.
- **Полевая задача рождается свободной, инфраструктурная — адресной** (R-P7-8): чинить сбор кабинета полевому оператору нечем, в пуле такая задача либо провисит, либо будет взята тем, кто не может её закрыть. Получателей нет — тоже в пул, плюс `warn` и событие `tasks.no_confirmers`.
- **Крон один, работ будет две.** В этой задаче — одна (`run`), под своим `catch`; вторая (`emitOverdue`) приходит в Task 5. Один таймер вместо двух — потому что страж `cron-shutdown.test.ts` описывает сервис с ОДНИМ полем `cron`, а образец «один таймер, две проверки, раздельные `catch`» уже написан в `sync-stale.service.ts:69-80`.

- [x] **Step 1: Тесты RED.**
```ts
// apps/core/src/tasks/task-bridge.test.ts — новый файл
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BRIDGE_EVENT_TYPES, BRIDGE_SOURCES, TaskBridgeService, nextMorning } from "./task-bridge.service";

type Row = Record<string, unknown>;

const СЕЙЧАС = new Date("2026-08-26T06:15:00+05:00");
const СЕРИЙНИК = "2508160376";
const ВТОРОЙ = "2508160359";
const КАРТОЧКА = "44444444-4444-4444-8444-444444444444";
const МЕНЕДЖЕР = "55555555-5555-4555-8555-555555555555";

function событие(type: string, payload: Row, at = "2026-08-26T05:00:00+05:00"): Row {
  return { id: `e-${type}-${String(payload.serial ?? "sys")}-${at}`, source: "system", type, payload, occurredAt: new Date(at) };
}

/**
 * Стенд моста. `настройки` — строки `system_config` (пусто = дефолты спеки),
 * `люди` — карточки под назначение инфраструктурной задачи.
 */
function стенд(opts: { события: Row[]; настройки?: Row[]; люди?: Row[]; конфликты?: Set<string> }) {
  const созданные: Row[] = []; // что реально ушло в ensureForDay
  const записанные: Row[] = []; // события, записанные мостом
  const предупреждения: string[] = [];

  // Единственное чтение базы, которое стенд обязан уметь, — `system_config`:
  // `settingValue`/`readIntSetting` берут таблицу целиком, без where. Выборку
  // людей подменяет `людиСПравом` ниже, поэтому второй цепочки здесь нет.
  const db = { select: () => ({ from: async () => opts.настройки ?? [] }) } as never;

  const tasks = {
    ensureForDay: async (input: Row) => {
      const ключ = `${String(input.source)}:${String(input.dayKey)}`;
      if (opts.конфликты?.has(ключ)) return null;
      const строка = { id: `t-${созданные.length + 1}`, ...input, source: ключ };
      созданные.push(строка);
      return строка;
    },
  } as never;

  const events = {
    list: async () => opts.события,
    record: async (v: Row) => {
      записанные.push(v);
      return v;
    },
  } as never;

  const vending = {
    machineIndex: async () => ({
      idBySerial: new Map([[СЕРИЙНИК, КАРТОЧКА]]),
      nameBySerial: new Map([[СЕРИЙНИК, "Olma"]]),
      firstIdBySerial: new Map([[СЕРИЙНИК, КАРТОЧКА]]),
    }),
  } as never;

  const s = new TaskBridgeService(db, tasks, events, vending);
  // Люди и лог подменяются на стенде: карточки читает отдельный запрос, а
  // громкость обрезки — часть приёмки, и молчаливый логгер её бы спрятал.
  (s as unknown as { людиСПравом: () => Promise<Row[]> }).людиСПравом = async () => opts.люди ?? [];
  (s as unknown as { logger: { warn: (m: string) => void; log: (m: string) => void } }).logger = {
    warn: (m: string) => предупреждения.push(m),
    log: () => undefined,
  };
  return { s, созданные, записанные, предупреждения };
}

describe("Мост «событие → задача» (П7, R-P7-2/R-P7-4/R-P7-7)", () => {
  it("три события «заканчивается» по ОДНОМУ автомату за сутки дают ОДНУ задачу", async () => {
    // Опустевшая планограмма даёт событие на КАЖДЫЙ товар: без агрегации одно
    // утро родило бы столько задач, сколько позиций в автомате.
    const st = стенд({
      события: [
        событие("machine.low_stock", { serial: СЕРИЙНИК, machine: "Olma", product: "Fanta 0,5", left: 1 }),
        событие("machine.low_stock", { serial: СЕРИЙНИК, machine: "Olma", product: "Cola 0,33", left: 2 }),
        событие("machine.low_stock", { serial: СЕРИЙНИК, machine: "Olma", product: "Snickers", left: 0 }),
      ],
    });
    const о = await st.s.run(СЕЙЧАС);
    assert.equal(о.created, 1);
    assert.equal(st.созданные.length, 1);
    assert.equal(st.созданные[0]!.source, `low_stock:${СЕРИЙНИК}:2026-08-26`);
    assert.match(String(st.созданные[0]!.title), /Пополнить Olma/);
    assert.match(String(st.созданные[0]!.description), /Fanta 0,5/);
    assert.match(String(st.созданные[0]!.description), /Snickers/);
  });

  it("два автомата — две задачи", async () => {
    const st = стенд({
      события: [
        событие("machine.low_stock", { serial: СЕРИЙНИК, product: "Fanta 0,5", left: 1 }),
        событие("machine.low_stock", { serial: ВТОРОЙ, product: "Cola 0,33", left: 2 }),
      ],
    });
    assert.equal((await st.s.run(СЕЙЧАС)).created, 2);
  });

  it("повторный прогон по тем же событиям создаёт 0 задач", async () => {
    // Ставку делает БД: частичный уникальный индекс `task_source_key` (0040).
    // `ensureForDay` вернул null — это `skipped`, а не ошибка.
    const st = стенд({
      события: [событие("machine.low_stock", { serial: СЕРИЙНИК, product: "Fanta 0,5", left: 1 })],
      конфликты: new Set([`low_stock:${СЕРИЙНИК}:2026-08-26`]),
    });
    const о = await st.s.run(СЕЙЧАС);
    assert.equal(о.created, 0);
    assert.equal(о.skipped, 1);
    assert.deepEqual(st.записанные, [], "о несозданной задаче событий не пишем");
  });

  it("ключ берёт ташкентские сутки СОБЫТИЯ: 23:50 и прогон в 06:15 дают вчерашний день", async () => {
    // Окно нахлёста (26 ч) существует ради пропущенного тика. Возьми день
    // прогона — и вечернее событие завело бы вторую задачу про вчера.
    const st = стенд({
      события: [событие("machine.low_stock", { serial: СЕРИЙНИК, product: "Fanta 0,5", left: 1 }, "2026-08-25T23:50:00+05:00")],
    });
    await st.s.run(СЕЙЧАС);
    assert.equal(st.созданные[0]!.source, `low_stock:${СЕРИЙНИК}:2026-08-25`);
  });

  it("потолок: 21-й ключ не создаётся, capped=true, в логе — список неотработанных", async () => {
    const события = Array.from({ length: 21 }, (_, i) =>
      событие("machine.low_stock", { serial: `250816${String(i).padStart(4, "0")}`, product: "Fanta", left: 1 }),
    );
    const st = стенд({ события });
    const о = await st.s.run(СЕЙЧАС);
    assert.equal(о.created, 20);
    assert.equal(о.capped, true);
    assert.equal(st.предупреждения.length, 1, "обрезка обязана быть громкой");
    assert.match(st.предупреждения[0]!, /low_stock:2508160020/, "в предупреждении — сам неотработанный ключ");
    assert.ok(st.записанные.some((v) => v.type === "task.bridge_run"), "обрезка уезжает событием");
  });

  it("потолок читается настройкой: 2 — значит две задачи", async () => {
    const st = стенд({
      события: [
        событие("machine.low_stock", { serial: СЕРИЙНИК, product: "Fanta", left: 1 }),
        событие("machine.low_stock", { serial: ВТОРОЙ, product: "Cola", left: 1 }),
        событие("vending.shrinkage_alert", { serial: СЕРИЙНИК, name: "Olma", product: "Snickers", lossUnits: 4, lossValue: 40000, days: 7 }),
      ],
      настройки: [{ key: "TASK_BRIDGE_MAX_PER_RUN", value: "2" }],
    });
    assert.equal((await st.s.run(СЕЙЧАС)).created, 2);
  });

  it("потолок режет НАИМЕНЕЕ срочное: urgent доезжает, normal остаётся", async () => {
    const st = стенд({
      события: [
        событие("vending.refill_detected", { serial: СЕРИЙНИК, name: "Olma", units: 12, windowTo: "2026-08-26T04:00:00.000Z", recorded: false }),
        событие("ourvend.sync_stale", { hoursSinceSuccess: null, lastSuccessAt: null, lastRunStatus: null }),
      ],
      настройки: [{ key: "TASK_BRIDGE_MAX_PER_RUN", value: "1" }],
    });
    await st.s.run(СЕЙЧАС);
    assert.equal(st.созданные[0]!.source, "sync_stale:system:2026-08-26", "urgent обязан пройти первым");
  });

  it("TASK_BRIDGE_ENABLED=0 — прогона нет, disabled=true", async () => {
    const st = стенд({
      события: [событие("machine.low_stock", { serial: СЕРИЙНИК, product: "Fanta", left: 1 })],
      настройки: [{ key: "TASK_BRIDGE_ENABLED", value: "0" }],
    });
    const о = await st.s.run(СЕЙЧАС);
    assert.equal(о.disabled, true);
    assert.equal(о.created, 0);
    assert.deepEqual(st.созданные, [], "выключенный мост не должен трогать ни ленту, ни задачи");
  });

  it("нет карточки реестра по серийнику — задача создаётся БЕЗ entityId, но создаётся", async () => {
    // Дырка в реестре не повод молчать о работе: имя автомата остаётся в
    // заголовке, и человек поймёт, куда ехать.
    const st = стенд({ события: [событие("machine.low_stock", { serial: ВТОРОЙ, product: "Fanta", left: 1 })] });
    await st.s.run(СЕЙЧАС);
    assert.equal(st.созданные[0]!.entityId, undefined);
    assert.match(String(st.созданные[0]!.title), new RegExp(ВТОРОЙ), "в заголовке — сам серийник");
  });

  it("заливка БЕЗ отчёта берётся, заливка с отчётом — нет", async () => {
    // `recorded:false` — окно, за которое мастер так и не отчитался. Строка с
    // `recorded:true` в ленте не появляется вовсе, но отбор обязан быть в коде:
    // иначе первое же уточнение эмитента завело бы задачу на оформленную работу.
    const st = стенд({
      события: [
        событие("vending.refill_detected", { serial: СЕРИЙНИК, name: "Olma", units: 12, windowTo: "2026-08-26T04:00:00.000Z", recorded: false }),
        событие("vending.refill_detected", { serial: ВТОРОЙ, name: "Vend-2", units: 7, windowTo: "2026-08-26T04:00:00.000Z", recorded: true }),
      ],
    });
    assert.equal((await st.s.run(СЕЙЧАС)).created, 1);
  });

  it("`ourvend.sync_stale` с hoursSinceSuccess: null даёт urgent", async () => {
    // «Успехов не было вовсе» тревожнее большого числа: сбор не заводили или
    // он не доехал ни разу.
    const st = стенд({ события: [событие("ourvend.sync_stale", { hoursSinceSuccess: null, lastSuccessAt: null, lastRunStatus: null })] });
    await st.s.run(СЕЙЧАС);
    assert.equal(st.созданные[0]!.priority, "urgent");

    const st2 = стенд({ события: [событие("ourvend.sync_stale", { hoursSinceSuccess: 9, lastSuccessAt: "2026-08-25T20:00:00Z", lastRunStatus: "ok" })] });
    await st2.s.run(СЕЙЧАС);
    assert.equal(st2.созданные[0]!.priority, "high");
  });

  it("инфраструктурная задача уходит первому менеджеру; менеджеров нет — в пул + предупреждение", async () => {
    const сМенеджером = стенд({
      события: [событие("ourvend.sync_failed_streak", { streak: 4, lastError: "timeout", since: "2026-08-25T10:00:00Z" })],
      люди: [{ id: МЕНЕДЖЕР, roles: ["manager"], role: null, active: "yes" }],
    });
    await сМенеджером.s.run(СЕЙЧАС);
    assert.equal(сМенеджером.созданные[0]!.ownerRef, МЕНЕДЖЕР);

    const без = стенд({
      события: [событие("ourvend.sync_failed_streak", { streak: 4, lastError: "timeout", since: "2026-08-25T10:00:00Z" })],
      люди: [],
    });
    await без.s.run(СЕЙЧАС);
    assert.equal(без.созданные[0]!.ownerRef, undefined, "адресата нет — задача идёт в общий пул");
    assert.ok(без.записанные.some((v) => v.type === "tasks.no_confirmers"), "тишину заменяет событие");
    assert.equal(без.предупреждения.length, 1);
  });

  it("полевая задача рождается СВОБОДНОЙ — закрепления за объектами нет", async () => {
    const st = стенд({
      события: [событие("machine.low_stock", { serial: СЕРИЙНИК, product: "Fanta", left: 1 })],
      люди: [{ id: МЕНЕДЖЕР, roles: ["manager"], role: null, active: "yes" }],
    });
    await st.s.run(СЕЙЧАС);
    assert.equal(st.созданные[0]!.ownerRef, undefined, "её разбирают из пула, а не вешают на менеджера");
  });

  it("на каждую созданную задачу пишется task.auto_created", async () => {
    // Этим событием меряется приёмка среза (T8): «тишина» становится
    // измеримой, а не гипотетической.
    const st = стенд({ события: [событие("machine.low_stock", { serial: СЕРИЙНИК, product: "Fanta", left: 1 })] });
    await st.s.run(СЕЙЧАС);
    const е = st.записанные.find((v) => v.type === "task.auto_created");
    assert.ok(е);
    const payload = е!.payload as Row;
    assert.equal(payload.key, `low_stock:${СЕРИЙНИК}:2026-08-26`);
    assert.equal(payload.eventType, "machine.low_stock");
    assert.equal(payload.serial, СЕРИЙНИК);
  });

  it("`nextMorning`: прогон 26.08 06:15 даёт срок 27.08 10:00 по Ташкенту", async () => {
    assert.equal(nextMorning(СЕЙЧАС).toISOString(), new Date("2026-08-27T10:00:00+05:00").toISOString());
    // Граница суток: 23:50 26-го — это всё ещё 26-е, значит утро 27-го.
    assert.equal(
      nextMorning(new Date("2026-08-26T23:50:00+05:00")).toISOString(),
      new Date("2026-08-27T10:00:00+05:00").toISOString(),
    );
  });

  it("BRIDGE_EVENT_TYPES выводится из BRIDGE_SOURCES — второго списка нет", () => {
    // Список типов уходит в SQL-фильтр ленты. Расхождение с таблицей
    // источников означало бы «правило есть, событий не подобрали» — ровно тот
    // дефект, который срез и чинит.
    assert.deepEqual([...BRIDGE_EVENT_TYPES].sort(), BRIDGE_SOURCES.map((s) => s.type).sort());
    assert.equal(BRIDGE_SOURCES.length, 5);
    assert.deepEqual(
      BRIDGE_SOURCES.map((s) => s.key).sort(),
      ["low_stock", "refill_unconfirmed", "shrinkage", "sync_failed", "sync_stale"],
    );
  });
});
```
```ts
// apps/core/src/system/config-spec.test.ts — новый набор в конец файла
describe("Тумблеры моста задач (П7, R-P7-13)", () => {
  it("TASK_BRIDGE_ENABLED — только 0 и 1, по умолчанию ВКЛЮЧЁН", () => {
    // Включён по умолчанию намеренно: выключенный мост повторил бы ровно ту
    // историю, ради которой затевался срез — код есть, задач нет.
    assert.equal(validateConfig("TASK_BRIDGE_ENABLED", "0"), null);
    assert.equal(validateConfig("TASK_BRIDGE_ENABLED", "1"), null);
    assert.match(validateConfig("TASK_BRIDGE_ENABLED", "да") ?? "", /допустимо/);
    assert.equal(specFor("TASK_BRIDGE_ENABLED")?.fallback, "1");
  });

  it("TASK_BRIDGE_MAX_PER_RUN: 0 и 201 отвергаются, 20 принимается", () => {
    assert.match(validateConfig("TASK_BRIDGE_MAX_PER_RUN", "0") ?? "", /от 1 до 200/);
    assert.match(validateConfig("TASK_BRIDGE_MAX_PER_RUN", "201") ?? "", /от 1 до 200/);
    assert.equal(validateConfig("TASK_BRIDGE_MAX_PER_RUN", "20"), null);
    assert.equal(specFor("TASK_BRIDGE_MAX_PER_RUN")?.fallback, "20");
    // Пустое — сброс к дефолту, допустимо всегда.
    assert.equal(validateConfig("TASK_BRIDGE_MAX_PER_RUN", ""), null);
  });

  it("у обоих тумблеров есть русский help — панель показывает его владельцу", () => {
    for (const key of ["TASK_BRIDGE_ENABLED", "TASK_BRIDGE_MAX_PER_RUN"]) {
      assert.ok((specFor(key)?.help ?? "").length > 40, `${key}: help пустой или отписка`);
    }
  });
});
```
```ts
// apps/core/src/cron-shutdown.test.ts — строка в таблицу сервисов
    // Мост «событие → задача» ходит по крону 06:15 (П7, R-P7-7): непойманный
    // `Cron` держит event loop открытым после shutdown — тот же риск, что и у
    // остальных.
    ["task-bridge", () => new TaskBridgeService({} as never, {} as never, {} as never, {} as never)],
```
- [x] **Step 2:** `pnpm --filter core build && pnpm --filter core test` → RED (`./task-bridge.service` не существует, `specFor("TASK_BRIDGE_ENABLED")` = `undefined`).
- [x] **Step 3: Тумблеры.** `apps/core/src/system/config-spec.ts`, новый блок сразу за блоком «Вендинг: полевой контур»:
```ts
  // ── Задачи: мост «событие → задача» (П7, R-P7-13) ──
  {
    key: "TASK_BRIDGE_ENABLED",
    label: "Задачи: мост «событие → задача»",
    kind: "bool",
    fallback: "1",
    help:
      "1 — утром 06:15 события парка превращаются в задачи (заканчивается товар, " +
      "заливка без отчёта, недостача, сбор OurVend). 0 — мост молчит, задачи ставятся руками. " +
      "Это и есть откат: выключать деплоем не нужно.",
    validate: oneOf(["0", "1"]),
  },
  {
    key: "TASK_BRIDGE_MAX_PER_RUN",
    label: "Задачи: потолок автозадач за один прогон",
    kind: "number",
    fallback: "20",
    help:
      "Сколько задач мост создаёт за одно утро. Опустевшая планограмма даёт событие на КАЖДЫЙ " +
      "товар: без потолка одно утро родило бы сотню задач. Обрезка пишется в лог и в событие прогона.",
    validate: inRange(1, 200),
  },
```
- [x] **Step 4: Сервис — таблица источников и утилиты.** `apps/core/src/tasks/task-bridge.service.ts`, верх файла: докблок модуля (почему мост живёт в Core и зовёт метод, а не маршрут — §2.4 спеки: единственный существующий мост молчит в проде 20 дней, а его отказ выглядит как «работ не подошло»), константы из «Interfaces (produces)», `nextMorning`:
```ts
/**
 * Срок автозадачи — СЛЕДУЮЩЕЕ ташкентское утро, 10:00.
 *
 * Отдельная экспортируемая функция, а не выражение внутри цикла: границу
 * суток проверяет тест, а не глаза. Не «сегодня вечером»: задача рождается в
 * 06:15 и попадает в дайджест 07:00, то есть день на неё уже есть; не «через
 * 24 часа» — плавающий срок развалил бы группировку по срочности.
 */
export function nextMorning(now: Date): Date {
  return new Date(tashkentDayStartOf(now).getTime() + 34 * 3_600_000);
}
```
и `BRIDGE_SOURCES` — пять строк по таблице выше, с русскими заголовками и описаниями; описание перечисляет агрегированные позиции, не более десяти, дальше `…и ещё N`:
```ts
/** Сколько позиций печатаем в описании. Дальше — «…и ещё N»: список на сорок строк не читают. */
const ПОЗИЦИЙ_В_ОПИСАНИИ = 10;

function перечислить(items: string[]): string {
  return items.length <= ПОЗИЦИЙ_В_ОПИСАНИИ
    ? items.join(", ")
    : `${items.slice(0, ПОЗИЦИЙ_В_ОПИСАНИИ).join(", ")} …и ещё ${items.length - ПОЗИЦИЙ_В_ОПИСАНИИ}`;
}
```
- [x] **Step 5: Сервис — прогон.** Шаги ровно в этом порядке:
  1. `TASK_BRIDGE_ENABLED !== "1"` → `{ …нули, disabled: true }`, одна строка в лог, выход. Читаем ЯВНО: `(await settingValue(this.db, "TASK_BRIDGE_ENABLED")).trim() === "1"` — `settingValue` возвращает `""` для неизвестного ключа, и «пусто = включено» было бы ложью; фолбэк `"1"` отдаёт сам `resolveEffective`.
  2. `events.list({ types: BRIDGE_EVENT_TYPES, since: new Date(now.getTime() - BRIDGE_WINDOW_MS), limit: BRIDGE_EVENTS_LIMIT })`.
  3. Группировка в `Map<ключ, { src, serial, day, payloads }>` — одна задача на автомат в сутки; ключ `${src.key}:${сущность}:${tashkentDay(e.occurredAt)}`, сущность — `serial` для `scope:"machine"` и `"system"` для `scope:"system"`; событие без серийника у `machine`-источника пропускается с `warn` (payload без ключевого поля — это дефект эмитента, и молчать о нём нельзя).
  4. Резолв `серийник → entityId` одним `machineIndex()` на прогон (`firstIdBySerial`), имя — `nameBySerial.get(canon) ?? canon`.
  5. Сортировка ключей: вес приоритета (`urgent 0 … low 3`), при равенстве — сам ключ.
  6. Срез по `TASK_BRIDGE_MAX_PER_RUN`; остаток → `capped: true`, `warn` со списком и событие `BRIDGE_RUN_EVENT`.
  7. На каждый ключ — `ensureForDay({ title, description, ownerKind: "human", …(ownerRef ? { ownerRef } : {}), source, dayKey, due: nextMorning(now), priority, …(entityId ? { entityId } : {}), domain: "vendhub", createdBy: "task-bridge" })`; `null` → `skipped += 1`.
  8. Создалась → `events.record({ source: "task-bridge", type: AUTO_CREATED_EVENT, payload: { taskId, key, eventType, serial, entityId, day } })`.

  Адресат инфраструктурной задачи — приватный `людиСПравом()`:
```ts
  /**
   * Активные люди с правом `tasks.confirm`, детерминированным порядком.
   *
   * Порядок — `created_at`, затем `id`: «первый менеджер» обязан быть одним и
   * тем же от прогона к прогону, иначе одна и та же авария каждое утро висела
   * бы на разных людях. Легаси-роль учитывается общим `effectiveRoles`: на
   * проде ролей owner/manager нет ни у кого, и без неё адресата не нашлось бы
   * никогда (R-P7-8).
   */
  private async людиСПравом(): Promise<{ id: string }[]> {
    const rows = await this.db
      .select({ id: person.id, roles: person.roles, role: person.role })
      .from(person)
      .where(eq(person.active, "yes"))
      .orderBy(asc(person.createdAt), asc(person.id));
    return rows.filter((p) => can(effectiveRoles(p), "tasks.confirm")).map((p) => ({ id: p.id }));
  }
```
- [x] **Step 6: Крон и регистрация.** В сервисе:
```ts
  /**
   * 06:15 Ташкента. После монитора ТО (06:00) — чтобы не спорить с ним за одни
   * и те же ключи; до дайджеста сотрудникам (07:00) — чтобы созданная утром
   * задача попала в СЕГОДНЯШНИЙ дайджест, а не пролежала сутки; до брифинга
   * владельца (07:30) — чтобы сигнал просрочки дошёл тем же утром.
   */
  onModuleInit(): void {
    this.cron = new Cron("15 6 * * *", { timezone: TZ }, () => {
      // Работа под СВОИМ `catch` (образец `sync-stale.service.ts:69-80`):
      // рядом с ней встанет вторая (эмитент просрочки), и падение одной не
      // должно гасить другую — они спрашивают разные таблицы.
      void this.run().catch((e: unknown) =>
        this.logger.warn(`Мост «событие → задача» не отработал: ${e instanceof Error ? e.message : String(e)}`),
      );
    });
  }

  onApplicationShutdown(): void {
    this.cron?.stop();
    this.cron = null;
  }
```
`apps/core/src/tasks/tasks.module.ts`:
```ts
@Module({
  // Maintenance — ради хука «закрыл задачу ТО → факт в журнале обслуживания».
  // Events + Vending — ради моста «событие → задача» (П7, R-P7-7): он читает
  // ленту и одну карту «серийник → карточка», ту же, что приём слотов.
  // Циклов нет: `TasksModule` не импортирует никто, кроме `app.module`, а
  // `VendingModule` тянет только `ApprovalsModule`.
  imports: [MaintenanceModule, EventsModule, VendingModule],
  controllers: [TasksController],
  providers: [TasksService, TaskBridgeService],
  exports: [TasksService],
})
export class TasksModule {}
```
- [x] **Step 7: Документация.** `docs/DATA_SOURCES.md`, новый раздел «### Задачи из событий (П7)» после блока про историю склада вендинга: пять источников таблицей (тип события → ключ → заголовок), правило ключа `<источник>:<сущность>:<дата Ташкента СОБЫТИЯ>` и почему дата события, а не прогона; крон 06:15 и почему именно он (между монитором ТО и дайджестом); обе настройки с их значениями по умолчанию и тем, что `TASK_BRIDGE_ENABLED=0` — это откат без деплоя; где смотреть результат (`task.source`, событие `task.auto_created`, `select split_part(source,':',1), count(*) …`); честная оговорка про ожидаемый объём — по 14-суточному замеру ленты это 0–3 задачи в первое утро, и ноль законен.
- [x] **Step 8:** `pnpm --filter core build && pnpm --filter core test` → GREEN; `pnpm -s typecheck`. На scratch-БД: `node tools/smoke-core.mjs` — существующие шаги задач и настроек зелёные; `GET /system/config` содержит оба тумблера с `source: "default"`.
- [x] **Step 9:** `git commit -m "feat(core): мост «событие → задача» — пять источников, крон 06:15, потолок и тумблер отката (П7, R-P7-2/R-P7-4/R-P7-7/R-P7-13)" -- apps/core/src/tasks/task-bridge.service.ts apps/core/src/tasks/task-bridge.test.ts apps/core/src/tasks/tasks.module.ts apps/core/src/system/config-spec.ts apps/core/src/system/config-spec.test.ts apps/core/src/cron-shutdown.test.ts docs/DATA_SOURCES.md`

---

### Task 4 (спека T2) · ВОЛНА 3 — Пуш «тебе поручили»: колонка-отметка, пара маршрутов, тихие часы

Идёт **параллельно с Task 5**: файлы не пересекаются. Опирается на колонку `assign_notified_at` из Task 2.

**Files:** Create `apps/bot/src/push-hours.ts`, `apps/bot/src/push-hours.test.ts`, `apps/bot/src/tasks-push.ts`, `apps/bot/src/tasks-push.test.ts`. Modify `packages/shared/src/tashkent-time.ts` (после `tashkentDayStartOf` стр. 68–70), `packages/shared/src/tashkent-time.test.ts` (конец файла), `apps/core/src/tasks/tasks.service.ts` (`claim()` стр. 433–447, `release()` стр. 460–483, `edit()` — строка `set.assignNotifiedAt`, новые методы рядом с `redoUnnotified` стр. 542–571), `apps/core/src/tasks/tasks.controller.ts` (`@Get("assign-unnotified")` рядом с `redo-unnotified` стр. 194–197, `@Post(":id/assign-notified")` рядом с `redo-notified` стр. 237–241), `apps/core/src/tasks/tasks.test.ts` (конец файла), `apps/bot/src/core-client.ts` (рядом с `redoUnnotified`/`markRedoNotified` стр. 733–740), `apps/bot/src/index.ts` (рядом с `sendRedoNotices` стр. 671–707 и её интервалом стр. 709–712), `tools/smoke-core.mjs` (рядом с шагами задач).

**Interfaces (consumes):** `redoUnnotified()` / `markRedoNotified()` (`tasks.service.ts:542-571`) — форма, которую зеркалим; `sendRedoNotices` (`apps/bot/src/index.ts:676-707`) — порядок «доставили → отметили»; `reportUnreachable` (`index.ts:655-671`); `TelegramError.isUnreachable` (`index.ts:695-700`); `taskKeyboard` / `dueLabel` (`apps/bot/src/staff.ts:119`, `@mydon/shared`); `СМЕЩЕНИЕ_МС` (`packages/shared/src/tashkent-time.ts:51`).

**Interfaces (produces):**
```ts
/** packages/shared/src/tashkent-time.ts */
/**
 * Час ташкентских суток (0–23) для момента.
 *
 * Живёт здесь, а не у потребителя: вторая копия смещения зоны в коде — ровно
 * та развилка, на которой донор VendCash уехал на пять часов (R-FW-11).
 * `toLocaleString` не годится: он зависит от набора ICU в рантайме.
 */
export function tashkentHour(at: Date): number;

/** apps/bot/src/push-hours.ts */
/**
 * Тихие часы для НОВЫХ пушей П7 (R-P7-11).
 *
 * Тихих часов в репозитории не было ни в каком виде — конвенцию заводим здесь
 * и УЗКО: ей подчиняются только «тебе поручили» (T2) и «выполнена —
 * подтвердите» (T3). Это пуши по ЧУЖОМУ действию (владелец назначил в 23:40,
 * сотрудник закрыл задачу в полночь), и разбудить ими человека можно ни за что.
 *
 * Напоминания о сроке и возвраты на доработку НЕ трогаем: их поведение —
 * приёмка прошлых срезов, и менять его в срезе про подтверждение значит менять
 * то, за чем в этом PR никто не следит.
 *
 * Автозадачи моста под тихие часы не попадают по построению: они рождаются в
 * 06:15 свободными, а свободные разносит дайджест 07:00.
 */
export const PUSH_HOURS = { from: 7, to: 22 } as const;
export function внутриРабочихЧасов(now: Date): boolean;

/** apps/core/src/tasks/tasks.service.ts */
/** Кому ещё не сказали, что на него повесили задачу. Зеркало `redoUnnotified`. */
assignUnnotified(limit?: number): Promise<TaskRow[]>;
/** Отметка ставится ПОСЛЕ доставки — как у возвратов: сбой сети не должен
 *  превращаться в «сотрудник так и не узнал». */
async markAssignNotified(id: string, now?: Date): Promise<void>;

/** apps/bot/src/core-client.ts */
assignUnnotified(): Promise<TaskRow[]>;
markAssignNotified(id: string): Promise<unknown>;

/** apps/bot/src/index.ts */
async function sendAssignNotices(now?: Date): Promise<void>;
```

Что обязана делать реализация:
- **Четыре точки отметки и все четыре в этом PR** (R-P7-10): `create` с непустым `ownerRef` → NULL (это умолчание колонки, и оно называется комментарием, а не лишней записью); `edit` при РЕАЛЬНОЙ смене `ownerRef` → NULL; `claim` (взял сам) → `now()`; `release` → NULL.
- Условие в `edit` точное: `set.ownerRef !== undefined && set.ownerRef !== before.ownerRef`. Чтение `before` уже стоит там после Task 1 — иначе правка срока слала бы пуш заново.
- Порядок бота — тот же, что у возвратов: **сначала доставка, потом отметка**. Вне рабочих часов отметка НЕ ставится и сообщение не уходит — пуш ждёт утра.
- Недоступен (`TelegramError.isUnreachable`) → `reportUnreachable` **и отметка**, чтобы цикл не долбил Telegram на каждом тике (дословный образец `index.ts:695-700`).
- `assignUnnotified` момента не принимает: в запросе нет ни одного временнóго предиката (см. «Отклонения» №2).

- [x] **Step 1: Тесты RED.**
```ts
// packages/shared/src/tashkent-time.test.ts — новый набор
describe("Час ташкентских суток", () => {
  it("полночь UTC — это пять утра в Ташкенте", () => {
    assert.equal(tashkentHour(new Date("2026-08-26T00:00:00.000Z")), 5);
  });

  it("границы суток не съезжают", () => {
    assert.equal(tashkentHour(new Date("2026-08-26T00:00:00+05:00")), 0);
    assert.equal(tashkentHour(new Date("2026-08-26T23:59:59+05:00")), 23);
    // 19:00 UTC = 00:00 следующих ташкентских суток.
    assert.equal(tashkentHour(new Date("2026-08-25T19:00:00.000Z")), 0);
  });
});
```
```ts
// apps/bot/src/push-hours.test.ts — новый файл
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PUSH_HOURS, внутриРабочихЧасов } from "./push-hours";

describe("Тихие часы новых пушей (П7, R-P7-11)", () => {
  it("окно 7:00–22:00 по Ташкенту, границы включительно снизу и исключительно сверху", () => {
    assert.deepEqual({ ...PUSH_HOURS }, { from: 7, to: 22 });
    assert.equal(внутриРабочихЧасов(new Date("2026-08-26T06:59:00+05:00")), false);
    assert.equal(внутриРабочихЧасов(new Date("2026-08-26T07:00:00+05:00")), true);
    assert.equal(внутриРабочихЧасов(new Date("2026-08-26T21:59:00+05:00")), true);
    assert.equal(внутриРабочихЧасов(new Date("2026-08-26T22:00:00+05:00")), false);
    assert.equal(внутриРабочихЧасов(new Date("2026-08-26T23:40:00+05:00")), false);
  });

  it("решение принимается по ТАШКЕНТУ, а не по часам процесса", () => {
    // 03:00 UTC — это 08:00 в Ташкенте: рабочее время. Контейнер бота может
    // жить с любым TZ, и вопрос «будить ли человека» от этого зависеть не должен.
    assert.equal(внутриРабочихЧасов(new Date("2026-08-26T03:00:00.000Z")), true);
    // 18:00 UTC — 23:00 в Ташкенте: молчим.
    assert.equal(внутриРабочихЧасов(new Date("2026-08-26T18:00:00.000Z")), false);
  });
});
```
```ts
// apps/core/src/tasks/tasks.test.ts — новый набор в конец файла
describe("Отметка «тебе поручили» (П7, R-P7-10)", () => {
  const PERSON = "11111111-1111-4111-8111-111111111111";
  const ДРУГОЙ = "22222222-2222-4222-8222-222222222222";
  const СЕЙЧАС = new Date("2026-08-26T10:00:00+05:00");

  it("«взял сам» гасит пуш: рассказывать человеку то, что он только что сделал, незачем", async () => {
    const патчи: Record<string, unknown>[] = [];
    const tx = {
      update: () => ({
        set: (p: Record<string, unknown>) => {
          патчи.push(p);
          return { where: () => ({ returning: async () => [{ id: "t1", ownerRef: PERSON }] }) };
        },
      }),
      insert: () => ({ values: async () => [] }),
      select: () => ({ from: () => ({ where: async () => [] }) }),
    };
    const db = { transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx) } as never;
    await makeTasks(db).claim("t1", PERSON, СЕЙЧАС);
    assert.equal(патчи[0]!.assignNotifiedAt, СЕЙЧАС);
  });

  it("возврат в пул возвращает отметку в NULL — следующему исполнителю пуш положен", async () => {
    const патчи: Record<string, unknown>[] = [];
    const before = { id: "t1", ownerRef: PERSON, status: "in_progress" };
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [before] }) }) }),
      update: () => ({
        set: (p: Record<string, unknown>) => {
          патчи.push(p);
          return { where: () => ({ returning: async () => [{ ...before, ...p }] }) };
        },
      }),
      insert: () => ({ values: async () => [] }),
    };
    const db = { transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx) } as never;
    await makeTasks(db).release("t1", PERSON);
    assert.equal(патчи[0]!.assignNotifiedAt, null);
  });

  it("edit со сменой исполнителя сбрасывает отметку, edit со сменой срока — нет", async () => {
    // Иначе правка срока слала бы «📌 Тебе поручили» заново — по работе,
    // которую человек уже неделю как взял.
    const задача = { id: "t1", ownerKind: "human", ownerRef: PERSON, priority: "normal", due: null };
    const смена = editStub(задача);
    await makeTasks(смена.db).edit("t1", { ownerRef: ДРУГОЙ });
    assert.equal(смена.captured[0]!.assignNotifiedAt, null);

    const срок = editStub(задача);
    await makeTasks(срок.db).edit("t1", { due: new Date("2026-08-27T05:00:00Z") });
    assert.equal("assignNotifiedAt" in срок.captured[0]!, false, "срок к назначению отношения не имеет");

    const тотЖе = editStub(задача);
    await makeTasks(тотЖе.db).edit("t1", { ownerRef: PERSON });
    assert.equal("assignNotifiedAt" in тотЖе.captured[0]!, false, "смены нет — пуша нет");
  });

  it("`assign-unnotified` спрашивает назначенные и незакрытые без отметки", async () => {
    const запросы: string[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: (w: unknown) => {
            запросы.push(String(w));
            return { limit: async () => [{ id: "t1", ownerRef: PERSON }] };
          },
        }),
      }),
    } as never;
    const строки = await makeTasks(db).assignUnnotified();
    assert.deepEqual(строки.map((r) => r.id), ["t1"]);
    // Заглушка БД SQL не исполняет — утверждаем состав условия; работу
    // частичного индекса проверяет дымовой прогон против живого Postgres.
    assert.match(запросы[0]!, /assign_notified_at/);
    assert.match(запросы[0]!, /owner_ref/);
  });
});
```
```ts
// apps/bot/src/tasks-push.test.ts — новый файл
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { внутриРабочихЧасов } from "./push-hours";
import type { TaskRow } from "./core-client";

/**
 * Петля «тебе поручили» проверяется через ВЫНЕСЕННУЮ функцию доставки, а не
 * через `index.ts`: тот поднимает Telegram, Core и все таймеры сразу. В
 * `index.ts` остаётся связывание и интервал, а решение «кому, что и когда» —
 * здесь, потому что каждый его шаг необратим (отправленное сообщение,
 * поставленная отметка).
 */
import { доставитьНазначения } from "./tasks-push";

const РАБОЧЕЕ = new Date("2026-08-26T10:00:00+05:00");
const НОЧЬ = new Date("2026-08-26T23:40:00+05:00");
const PERSON = "11111111-1111-4111-8111-111111111111";

const задача = (over: Partial<TaskRow> = {}): TaskRow =>
  ({
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "Пополнить Olma",
    description: null,
    ownerKind: "human",
    ownerRef: PERSON,
    status: "todo",
    priority: "high",
    due: "2026-08-27T05:00:00.000Z",
    resultNote: null,
    entityId: null,
    quality: null,
    completedAt: null,
    closedBy: null,
    confirmedAt: null,
    confirmedBy: null,
    assignNotifiedAt: null,
    ...over,
  }) as TaskRow;

class Недоступен extends Error {
  readonly isUnreachable = true;
  readonly description = "bot was blocked by the user";
}

function стенд(opts: { задачи: TaskRow[]; чат?: string | null; падать?: Error }) {
  const отправлено: { chat: number; text: string }[] = [];
  const отмечено: string[] = [];
  const жалобы: string[] = [];
  const deps = {
    assignUnnotified: async () => opts.задачи,
    people: async () => [{ id: PERSON, name: "Рустам", tgChatId: opts.чат === undefined ? "111" : opts.чат, active: "yes" }],
    markAssignNotified: async (id: string) => {
      отмечено.push(id);
    },
    send: async (chat: number, text: string) => {
      if (opts.падать) throw opts.падать;
      отправлено.push({ chat, text });
    },
    reportUnreachable: async (personId: string) => {
      жалобы.push(personId);
    },
    isUnreachable: (e: unknown) => e instanceof Недоступен,
  };
  return { deps, отправлено, отмечено, жалобы };
}

describe("Пуш «тебе поручили» (П7, R-P7-10/R-P7-11)", () => {
  it("доставили → отметили, именно в таком порядке", async () => {
    const st = стенд({ задачи: [задача()] });
    await доставитьНазначения(st.deps, РАБОЧЕЕ);
    assert.equal(st.отправлено.length, 1);
    assert.match(st.отправлено[0]!.text, /📌 Тебе поручили: Пополнить Olma/);
    assert.deepEqual(st.отмечено, ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
  });

  it("при сбое Telegram отметки НЕТ — иначе человек не узнал бы о задаче никогда", async () => {
    const st = стенд({ задачи: [задача()], падать: new Error("500 from Telegram") });
    await доставитьНазначения(st.deps, РАБОЧЕЕ);
    assert.deepEqual(st.отмечено, []);
  });

  it("заблокировал бота: жалоба владельцу И отметка, чтобы цикл не долбил Telegram", async () => {
    // Тот же размен, что у возвратов на доработку (`index.ts:695-700`):
    // неотмеченная задача при недоступном человеке означает запрос в Telegram
    // на каждом тике, вечно.
    const st = стенд({ задачи: [задача()], падать: new Недоступен() });
    await доставитьНазначения(st.deps, РАБОЧЕЕ);
    assert.deepEqual(st.жалобы, [PERSON]);
    assert.deepEqual(st.отмечено, ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]);
  });

  it("вне рабочих часов пуш не уходит и отметка не ставится — придёт утром", async () => {
    assert.equal(внутриРабочихЧасов(НОЧЬ), false);
    const st = стенд({ задачи: [задача()] });
    await доставитьНазначения(st.deps, НОЧЬ);
    assert.deepEqual(st.отправлено, []);
    assert.deepEqual(st.отмечено, [], "отметка без доставки — это «сказали» без «сказали»");
  });

  it("исполнитель без Telegram пропускается молча — он увидит задачу в списке", async () => {
    const st = стенд({ задачи: [задача()], чат: null });
    await доставитьНазначения(st.deps, РАБОЧЕЕ);
    assert.deepEqual(st.отправлено, []);
    assert.deepEqual(st.отмечено, [], "отметить недоставленное значит потерять пуш при будущей привязке чата");
  });
});
```
- [x] **Step 2:** `pnpm --filter @mydon/shared build && pnpm --filter @mydon/shared test` → RED (`tashkentHour` нет); `pnpm --filter core build && pnpm --filter core test` → RED (`assignUnnotified` нет, `claim` третьего аргумента не знает); `pnpm --filter bot build && pnpm --filter bot test` → RED («Cannot find module ./push-hours», «./tasks-push»).
- [x] **Step 3: Час Ташкента и тихие часы.** `packages/shared/src/tashkent-time.ts` — `tashkentHour` из «Interfaces (produces)»:
```ts
export function tashkentHour(at: Date): number {
  return new Date(at.getTime() + СМЕЩЕНИЕ_МС).getUTCHours();
}
```
`apps/bot/src/push-hours.ts` — докблок из «Interfaces (produces)» целиком (он единственное место, где записано, ПОЧЕМУ конвенция узкая) плюс:
```ts
export function внутриРабочихЧасов(now: Date): boolean {
  const час = tashkentHour(now);
  return час >= PUSH_HOURS.from && час < PUSH_HOURS.to;
}
```
- [x] **Step 4: Core — выборка и отметка.** `apps/core/src/tasks/tasks.service.ts`, рядом с `redoUnnotified` (`:542`):
```ts
  /**
   * Кому ещё не сказали, что на него повесили задачу (R-P7-10).
   *
   * Зеркало `redoUnnotified`: та же форма пары «спросить кого — отметить
   * доставку», уже проверенная возвратами на доработку. Без колонки бот не мог
   * бы спросить это иначе как перебором всех задач.
   *
   * Момента здесь нет: в условии нет ни одного временнóго предиката.
   */
  assignUnnotified(limit = 50): Promise<TaskRow[]> {
    return this.db
      .select()
      .from(task)
      .where(
        and(
          eq(task.ownerKind, "human"),
          isNotNull(task.ownerRef),
          ne(task.status, "done"),
          ne(task.status, "cancelled"),
          isNull(task.assignNotifiedAt),
        ),
      )
      .limit(limit);
  }

  /** Отметка ставится ПОСЛЕ доставки: сбой сети не должен превращаться в
   *  «сотрудник так и не узнал». */
  async markAssignNotified(id: string, now = new Date()): Promise<void> {
    await this.db.update(task).set({ assignNotifiedAt: now }).where(eq(task.id, id));
  }
```
Четыре точки: в `create()` — комментарий над `.values({…})`, что NULL — это умолчание колонки и оно означает «пуш положен»; в `edit()` после блока `if (patch.ownerRef !== undefined)` — сброс при реальной смене; в `claim(id, personId, now = new Date())` — `assignNotifiedAt: now` в `.set(...)` (сигнатура получает третий параметр с умолчанием, контроллер не правится); в `release()` — `assignNotifiedAt: null` в `.set(...)`.
- [x] **Step 5: Маршруты.** `apps/core/src/tasks/tasks.controller.ts`, рядом с `redo-unnotified` (`:194`) — `@Get("assign-unnotified")` (ОБЯЗАТЕЛЬНО выше параметрического `:id`, иначе перехват), и рядом с `redo-notified` (`:237`) — `@Post(":id/assign-notified")`, отвечающий `{ ok: true }`, как сосед.
- [x] **Step 6: Клиент бота.** `apps/bot/src/core-client.ts`, рядом с `redoUnnotified`/`markRedoNotified` (`:733-740`): `assignUnnotified()` → `GET /tasks/assign-unnotified`, `markAssignNotified(id)` → `POST /tasks/${id}/assign-notified`, с докблоками про порядок «доставили → отметили».
- [x] **Step 7: Петля бота.** Новый модуль `apps/bot/src/tasks-push.ts` с `доставитьНазначения(deps, now)` по форме стенда из Step 1 (зависимости инъекцией — иначе шаги, каждый из которых необратим, проверяются только живым Telegram) и текстом:
```ts
  const текст = `📌 Тебе поручили: ${t.title}\n${dueLabel(t.due, now)}`;
```
плюс `taskKeyboard(t)`. В `apps/bot/src/index.ts` рядом с `sendRedoNotices` — связывание:
```ts
  /**
   * «Тебе поручили»: задача назначена — исполнитель должен узнать сразу, а не
   * в 07:00 дайджестом и не через полчаса напоминанием о сроке.
   *
   * Порядок тот же, что у возвратов: сначала доставка, потом отметка. Вне
   * рабочих часов (R-P7-11) отметка НЕ ставится — пуш ждёт утра.
   */
  async function sendAssignNotices(now = new Date()): Promise<void> {
    await доставитьНазначения(
      {
        assignUnnotified: () => deps.core.assignUnnotified(),
        people: () => deps.core.people(),
        markAssignNotified: (id) => deps.core.markAssignNotified(id).then(() => undefined),
        send: async (chat, text, keyboard) => {
          await tg.sendMessage(chat, text, keyboard);
        },
        reportUnreachable: (personId, reason) => reportUnreachable(personId, reason),
        isUnreachable: (e) => e instanceof TelegramError && e.isUnreachable,
      },
      now,
    );
  }

  const assignEveryMs = Number(process.env.ASSIGN_NOTIFY_INTERVAL_MS ?? 60_000);
  setInterval(() => {
    void sendAssignNotices().catch((err: unknown) => console.error("Назначения:", err));
  }, assignEveryMs).unref();
```
- [x] **Step 8: Смоук.** В `tools/smoke-core.mjs`, рядом с шагами задач:
```js
  // Окно «кому ещё не сказали» (П7): частичный индекс `task_assign_pending_idx`
  // и условие по трём колонкам — юнит-заглушка SQL не исполняет.
  {
    path: "/tasks/assign-unnotified",
    проверить: (ответ) => {
      if (!Array.isArray(ответ)) throw new Error("ожидали массив назначенных без отметки");
    },
  },
```
- [x] **Step 9:** `pnpm --filter @mydon/shared build && pnpm --filter @mydon/shared test && pnpm --filter core build && pnpm --filter core test && pnpm --filter bot build && pnpm --filter bot test` → GREEN; `pnpm -s typecheck`. На scratch-БД: `node tools/smoke-core.mjs` — шаг `/tasks/assign-unnotified` зелёный.
- [x] **Step 10:** `git commit -m "feat(core,bot,shared): пуш «тебе поручили» со своей отметкой и тихими часами (П7, R-P7-10/R-P7-11)" -- packages/shared/src/tashkent-time.ts packages/shared/src/tashkent-time.test.ts apps/core/src/tasks/tasks.service.ts apps/core/src/tasks/tasks.controller.ts apps/core/src/tasks/tasks.test.ts apps/bot/src/push-hours.ts apps/bot/src/push-hours.test.ts apps/bot/src/tasks-push.ts apps/bot/src/tasks-push.test.ts apps/bot/src/core-client.ts apps/bot/src/index.ts tools/smoke-core.mjs`

---

### Task 5 (спека T7) · ВОЛНА 3 — Эмитент `task.overdue`: мёртвое правило оживает со ВТОРОГО дня

Идёт **параллельно с Task 4**: файлы не пересекаются. Опирается на `TaskBridgeService` из Task 3 — вторая работа того же крона.

**Files:** Modify `apps/core/src/tasks/task-bridge.service.ts` (крон `onModuleInit`, новый метод), `apps/core/src/tasks/task-bridge.test.ts` (новый набор), `apps/core/src/tasks/tasks.module.ts` (`RulesModule` в `imports`), `apps/core/src/cron-shutdown.test.ts` (арность конструктора в строке `task-bridge`). Create — нет.

**Interfaces (consumes):** `RulesService.claim(key)` — атомарная одноразовая заявка через `RETURNING` (`rules/rules.service.ts:56-73`), `RulesModule` экспортирует `RulesService` (`rules/rules.module.ts:7-12`); правило `task.overdue` (`rules/rules.ts:358-363`, `urgency: "immediate"`, печатает `payload.title`); `RULE_EVENT_TYPES` выводится из `RULES` (`rules.ts:601`); `tashkentDay` / `tashkentDayStartOf`; `task` (`packages/db/src/schema.ts:171`); напоминание бота «⏰ Просрочено» владельцу (`apps/bot/src/index.ts:625-634`, отметка `reminded_at` ставится навсегда).

**Interfaces (produces):**
```ts
/** apps/core/src/tasks/task-bridge.service.ts */
/**
 * Потолок событий просрочки за прогон.
 *
 * Правило `task.overdue` — `immediate` (`rules.ts:358`), то есть КАЖДОЕ
 * событие превращается в отдельное сообщение владельцу. Двадцати хватает,
 * чтобы понять масштаб; двадцать первое читать уже не будут.
 */
export const OVERDUE_MAX_EVENTS = 20;
export const OVERDUE_EVENT = "task.overdue";

/**
 * Просрочка → событие `task.overdue`, раз в ташкентские сутки на задачу.
 *
 * ПОЧЕМУ СО ВТОРОГО ДНЯ. Бот уже шлёт владельцу «⏰ Просрочено» один раз на
 * задачу (`apps/bot/src/index.ts:625-634`, отметка `reminded_at` ставится
 * навсегда). Эмитить с первого дня значило бы дать владельцу два сообщения об
 * одном и том же в одно утро. Граница — `due < начало СЕГОДНЯШНИХ ташкентских
 * суток`: первый день просрочки принадлежит боту, второй и дальше — правилу.
 *
 * ДЕДУП — заявкой, а не сканом ленты: ключ `task-overdue:<день>:<taskId>`
 * известен заранее, и `RulesService.claim` разрешает гонку через RETURNING
 * точнее, чем сравнение payload'ов (так дедупятся сторожа, где ключа заранее
 * нет).
 */
async emitOverdue(now?: Date): Promise<{ emitted: number; capped: boolean }>;
```

Что обязана делать реализация:
- Выборка: `due IS NOT NULL AND due < tashkentDayStartOf(now) AND status NOT IN ('done','cancelled')`, сортировка по `due` ВВЕРХ (старейшее первым), лимит `OVERDUE_MAX_EVENTS + 1` — чтобы `capped` был фактом, а не догадкой.
- Payload: `{ taskId, title, due, ownerRef, daysOverdue }`. `title` обязателен — его печатает правило (`rules.ts:362`); без него владелец получит «Просрочена задача: —».
- Правило `task.overdue` **не трогаем**: оно уже написано и уже в `RULE_EVENT_TYPES`. Срез его оживляет, а не заводит новое.
- Строку в брифинге (`registry.service.ts:200-208`) менять не нужно — она уже считает просрочку; в приёмке сверяем, что число и поток сигналов сходятся.
- Вторая работа встаёт в ТОТ ЖЕ крон под СВОИМ `catch`: падение выборки просрочки не должно гасить мост, и наоборот.

- [x] **Step 1: Тесты RED.**
```ts
// apps/core/src/tasks/task-bridge.test.ts — новый набор в конец файла
describe("Эмитент просрочки (П7, R-P7-5, T7)", () => {
  const СЕЙЧАС = new Date("2026-08-26T06:15:00+05:00");

  /** Стенд просрочки: строки задач, заявки ключей, записанные события. */
  function стендПросрочки(opts: { задачи: Row[]; занятые?: Set<string> }) {
    const записанные: Row[] = [];
    const заявки: string[] = [];
    const db = {
      select: () => ({
        from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => opts.задачи }) }) }),
      }),
    } as never;
    const events = { record: async (v: Row) => { записанные.push(v); return v; } } as never;
    const rules = {
      claim: async (key: string) => {
        заявки.push(key);
        return !(opts.занятые?.has(key) ?? false);
      },
    } as never;
    const s = new TaskBridgeService(db, {} as never, events, {} as never, rules);
    return { s, записанные, заявки };
  }

  const просрочка = (id: string, due: string, over: Row = {}): Row => ({
    id,
    title: `Задача ${id}`,
    due: new Date(due),
    ownerRef: null,
    status: "todo",
    ...over,
  });

  it("задача, просроченная СЕГОДНЯ, события не даёт — первый день за ботом", async () => {
    // Бот уже прислал владельцу «⏰ Просрочено» один раз. Второе сообщение об
    // одном и том же в одно утро — это способ приучить не читать оба.
    const st = стендПросрочки({ задачи: [просрочка("t1", "2026-08-26T09:00:00+05:00")] });
    const о = await st.s.emitOverdue(СЕЙЧАС);
    assert.equal(о.emitted, 0);
    assert.deepEqual(st.записанные, []);
  });

  it("задача, просроченная вчера, даёт событие один раз в сутки", async () => {
    const st = стендПросрочки({ задачи: [просрочка("t1", "2026-08-25T18:00:00+05:00")] });
    assert.equal((await st.s.emitOverdue(СЕЙЧАС)).emitted, 1);
    assert.deepEqual(st.заявки, ["task-overdue:2026-08-26:t1"]);
    const payload = st.записанные[0]!.payload as Row;
    assert.equal(payload.title, "Задача t1", "без title правило напечатает «Просрочена задача: —»");
    assert.equal(payload.daysOverdue, 1);
  });

  it("повторный прогон в те же сутки события не даёт — ключ занят", async () => {
    const st = стендПросрочки({
      задачи: [просрочка("t1", "2026-08-25T18:00:00+05:00")],
      занятые: new Set(["task-overdue:2026-08-26:t1"]),
    });
    assert.equal((await st.s.emitOverdue(СЕЙЧАС)).emitted, 0);
    assert.deepEqual(st.записанные, [], "заявка проиграна — события быть не должно");
  });

  it("двадцать первая просрочка не эмитится, capped=true", async () => {
    // Лимит выборки — OVERDUE_MAX_EVENTS + 1: так «показано не всё» становится
    // фактом, а не догадкой по равенству длин.
    const задачи = Array.from({ length: OVERDUE_MAX_EVENTS + 1 }, (_, i) =>
      просрочка(`t${i}`, "2026-08-20T18:00:00+05:00"),
    );
    const st = стендПросрочки({ задачи });
    const о = await st.s.emitOverdue(СЕЙЧАС);
    assert.equal(о.emitted, OVERDUE_MAX_EVENTS);
    assert.equal(о.capped, true);
  });

  it("ровно двадцать просрочек — не обрезка", async () => {
    const задачи = Array.from({ length: OVERDUE_MAX_EVENTS }, (_, i) => просрочка(`t${i}`, "2026-08-20T18:00:00+05:00"));
    const st = стендПросрочки({ задачи });
    const о = await st.s.emitOverdue(СЕЙЧАС);
    assert.equal(о.emitted, OVERDUE_MAX_EVENTS);
    assert.equal(о.capped, false);
  });

  it("done и cancelled не эмитятся — их отсекает сам запрос", async () => {
    // Заглушка SQL не исполняет, поэтому утверждаем состав условия: строка
    // `status not in ('done','cancelled')` обязана быть в запросе, иначе
    // закрытая вчера задача разбудила бы владельца сегодня.
    const условия: string[] = [];
    const db = {
      select: () => ({
        from: () => ({
          where: (w: unknown) => {
            условия.push(String(w));
            return { orderBy: () => ({ limit: async () => [] }) };
          },
        }),
      }),
    } as never;
    const s = new TaskBridgeService(db, {} as never, { record: async () => ({}) } as never, {} as never, { claim: async () => true } as never);
    await s.emitOverdue(СЕЙЧАС);
    assert.match(условия[0]!, /status/);
    assert.match(условия[0]!, /due/);
  });
});
```
- [x] **Step 2:** `pnpm --filter core build && pnpm --filter core test` → RED (`emitOverdue` не существует, конструктор принимает четыре аргумента).
- [x] **Step 3: Пятый аргумент и вторая работа.** `apps/core/src/tasks/task-bridge.service.ts`: конструктор получает `private readonly rules: RulesService` пятым параметром; константы `OVERDUE_MAX_EVENTS` / `OVERDUE_EVENT`; метод `emitOverdue` с докблоком из «Interfaces (produces)»:
```ts
  async emitOverdue(now = new Date()): Promise<{ emitted: number; capped: boolean }> {
    const граница = tashkentDayStartOf(now);
    const строки = await this.db
      .select({ id: task.id, title: task.title, due: task.due, ownerRef: task.ownerRef })
      .from(task)
      .where(
        and(
          isNotNull(task.due),
          lt(task.due, граница),
          ne(task.status, "done"),
          ne(task.status, "cancelled"),
        ),
      )
      .orderBy(asc(task.due))
      .limit(OVERDUE_MAX_EVENTS + 1);

    const capped = строки.length > OVERDUE_MAX_EVENTS;
    const день = tashkentDay(now);
    let emitted = 0;
    for (const t of строки.slice(0, OVERDUE_MAX_EVENTS)) {
      // Ключ известен заранее — заявка через RETURNING точнее скана ленты.
      if (!(await this.rules.claim(`task-overdue:${день}:${t.id}`))) continue;
      await this.events.record({
        source: "tasks",
        type: OVERDUE_EVENT,
        occurredAt: now,
        payload: {
          taskId: t.id,
          title: t.title,
          due: t.due?.toISOString() ?? null,
          ownerRef: t.ownerRef,
          daysOverdue: Math.max(1, Math.round((граница.getTime() - (t.due?.getTime() ?? 0)) / 86_400_000)),
        },
      });
      emitted += 1;
    }
    if (capped) {
      this.logger.warn(
        `Просроченных задач больше ${OVERDUE_MAX_EVENTS}: показано ${OVERDUE_MAX_EVENTS}, остальные молчат до разбора`,
      );
    }
    return { emitted, capped };
  }
```
и в `onModuleInit` — вторая работа под своим `catch`, рядом с первой:
```ts
      void this.emitOverdue().catch((e: unknown) =>
        this.logger.warn(`Эмитент просрочки не отработал: ${e instanceof Error ? e.message : String(e)}`),
      );
```
- [x] **Step 4: Модуль, страж и арность существующих стендов.** `apps/core/src/tasks/tasks.module.ts` — `RulesModule` в `imports` с комментарием, что он нужен ради одноразовых ключей дедупа (`RulesService.claim`), а не ради правил как таковых. `apps/core/src/cron-shutdown.test.ts` — строка `task-bridge` получает пятый `{} as never`. В `task-bridge.test.ts` стенд моста (`стенд`, Task 3 Step 1) получает пятым аргументом `{ claim: async () => true } as never`: конструктор вырос, и тесты моста обязаны собраться — правка механическая, но пропустить её значит уронить ВСЮ волну на компиляции.
- [x] **Step 5:** `pnpm --filter core build && pnpm --filter core test` → GREEN; `pnpm -s typecheck`. На scratch-БД: `node tools/smoke-core.mjs` — существующие шаги правил и брифинга зелёные.
- [x] **Step 6:** `git commit -m "feat(core): эмитент task.overdue со второго дня просрочки — мёртвое правило оживает (П7, R-P7-5)" -- apps/core/src/tasks/task-bridge.service.ts apps/core/src/tasks/task-bridge.test.ts apps/core/src/tasks/tasks.module.ts apps/core/src/cron-shutdown.test.ts`

---

### Task 6 (спека T3) · ВОЛНА 4 — Веер менеджерам «выполнена — подтвердите» и возврат в работу с причиной

Идёт ПОСЛЕ Task 4: делит с ней `bot/index.ts`, `bot/core-client.ts` и подчиняется её `push-hours.ts`.

**Files:** Create `apps/bot/src/task-confirm.ts`, `apps/bot/src/task-confirm.test.ts`. Modify `apps/bot/src/index.ts` (рядом с петлёй назначений из Task 4), `apps/bot/src/core-client.ts` (рядом с `assignUnnotified` из Task 4), `apps/bot/src/staff.ts` (импорты стр. 1–90, разбор текста активного визарда стр. 436–441, `handleStaffCallback` стр. 626–700), `apps/core/src/rules/rules.ts` (список `RULES`, рядом с `task.overdue` стр. 358–363), `apps/core/src/rules/rules.test.ts` (конец файла).

**Interfaces (consumes):** `GET /tasks?awaiting=1` (Task 2), `POST /tasks/:id/confirm` (Task 2), `POST /tasks/:id/quality` с `actor` (Task 1), `POST /tasks/:id/comments` (`tasks.controller.ts:225-228`), `claimNotification(key)` (`apps/bot/src/core-client.ts:950-957`), `recordEvent(type, payload)` (`core-client.ts:668-673`), `effectiveRoles`/`can` (Task 1), `внутриРабочихЧасов` (Task 4), `Conversations` (TTL 45 мин, `apps/bot/src/conversation.ts:23-30`), образец отказа «получателей нет» (`apps/bot/src/weekly-delivery.ts:114-131`), `RULE_EVENT_TYPES` выводится из `RULES` (`rules.ts:601`).

**Interfaces (produces):**
```ts
/** apps/bot/src/task-confirm.ts */
/** Кому положено подтверждать: право `tasks.confirm`, активен, есть чат. */
export function confirmRecipients(people: readonly PersonRow[]): PersonRow[];

/**
 * Ключ веера: по ЧЕЛОВЕКУ, а не на рассылку (R-P7-9).
 *
 * Ключ на всю рассылку заставил бы сбой одного чата лишить подтверждения
 * ВСЕХ — этот урок уже записан в `weeklyDigestKey`. Заявка занимается ДО
 * отправки: цена дубля («подтвердите» пришло дважды пятерым) выше цены редкой
 * потери — задача никуда не девается, она на экране «ждут подтверждения».
 */
export function confirmKey(taskId: string, personId: string): string; // task-confirm:<taskId>:<personId>
/** Ключ запасного пути «адресатов нет»: строка владельцу тоже одноразовая. */
export function ownerFallbackKey(taskId: string): string; // task-confirm:<taskId>:owner-fallback

/** Текст и кнопки одного «подтвердите». */
export function formatConfirmRequest(t: TaskRow, closerName: string, now?: Date): StaffReply;

/** Разбор нажатия. Префикс `tc:` — своё пространство, `t:` не трогаем. */
export function parseConfirmCallback(data: string): { id: string; action: "ok" | "redo" } | null;
/** Отмена мастера возврата. Отдельной строкой, а не третьим действием: у неё нет id. */
export const CONFIRM_CANCEL = "tc:x";

/** Мастер «вернуть в работу»: одна строка причины, состояние в памяти, TTL 45 мин. */
export const REDO_FLOW = "task-redo";
export function startConfirmRedo(chatId: number, t: TaskRow, deps: { conversations: Conversations }): StaffReply;
export function confirmRedoStepHint(step: string): string;
export async function handleConfirmRedoReason(
  chatId: number,
  text: string,
  person: PersonRow,
  deps: { conversations: Conversations; core: CoreClient },
): Promise<StaffReply>;

/** Тип события «подтверждать некому» — зеркало `weekly-digest.no_recipients`. */
export const NO_CONFIRMERS_EVENT = "tasks.no_confirmers";

/** Доставка веера. Инъекция зависимостей — каждый шаг здесь необратим. */
export async function разослатьПодтверждения(deps: ConfirmDeps, now?: Date): Promise<void>;

/** apps/bot/src/core-client.ts */
awaitingTasks(): Promise<TaskRow[]>;
confirmTask(id: string, actor: string): Promise<TaskRow>;
rateTask(id: string, quality: "excellent" | "accepted" | "redo", actor: string): Promise<TaskRow>;

/** apps/core/src/rules/rules.ts — новое правило рядом с task.overdue */
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

Текст веера (по донору, но поверх модели MYDON):
```
🟡 Выполнена: <title>
Закрыл: <имя> · <дата и время по Ташкенту>
Отчёт: <resultNote>
[👌 Принять] [↩ Вернуть в работу]
```

Что обязана делать реализация:
- Заявка `claimNotification(confirmKey(...))` — **ДО** отправки, по каждому адресату отдельно.
- Из адресатов исключается закрывший: `t.closedBy === "person:<его id>"`. Это единственное, что мешает менеджеру подтверждать самому себе по пушу.
- Адресатов нет → одна строка в чаты владельца (под своим одноразовым ключом), событие `tasks.no_confirmers` с payload `{ taskId, title }` и `console.warn` — дословный урок `weekly-delivery.ts:114-131`: отказ рассылки виден только тому, кто читает логи контейнера, то есть никому.
- «👌 Принять» → `POST /tasks/:id/confirm { actor: "person:<id>" }`; 403 → «Подтверждать может менеджер. Попроси владельца проставить роль.»; успех → исполнителю (если у него есть чат) `✅ Задача принята: <title>. Спасибо!`.
- «↩ Вернуть в работу» → мастер на ОДНУ строку. Причина ОБЯЗАТЕЛЬНА: `rate("redo")` пишет свой комментарий «Возвращено на доработку. Прошлый отчёт: …» (`tasks.service.ts:521-527`), но не объясняет ПОЧЕМУ, а рассылка возвратов шлёт «детали в комментариях к задаче» (`index.ts:686`) — без причины эта строка врёт.
- Порядок двух вызовов возврата строгий: сначала `POST /tasks/:id/comments`, потом `POST /tasks/:id/quality { quality: "redo", actor }`. Комментарий обязан УЖЕ лежать, когда рассылка возвратов (60 с) позовёт исполнителя смотреть детали.
- Веер подчиняется тихим часам (R-P7-11): вне окна ключи не занимаются и сообщения не уходят.
- Правило `tasks.no_confirmers` в `RULE_EVENT_TYPES` руками не вписывается — список выводится из `RULES` (`rules.ts:601`); тест это утверждает (урок П5b N5: правило без записи не подберётся `/rules/pending`).

- [x] **Step 1: Тесты RED.**
```ts
// apps/bot/src/task-confirm.test.ts — новый файл
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Conversations } from "./conversation";
import type { PersonRow, TaskRow } from "./core-client";
import {
  CONFIRM_CANCEL,
  NO_CONFIRMERS_EVENT,
  confirmKey,
  confirmRecipients,
  formatConfirmRequest,
  handleConfirmRedoReason,
  parseConfirmCallback,
  разослатьПодтверждения,
  startConfirmRedo,
} from "./task-confirm";

const РАБОЧЕЕ = new Date("2026-08-26T10:00:00+05:00");
const НОЧЬ = new Date("2026-08-26T23:40:00+05:00");
const ЗАКРЫЛ = "11111111-1111-4111-8111-111111111111";
const МЕНЕДЖЕР = "22222222-2222-4222-8222-222222222222";
const ЗАДАЧА = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const человек = (over: Partial<PersonRow>): PersonRow =>
  ({ id: "x", name: "Кто-то", role: null, roles: [], tgUsername: null, tgChatId: "1", active: "yes", ...over }) as PersonRow;

const задача = (over: Partial<TaskRow> = {}): TaskRow =>
  ({
    id: ЗАДАЧА,
    title: "Пополнить Olma",
    description: null,
    ownerKind: "human",
    ownerRef: ЗАКРЫЛ,
    status: "done",
    priority: "high",
    due: null,
    resultNote: "Загрузил 40 позиций",
    entityId: null,
    quality: null,
    completedAt: "2026-08-26T09:30:00+05:00",
    closedBy: `person:${ЗАКРЫЛ}`,
    confirmedAt: null,
    confirmedBy: null,
    assignNotifiedAt: "2026-08-25T05:00:00.000Z",
    ...over,
  }) as TaskRow;

describe("Адресаты веера (П7, R-P7-9/R-P7-12)", () => {
  it("роль manager/owner ИЛИ легаси role='владелец', активен, есть чат", () => {
    const люди = [
      человек({ id: "a", roles: ["manager"] }),
      человек({ id: "b", roles: [], role: "владелец" }),
      человек({ id: "c", roles: ["operator"] }),
      человек({ id: "d", roles: ["manager"], active: "no" }),
      человек({ id: "e", roles: ["manager"], tgChatId: null }),
    ];
    assert.deepEqual(confirmRecipients(люди).map((p) => p.id), ["a", "b"]);
  });

  it("на проде ролей owner/manager нет ни у кого — легаси-строка единственный источник адресата", () => {
    // Не «на всякий случай»: 25.08.2026 в `roles` лежат только
    // storekeeper/technician/operator/collector, а владелец помечен ровно так.
    assert.deepEqual(confirmRecipients([человек({ id: "o", roles: [], role: "Владелец" })]).map((p) => p.id), ["o"]);
  });

  it("ключ веера — ПО ЧЕЛОВЕКУ: сбой одного чата не лишает остальных", () => {
    assert.equal(confirmKey(ЗАДАЧА, МЕНЕДЖЕР), `task-confirm:${ЗАДАЧА}:${МЕНЕДЖЕР}`);
    assert.notEqual(confirmKey(ЗАДАЧА, МЕНЕДЖЕР), confirmKey(ЗАДАЧА, "другой"));
  });
});

describe("Текст и кнопки «подтвердите»", () => {
  it("печатает заголовок, кто закрыл, момент по Ташкенту и отчёт", () => {
    const r = formatConfirmRequest(задача(), "Рустам", РАБОЧЕЕ);
    assert.match(r.text, /🟡 Выполнена: Пополнить Olma/);
    assert.match(r.text, /Закрыл: Рустам/);
    assert.match(r.text, /09:30/, "момент печатается по Ташкенту, а не в UTC");
    assert.match(r.text, /Отчёт: Загрузил 40 позиций/);
    const кнопки = r.keyboard!.inline_keyboard.flat().map((b) => b.callback_data);
    assert.deepEqual(кнопки, [`tc:${ЗАДАЧА}:ok`, `tc:${ЗАДАЧА}:redo`]);
  });

  it("отчёта нет — говорим это словами, а не пустой строкой", () => {
    const r = formatConfirmRequest(задача({ resultNote: null }), "Рустам", РАБОЧЕЕ);
    assert.match(r.text, /Отчёта нет/);
  });

  it("parseConfirmCallback: чужой префикс и битый uuid отвергаются", () => {
    assert.deepEqual(parseConfirmCallback(`tc:${ЗАДАЧА}:ok`), { id: ЗАДАЧА, action: "ok" });
    assert.deepEqual(parseConfirmCallback(`tc:${ЗАДАЧА}:redo`), { id: ЗАДАЧА, action: "redo" });
    assert.equal(parseConfirmCallback(`t:${ЗАДАЧА}:done`), null, "пространство задач не трогаем");
    assert.equal(parseConfirmCallback("tc:не-uuid:ok"), null);
    assert.equal(parseConfirmCallback(`tc:${ЗАДАЧА}:delete`), null);
    assert.equal(parseConfirmCallback(CONFIRM_CANCEL), null, "у отмены нет id — она разбирается отдельно");
  });
});

describe("Рассылка веера", () => {
  function стенд(opts: { задачи: TaskRow[]; люди: PersonRow[]; занятые?: Set<string> }) {
    const отправлено: { chat: number; text: string }[] = [];
    const владельцу: string[] = [];
    const события: { type: string; payload: Record<string, unknown> }[] = [];
    const предупреждения: string[] = [];
    const deps = {
      awaitingTasks: async () => opts.задачи,
      people: async () => opts.люди,
      claimNotification: async (key: string) => !(opts.занятые?.has(key) ?? false),
      recordEvent: async (type: string, payload: Record<string, unknown>) => {
        события.push({ type, payload });
      },
      send: async (chat: number, text: string) => {
        отправлено.push({ chat, text });
      },
      ownerChats: [999],
      sendOwner: async (chat: number, text: string) => {
        владельцу.push(`${chat}|${text}`);
      },
      warn: (m: string) => предупреждения.push(m),
    };
    return { deps, отправлено, владельцу, события, предупреждения };
  }

  it("закрывший задачу себе «подтвердите» не получает", async () => {
    // Иначе менеджер подтверждает сам себя по пушу — и приёмка перестаёт быть
    // приёмкой. Поведение донора («кроме себя»).
    const st = стенд({
      задачи: [задача({ closedBy: `person:${МЕНЕДЖЕР}` })],
      люди: [человек({ id: МЕНЕДЖЕР, roles: ["manager"], tgChatId: "500" }), человек({ id: "m2", roles: ["manager"], tgChatId: "501" })],
    });
    await разослатьПодтверждения(st.deps, РАБОЧЕЕ);
    assert.deepEqual(st.отправлено.map((o) => o.chat), [501]);
  });

  it("занятый ключ одного человека не мешает остальным", async () => {
    const st = стенд({
      задачи: [задача()],
      люди: [человек({ id: "m1", roles: ["manager"], tgChatId: "500" }), человек({ id: "m2", roles: ["manager"], tgChatId: "501" })],
      занятые: new Set([confirmKey(ЗАДАЧА, "m1")]),
    });
    await разослатьПодтверждения(st.deps, РАБОЧЕЕ);
    assert.deepEqual(st.отправлено.map((o) => o.chat), [501]);
  });

  it("адресатов нет — событие tasks.no_confirmers и строка владельцу, а не тишина", async () => {
    const st = стенд({ задачи: [задача()], люди: [человек({ id: "c", roles: ["operator"] })] });
    await разослатьПодтверждения(st.deps, РАБОЧЕЕ);
    assert.deepEqual(st.события.map((e) => e.type), [NO_CONFIRMERS_EVENT]);
    assert.equal(st.события[0]!.payload.title, "Пополнить Olma", "правило печатает именно title");
    assert.equal(st.владельцу.length, 1);
    assert.equal(st.предупреждения.length, 1);
  });

  it("вне рабочих часов веер молчит и ключей не тратит", async () => {
    const st = стенд({ задачи: [задача()], люди: [человек({ id: "m1", roles: ["manager"], tgChatId: "500" })] });
    await разослатьПодтверждения(st.deps, НОЧЬ);
    assert.deepEqual(st.отправлено, []);
    assert.deepEqual(st.события, [], "занятый ночью ключ означал бы, что утром пуш уже «доставлен»");
  });
});

describe("Возврат в работу с причиной", () => {
  it("мастер ждёт строку: пустой ввод не отправляется", async () => {
    const conversations = new Conversations();
    const вызовы: string[] = [];
    const core = {
      addTaskComment: async () => {
        вызовы.push("comment");
      },
      rateTask: async () => {
        вызовы.push("rate");
      },
    } as never;
    startConfirmRedo(1, задача(), { conversations });
    const r = await handleConfirmRedoReason(1, "   ", человек({ id: МЕНЕДЖЕР }), { conversations, core });
    assert.match(r.text, /Напиши, что не так/);
    assert.deepEqual(вызовы, [], "без причины строка «детали в комментариях» была бы враньём");
  });

  it("причина уезжает КОММЕНТАРИЕМ, и только потом ставится redo", async () => {
    // Порядок строгий: рассылка возвратов (60 с) зовёт исполнителя смотреть
    // детали — комментарий обязан уже лежать, когда она сработает.
    const conversations = new Conversations();
    const вызовы: string[] = [];
    const core = {
      addTaskComment: async (id: string, body: string, author: string) => {
        вызовы.push(`comment:${id}:${body}:${author}`);
      },
      rateTask: async (id: string, quality: string, actor: string) => {
        вызовы.push(`rate:${id}:${quality}:${actor}`);
      },
    } as never;
    startConfirmRedo(1, задача(), { conversations });
    const r = await handleConfirmRedoReason(1, "Слот 12 пустой", человек({ id: МЕНЕДЖЕР }), { conversations, core });
    assert.deepEqual(вызовы, [
      `comment:${ЗАДАЧА}:Слот 12 пустой:person:${МЕНЕДЖЕР}`,
      `rate:${ЗАДАЧА}:redo:person:${МЕНЕДЖЕР}`,
    ]);
    assert.match(r.text, /Вернул в работу/);
    assert.equal(conversations.get(1), null, "мастер закрывается — иначе следующая фраза уйдёт причиной");
  });
});
```
```ts
// apps/core/src/rules/rules.test.ts — новый набор в конец файла
describe("Правила задач (П7)", () => {
  it("`task.overdue` и `tasks.no_confirmers` есть в RULE_EVENT_TYPES", () => {
    // Список выводится из RULES, но именно он стоит SQL-фильтром в
    // `/rules/pending`: правило без записи не подберётся, и сигнал будет
    // «отправлен» в никуда (урок П5b N5).
    assert.ok(RULE_EVENT_TYPES.includes("task.overdue"));
    assert.ok(RULE_EVENT_TYPES.includes("tasks.no_confirmers"));
  });

  it("«подтверждать некому» печатает заголовок задачи и говорит, ЧТО сделать", () => {
    const [n] = applyRules({
      source: "bot",
      type: "tasks.no_confirmers",
      payload: { taskId: "t1", title: "Пополнить Olma" },
    });
    assert.equal(n?.urgency, "immediate");
    assert.match(n!.text, /Пополнить Olma/);
    assert.match(n!.text, /Проставь роль/, "тревога без действия — это шум");
  });

  it("у `task.confirmed` правила НЕТ — приёмка не тревога", () => {
    // `immediate` превратило бы каждое «👌 Принять» в сообщение владельцу о
    // его же решении. Ему это видно в ленте «Действия».
    assert.deepEqual(applyRules({ source: "tasks", type: "task.confirmed", payload: { title: "x" } }), []);
  });

  it("у `task.auto_created` правила НЕТ — свободные задачи разносит дайджест 07:00", () => {
    assert.deepEqual(applyRules({ source: "task-bridge", type: "task.auto_created", payload: {} }), []);
  });
});
```
- [x] **Step 2:** `pnpm --filter bot build && pnpm --filter bot test` → RED («Cannot find module ./task-confirm»); `pnpm --filter core build && pnpm --filter core test` → RED (`tasks.no_confirmers` нет в `RULE_EVENT_TYPES`).
- [x] **Step 3: Правило.** `apps/core/src/rules/rules.ts` — блок из «Interfaces (produces)» сразу за `task.overdue` (`:358-363`), с комментарием: зеркало `weekly-digest.no_recipients` — отказ рассылки виден только тому, кто читает логи контейнера, то есть никому.
- [x] **Step 4: Модуль веера.** `apps/bot/src/task-confirm.ts` — все экспорты из «Interfaces (produces)» с докблоками. `confirmRecipients` считает право общим `can(effectiveRoles(p), "tasks.confirm")` (не своим списком ролей — иначе бот и Core разойдутся); момент закрытия печатается через `TZ`-форматирование, уже принятое в боте.
- [x] **Step 5: Клиент Core.** `apps/bot/src/core-client.ts`: `awaitingTasks()` → `GET /tasks?awaiting=1`; `confirmTask(id, actor)` → `POST /tasks/${id}/confirm { actor }`; `rateTask(id, quality, actor)` → `POST /tasks/${id}/quality { quality, actor }`. У `rateTask` докблок: актор обязателен, иначе журнал припишет оценку менеджера владельцу.
- [x] **Step 6: Разбор нажатий и текста.** `apps/bot/src/staff.ts`: в `handleStaffCallback` (`:626`) — ДО общего разбора задач:
```ts
  // Пространство «tc:» — приёмка П7. Проверяется раньше `t:`, потому что
  // префиксы разные, но фолбэк «эта кнопка устарела» ниже съел бы незнакомое.
  if (data === CONFIRM_CANCEL) {
    deps.conversations.clear(chatId);
    return { answer: "Отменил", message: "Ок, задача осталась принятой к рассмотрению." };
  }
  const tc = parseConfirmCallback(data);
  if (tc) return unwrap(await handleConfirmCallback(chatId, tc, person, deps));
```
и в разбор текста активного визарда (`:436`, рядом с `task-done`):
```ts
  if (conv?.flow === REDO_FLOW) {
    if (conv.step === "reason" && clean.length > 0 && !clean.startsWith("/")) {
      return { reply: await handleConfirmRedoReason(chatId, clean, person, deps) };
    }
    return { reply: { text: confirmRedoStepHint(conv.step) } };
  }
```
- [x] **Step 7: Петля.** `apps/bot/src/index.ts`, рядом с петлёй назначений:
```ts
  /**
   * Веер «выполнена — подтвердите». Опрос раз в минуту: закрытие задачи не
   * должно ждать дайджеста, а владелец не должен узнавать о нём, открыв /tasks.
   */
  async function sendConfirmRequests(now = new Date()): Promise<void> {
    await разослатьПодтверждения(
      {
        awaitingTasks: () => deps.core.awaitingTasks(),
        people: () => deps.core.people(),
        claimNotification: (key) => deps.core.claimNotification(key),
        recordEvent: (type, payload) => deps.core.recordEvent(type, payload).then(() => undefined),
        send: async (chat, text, keyboard) => {
          await tg.sendMessage(chat, text, keyboard);
        },
        ownerChats: allowlist,
        sendOwner: async (chat, text) => {
          await tg.sendMessage(chat, text);
        },
        warn: (m) => console.warn(m),
      },
      now,
    );
  }

  const confirmEveryMs = Number(process.env.CONFIRM_NOTIFY_INTERVAL_MS ?? 60_000);
  setInterval(() => {
    void sendConfirmRequests().catch((err: unknown) => console.error("Подтверждения:", err));
  }, confirmEveryMs).unref();
```
- [x] **Step 8:** `pnpm --filter @mydon/shared build && pnpm --filter core build && pnpm --filter core test && pnpm --filter bot build && pnpm --filter bot test` → GREEN; `pnpm -s typecheck`.
- [x] **Step 9:** `git commit -m "feat(bot,core): веер менеджерам «выполнена — подтвердите», возврат в работу с причиной, правило tasks.no_confirmers (П7, R-P7-9)" -- apps/bot/src/task-confirm.ts apps/bot/src/task-confirm.test.ts apps/bot/src/index.ts apps/bot/src/core-client.ts apps/bot/src/staff.ts apps/core/src/rules/rules.ts apps/core/src/rules/rules.test.ts`

---

### Task 7 (спека T6) · ВОЛНА 5 — Экран «ждут подтверждения» в боте и блок в панели

Идёт ПОСЛЕ Task 6: дописывает её `task-confirm.ts` и делит `staff.ts`.

**Files:** Create `apps/cc/src/components/awaiting-block.tsx`, `apps/cc/src/components/awaiting-block.test.tsx`. Modify `apps/bot/src/menu.ts` (`STAFF_MENU`, ряд «редкое» стр. 139–141), `apps/bot/src/menu.test.ts` (наборы прав и триггеров), `apps/bot/src/staff.ts` (`startMenuItem`, `switch (item.id)` стр. 542–606), `apps/bot/src/task-confirm.ts` (экран), `apps/bot/src/task-confirm.test.ts` (набор экрана), `apps/cc/src/lib/core.ts` (блок `// ── Задачи ──` стр. 2147–2164), `apps/cc/src/app/tasks/page.tsx` (загрузка стр. 17–22, рендер стр. 35–47), `apps/cc/src/app/tasks/actions.ts` (рядом с `rateTask` стр. 96–110), `apps/cc/src/app/tasks/[id]/page.tsx` (шапка стр. 69–78), `tools/smoke-panel.mjs` (список страниц, шаг `/tasks` стр. 61).

**Interfaces (consumes):** `menuFor` / `matchTrigger` — ОДИН фильтр для кнопок, справки и слов (`apps/bot/src/menu.ts:148-155`, `:199`), `tasksKeyboard` (`apps/bot/src/staff.ts:145-159`), `parseConfirmCallback` / `confirmRecipients` (Task 6), `core.tasks({ awaiting: "1" })` (`apps/cc/src/lib/core.ts:2148`), `taskState` / `TASK_STATE_LABELS` (Task 2), конвенция мутирующих кнопок панели (`CLAUDE.md:57-64`, эталон `components/customs-rates.tsx`), `groupByUrgency` (`apps/cc/src/app/tasks/page.tsx:27`).

**Interfaces (produces):**
```ts
/** apps/bot/src/menu.ts — в ряд «редкое» */
  {
    id: "confirm",
    label: "🧾 Ждут подтверждения",
    perm: "tasks.confirm",
    ready: true,
    match: (t) => /^(ждут подтвер|подтвержд|на подтвержд|приёмк|приемк)/i.test(t.trim()),
  },

/** apps/bot/src/task-confirm.ts */
/** Экран «ждут подтверждения»: нумерованный список и пара кнопок на строку. */
export function formatAwaitingScreen(tasks: readonly TaskRow[], names: ReadonlyMap<string, string>, now?: Date): StaffReply;

/** apps/cc/src/lib/core.ts */
  /** Приёмка работы. Панель ходит от владельца — сегодняшнее поведение. */
  confirmTask: (id: string) => send<Task>(`/tasks/${id}/confirm`, "POST", { actor: "owner" }),

/** apps/cc/src/app/tasks/actions.ts */
/** Приёмка работы. «Переделать» живёт отдельно — это rateTask(id, "redo"). */
export async function confirmTask(id: string): Promise<ActionResult>;

/** apps/cc/src/components/awaiting-block.tsx */
export function AwaitingBlock({ tasks, names }: { tasks: Task[]; names: Map<string, string> }): JSX.Element;
```

Что обязана делать реализация:
- Значок «🧾», не «📋» и не «✅»: первый занят «Мои задачи» (`menu.ts:77`), второй — кнопкой «Выполнил». Оператор сканирует меню по эмодзи, и один символ на два пункта провоцирует промах — правило уже записано у «🧮» и «🍫» (`menu.ts:129`, `:137-141`).
- Пункт фильтруется ОДНИМ фильтром `menuFor` — и кнопка, и справка, и текстовый триггер: «спрятано кнопкой, доступно словом» не должно возникнуть.
- Пусто в боте → третье состояние: «Ничего не ждёт приёмки. Как только кто-то закроет задачу, она появится здесь.»
- Панель: блок рисуется **над** группами срочности (это то, что требует решения СЕЙЧАС), со счётчиком и парой кнопок в строке. Кнопки — не форма, поэтому конвенция мутирующих форм применяется в её сути: вызов в `startTransition`, при `res.ok` — `router.refresh()`, при отказе — `setError(res.error)`, список не гаснет.
- Панель показывает блок ВСЕГДА (панель = владелец, у него право есть по определению) — пустой блок рисуется третьим состоянием, а не исчезает: исчезнувший блок неотличим от «ещё не выкатили».
- Карточка задачи печатает «Принято: <кто>, <когда>», когда `confirmedAt` есть.

- [x] **Step 1: Тесты RED.**
```ts
// apps/bot/src/menu.test.ts — правки существующих наборов
  it("пункт «Ждут подтверждения» не виден оператору ни кнопкой, ни словом", () => {
    // Один фильтр на три входа: спрятанный кнопкой, но доступный словом пункт
    // сделал бы всю модель прав косметикой.
    assert.equal(menuFor(ALL).some((i) => i.id === "confirm"), false, "у ALL нет manager/owner");
    assert.equal(matchTrigger2("ждут подтверждения"), null);
    assert.equal(matchTrigger2("приёмка"), null);
  });

  it("менеджеру пункт виден и ловится словом", () => {
    assert.equal(menuFor(["manager"]).some((i) => i.id === "confirm"), true);
    assert.equal(matchTrigger("подтверждение", ["manager"])?.id, "confirm");
    assert.equal(matchTrigger("приемка", ["owner"])?.id, "confirm");
  });

  it("значок пункта не занят другим — оператор сканирует меню по эмодзи", () => {
    const значки = STAFF_MENU.map((i) => i.label.split(" ")[0]);
    assert.equal(new Set(значки).size, значки.length, `дубль значка: ${значки.join(" ")}`);
  });
```
```ts
// apps/bot/src/task-confirm.test.ts — новый набор
describe("Экран «ждут подтверждения» (П7, T6)", () => {
  it("печатает нумерованный список и пару кнопок на строку", () => {
    const ВТОРАЯ = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const r = formatAwaitingScreen(
      [задача(), задача({ id: ВТОРАЯ, title: "Инкассация Kaffit-04" })],
      new Map([[ЗАКРЫЛ, "Рустам"]]),
      РАБОЧЕЕ,
    );
    assert.match(r.text, /1\. Пополнить Olma/);
    assert.match(r.text, /2\. Инкассация Kaffit-04/);
    assert.match(r.text, /Рустам/, "владелец должен видеть, чью работу принимает");
    const ряды = r.keyboard!.inline_keyboard;
    assert.equal(ряды.length, 2);
    assert.deepEqual(ряды[0]!.map((b) => b.callback_data), [`tc:${ЗАДАЧА}:ok`, `tc:${ЗАДАЧА}:redo`]);
  });

  it("пустой экран говорит «ничего не ждёт приёмки» и что случится дальше", () => {
    // Третье состояние, а не зелёная галка: «ноль» и «сломалось» обязаны
    // выглядеть по-разному.
    const r = formatAwaitingScreen([], new Map(), РАБОЧЕЕ);
    assert.match(r.text, /Ничего не ждёт приёмки/);
    assert.match(r.text, /появится здесь/);
    assert.equal(r.keyboard, undefined, "кнопок без строк не бывает");
  });

  it("исполнитель без карточки не ломает экран — печатается ссылка, а не пусто", () => {
    const r = formatAwaitingScreen([задача({ closedBy: "person:кто-то" })], new Map(), РАБОЧЕЕ);
    assert.match(r.text, /Пополнить Olma/);
  });
});
```
```tsx
// apps/cc/src/components/awaiting-block.test.tsx — новый файл
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../lib/core";
import { AwaitingBlock } from "./awaiting-block";

const mocks = vi.hoisted(() => ({ confirmTask: vi.fn(), rateTask: vi.fn(), refresh: vi.fn() }));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../app/tasks/actions", () => ({ confirmTask: mocks.confirmTask, rateTask: mocks.rateTask }));

const ЗАДАЧА: Task = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  title: "Пополнить Olma",
  description: null,
  ownerKind: "human",
  ownerRef: "11111111-1111-4111-8111-111111111111",
  domain: "vendhub",
  status: "done",
  priority: "high",
  due: null,
  source: "low_stock:2508160376:2026-08-26",
  createdBy: "task-bridge",
  resultNote: "Загрузил 40 позиций",
  entityId: null,
  quality: null,
  completedAt: "2026-08-26T09:30:00+05:00",
  closedBy: "person:11111111-1111-4111-8111-111111111111",
  confirmedAt: null,
  confirmedBy: null,
  assignNotifiedAt: "2026-08-25T05:00:00.000Z",
  createdAt: "2026-08-26T01:15:00.000Z",
};
const ИМЕНА = new Map([["11111111-1111-4111-8111-111111111111", "Рустам"]]);

describe("Блок «Ждут подтверждения» (П7, T6)", () => {
  beforeEach(() => vi.resetAllMocks());

  it("показывает задачу, автора закрытия, отчёт и обе кнопки", () => {
    render(<AwaitingBlock tasks={[ЗАДАЧА]} names={ИМЕНА} />);
    expect(screen.getByText("Пополнить Olma")).toBeVisible();
    expect(screen.getByText(/Рустам/)).toBeVisible();
    expect(screen.getByText(/Загрузил 40 позиций/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Принять" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Переделать" })).toBeVisible();
  });

  it("пусто — третье состояние, а не зелёная галка и не исчезнувший блок", () => {
    // Исчезнувший блок неотличим от «ещё не выкатили»: владелец должен видеть,
    // что приёмка работает и очередь пуста.
    render(<AwaitingBlock tasks={[]} names={ИМЕНА} />);
    expect(screen.getByText("Ждут подтверждения")).toBeVisible();
    expect(screen.getByText(/Ничего не ждёт приёмки/)).toBeVisible();
  });

  it("«Принять» зовёт экшен и обновляет страницу", async () => {
    mocks.confirmTask.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<AwaitingBlock tasks={[ЗАДАЧА]} names={ИМЕНА} />);
    await user.click(screen.getByRole("button", { name: "Принять" }));
    await waitFor(() => expect(mocks.confirmTask).toHaveBeenCalledWith(ЗАДАЧА.id));
    expect(mocks.refresh).toHaveBeenCalledOnce();
  });

  it("отказ Core оставляет текст ошибки и НЕ гасит список", async () => {
    mocks.confirmTask.mockResolvedValue({ ok: false, error: "Это может менеджер" });
    const user = userEvent.setup();
    render(<AwaitingBlock tasks={[ЗАДАЧА]} names={ИМЕНА} />);
    await user.click(screen.getByRole("button", { name: "Принять" }));
    expect(await screen.findByText("Это может менеджер")).toBeVisible();
    expect(screen.getByText("Пополнить Olma")).toBeVisible();
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("«Переделать» — это rateTask(redo), а не приёмка", () => {
    // Отдельные действия с разными последствиями: приёмка закрывает вопрос,
    // «переделать» возвращает задачу в работу и включает напоминания заново.
    render(<AwaitingBlock tasks={[ЗАДАЧА]} names={ИМЕНА} />);
    expect(mocks.rateTask).not.toHaveBeenCalled();
  });
});
```
- [x] **Step 2:** `pnpm --filter bot build && pnpm --filter bot test` → RED (пункта `confirm` нет, `formatAwaitingScreen` не существует); `pnpm --filter cc test` → RED («Cannot find module ./awaiting-block»).
- [x] **Step 3: Меню и экран бота.** `apps/bot/src/menu.ts` — пункт из «Interfaces (produces)» в ряд «редкое», рядом с «🆕 Новая карточка», с комментарием про выбор значка. `apps/bot/src/task-confirm.ts` — `formatAwaitingScreen` по образцу `tasksKeyboard` (`staff.ts:145-159`): нумерованный список (заголовок, кто закрыл, когда, первая строка отчёта), у каждой строки — ряд из пары `tc:<id>:ok` / `tc:<id>:redo`; пусто → третье состояние без клавиатуры. `apps/bot/src/staff.ts`, `startMenuItem`:
```ts
    case "confirm": {
      const [tasks, people] = await Promise.all([
        deps.core.awaitingTasks(),
        deps.core.people().catch(() => [] as PersonRow[]),
      ]);
      return { reply: formatAwaitingScreen(tasks, new Map(people.map((p) => [p.id, p.name]))) };
    }
```
- [x] **Step 4: Клиент и экшен панели.** `apps/cc/src/lib/core.ts`, в блок `// ── Задачи ──` рядом с `rateTask` — `confirmTask` из «Interfaces (produces)». `apps/cc/src/app/tasks/actions.ts`, рядом с `rateTask` (`:96`):
```ts
/**
 * Приёмка работы. «Переделать» живёт отдельно — это `rateTask(id, "redo")`:
 * у них разные последствия, и одна кнопка на оба означала бы, что владелец
 * возвращает задачу в работу, думая, что закрывает вопрос.
 */
export async function confirmTask(id: string): Promise<ActionResult> {
  try {
    await core.confirmTask(id);
  } catch (err) {
    return fail(err);
  }
  revalidatePath("/tasks");
  revalidatePath(`/tasks/${id}`);
  revalidatePath("/team");
  return { ok: true };
}
```
- [x] **Step 5: Блок панели.** `apps/cc/src/components/awaiting-block.tsx` — клиентский компонент по образцу `task-row.tsx` (`useTransition` + `useRouter().refresh()` + локальный `error`), заголовок «Ждут подтверждения» со счётчиком, строка задачи: заголовок, «закрыл <имя> · <когда>», первая строка отчёта, кнопки «Принять» (`confirmTask`) и «Переделать» (`rateTask(id, "redo")`), под блоком — текст ошибки. Пусто → `<div className="empty"><b>Ничего не ждёт приёмки</b>{"Как только кто-то закроет задачу, она появится здесь."}</div>`.
- [x] **Step 6: Страница и карточка.** `apps/cc/src/app/tasks/page.tsx`:
```tsx
    [open, awaiting, people, agents] = await Promise.all([
      core.tasks({ open: "1" }),
      // Второй список: `done` без отметки приёмки не показывает никто —
      // ни `/tasks` (там `open=1`), ни лента. Именно он требует решения
      // владельца прямо сейчас, поэтому блок стоит НАД группами срочности.
      core.tasks({ awaiting: "1" }),
      core.people(),
      core.agents(),
    ]);
```
и `<AwaitingBlock tasks={awaiting} names={new Map(people.map((p) => [p.id, p.name]))} />` перед блоком групп. `apps/cc/src/app/tasks/[id]/page.tsx` — в шапку, когда `task.confirmedAt !== null`: строка «Принято: <кто>, <когда>», где «кто» — имя из `peopleById` по `personIdOf`-подобному разбору `confirmedBy` (`owner` печатается как «владелец»).
- [x] **Step 7: Смоук панели.** `tools/smoke-panel.mjs`, рядом с существующим `{ path: "/tasks", должно: "Задачи" }`:
```js
  // П7: блок приёмки рисуется ВСЕГДА, в том числе пустым (третье состояние),
  // поэтому слово находится и на засеянной базе без задач.
  { path: "/tasks", должно: "Ждут подтверждения" },
```
- [x] **Step 8:** `pnpm --filter @mydon/shared build && pnpm --filter bot build && pnpm --filter bot test && pnpm --filter cc test` → GREEN; `pnpm -s typecheck`; `pnpm -s lint`. На scratch-БД: `node tools/smoke-panel.mjs` — оба шага `/tasks` зелёные.
- [x] **Step 9:** `git commit -m "feat(bot,cc): экран «ждут подтверждения» в боте и блок приёмки в панели (П7, T6)" -- apps/bot/src/menu.ts apps/bot/src/menu.test.ts apps/bot/src/staff.ts apps/bot/src/task-confirm.ts apps/bot/src/task-confirm.test.ts apps/cc/src/lib/core.ts apps/cc/src/components/awaiting-block.tsx apps/cc/src/components/awaiting-block.test.tsx apps/cc/src/app/tasks/page.tsx apps/cc/src/app/tasks/actions.ts "apps/cc/src/app/tasks/[id]/page.tsx" tools/smoke-panel.mjs`

---

### Task 8 (спека T8) · ВОЛНА 6 — Контрольный замер в проде и рунбуки

Кода нет. Это условие приёмки среза и три рунбука, которые описывают его ЦЕЛИКОМ (см. «Отклонения» №6).

**Files:** Modify `docs/DEPLOY.md` (после подраздела «Разовый бэкфилл `product_id`» стр. 153–240), `docs/AGENTS_ACTIVATION.md` (новые разделы перед «Проверка «включилось ли»» стр. 116), `docs/PLAN_STOCK_ABSORPTION.md` (§«П7. Задачи — отдельное решение владельца» стр. 363–368), `docs/superpowers/specs/2026-08-26-p7-tasks-design.md` (аддендум в конец), `docs/superpowers/plans/2026-08-26-sloy-p7-tasks.md` (галочки). Create — нет.

**Interfaces (consumes):** запросы замера (ниже), `GET /health` → `commit`, панель настроек (`TASK_BRIDGE_ENABLED`).

**Interfaces (produces):** только текст. Три раздела документации и один аддендум спеки.

- [x] **Step 1: `docs/DEPLOY.md`.** Новый подраздел «Проверка после выката П7 (задачи)» с ДВУМЯ пунктами:
```bash
# 1. Бэкфилл отметки «тебе поручили» — СРАЗУ после деплоя, до первого крона 06:15.
docker exec -i mydon-core psql "$DATABASE_URL" -c \
  "select count(*) from task where owner_ref is not null and assign_notified_at is null;" </dev/null
# Должен быть 0. Не ноль — миграция не доехала, и утром люди получат пуши по
# старым задачам; чинить ДО наступления следующего утра.
```
плюс абзац «Откат моста задач»: `TASK_BRIDGE_ENABLED = 0` в панели настроек, деплой не нужен — тумблер читается из базы на каждом прогоне, база важнее env. `</dev/null` в каждом `docker exec` обязателен: без него остаток скрипта уходит в контейнер и шаги после молча не выполняются (`DEPLOY.md:120`).
- [x] **Step 2: `docs/AGENTS_ACTIVATION.md`.** Два новых раздела.
  «## Кроны Core» — таблица: `15 6 * * *` Asia/Tashkent, `TaskBridgeService`, две работы (мост «событие → задача» и эмитент `task.overdue`), каждая под своим `catch`; почему 06:15 (после монитора ТО 06:00, до дайджеста 07:00 и брифинга 07:30); тумблеры `TASK_BRIDGE_ENABLED` / `TASK_BRIDGE_MAX_PER_RUN`; где смотреть — логи Core (не агентов: у агентов контейнер перезапускается и логи прошлого удаляются).
  «## Петли бота» — таблица: «тебе поручили» (`ASSIGN_NOTIFY_INTERVAL_MS`, 60 с), «выполнена — подтвердите» (`CONFIRM_NOTIFY_INTERVAL_MS`, 60 с), существующие возвраты (`REDO_NOTIFY_INTERVAL_MS`) и напоминания (`REMIND_INTERVAL_MS`); тихие часы 7:00–22:00 действуют ТОЛЬКО на две новых, и почему (R-P7-11).
- [x] **Step 3: `docs/PLAN_STOCK_ABSORPTION.md`.** §П7 переписывается целиком: строка «В монорепо модуля задач нет» неверна с большим запасом — таблица `task` на 23 колонки, спутник `task_comment`, 19 маршрутов Core, полный контур в боте, две страницы панели, исполнение задач агентами и хук «закрыл задачу ТО → журнал обслуживания»; донорские `tasks` — **0 строк за всю историю**, переносить «проверенный практикой контур» неоткуда. Настоящая проблема была в том, что модуль никто не кормил; срез П7 достроил мост, подтверждение и уведомления. Отдельной строкой остаётся «Гигиена» (#16) — починка монитора графиков ТО, чей HTTP-путь молчит в проде.
- [x] **Step 4: Аддендум спеки.** В конец `docs/superpowers/specs/2026-08-26-p7-tasks-design.md` — раздел «Аддендум после реализации» с ШЕСТЬЮ отклонениями из шапки этого плана, каждое одним абзацем: что в спеке, что в коде, почему.
- [ ] **Step 5: Замер (после мержа и трёх суток, только чтение).** Запросы выполняет владелец; результат вписывается сюда же, в `docs/PLAN_STOCK_ABSORPTION.md`:
```sql
-- 1. Какие источники моста дали задачи (исключаем автозадачи монитора ТО).
select split_part(source, ':', 1) as источник, count(*)
  from task
 where source ~ ':[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   and source not like 'maint:%'
 group by 1 order by 2 desc;

-- 2. Сколько автозадач мост заявил своим событием.
select count(*) from event where type = 'task.auto_created';

-- 3. Доля подтверждённых среди сделанных — база для следующего замера.
select count(*) filter (where confirmed_at is not null)::float
     / nullif(count(*), 0) as доля_подтверждённых
  from task where status = 'done';

-- 4. Контроль тишины: события источников за те же трое суток.
select type, count(*) from event
 where occurred_at > now() - interval '3 days'
   and type in ('machine.low_stock','vending.refill_detected','vending.shrinkage_alert',
                'ourvend.sync_stale','ourvend.sync_failed_streak')
 group by 1;
```
**Приёмка.** `task.auto_created` = 0 при НЕПУСТОМ результате запроса 4 — срез **не принят**, разбирается как дефект (это ровно §2.4 спеки, повторённая на новом мосту). Оба нуля — мост исправен, парк молчит: это вопрос к сбору, не к П7. Доля подтверждённых на четырёх ручных задачах бессмысленна, но следующий замер будет с чем сравнивать.
- [x] **Step 6:** `pnpm -s lint && pnpm -s typecheck && pnpm -s build && pnpm -s test` — полный прогон перед PR.
- [x] **Step 7:** `git commit -m "docs(p7): рунбуки кронов и петель, проверка бэкфилла, откат моста, контрольный замер и аддендум спеки (П7, T8)" -- docs/DEPLOY.md docs/AGENTS_ACTIVATION.md docs/PLAN_STOCK_ABSORPTION.md docs/superpowers/specs/2026-08-26-p7-tasks-design.md docs/superpowers/plans/2026-08-26-sloy-p7-tasks.md`

---

## Выкатка (спека §9)

> **Из задач плана прод НЕ пишется ни разу.** Единственная запись среза — бэкфилл ВНУТРИ миграции; её применяет автодеплой. Всё остальное создаёт мост сам, начиная с первого утра после выката. Донор (`mydon-stock`) не пишется ни здесь, ни там.

1. **Ветка и PR.** `feat/p7-tasks` от свежего `main` (уже создана: `b3b595d` + спека `112612d`). После `git checkout main` ПЕРВОЙ командой — `git checkout -b`: фолбэк вида `|| git push` молча отправляет `main` в прод, а автодеплой ходит каждые 2 минуты. PR → CI зелёный (lint · typecheck · build · test · миграции на живом Postgres · smoke-core · smoke-panel) → adversarial-ревью → squash-мерж.
2. **Номер миграции перед PR.** `ls packages/db/drizzle | tail -3`. П6 и «Инкассации» идут параллельно и могут занять `0072`/`0073` первыми — тогда наш файл переименовывается вместе с записью в `meta/_journal.json` и перегенерацией снапшота; чужой файл не трогается. Страж цепочки (`packages/db/src/migrations.test.ts`) уронит тест на дубле номера ДО того, как это сделает `migrate.js` на проде.
3. **Полный прогон перед PR:** `pnpm -s lint && pnpm -s typecheck && pnpm -s build && pnpm -s test`; smoke на scratch-БД целиком: `createdb mydon_p7` → `node packages/db/dist/migrate.js` → `seed.js` → `seed-vending.js` → `smoke-core.mjs` → `smoke-panel.mjs` → `dropdb mydon_p7`. Отдельно: `pnpm --filter @mydon/db db:generate` → «No schema changes» (снапшот обязан быть уже в коммите). **Миграция обязана пройти на базе, где `task` НЕ пуста** — иначе бэкфилл `assign_notified_at` не проверен ничем: перед `migrate.js` вставить пару задач с `owner_ref`.
4. **Деплой и сверка того, что выкачено ИМЕННО это.** `GET /health` → `commit` совпадает с коммитом мержа: каталог обновляется за секунды, образ собирается минуты. Миграция применяется автодеплоем; повторный прогон мигратора — no-op (`IF NOT EXISTS`).
5. **СРАЗУ после деплоя, до первого крона 06:15 — проверка бэкфилла:**
   ```sql
   select count(*) from task where owner_ref is not null and assign_notified_at is null;
   ```
   Должен быть **0**. Не ноль — миграция не доехала, и утром люди получат пуши по старым задачам; чинить до наступления следующего утра.
6. **Ожидаемый объём первых суток.** По 14-суточному замеру ленты (опись §3): `machine.low_stock` 3 события / 14 сут, `vending.refill_detected` 7 / 14, `vending.shrinkage_alert` 0, `ourvend.sync_stale` 0, `ourvend.sync_failed_streak` 0. После агрегации «одна задача на автомат в сутки» это **0–3 автозадачи в первое утро**, наиболее вероятно 1–2. **Ноль в первое утро — законный результат** (события идут не каждый день), и поводом для тревоги он становится только вместе с шагом 8. Потолки сверху: 20 задач на прогон (`TASK_BRIDGE_MAX_PER_RUN`) и «одна на автомат в сутки». Больше 20 в первое же утро = обрезка (`capped: true` в событии `task.bridge_run`), и это сигнал разбираться, а не поднимать потолок.
7. **Проверка витрин в тот же день — только чтение:**
   - `GET /tasks?awaiting=1` → массив (пустой законен); `GET /tasks/assign-unnotified` → массив;
   - `GET /tasks` → у строки есть ключи `confirmedAt`, `confirmedBy`, `assignNotifiedAt`, `closedBy`;
   - `GET /system/config` → оба тумблера видны: `TASK_BRIDGE_ENABLED` = `"1"` (`source: "default"`), `TASK_BRIDGE_MAX_PER_RUN` = `"20"`; попытка сохранить `0` в потолок — отказ валидатора «нужно число от 1 до 200»;
   - панель `/tasks` — блок «Ждут подтверждения» на месте (пустой рисуется третьим состоянием), кнопки работают;
   - бот у владельца — пункт «🧾 Ждут подтверждения» виден; у оператора — нет ни кнопкой, ни словом;
   - назначить себе тестовую задачу из панели → в течение минуты приходит «📌 Тебе поручили» (если сейчас 7:00–22:00 по Ташкенту; вне окна — ждать утра, это и есть R-P7-11);
   - закрыть её в боте → приходит «🟡 Выполнена … подтвердите» → «👌 Принять» → в ленте `/team/actions` появляется «👌 Принял работу», а «✅ Закрыл задачу» остаётся на месте (прямая приёмка R-P7-6).
8. **T8 — контрольный замер через 3 суток (только чтение).** Четыре запроса из Task 8 Step 5. Приёмка: `task.auto_created` = 0 при непустой ленте источников — срез **не принят**, разбирается как дефект.
9. **Отложенная проверка просрочки — следующее утро после того, как в базе появится задача, просроченная БОЛЬШЕ суток.** Владельцу приходит «⏰ Просрочена задача: …» правилом (не ботовое «⏰ Просрочено» — то одноразовое и приходит в первый день). Два сообщения об одной задаче в одно утро означают, что граница `due < tashkentDayStartOf(now)` где-то потерялась.

## Самопроверка плана

**Покрытие рулингов спеки:**

| Рулинг / раздел | Где закрыт | Чем проверен |
|---|---|---|
| R-P7-1 охват — ровно восемь задач, донор не переносится | Global Constraints; восемь задач ниже, ни одной строки про `maintenance.due`, `machine.idle`, инкассацию, `kind`, EAV или read-token | ревью: в дифф-списках нет `apps/agents/**`, `docker-compose`, `.env.example`; `PLAN_STOCK_ABSORPTION.md` (Task 8) оставляет «Гигиену» (#16) отдельной открытой строкой |
| R-P7-2 ключ дедупа `<источник>:<сущность>:<дата события>` | Task 3 (`BRIDGE_SOURCES`, группировка, `tashkentDay(e.occurredAt)`) | T4 «три события по одному автомату дают ОДНУ задачу», «два автомата — две задачи», «ключ берёт сутки СОБЫТИЯ: 23:50 и прогон 06:15 дают вчерашний день», «повторный прогон создаёт 0 задач» |
| R-P7-3 права из `person.roles` + легаси-фолбэк | Task 1 (`PERMISSIONS`, `LEGACY_ROLE_MAP`, `effectiveRoles`) | shared «менеджер может, оператор нет», «`tasks.own` остаётся у сотрудника без ролей», «легаси `владелец` даёт owner, мусор — ничего», «карта отдаёт только owner/manager»; `weekly-digest.test.ts` зелёный БЕЗ правок |
| R-P7-4 пять источников, `maintenance.due` вне охвата | Task 3 (`BRIDGE_SOURCES` — ровно пять строк) | T4 «BRIDGE_EVENT_TYPES выводится из BRIDGE_SOURCES, их пять, ключи именно эти», «заливка без отчёта берётся, с отчётом — нет», «`sync_stale` с null даёт urgent» |
| R-P7-5 эмитент `task.overdue` + событие `task.confirmed` | Task 5 (`emitOverdue`), Task 2 (`confirm` пишет `event`) | T7 «просроченная вчера даёт событие один раз в сутки», «повторный прогон — ключ занят», «21-я не эмитится, capped», «сегодняшняя просрочка молчит»; T1 «успешная приёмка пишет и журнал, и событие» |
| **R-P7-6 колонки, а не пятое значение enum** | Task 2 (две колонки, `taskState` в shared, страж в `schema.test.ts`) | `schema.test.ts` «СТРАЖ: `task_status` остаётся ЧЕТЫРЁХЗНАЧНЫМ» с перечнем десяти условий в докблоке; T1 «подтверждение НЕ меняет статус»; `actions.service.test.ts` «`task_confirmed` рядом с `task_done`, а не вместо»; shared «`cancelled` + отметка ≠ confirmed» |
| R-P7-7 мост в Core, вызовом метода, один крон 06:15 | Task 3 (`TaskBridgeService`, `ensureForDay` методом, `croner` + `TZ`), Task 5 (вторая работа под своим `catch`) | `cron-shutdown.test.ts` строка `task-bridge`; T4 «повторный прогон создаёт 0 задач» (идемпотентность через `task_source_key`, а не HTTP); в диффе нет ни одного обращения к `POST /tasks/ensure-for-day` |
| R-P7-8 полевая свободна, инфраструктурная адресна | Task 3 (`людиСПравом`, ветка `scope`) | T4 «полевая задача рождается СВОБОДНОЙ», «инфраструктурная уходит первому менеджеру; менеджеров нет — в пул + предупреждение + событие»; `VENDING_ROUTE_ORDER` в диффе не упоминается ни разу |
| R-P7-9 веер по человеку, заявка ДО отправки, кроме закрывшего | Task 6 (`confirmKey`, `claimNotification` до `send`, фильтр `closedBy`) | бот «закрывший себе «подтвердите» не получает», «занятый ключ одного не мешает остальным», «адресатов нет — событие и строка владельцу», «вне рабочих часов ключей не тратим» |
| R-P7-10 своя колонка-отметка, бэкфилл, четыре точки | Task 2 (колонка + бэкфилл в миграции), Task 4 (четыре точки, пара маршрутов, петля) | миграция с `UPDATE … WHERE owner_ref IS NOT NULL`; Core «взял сам гасит пуш», «release возвращает NULL», «edit со сменой сбрасывает, со сроком — нет», «переназначение на того же — не смена»; бот «доставили → отметили», «при сбое отметки нет», «заблокировал — жалоба И отметка»; выкатка §5 (`count(*) = 0`) |
| R-P7-11 тихие часы ТОЛЬКО для T2 и T3 | Task 4 (`push-hours.ts`), Task 6 (веер под тем же окном) | `push-hours.test.ts` «окно 7–22, границы», «решение по Ташкенту, а не по часам процесса»; `tasks-push.test.ts` «вне часов пуш не уходит и отметка не ставится»; `task-confirm.test.ts` «вне часов веер молчит»; в диффе нет правок `sendReminders` и `sendRedoNotices` |
| R-P7-12 право проверяется в Core по актору | Task 1 (`assertCan`, `SetQualityDto.actor`), Task 2 (`confirm` зовёт его первым) | Core «оценка от оператора — 403», «от менеджера — можно», «от владельца — без похода в карточку», «уволенный менеджер прав не имеет», «актор не в форме `person:<uuid>` отвергается»; бот `menu.test.ts` «пункт не виден оператору ни кнопкой, ни словом» |
| R-P7-13 потолок и тумблер, откат без деплоя | Task 3 (`TASK_BRIDGE_ENABLED`, `TASK_BRIDGE_MAX_PER_RUN`) | `config-spec.test.ts` «только 0 и 1, по умолчанию включён», «0 и 201 отвергаются, 20 принимается», «у обоих есть русский help»; T4 «`ENABLED=0` — прогона нет», «потолок читается настройкой», «потолок режет наименее срочное», «обрезка громкая: warn со списком + событие»; выкатка §7 (тумблеры видны в `/system/config`) |
| §6 данные и миграции | Task 2 Step 4–5 | одна миграция (три колонки, бэкфилл, два частичных индекса); `migrations.test.ts` (цепочка, номера, idx); `db:generate` → «No schema changes»; двойной прогон `migrate.js` — no-op; миграция гоняется на НЕПУСТОЙ `task` |
| §7 события и правила | Task 2 (`task.confirmed`), Task 3 (`task.auto_created`, `task.bridge_run`), Task 5 (`task.overdue`), Task 6 (правило `tasks.no_confirmers`) | `rules.test.ts` «оба типа в `RULE_EVENT_TYPES`», «у `task.confirmed` правила НЕТ», «у `task.auto_created` правила НЕТ», «`tasks.no_confirmers` печатает title и говорит, что сделать»; лента: `task_confirmed` добавлен, выборка `task_done` не тронута |
| §8 тесты | все восемь задач | каждый пункт §8 разложен по задачам; единственный переезд — тест `RULE_EVENT_TYPES` из T7 в Task 6 («Отклонения» №5) |
| §9 выкатка и чек-лист | «Выкатка» + Task 8 | девять шагов, включая проверку бэкфилла до первого крона, ожидаемый объём 0–3 задачи и условие непринятия среза |
| §4 общие ограничения (время, настройки, троттлы, ноль ≠ хорошо) | Global Constraints; Task 2·3·4·5·6·7 | «третье состояние» проверено в трёх местах (экран бота, блок панели, пустая история моста); `tashkentDay`/`tashkentDayStartOf`/`tashkentHour` — единственный источник ташкентского времени (вторая копия смещения не заводится нигде); оба тумблера через `CONFIG_SPECS` с русским `help`; новый маршрут `POST /tasks/:id/confirm` — под именованным троттлом `burst`/`sustained` |

**Сканирование на заглушки.** В плане нет `TBD`, нет «add validation», нет «аналогично Task N» и нет «см. выше» вместо кода: каждый тест и каждый фрагмент реализации выписан целиком там, где нужен, даже когда повторяет соседа (пять источников моста перечислены таблицей и константами, а не «и так далее»; четыре точки отметки названы по одной; текст веера и текст экрана выписаны отдельно, хотя оба живут в одном модуле). Три места, где план сознательно НЕ выписывает код, названы явно и заглушками не являются: (а) тела `BRIDGE_SOURCES.title/description` для пяти источников — их форма задана таблицей источников и тестами на заголовок и описание, а буквальные строки — вопрос русского языка, а не контракта; (б) разметка блока `awaiting-block.tsx` — она копируется с `task-row.tsx`, который уже рендерит задачу с кнопкой и ошибкой, и переписывать его целиком значит навязать вторую вёрстку той же строки; (в) точный номер миграции — он вычисляется командой в Task 2 Step 4 и защищён стражем цепочки, а вписанный заранее номер как раз и был бы заглушкой.

**Согласованность типов между задачами.** `TaskState`/`taskState`/`TASK_STATE_LABELS` объявлены ровно один раз — `packages/shared/src/tasks.ts` (Task 2); бот и панель их импортируют, своих копий «подтверждено» не заводят. `Permission` и `StaffRole` остаются в `packages/shared/src/roles.ts`; `LEGACY_ROLE_MAP` после Task 1 живёт ТОЛЬКО там — копия в `apps/bot/src/weekly-digest.ts` удаляется, и её отсутствие проверяется зелёным `weekly-digest.test.ts` без правок. `TaskRow` (Core, `tasks.service.ts:14` — вывод из `task.$inferSelect`), `TaskRow` (бот, `core-client.ts:61`) и `Task` (панель, `lib/core.ts:1135`) остаются ТРЕМЯ рукописными зеркалами намеренно: их схлопывание в shared прямо названо вне охвата (R-P7-1) — это правка бота, панели и Core разом ради формы, а не ради вопроса владельца. В П7 зеркала только прирастают полями, и синхронность держит дымовой шаг `/tasks` (Task 2 Step 10), который проверяет наличие ключей в НАСТОЯЩЕМ ответе Core, а не в типе. `BridgeSource`/`BridgeRun`/`Payload` — внутренние формы моста, наружу по HTTP не отдаются и в shared не едут. `MachineIndex` (`vending.service.ts:565`) мост ПОТРЕБЛЯЕТ и не переобъявляет: вторая карта «серийник → карточка» с другими правилами дала бы задачи, висящие мимо автомата, — это докблок самого `machineIndex`. `ConfirmDeps` и деп-объект `доставитьНазначения` — интерфейсы инъекции внутри бота, они не пересекаются ни с `WeeklyCore` (`weekly-delivery.ts:32`), ни с `StaffDeps`: каждый называет РОВНО те вызовы Core, которые ему нужны, по образцу `WeeklyCore`. `tashkentHour` добавляется в `tashkent-time.ts` рядом с `tashkentDay`, откуда его берут и бот, и (потенциально) Core — второй реализации часа в репозитории не появляется.

**Матрица пересечения файлов внутри волн** (пусто = не трогает; конфликтов нет ни в одной волне):

| Файл | В1: T5 | В2: T1 | В2: T4 | В3: T2 | В3: T7 | В4: T3 | В5: T6 | В6: T8 |
|---|---|---|---|---|---|---|---|---|
| `packages/shared/src/roles.ts` (+test) | ✎ | | | | | | | |
| `packages/shared/src/tasks.ts` (+test) | | ✎ | | | | | | |
| `packages/shared/src/tashkent-time.ts` (+test) | | | | ✎ | | | | |
| `packages/db/src/schema.ts` (+test), `drizzle/`, `migrations.test.ts` | | ✎ | | | | | | |
| `apps/core/src/tasks/tasks.service.ts` | ✎ | ✎ | | ✎ | | | | |
| `apps/core/src/tasks/tasks.controller.ts` | ✎ | ✎ | | ✎ | | | | |
| `apps/core/src/tasks/tasks.test.ts` | ✎ | ✎ | | ✎ | | | | |
| `apps/core/src/tasks/task-bridge.service.ts` (+test) | | | ✎ | | ✎ | | | |
| `apps/core/src/tasks/tasks.module.ts` | | | ✎ | | ✎ | | | |
| `apps/core/src/cron-shutdown.test.ts` | | | ✎ | | ✎ | | | |
| `apps/core/src/system/config-spec.ts` (+test) | | | ✎ | | | | | |
| `apps/core/src/registry/actions.service.ts` (+test) | | ✎ | | | | | | |
| `apps/core/src/rules/rules.ts` (+test) | | | | | | ✎ | | |
| `apps/bot/src/core-client.ts` | | ✎ | | ✎ | | ✎ | | |
| `apps/bot/src/index.ts` | | | | ✎ | | ✎ | | |
| `apps/bot/src/staff.ts` | | | | | | ✎ | ✎ | |
| `apps/bot/src/task-confirm.ts` (+test) | | | | | | ✎ | ✎ | |
| `apps/bot/src/push-hours.ts`, `tasks-push.ts` (+tests) | | | | ✎ | | | | |
| `apps/bot/src/menu.ts` (+test) | | | | | | | ✎ | |
| `apps/bot/src/weekly-digest.ts` | ✎ | | | | | | | |
| `apps/cc/src/lib/core.ts` | | ✎ | | | | | ✎ | |
| `apps/cc/src/app/tasks/**`, `components/awaiting-block.*` | | | | | | | ✎ | |
| `tools/smoke-core.mjs` | | ✎ | | ✎ | | | | |
| `tools/smoke-panel.mjs` | | | | | | | ✎ | |
| `docs/DATA_SOURCES.md` | | | ✎ | | | | | |
| `docs/DEPLOY.md`, `AGENTS_ACTIVATION.md`, `PLAN_STOCK_ABSORPTION.md` | | | | | | | | ✎ |

Проверка по столбцам волн: **В2** — `{T1}` и `{T4}` не делят ни одного файла; **В3** — `{T2}` и `{T7}` не делят ни одного файла. Остальные волны одиночные.

**Известные риски исполнения.** (1) `apps/core/src/tasks/tasks.service.ts` правят ТРИ задачи в трёх разных волнах — порядок обязателен: T5 вносит `assertCan` и чтение `before` в `edit()`, T1 на них опирается, T2 дописывает четвёртую точку отметки в тот же `edit()`. Нарушишь порядок — получишь три конфликтующие версии одного метода. (2) Конструктор `TaskBridgeService` растёт с четырёх аргументов до пяти в Task 5: механическая правка стенда и `cron-shutdown.test.ts`, но пропуск роняет ВСЮ волну на компиляции (Task 5 Step 4 называет её явно). (3) Номер миграции выбирают три среза одновременно; сверять `ls packages/db/drizzle | tail -3` НЕПОСРЕДСТВЕННО перед `db:generate`, а не в начале работы. (4) `apps/bot/src/index.ts` и `core-client.ts` делят Task 4 и Task 6 — они РАЗНЫХ волн намеренно; попытка ускориться, слив их в одну, даст конфликт на обеих петлях. (5) Тихие часы делают тесты пушей чувствительными к моменту: во всех тестах `now` передаётся ЯВНО, ни один не полагается на часы прогона — иначе набор краснел бы после 22:00 по Ташкенту. (6) Общий worktree с Codex: перед правкой дерева сверять `mtime` чужих файлов и коммитить только своими путями (`git commit -- …`); `git add -A` утащит чужое. (7) Мост включён по умолчанию — первое утро после мержа создаст задачи БЕЗ отдельного действия человека; ожидаемый объём посчитан заранее (Выкатка §6), кнопка выключения — одно сохранение в панели.
