# Срез П6 «Фискальный блок карточки снека, сторно с журналом, „Мои записи“» — план реализации (7 задач)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** На все семь вопросов владельца из §1 спеки появляется ответ в коде, а не в голове. У карточки снека заводится ТИПИЗИРОВАННЫЙ фискальный блок (ИКПУ · МХИК · НДС · штрих-код · код упаковки ОКЕИ · маркировка) с единственным писателем, следом в `audit_log` и правилом в брифинг; проверка кода перестаёт быть «17 цифр у ИКПУ и больше ничего»; владелец видит и правит блок в панели и читает его из бота командой «карточка <товар>»; 44 донорских кода `mydon-stock` переезжают разовым идемпотентным скриптом, который пишет ТОЛЬКО SKU-уровневые значения и печатает всё спорное; три вида снек-записей (заправка · пересчёт · касса закупа) получают отмену СТОРНИРУЮЩЕЙ строкой — тремя разными формами, потому что ленты разные; полевой сотрудник получает в боте экран «✏️ Мои записи» с двухшаговым подтверждением, а вместе с ним — проводку автора, без которой этот экран пуст по построению для двух видов записей из трёх.

**Architecture:** Ничего нового не заводится там, где уже есть готовое. Фискальные поля — шесть колонок в `vending_product` рядом с правилами закупа, а не вторая таблица и не второй справочный механизм: `entity(type='product').attrs` остаётся жить для кофейного контура реестра и становится ПЕРВЫМ источником переноса. Единственный писатель — `ProductFiscalService.update`, устроенный дословно как `setProductRules` (`vending.service.ts:2120`): запись, событие и аудит в ОДНОЙ транзакции, `tx.insert(auditLog)` вместо `AuditService.record`, чтобы журнал не пережил откат. Валидатор один на Core и на панель — `validateFiscalPatch` из нового `packages/shared/src/fiscal.ts`, поэтому текст ошибки в форме и в 400-ке буквально один и тот же. Сторно — не удаление: `vending_refill` получает противознак (все существующие суммирующие читатели дают ноль без единой правки), `vending_stock_count` — метку отмены на ВЕСЬ ввод по `(source, countedAt, personId)`, `vending_cash_session` — противознак по трём суммам и по каждой статье. Идемпотентность отмены достаётся бесплатно: у заправки — существующим `vending_refill_client_key`, у пересчёта и кассы — новыми частичными уникальными по `reverses_id where source='storno'`. Лента «Действия» читает доменные таблицы, поэтому сторно-строка попадёт туда САМА — и ветка подписи там не улучшение, а обязательство.

**Tech Stack:** TypeScript strict, NestJS + class-validator/class-transformer, Drizzle/Postgres (**одна миграция — «следующая свободная», см. Global Constraints**), `node:test` по dist (core/bot/shared/db) + vitest (cc), Testing Library, `tools/smoke-core.mjs` против живого Postgres, Telegram-бот, Next.js App Router (панель — форма по конвенции `CLAUDE.md:57-67`).

**Spec:** `docs/superpowers/specs/2026-08-26-p6-fiscal-design.md` (коммит `cfa4b54`, рулинги R-P6-1…R-P6-14)
**Опись:** `.superpowers/sdd/2026-08-26-sloy-p6-fiscal/inventory.md`, рулинги контроллера — `.superpowers/sdd/2026-08-26-sloy-p6-fiscal/progress.md`. Каталог `.superpowers/` не версионируется; в этом worktree он ЕСТЬ (проверено).

**Ветка:** `feat/p6-fiscal` = `origin/main` **b3b595d** («Хвосты снек-контура», #217) + коммит спеки `cfa4b54`. Зависимостей от невлитых веток нет.

## Global Constraints

Копия §4 спеки плюс рулинги, связывающие несколько задач сразу. Нарушение здесь — не стилевая правка: срез переопределяет CHECK на таблице, куда полевой сотрудник пишет каждый день, и заводит первый в снек-контуре путь, который МЕНЯЕТ уже записанное.

- **R-P6-1/R-P6-5 Фискальный блок = шесть типизированных колонок `vending_product`.** Единственный писатель — `ProductFiscalService`. `entity(type='product').attrs` НЕ трогаем и НЕ чистим: `fiscalGaps(attrs)` (`packages/shared/src/sources.ts:222`), «Фискальная готовность» (`apps/cc/src/components/product-card-sections.tsx:38`), кольцо полноты (`product-card-360.tsx:52`) и `isIncomplete` (`products-book.tsx:19`) продолжают обслуживать карточки реестра, где живёт кофе. `name_uz` не заводим (R-P6-4).
- **R-P6-6 CHECK в SQL — структура, словарь — в коде.** Длины и «только цифры» стоят CHECK'ами в миграции; допустимые ЗНАЧЕНИЯ (12/0/15, семь кодов ОКЕИ, 0/1) живут константами в `packages/shared/src/fiscal.ts` и проверяются DTO (`@IsIn`) и `<select>`. CHECK'и — в SQL-файле, а НЕ в drizzle-схеме: `check()` в схеме заставил бы генератор выпустить ещё одну миграцию ради ограничения, которое эта уже ставит (дословно причина `fixedPurchaseQty`, `packages/db/src/schema.ts:1394-1405`).
- **R-P6-7 `package_code` — это ОКЕИ, и только ОКЕИ.** Семизначные `entity.attrs["упаковка"]` (`1218841`…) — идентификатор каталога Multikassa, ДРУГАЯ величина; скрипт переноса не пишет их в `package_code` НИКОГДА, и это утверждает отдельный тест.
- **R-P6-8 НДС 12 по умолчанию — перенос донорского умолчания.** `vat_pct integer NOT NULL DEFAULT 12`; скрипт переноса эту колонку не трогает вообще (62/62 донорских строк = 12). Ставка 0 — законное значение, пустого не бывает.
- **R-P6-9 Категорийность решает СПРАВОЧНИК ДОНОРА, суффикс `000000` — независимая сверка.** Расхождение двух признаков либо отсутствие кода в справочнике → строка ПЕЧАТАЕТСЯ и НЕ пишется.
- **R-P6-10 Три вида — три формы сторно.** `refill` — дельта (противознак + возврат на склад); `stock_count` — метка (qty копируется, `vending_stock` НЕ трогаем, и бот обязан сказать это словами); `cash` — противознак по трём суммам и по каждой статье. Одна форма на три ленты означала бы либо удаление строк (запрещено R-P6-3), либо выдуманный факт «−19 штук на складе» в истории пересчётов.
- **R-P6-11 Единица отмены инвентаризации — ВВОД, а не позиция.** Ключ кнопки — `id` первой строки ввода; Core разворачивает его в группу по `(source='own', countedAt, personId)`.
- **R-P6-12 Окно 24 ч — по `created_at`; «без лимита» — это право `system.admin`.** Право читается В CORE по `person.roles` через `can(roles, "system.admin")` (`packages/shared/src/roles.ts:100`, право объявлено `:52`, `owner: [...PERMISSIONS]` `:96`). Седьмую роль не заводим. Окно — настройка `SNACK_CANCEL_WINDOW_HOURS`, не константа.
- **R-P6-13 Отмену видно там, где её ищут.** Лента «Действия» получает вид `vending_refill_cancelled` и ветку подписи; пересчёты и кассы в ленту НЕ добавляются. След всех трёх — `audit_log` before/after (`/audit`) и событие `vending.record_cancelled`.
- **R-P6-14 Перенос пишет ТРИ поля и никогда не затирает непустое:** `ikpu`, `barcode`, `marked` — и только туда, где у нас пусто. `vat_pct`, `package_code`, `mxik`, `pack_size` — не трогает ни при каких данных. `marked` умеет только подниматься `false → true`.
- **Миграция — «СЛЕДУЮЩАЯ СВОБОДНАЯ», а не 0072.** Спека писалась, когда последней в `main` была 0071; П7 и «Инкассации» идут параллельно и могут занять 0072/0073 раньше. Номер вычисляется КОМАНДОЙ на шаге 1 задачи 1 и перепроверяется после каждого `git rebase origin/main`; имя файла — `<NNNN>_product_fiscal_and_storno.sql`. Инварианты цепочки (файл ↔ запись журнала, `idx` подряд с нуля, префикс имени = `idx`) держит новый сторож `packages/db/src/migrations.test.ts` — он и есть защита от «две ветки взяли один номер».
- **Время.** Только `packages/shared/src/tashkent-time.ts`. `now` приходит **параметром** в `ProductFiscalService.update` и `RecordCancelService.cancel`; стенных часов внутри этих сервисов нет.
- **Настройки.** Только через `apps/core/src/system/config-spec.ts` (`CONFIG_SPECS` `:99`, поля `key/label/kind/fallback/help/validate`) с русским `help`; чтение — `readIntSetting` (`apps/core/src/system/settings.ts:40`); база важнее env.
- **`@Throttle`** — только именованные лимитеры `burst`/`sustained`; `default` ThrottlerGuard не читает (сторож `vending.controller.test.ts:15`). **Новых лимитеров в срезе нет** — единственный новый GET (`/vending/my-records`) отдаёт 15 строк по индексу.
- **Мутации — под глобальным `ServiceTokenGuard`** (`apps/core/src/app.module.ts:83`); чтения открыты внутри сети (изменение этого — П8 пп. 3–5, не здесь).
- **Ноль ≠ «всё хорошо».** Пустая выборка рендерится ТРЕТЬИМ состоянием. «Нет ИКПУ» и «ИКПУ из 16 цифр» показываются раздельно — это разные беды и чинятся по-разному.
- **Деньги — «N сум», проценты — «N %»** (с пробелом), минус — U+2212. Числа снек-листов — без U+00A0 (`count()`/`amount()`, `apps/cc/src/lib/format.ts:71`, `:80`); `money()` в снек-листах запрещена сторожем `snack-format.test.tsx`.
- **TS strict, без `any`.** Русский в UI, тестах и документации; идентификаторы — английские, экспортируемые имена общего слоя — латиницей.
- **Документация правится ВНУТРИ задачи, которой она нужна:** `docs/DATA_SOURCES.md` — T3, `docs/DEPLOY.md` — T6, `docs/PLAN_STOCK_ABSORPTION.md` — T7. Отдельного «доккоммита в конце» нет.
- **Записей в прод из задач плана — НИ ОДНОЙ.** Плановых записей ровно две, обе в разделе «Выкатка»: миграция автодеплоем и один прогон `import-fiscal.js --apply` после чистой примерки. В доноре — только SELECT, ничего не удаляется и не меняется.
- **Тесты по dist:** `pnpm --filter @mydon/shared build` ПЕРЕД `pnpm --filter @mydon/db test` / `pnpm --filter core test` / `pnpm --filter bot test`; `pnpm --filter cc test` — vitest. Существующие наборы остаются зелёными.
- **Смоук.** Каждое новое поле ответа и каждый новый роут — в `tools/smoke-core.mjs` (юнит-заглушка БД SQL не исполняет, а весь срез стоит на частичных уникальных индексах и переопределённом CHECK). Последняя строка файла печатает ЧИСЛО сценариев — при добавлении своих его надо поднять, иначе отчёт врёт. `tools/smoke-import.mjs` не трогаем (требует `SMOKE_SCRATCH=1` либо базы со словом `smoke` в имени).
- **Коммиты в общем worktree.** Коммитим ТОЛЬКО свои пути: `git commit -m "…" -- <путь> <путь>`; `git add -A` / `git commit -a` утащат чужие несохранённые правки (Codex работает на тех же репозиториях — перед правкой дерева сверять `mtime`). Conventional Commits + трейлеры `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` и `Claude-Session: …`. Push только в свою ветку: после `git checkout main` ПЕРВОЙ командой `git checkout -b` — фолбэк вида `|| git push` молча отправляет `main` в прод, а автодеплой ходит каждые 2 минуты.

### Параллельность и порядок

Контракты (T1 миграция+схема, T2 общий валидатор) идут первой волной; потребители — следом. Волны разведены ПО ФАЙЛАМ, а не по «кажется, не мешают»: матрица пересечений — в «Самопроверке плана».

| Волна | Задачи | Почему параллельно |
|---|---|---|
| 1 | **T1 ∥ T2** | `packages/db/{drizzle,src/schema*.ts,src/migrations.test.ts}` против `packages/shared/src/{fiscal.ts,fiscal.test.ts,index.ts}` — пересечений ноль |
| 2 | **T3 ∥ T6** | `apps/core/**` + `docs/DATA_SOURCES.md` против `packages/db/src/import-fiscal*.ts` + `packages/db/package.json` + `docs/DEPLOY.md` — пересечений ноль |
| 3 | **T4 ∥ T7** | `apps/cc/**` против `apps/core/**` + `apps/bot/{my-records,menu,staff,core-client,cash-intake}` + `tools/smoke-core.mjs` + `docs/PLAN_STOCK_ABSORPTION.md` — пересечений ноль |
| 4 | **T5** | один, ПОСЛЕ T7: обе задачи правят `apps/bot/src/core-client.ts` и `core-client.test.ts` |

T3 и T7 параллельными не бывают: они правят одни и те же шесть файлов (`vending.controller.ts`, `vending.controller.test.ts`, `vending.service.ts`, `vending.module.ts`, `rules.ts`, `rules.test.ts`) и оба — `tools/smoke-core.mjs`. Порядок T3 → T7, как в спеке: T3 ставит в контроллере образец DTO и роут, T7 дописывает рядом.

### Отклонения от буквы спеки, зафиксированные кодом

Семь — каждое проверено в рабочем дереве, каждое уходит в аддендум спеки шагом T7.

1. **Новый интерфейс называется `ProductFiscalFlaw`, а не `FiscalFlaw`.** Имя `FiscalFlaw` УЖЕ занято в `packages/shared/src/sources.ts:190` — это союз `"нет" | "неверно"`, и он реэкспортируется барелем (`index.ts:50`). Второй `export * from "./fiscal"` с тем же именем даёт TS2308 («уже экспортирован член с именем FiscalFlaw»), а в рантайме ES-модулей неоднозначное имя просто ИСЧЕЗАЕТ из барреля — то есть `FiscalGap.flaw` перестал бы резолвиться у существующих потребителей. Поле `flaw` нового интерфейса при этом ТИПИЗИРОВАНО существующим союзом (`import type { FiscalFlaw } from "./sources"`), то есть «тем же языком, что `FiscalGap`» — буквально, а не по совпадению слов.
2. **Номер миграции — вычисляемый, плюс сторож цепочки.** См. Global Constraints. Сторож green на сегодняшнем дереве (проверено: 72 файла ↔ 72 записи, `idx` 0…71, префиксы совпадают) и НЕ проверяет наличие `meta/<NNNN>_snapshot.json`: снапшотов 65, у семи рукописных миграций (`0049`…`0055`) их нет, и такая проверка была бы красной с рождения.
3. **`ProductFiscal` в панель импортируется, но НЕ реэкспортируется из `apps/cc/src/lib/core.ts`.** В `apps/cc` уже живёт React-компонент с этим именем (`components/product-card-sections.tsx:38`, зовётся из `app/card/[id]/page.tsx:728`, `:1058`). Реэкспорт типа из `lib/core.ts` завёл бы одно имя на две разные вещи в одном приложении, и первый же файл, которому нужны обе, не соберётся. Тип берётся прямым импортом `import type { ProductFiscal } from "@mydon/shared"` там, где он нужен (`lib/core.ts`, `product-fiscal-form.tsx`, `product-rules-panel.tsx`). Компиляторная сверка зеркал (`core-types.test.ts`) от этого не страдает: она и так импортирует общий тип под алиасом.
4. **Спека цитирует `stockCounts` по `vending.service.ts:1658` — в дереве он на `:1609`.** Остальные адреса спеки сверены и верны (`ingestStock:1394`, `products():2092`, `setProductRules:2120`, `recordCashSession:2925`, `VendingProductRow:510`, роуты контроллера `:548/:554/:601/:627/:656`). Реализующий по `:1658` открыл бы не тот код.
5. **Бот получает СВОЙ тип строки прайса — `VendingProductCard`, а не `VendingProductRow`.** Сегодня `CoreClient.vendingProducts()` объявляет сужённый ответ `{ id; name; isActive }[]` (`apps/bot/src/core-client.ts:1104`), и единственный его потребитель (`staff-refill.ts:763`) берёт оттуда два поля. Карточке нужны цена, блок, эталон, категория и `fiscal`. Полный перенос `VendingProductRow` в `@mydon/shared` спека прямо выносит за охват (§10), а объявить в боте копию под ТЕМ ЖЕ именем значит завести третье зеркало под видом одного. Поэтому в боте объявляется `VendingProductCard` — ровно поля, которые печатает карточка, — и `fiscal: ProductFiscal` в нём импортируется из shared. Подпись из спеки становится `formatProductCard(row: VendingProductCard): string`.
6. **`CashSessionRow` (Core) и `VendingCashSession` (бот) прирастают полем `source`.** Спека называет колонку `vending_cash_session.source` (миграция) и требует, чтобы `GET /vending/cash` показывал обе строки, но не выводит поле в ответ. Без него бот в «истории касс» (`apps/bot/src/cash-intake.ts:113`) напечатает `• 26.08 — получил −150 000 сум…` без единого слова о том, что это отмена — ровно тот дефект, который R-P6-13 называет обязательством для ленты «Действия». Диффа — одно поле в `select`-маппинге и один тернарник в форматтере.
7. **`StockCountRow` прирастает полем `id`.** Отмена пересчёта адресуется `id` первой строки ввода (R-P6-11), а «Мои записи» строятся поверх той же выборки. Сегодня `stockCounts()` `id` не отдаёт (`vending.service.ts:1630-1637`), хотя в `orderBy` он уже участвует третьим ключом. Поле аддитивное, оно нужно и листу «История склада» из «Хвостов» (кнопки там нет, но строка теперь адресуема), и `my-records`.
8. **Номера строк `packages/db/src/schema.ts` в Task 1–5 сверены против `b3b595d` и УЖЕ РАСХОДЯТСЯ с деревом.** Между написанием спеки/Task 1–5 и продолжением плана в `main` смёржен PR #218 «Гигиена» (`f9beb7b`): он вставил docblock + константу `TASK_SOURCE_DAY_PREDICATE` ПЕРЕД таблицей `task` (район старой строки 168) — чистая вставка на +19 строк, ничего не удалено и не переставлено. Всё, что в Task 1–5 процитировано ниже этой точки, сдвинуто: например `vendingProduct` был «стр. 1371–1412» — сейчас `1390–1431`; `vendingStockCount` «1580–1613» → `1599–1632`; `vendingRefill` «1700–1741» → `1719–1758`; `vendingCashSession` «1827–1837» → `1846–1856` (сверено вручную построчным grep 26.08 вечером). Реализующий Task 1–5 обязан **сверять номер строки по живому файлу командой типа `grep -n "^export const vendingProduct" packages/db/src/schema.ts`, а не доверять цифре в тексте плана** — пересчитывать все старые цитаты вручную здесь не входит в объём этого дописывания (отдельная, отдельно оцениваемая правка). Все НОВЫЕ цитаты в Task 6–7 ниже уже сверены по дереву на момент дописывания (26.08, после `git merge origin/main`, коммит слияния см. `git log -1`).
9. **Проводка автора для `stock`/`cash` (задача 7, R-P6-3 дыры 1–2) резолвится в `apps/bot/src/handler.ts`, а не «просто передаётся».** Спека называет только клиентские методы (`core-client.ts:487-495`/`:501-514` по своей нумерации), но не называет ОТКУДА боту взять `personId` в этих двух местах. Проверено: `POST /vending/stock` и `POST /vending/cash` в боте вызываются РОВНО из `handleMessage` (`apps/bot/src/handler.ts`, ветки `isCashPrefixed`/`isStockCommand`) — это единственный маршрут владельца (`apps/bot/src/index.ts:837`, `!asStaff.has(chatId)`), и `index.ts` НЕ резолвит `person` перед вызовом `handleMessage` (в отличие от `staff`-маршрута и регистрации, где уже есть готовый паттерн `personOf(chatId)` → `deps.core.personByChat`, `index.ts:153-160`). Роль `owner` в матрице прав предполагает, что у владельца ЕСТЬ карточка `person` (R-P6-12 этого же плана: «отмена без лимита не сработает ни у кого, включая владельца», если роль не проставлена) — значит, тот же `personByChat` резолвит и его. Решение (реализуется в Task 7, шаг для `handler.ts`): резолвить `person` ЛОКАЛЬНО внутри каждой из двух веток (`isCashPrefixed`, `isStockCommand`) через `deps.core.personByChat(String(chatId))`, а не добавлять резолв на КАЖДОЕ сообщение владельца — большинство команд личность автора не спрашивают, и лишний HTTP-вызов на каждый брифинг-запрос не оправдан. Не найденный человек (`{ found: false }`) — не ошибка: запись уходит без автора, как и раньше.

## Карта файлов

| Файл | Задача | Роль |
|---|---|---|
| `packages/db/drizzle/<NNNN>_product_fiscal_and_storno.sql` | T1 | шесть колонок + 5 CHECK; `reverses_id` ×3; переопределённый CHECK `qty`; `source` у кассы; три индекса |
| `packages/db/drizzle/meta/{<NNNN>_snapshot.json,_journal.json}` | T1 | снапшот и запись журнала (через `db:generate`) |
| `packages/db/src/schema.ts` | T1 | шесть полей `vendingProduct`; `reversesId` у трёх таблиц; `source` у кассы; **снятие `check("vending_refill_qty_positive")`** |
| `packages/db/src/schema.test.ts` | T1 | сторожи: шесть колонок, CHECK живёт в SQL, частичность сторно-индексов |
| `packages/db/src/migrations.test.ts` (новый) | T1 | сторож цепочки миграций (файл ↔ журнал, `idx` подряд, префикс = `idx`) |
| `packages/shared/src/fiscal.ts` (+`fiscal.test.ts`) | T2 | `ProductFiscal`, словари, `validateFiscalPatch`, `fiscalFlaws`, `fiscalReady`, `normalizeFiscalInput`, `classifyIkpu` |
| `packages/shared/src/index.ts` | T2 | `export * from "./fiscal";` |
| `apps/core/src/vending/product-fiscal.service.ts` (+test) | T3 | единственный писатель фискального блока |
| `apps/core/src/vending/vending.service.ts` | T3·T7 | `VendingProductRow.fiscal` + `products()`; `StockCountRow.id`, фильтр сторно в `stockCounts()`, `myRecords()`, `CashSessionRow.source` |
| `apps/core/src/vending/vending.controller.ts` (+test) | T3·T7 | `SetProductFiscalDto` + `POST product-fiscal`; `CancelRecordDto`/`MyRecordsDto` + три `POST …/cancel` + `GET my-records` |
| `apps/core/src/vending/vending.module.ts` | T3·T7 | провайдеры `ProductFiscalService`, `RecordCancelService` |
| `apps/core/src/rules/rules.ts` (+`rules.test.ts`) | T3·T7 | правила `vending.product_fiscal_changed`, `vending.record_cancelled` |
| `apps/core/src/vending/record-cancel.service.ts` (+test) | T7 | три ветки сторно в одной транзакции + права + окно |
| `apps/core/src/system/config-spec.ts` (+test) | T7 | ключ `SNACK_CANCEL_WINDOW_HOURS` |
| `apps/core/src/registry/actions.service.ts` (+test) | T7 | `source` в выборке, вид `vending_refill_cancelled`, ветка подписи |
| `apps/cc/src/lib/core.ts` (+`core-types.test.ts`) | T4 | `VendingProductRow.fiscal`, клиент `setVendingProductFiscal` |
| `apps/cc/src/app/vending/actions.ts` | T4 | server action `saveVendingProductFiscal` |
| `apps/cc/src/components/product-fiscal-form.tsx` (+test) | T4 | форма по конвенции `CLAUDE.md:57-67` |
| `apps/cc/src/components/product-rules-panel.tsx` (+test) | T4 | чип готовности + вторая форма одним блоком |
| `apps/bot/src/product-card.ts` (+test) | T5 | «карточка <товар>» с фискальным блоком |
| `apps/bot/src/handler.ts` | T5 | роутинг раньше `isRuleCommand` |
| `apps/bot/src/core-client.ts` (+test) | T5·T7 | `VendingProductCard`; проводка автора, `myRecords`, `cancelVendingRecord`, `source` у кассы |
| `apps/bot/src/my-records.ts` (+test) | T7 | экран «Мои записи», две кнопки в разных рядах, строгий разбор |
| `apps/bot/src/menu.ts` (+`menu.test.ts`), `apps/bot/src/staff.ts` | T7 | пункт «✏️ Мои записи» и его проводка |
| `apps/bot/src/cash-intake.ts` (+test) | T7 | подпись отменённой кассы в истории |
| `packages/db/src/import-fiscal.ts` (+test) | T6 | разовый перенос `--dry-run`/`--apply` |
| `packages/db/package.json` | T6 | скрипт `db:import:fiscal` |
| `tools/smoke-core.mjs` | T3·T7 | фискальная правка; три сценария сторно; `my-records` |
| `docs/DATA_SOURCES.md` · `docs/DEPLOY.md` · `docs/PLAN_STOCK_ABSORPTION.md` | T3·T6·T7 | где живут фискальные поля; как гонять перенос; что закрыто в П6 |

---

### Task 1: Миграция и схема — шесть фискальных колонок, `reverses_id` у трёх таблиц, переопределённый CHECK `qty`

**Files:** Modify `packages/db/src/schema.ts` (`vendingProduct` стр. 1371–1412; `vendingStockCount` стр. 1580–1613, список индексов 1603–1612; `vendingRefill` стр. 1700–1741, **`check("vending_refill_qty_positive"…)` стр. 1738**; `vendingCashSession` стр. 1827–1837), `packages/db/src/schema.test.ts` (набор «Схема MYDON Core (ТЗ §7)», тест «вендинг: слот хранит ВМЕСТИМОСТЬ и остаток» стр. 74, сторож индексов ретенции стр. 98 — из него берём готовые помощники `конфиг`/`имена` стр. 105–114). Create `packages/db/drizzle/<NNNN>_product_fiscal_and_storno.sql`, `packages/db/src/migrations.test.ts`; `packages/db/drizzle/meta/<NNNN>_snapshot.json` и запись в `packages/db/drizzle/meta/_journal.json` — генерируются `db:generate`.

**Interfaces (consumes):** `pgTable`/`text`/`integer`/`boolean`/`uuid`/`index`/`uniqueIndex`/`check` (drizzle-orm/pg-core, уже импортированы в `schema.ts`); защитный паттерн `IF NOT EXISTS` в рукописных миграциях (`0067`, `0069`, `0070`, `0071`); объяснение «CHECK живёт в SQL, а не в схеме» — `schema.ts:1394-1405` (`fixedPurchaseQty`); извлечение конфигурации индексов через `Symbol.for("drizzle:ExtraConfigBuilder")` (`schema.test.ts:105-114`).

**Interfaces (produces):**
```ts
/** packages/db/src/schema.ts — vendingProduct прирастает шестью полями */
  /** ИКПУ, 17 цифр. NULL — код не выясняли. CHECK живёт в SQL миграции. */
  ikpu: text("ikpu"),
  /** МХИК, 17 цифр. Правило донора (`validate_fiscal`), не проверенная нами норма (R-P6-3). */
  mxik: text("mxik"),
  /**
   * Ставка НДС, целые проценты. Умолчание 12 ПЕРЕНЕСЕНО от донора
   * (`vat_rate NUMERIC NOT NULL DEFAULT 12`) и НЕ является решением о карточке
   * (R-P6-8): ноль в Узбекистане записывается ЯВНО, а пустого здесь не бывает.
   */
  vatPct: integer("vat_pct").default(12).notNull(),
  /** EAN: 8, 12 или 13 цифр. NULL — не выясняли. */
  barcode: text("barcode"),
  /**
   * Код ОКЕИ («796» штука). НЕ идентификатор упаковки каталога Multikassa —
   * те семизначные (`1218841`) и живут в `entity.attrs["упаковка"]` (R-P6-7).
   * Сложив их в одну колонку, получили бы поле, где два числа значат разное,
   * а выглядят одинаково.
   */
  packageCode: text("package_code").default("796").notNull(),
  /** Требует маркировки (КИЗ). `false` значит И «не требуется», И «не выясняли» — различить нечем. */
  marked: boolean("marked").default(false).notNull(),

/** vendingRefill: новая колонка + индекс; check(...) СНЯТ */
  /** Оригинал, который эта строка сторнирует (R-P6-10). NULL — обычная заливка. */
  reversesId: uuid("reverses_id").references((): AnyPgColumn => vendingRefill.id),
  // …в списке индексов:
  index("vending_refill_reverses_idx").on(t.reversesId).where(sql`${t.reversesId} is not null`),
  // CHECK «qty» живёт в SQL миграции <NNNN>, а НЕ здесь: у сторно qty < 0, и
  // выразить это в drizzle-схеме значило бы выпустить ещё одну миграцию ради
  // ограничения, которое <NNNN> уже ставит (та же причина, что у fixedPurchaseQty).

/** vendingStockCount / vendingCashSession */
  reversesId: uuid("reverses_id").references((): AnyPgColumn => vendingStockCount.id),
  uniqueIndex("vending_stock_count_storno_key").on(t.reversesId).where(sql`${t.source} = 'storno'`),

  /** Откуда строка: 'own' (поход на базар) | 'storno' (отмена). Колонки не было вовсе. */
  source: text("source").default("own").notNull(),
  reversesId: uuid("reverses_id").references((): AnyPgColumn => vendingCashSession.id),
  uniqueIndex("vending_cash_session_storno_key").on(t.reversesId).where(sql`${t.source} = 'storno'`),
```

Что обязана делать реализация:
- Колонки и индексы заводятся В DRIZZLE-СХЕМЕ (без них `select` их не увидит), CHECK'и — НЕТ.
- `vendingCashSession` сегодня объявлена без второго аргумента (`pgTable("vending_cash_session", {…})`, `schema.ts:1827`) — у неё нет списка индексов вовсе. Он добавляется третьим аргументом-стрелкой, как у соседей.
- Самоссылка колонки (`reverses_id` → `id` той же таблицы) требует явной аннотации возвращаемого типа `(): AnyPgColumn =>` — иначе TS ругается на циклический вывод. `AnyPgColumn` импортируется из `drizzle-orm/pg-core`.

- [ ] **Step 1: Номер миграции — командой, а не из спеки.**
```bash
ls packages/db/drizzle/*.sql | sed -E 's#.*/([0-9]{4})_.*#\1#' | sort -n | tail -1
node -e 'const j=require("./packages/db/drizzle/meta/_journal.json");console.log("последняя запись журнала:",j.entries.at(-1).idx,j.entries.at(-1).tag)'
```
Оба числа обязаны совпасть. Следующий свободный = последнее + 1, дополненное до четырёх цифр. Это число дальше подставляется вместо `<NNNN>` везде, включая имя снапшота и трейлер коммита. **После каждого `git rebase origin/main` команду повторить:** П7 и «Инкассации» идут параллельно, и занятый номер обнаруживается сторожем шага 4, а не в проде.
- [ ] **Step 2: Сторож цепочки миграций RED.** Создать `packages/db/src/migrations.test.ts`:
```ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * Сторож ЦЕПОЧКИ миграций, а не их содержания.
 *
 * Ловит ровно один класс аварии: две ветки взяли один номер. Мигратор
 * drizzle идёт по `_journal.json`, а не по каталогу, поэтому файл без записи
 * НЕ применится вовсе (и это будет видно только в проде, когда колонки нет), а
 * запись без файла роняет автодеплой на ровном месте. Оба случая рождаются в
 * rebase и оба невидимы для `pnpm build`.
 *
 * Папка считается от расположения файла (`dist/../drizzle`), а не от cwd, —
 * тот же приём, что в `migrate.ts:33`: тесты зовут и из корня, и из пакета.
 *
 * Снапшоты (`meta/<NNNN>_snapshot.json`) НЕ проверяются намеренно: их 65 на 72
 * миграции — у семи рукописных (`0049`…`0055`) снапшота нет, и такая проверка
 * была бы красной с рождения, то есть её бы отключили в первый же день.
 */
const ПАПКА = path.resolve(__dirname, "..", "drizzle");

interface ЗаписьЖурнала { idx: number; tag: string }

function журнал(): ЗаписьЖурнала[] {
  const raw = readFileSync(path.join(ПАПКА, "meta", "_journal.json"), "utf8");
  return (JSON.parse(raw) as { entries: ЗаписьЖурнала[] }).entries;
}

describe("Цепочка миграций: файл ↔ журнал (сторож номера)", () => {
  const записи = журнал();
  const файлы = readdirSync(ПАПКА).filter((f) => f.endsWith(".sql")).map((f) => f.slice(0, -4));

  it("у каждого .sql есть запись журнала, у каждой записи — файл", () => {
    const теги = new Set(записи.map((e) => e.tag));
    for (const f of файлы) assert.ok(теги.has(f), `${f}.sql не записан в _journal.json — мигратор его не применит`);
    const наДиске = new Set(файлы);
    for (const e of записи) assert.ok(наДиске.has(e.tag), `в журнале есть ${e.tag}, а файла нет — автодеплой упадёт`);
  });

  it("idx идут подряд с нуля и не повторяются", () => {
    assert.deepEqual(
      записи.map((e) => e.idx),
      записи.map((_, i) => i),
      "дырка или дубль idx — верный признак того, что две ветки взяли один номер",
    );
  });

  it("префикс имени файла равен idx", () => {
    for (const e of записи) {
      assert.equal(e.tag.slice(0, 4), String(e.idx).padStart(4, "0"), `${e.tag}: имя и idx разошлись`);
    }
  });

  it("теги уникальны", () => {
    assert.equal(new Set(записи.map((e) => e.tag)).size, записи.length);
  });
});
```
> Этот набор ЗЕЛЁН на сегодняшнем дереве (72 файла ↔ 72 записи, `idx` 0…71) — он и должен быть зелёным: его работа начинается на rebase, а не сейчас.
- [ ] **Step 3: Сторожи схемы RED.** Дописать в `packages/db/src/schema.test.ts`, внутрь набора «Схема MYDON Core (ТЗ §7)», после теста стр. 74:
```ts
  it("вендинг: у карточки прайса есть ФИСКАЛЬНЫЙ БЛОК из шести полей (П6, R-P6-5)", () => {
    const prod = Object.keys(schema.vendingProduct as unknown as Record<string, unknown>);
    for (const поле of ["ikpu", "mxik", "vatPct", "barcode", "packageCode", "marked"]) {
      assert.ok(prod.includes(поле), `нет фискального поля ${поле} — чек по карточке не собрать`);
    }
    // `vat_pct` и `package_code` НЕ nullable: пустой ставки не бывает (R-P6-8),
    // пустой единицы измерения — тоже. Проверяем через сам столбец, а не через
    // список имён: notNull() — это и есть отличие «0 %» от «не выясняли».
    const колонки = (schema.vendingProduct as unknown as { vatPct: { notNull: boolean }; packageCode: { notNull: boolean }; ikpu: { notNull: boolean } });
    assert.equal(колонки.vatPct.notNull, true, "ставка НДС обязана иметь значение всегда");
    assert.equal(колонки.packageCode.notNull, true, "код упаковки обязан иметь значение всегда");
    assert.equal(колонки.ikpu.notNull, false, "ИКПУ, наоборот, обязан уметь быть пустым: «не выясняли» — это ответ");
  });

  it("СТРАЖ: CHECK «qty» заливки живёт в SQL-миграции, а не в drizzle-схеме (R-P6-6)", () => {
    // У сторно qty < 0, и старый check(«qty > 0») его бы отверг. Переопределение
    // стоит в SQL; объяви его здесь — и генератор выпустил бы ЕЩЁ ОДНУ миграцию
    // ради ограничения, которое уже поставлено, а снапшот разошёлся бы с файлом
    // (та же причина записана у fixedPurchaseQty, schema.ts:1394-1405).
    const исходник = readFileSync(path.join(__dirname, "..", "src", "schema.ts"), "utf8");
    assert.ok(
      !/check\(\s*"vending_refill_qty_positive"/.test(исходник),
      "CHECK вернулся в схему — при следующем db:generate появится миграция-призрак",
    );
  });

  it("сторно-индексы ЧАСТИЧНЫЕ: уникальность только при source='storno'", () => {
    // Сплошной unique(reverses_id) не нужен и вреден: у обычных строк он NULL
    // (в Postgres NULL уникальности не мешает), но частичность — это ДОГОВОР,
    // что вторая сторно-строка на тот же оригинал невозможна, и повторное
    // нажатие кнопки в боте безвредно. У пересчёта своего client_key нет —
    // вся идемпотентность держится ровно на этом индексе.
    for (const [таблица, индекс] of [
      [schema.vendingStockCount, "vending_stock_count_storno_key"],
      [schema.vendingCashSession, "vending_cash_session_storno_key"],
      [schema.vendingRefill, "vending_refill_reverses_idx"],
    ] as const) {
      assert.ok(имена(таблица).includes(индекс), `нет индекса ${индекс}`);
    }
  });
```
> Помощники `конфиг`/`имена` объявлены внутри теста стр. 98 — при добавлении третьего потребителя поднять их на уровень `describe` (одна правка отступов, тела не меняются). `readFileSync`/`path` дописать в импорты файла.
- [ ] **Step 4:** `pnpm --filter @mydon/db build && pnpm --filter @mydon/db test` → RED (нет фискальных полей, нет сторно-индексов; сторож CHECK **зелёный** — `check(...)` ещё на месте, значит он пока и не должен падать… нет: тест утверждает ОТСУТСТВИЕ строки, и сейчас он КРАСНЫЙ. Это правильный RED).
- [ ] **Step 5: Правка схемы.** В `packages/db/src/schema.ts`:
  - импорт `import { type AnyPgColumn } from "drizzle-orm/pg-core";` (или дописать `AnyPgColumn` в существующий импорт);
  - шесть полей в `vendingProduct` — между `fixedPurchaseQty` и `isActive`, с докблоками из «Interfaces (produces)» дословно;
  - `vendingRefill`: поле `reversesId` после `createdBy`; в списке индексов — частичный `vending_refill_reverses_idx`; **строка `check("vending_refill_qty_positive", sql\`${t.qty} > 0\`)` УДАЛЯЕТСЯ** и заменяется комментарием;
  - `vendingStockCount`: поле `reversesId` после `note`; `uniqueIndex("vending_stock_count_storno_key")` в конце списка;
  - `vendingCashSession`: поля `source` (после `remainder`) и `reversesId` (после `createdBy`), плюс НОВЫЙ третий аргумент `(t) => [uniqueIndex("vending_cash_session_storno_key")…]`.
- [ ] **Step 6: Сгенерировать миграцию и заменить её тело.**
```bash
pnpm --filter @mydon/db db:generate     # создаст <NNNN>_<случайный_тег>.sql + meta/<NNNN>_snapshot.json + запись журнала
```
Затем: переименовать файл в `<NNNN>_product_fiscal_and_storno.sql`, поправить `tag` в `meta/_journal.json` на то же имя и **заменить сгенерированное тело** на рукописное (генератор не ставит `IF NOT EXISTS` и не знает про CHECK'и):
```sql
-- П6: фискальный блок карточки снека (R-P6-1/R-P6-5) и сторно снек-записей
-- (R-P6-3/R-P6-10). Идемпотентно; дефолты безопасны для 52 живых строк прайса.
--
-- IF NOT EXISTS везде — защитный паттерн 0067/0069/0070/0071: автодеплой
-- применяет миграции без отката, и каждый оператор обязан быть безопасен на
-- повторе.

-- 1. Фискальные поля прайса. CHECK'и СТРУКТУРНЫЕ (длина и цифры); набор
--    значений (12/0/15, семь кодов ОКЕИ) живёт в @mydon/shared — R-P6-6:
--    ставки НДС меняют законом, и в день изменения не должно требоваться
--    миграции.
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "ikpu" text;--> statement-breakpoint
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "mxik" text;--> statement-breakpoint
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "vat_pct" integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "barcode" text;--> statement-breakpoint
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "package_code" text DEFAULT '796' NOT NULL;--> statement-breakpoint
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "marked" boolean DEFAULT false NOT NULL;--> statement-breakpoint

ALTER TABLE "vending_product" DROP CONSTRAINT IF EXISTS "vending_product_ikpu_check";--> statement-breakpoint
ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_ikpu_check"
  CHECK ("ikpu" IS NULL OR "ikpu" ~ '^[0-9]{17}$');--> statement-breakpoint
ALTER TABLE "vending_product" DROP CONSTRAINT IF EXISTS "vending_product_mxik_check";--> statement-breakpoint
ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_mxik_check"
  CHECK ("mxik" IS NULL OR "mxik" ~ '^[0-9]{17}$');--> statement-breakpoint
ALTER TABLE "vending_product" DROP CONSTRAINT IF EXISTS "vending_product_barcode_check";--> statement-breakpoint
ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_barcode_check"
  CHECK ("barcode" IS NULL OR "barcode" ~ '^([0-9]{8}|[0-9]{12}|[0-9]{13})$');--> statement-breakpoint
ALTER TABLE "vending_product" DROP CONSTRAINT IF EXISTS "vending_product_package_code_check";--> statement-breakpoint
ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_package_code_check"
  CHECK ("package_code" ~ '^[0-9]{3}$');--> statement-breakpoint
ALTER TABLE "vending_product" DROP CONSTRAINT IF EXISTS "vending_product_vat_pct_check";--> statement-breakpoint
ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_vat_pct_check"
  CHECK ("vat_pct" >= 0 AND "vat_pct" <= 100);--> statement-breakpoint

-- 2. Сторно заправок. qty — ДЕЛЬТА, поэтому противознак; старый CHECK
--    «qty > 0» его бы отверг. Ослабляем РОВНО на источник 'storno':
--    обычная заправка на минус по-прежнему невозможна.
ALTER TABLE "vending_refill" ADD COLUMN IF NOT EXISTS "reverses_id" uuid REFERENCES "vending_refill"("id");--> statement-breakpoint
ALTER TABLE "vending_refill" DROP CONSTRAINT IF EXISTS "vending_refill_qty_positive";--> statement-breakpoint
ALTER TABLE "vending_refill" ADD CONSTRAINT "vending_refill_qty_positive"
  CHECK (("source" = 'storno' AND "qty" < 0) OR ("source" <> 'storno' AND "qty" > 0));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "vending_refill_reverses_idx"
  ON "vending_refill" USING btree ("reverses_id") WHERE "reverses_id" IS NOT NULL;--> statement-breakpoint

-- 3. Сторно пересчётов. qty — СНИМОК, противознака нет, строка это МЕТКА:
--    «−19 штук на складе» никто не считал, и записать это значило бы выдумать
--    факт. Идемпотентность своим частичным уникальным: own_key её не
--    покрывает (он ограничен source='own').
ALTER TABLE "vending_stock_count" ADD COLUMN IF NOT EXISTS "reverses_id" uuid REFERENCES "vending_stock_count"("id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vending_stock_count_storno_key"
  ON "vending_stock_count" USING btree ("reverses_id") WHERE "source" = 'storno';--> statement-breakpoint

-- 4. Сторно касс закупа. Колонки source у таблицы не было вовсе.
ALTER TABLE "vending_cash_session" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'own' NOT NULL;--> statement-breakpoint
ALTER TABLE "vending_cash_session" ADD COLUMN IF NOT EXISTS "reverses_id" uuid REFERENCES "vending_cash_session"("id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "vending_cash_session_storno_key"
  ON "vending_cash_session" USING btree ("reverses_id") WHERE "source" = 'storno';
```
- [ ] **Step 7: Снапшот не должен разойтись.** `pnpm --filter @mydon/db db:generate` ещё раз → ожидание `No schema changes, nothing to generate`. Если генератор снова хочет миграцию — значит `check(...)` вернулся в схему либо колонка объявлена не так, как её ставит SQL.
- [ ] **Step 8:** `pnpm --filter @mydon/db build && pnpm --filter @mydon/db test` → GREEN; `pnpm -s typecheck`. На scratch-БД проверить, что миграция ИДЕМПОТЕНТНА и что CHECK работает в обе стороны:
```bash
createdb mydon_p6_smoke
DATABASE_URL=postgresql://…/mydon_p6_smoke node packages/db/dist/migrate.js   # «Миграции применены.»
DATABASE_URL=postgresql://…/mydon_p6_smoke node packages/db/dist/migrate.js   # повтор — тоже «применены», без ошибок
psql mydon_p6_smoke -c "insert into vending_refill (machine_serial, product_name, qty, performed_at, client_key, source) values ('X','Y',-1, now(), 'k1', 'bot')"     # ожидание: ОТКАЗ по vending_refill_qty_positive
psql mydon_p6_smoke -c "insert into vending_refill (machine_serial, product_name, qty, performed_at, client_key, source) values ('X','Y',-1, now(), 'k2', 'storno')"  # ожидание: ОК
psql mydon_p6_smoke -c "insert into vending_product (name, ikpu) values ('T','1234567890123456')"  # 16 цифр → ОТКАЗ по vending_product_ikpu_check
psql mydon_p6_smoke -c "select vat_pct, package_code from vending_product limit 1"                 # ожидание: 12 | 796
dropdb mydon_p6_smoke
```
- [ ] **Step 9:** `git commit -m "feat(db): фискальные поля карточки снека и сторно снек-записей — миграция <NNNN>, сторож цепочки миграций (П6, R-P6-5/R-P6-6/R-P6-10)" -- packages/db/drizzle packages/db/src/schema.ts packages/db/src/schema.test.ts packages/db/src/migrations.test.ts`

---

### Task 2: `packages/shared/src/fiscal.ts` — один валидатор на Core, панель и скрипт переноса

**Files:** Modify `packages/shared/src/index.ts` (рядом с `export * from "./sources";` стр. 50). Create `packages/shared/src/fiscal.ts`, `packages/shared/src/fiscal.test.ts`.

**Interfaces (consumes):** `IKPU_DIGITS = 17` и тип `FiscalFlaw = "нет" | "неверно"` (`packages/shared/src/sources.ts:187`, `:190`) — правило длины НЕ дублируется, союз состояний переиспользуется; тексты ошибок донора (`app/cards.py:16-24` в `mydon-stock`); словари донора (`app/refs_model.py:10-37`).

**Interfaces (produces):**
```ts
/** packages/shared/src/fiscal.ts */
import { IKPU_DIGITS, type FiscalFlaw } from "./sources";

/** Фискальный блок карточки снека — типизированный, в отличие от entity.attrs. */
export interface ProductFiscal {
  /** ИКПУ, 17 цифр. null — код не выясняли (это НЕ «чек не соберётся», это «не знаем»). */
  ikpu: string | null;
  /** МХИК, 17 цифр. Правило донора (`validate_fiscal`), не проверенная нами норма — R-P6-3. */
  mxik: string | null;
  /** Ставка НДС, целые проценты. 0 законен, пустого не бывает — R-P6-8. */
  vatPct: number;
  /** EAN: 8, 12 или 13 цифр. null — не выясняли. */
  barcode: string | null;
  /** Код ОКЕИ. НЕ идентификатор упаковки каталога Multikassa — R-P6-7. */
  packageCode: string;
  /** Требует маркировки (КИЗ). false = «не требуется» И «не выясняли». */
  marked: boolean;
}

/** Патч: undefined — не трогать, null — очистить (только у nullable-полей). */
export type ProductFiscalPatch = {
  [K in keyof ProductFiscal]?: ProductFiscal[K] | (null extends ProductFiscal[K] ? null : never);
};

export const FISCAL_DEFAULTS = { vatPct: 12, packageCode: "796", marked: false } as const;

/** Длины штрих-кода — множество, как у донора (`_digits_ok(barcode, {8, 12, 13})`). */
export const BARCODE_DIGITS: readonly number[] = [8, 12, 13];

export interface DictEntry { code: string; label: string }

export const VAT_RATES: readonly DictEntry[];
export const PACKAGE_CODES: readonly DictEntry[];
export const MARKING: readonly DictEntry[];

/**
 * Что именно плохо в поле.
 *
 * `ProductFiscalFlaw`, а не `FiscalFlaw`: последнее имя занято СОЮЗОМ
 * состояний в `sources.ts:190`, и второе объявление под ним сломало бы
 * барель (`export *` с неоднозначным именем — TS2308). Поле `flaw`
 * типизировано ровно тем союзом: язык у обоих отчётов один.
 */
export interface ProductFiscalFlaw { field: keyof ProductFiscal; flaw: FiscalFlaw; why: string }

/** Проверка ПАТЧА перед записью: русские тексты, годятся и Core, и форме. */
export function validateFiscalPatch(patch: ProductFiscalPatch): string[];

/** Что мешает выбить чек по УЖЕ СОХРАНЁННОЙ карточке. Пусто — соберётся. */
export function fiscalFlaws(fiscal: ProductFiscal): ProductFiscalFlaw[];

/** Чек соберётся: есть ИКПУ верной длины и код упаковки из словаря. */
export function fiscalReady(fiscal: ProductFiscal): boolean;

/** Нормализация ввода: пробелы/NBSP/узкий пробел/дефисы вырезаются, "" → null. */
export function normalizeFiscalInput(raw: string | null | undefined): string | null;

/** Категорийный ли код ПО СПРАВОЧНИКУ ДОНОРА; суффикс `000000` — сверка (R-P6-9). */
export function classifyIkpu(
  code: string,
  dict: ReadonlyMap<string, string>,
): { kind: "sku" } | { kind: "category" } | { kind: "unknown"; why: string };
```

Что обязана делать реализация:
- Тексты ошибок — ДОСЛОВНО донорские, потому что владелец их уже читает в панели `mydon-stock`: «ИКПУ должен быть 17 цифр или пусто», «МХИК должен быть 17 цифр или пусто», «Штрихкод должен быть 8/12/13 цифр или пусто». Новые, которых у донора нет: «Код упаковки — 3 цифры ОКЕИ», «Ставка НДС — одно из: 12, 0, 15».
- `classifyIkpu` возвращает `unknown` в ДВУХ случаях: кода нет в справочнике донора; справочник и суффикс `000000` расходятся. Оба — в отчёт, не в базу.
- Метки словарей — подписи из `dictionary_entries` донора (ОКЕИ). Коды — несущие (по ним стоит `@IsIn`), метки — витринные: если формулировка донора отличается, побеждает донор.

- [ ] **Step 1: Тесты RED.** Создать `packages/shared/src/fiscal.test.ts`:
```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BARCODE_DIGITS,
  classifyIkpu,
  fiscalFlaws,
  fiscalReady,
  normalizeFiscalInput,
  PACKAGE_CODES,
  validateFiscalPatch,
  VAT_RATES,
  type ProductFiscal,
} from "./fiscal";

const ПОЛНЫЙ: ProductFiscal = {
  ikpu: "02202003001086002",
  mxik: null,
  vatPct: 12,
  barcode: null,
  packageCode: "796",
  marked: false,
};

describe("Фискальный блок: проверка патча (R-P6-6)", () => {
  it("ИКПУ из 17 цифр принят, из 16 — отвергнут текстом донора", () => {
    assert.deepEqual(validateFiscalPatch({ ikpu: "02202003001086002" }), []);
    // Ровно наш дефект `Coca-Cola ZeroS CAN 0.25`: потерян ведущий ноль.
    assert.deepEqual(validateFiscalPatch({ ikpu: "2202002001010032" }), ["ИКПУ должен быть 17 цифр или пусто"]);
  });

  it("пусто законно и для ИКПУ, и для МХИК, и для штрихкода", () => {
    assert.deepEqual(validateFiscalPatch({ ikpu: null, mxik: null, barcode: null }), []);
  });

  it("штрихкод: 8, 12 и 13 цифр приняты, 10 — отвергнут", () => {
    for (const n of BARCODE_DIGITS) {
      assert.deepEqual(validateFiscalPatch({ barcode: "1".repeat(n) }), [], `${n} цифр — законная длина EAN`);
    }
    assert.deepEqual(validateFiscalPatch({ barcode: "1".repeat(10) }), ["Штрихкод должен быть 8/12/13 цифр или пусто"]);
  });

  it("пробелы, NBSP, узкий пробел и дефисы в коде разделителями не считаются", () => {
    // Владелец копирует код из таблицы, и там он разбит на группы.
    assert.deepEqual(validateFiscalPatch({ ikpu: "022 0200-3001 086 002" }), []);
    assert.equal(normalizeFiscalInput("022 0200-3001 086 002"), "02202003001086002");
    assert.equal(normalizeFiscalInput("   "), null, "пустая строка — это сброс, а не значение");
    assert.equal(normalizeFiscalInput(undefined), null);
  });

  it("МХИК проверяется тем же правилом, что ИКПУ, — правило донора, не норма", () => {
    assert.deepEqual(validateFiscalPatch({ mxik: "1".repeat(17) }), []);
    assert.deepEqual(validateFiscalPatch({ mxik: "1".repeat(16) }), ["МХИК должен быть 17 цифр или пусто"]);
  });

  it("ставка вне набора 12/0/15 отвергнута, а сам набор — донорский", () => {
    assert.deepEqual(VAT_RATES.map((r) => r.code), ["12", "0", "15"]);
    assert.deepEqual(validateFiscalPatch({ vatPct: 0 }), [], "нулевая ставка — законное значение");
    assert.deepEqual(validateFiscalPatch({ vatPct: 7 }), ["Ставка НДС — одно из: 12, 0, 15"]);
  });

  it("`packageCode` вне словаря ОКЕИ отвергнут — 1218841 это не единица (R-P6-7)", () => {
    // Ровно то значение, что лежит в entity.attrs["упаковка"]: идентификатор
    // каталога Multikassa. Пустив его сюда, мы получили бы поле, где 796 и
    // 1218841 значат разное, а выглядят одинаково.
    assert.deepEqual(validateFiscalPatch({ packageCode: "1218841" }), ["Код упаковки — 3 цифры ОКЕИ"]);
    assert.deepEqual(validateFiscalPatch({ packageCode: "796" }), []);
    assert.equal(PACKAGE_CODES.length, 7, "семь значений словаря донора");
    assert.ok(PACKAGE_CODES.every((p) => /^\d{3}$/.test(p.code)));
  });
});

describe("Фискальный блок: готовность и дыры", () => {
  it("`fiscalReady` требует ИКПУ и код упаковки; маркировка на чек не влияет", () => {
    assert.equal(fiscalReady(ПОЛНЫЙ), true);
    assert.equal(fiscalReady({ ...ПОЛНЫЙ, marked: true }), true, "КИЗ — не про сборку чека");
    assert.equal(fiscalReady({ ...ПОЛНЫЙ, ikpu: null }), false);
    assert.equal(fiscalReady({ ...ПОЛНЫЙ, ikpu: "2202002001010032" }), false, "огрызок кода — не готовность");
  });

  it("«нет» и «неверно» — разные беды и называются раздельно", () => {
    assert.deepEqual(fiscalFlaws({ ...ПОЛНЫЙ, ikpu: null }), [
      { field: "ikpu", flaw: "нет", why: "код не выяснен" },
    ]);
    const кривой = fiscalFlaws({ ...ПОЛНЫЙ, ikpu: "2202002001010032" });
    assert.equal(кривой.length, 1);
    assert.equal(кривой[0].flaw, "неверно");
    assert.match(кривой[0].why, /17 цифр, а тут 16/, "владелец должен понять, что именно чинить");
  });

  it("ставка 0 дырой не считается, а маркировка дырой не бывает вовсе", () => {
    assert.deepEqual(fiscalFlaws({ ...ПОЛНЫЙ, vatPct: 0 }), []);
    assert.deepEqual(fiscalFlaws({ ...ПОЛНЫЙ, marked: false }), []);
  });
});

describe("Категорийный ИКПУ решает справочник донора (R-P6-9)", () => {
  const СПРАВОЧНИК = new Map([
    ["02202002001000000", "Газнапитки (категория)"],
    ["01806001001000000", "Шоколадные батончики (категория)"],
    ["02202003001086002", "Lit Energy Blueberry 0,45"],
    ["02202003001086009", "Странный SKU с нулями 000000"],
  ]);

  it("код, подписанный «(категория)», — категорийный", () => {
    assert.deepEqual(classifyIkpu("02202002001000000", СПРАВОЧНИК), { kind: "category" });
  });

  it("код, подписанный именем товара, — SKU", () => {
    assert.deepEqual(classifyIkpu("02202003001086002", СПРАВОЧНИК), { kind: "sku" });
  });

  it("кода нет в справочнике донора → unknown, а не догадка", () => {
    // 24 категорийных кода из 44 — больше половины переноса. Цена ошибки здесь
    // не «одна карточка», и гадать по суффиксу мы не имеем права.
    const ответ = classifyIkpu("09999999999999999", СПРАВОЧНИК);
    assert.equal(ответ.kind, "unknown");
    assert.match((ответ as { why: string }).why, /справочник/i);
  });

  it("справочник говорит SKU, а суффикс `000000` — расхождение → unknown", () => {
    const ответ = classifyIkpu("02202003001000000", new Map([["02202003001000000", "Товар без пометки"]]));
    assert.equal(ответ.kind, "unknown");
    assert.match((ответ as { why: string }).why, /суффикс/i);
  });
});
```
- [ ] **Step 2:** `pnpm --filter @mydon/shared build && pnpm --filter @mydon/shared test` → RED (модуля нет).
- [ ] **Step 3: Реализация.** Создать `packages/shared/src/fiscal.ts` по «Interfaces (produces)». Тела, которые задают поведение:
```ts
/** Ставки НДС (словарь `vat` донора: 12 стандарт, 0 нулевая, 15 специальная). */
export const VAT_RATES: readonly DictEntry[] = [
  { code: "12", label: "12 % — стандартная" },
  { code: "0", label: "0 % — нулевая (льготная позиция)" },
  { code: "15", label: "15 % — специальная" },
];

/**
 * ОКЕИ (словарь `package` донора, семь значений; 796 «Штука» — умолчание).
 *
 * Это ЕДИНИЦА ИЗМЕРЕНИЯ, а не ключ каталога: семизначные значения
 * `entity.attrs["упаковка"]` — идентификатор упаковки Multikassa/Tasnif и
 * сюда не попадают никогда (R-P6-7).
 */
export const PACKAGE_CODES: readonly DictEntry[] = [
  { code: "796", label: "Штука" },
  { code: "778", label: "Упаковка" },
  { code: "166", label: "Килограмм" },
  { code: "112", label: "Литр" },
  { code: "736", label: "Рулон" },
  { code: "356", label: "Час" },
  { code: "111", label: "Сантиметр кубический" },
];

/** Маркировка (словарь `marking` донора: 0 «Не требуется», 1 «Требуется (КИЗ)»). */
export const MARKING: readonly DictEntry[] = [
  { code: "0", label: "Не требуется" },
  { code: "1", label: "Требуется (КИЗ)" },
];

/** Разделители набора: их вырезают, а не считают частью кода. */
const РАЗДЕЛИТЕЛИ = /[\s\u00A0\u202F-]/g;

export function normalizeFiscalInput(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.replace(РАЗДЕЛИТЕЛИ, "");
  return s.length === 0 ? null : s;
}

const цифры = (v: string, сколько: readonly number[]): boolean =>
  /^\d+$/.test(v) && сколько.includes(v.length);

export function validateFiscalPatch(patch: ProductFiscalPatch): string[] {
  const errors: string[] = [];
  const код = (v: string | null | undefined, длины: readonly number[], текст: string) => {
    if (v === undefined) return;
    const norm = normalizeFiscalInput(v);
    if (norm === null) return;           // пусто законно у всех трёх
    if (!цифры(norm, длины)) errors.push(текст);
  };
  код(patch.ikpu, [IKPU_DIGITS], "ИКПУ должен быть 17 цифр или пусто");
  код(patch.mxik, [IKPU_DIGITS], "МХИК должен быть 17 цифр или пусто");
  код(patch.barcode, BARCODE_DIGITS, "Штрихкод должен быть 8/12/13 цифр или пусто");
  if (patch.vatPct !== undefined && !VAT_RATES.some((r) => Number(r.code) === patch.vatPct)) {
    errors.push(`Ставка НДС — одно из: ${VAT_RATES.map((r) => r.code).join(", ")}`);
  }
  if (patch.packageCode !== undefined && !PACKAGE_CODES.some((p) => p.code === patch.packageCode)) {
    errors.push("Код упаковки — 3 цифры ОКЕИ");
  }
  return errors;
}

/**
 * Категорийность — ЦИТАТА справочника владельца, а не наша догадка о
 * классификаторе, которым мы не владеем. Суффикс `000000` — независимая
 * сверка: расходятся признаки — строка уходит в отчёт, а не в базу.
 */
export function classifyIkpu(code: string, dict: ReadonlyMap<string, string>) {
  const label = dict.get(code);
  if (label === undefined) {
    return { kind: "unknown" as const, why: "кода нет в справочнике донора — категорийность подтвердить нечем" };
  }
  const поСправочнику = /\(категория\)/i.test(label);
  const поСуффиксу = code.endsWith("000000");
  if (поСправочнику !== поСуффиксу) {
    return {
      kind: "unknown" as const,
      why: `справочник донора говорит «${label}», а суффикс — ${поСуффиксу ? "категорийный" : "SKU"}`,
    };
  }
  return поСправочнику ? { kind: "category" as const } : { kind: "sku" as const };
}
```
`fiscalFlaws` повторяет язык `fiscalGaps` (`sources.ts:222`): пустой ИКПУ → `{flaw:"нет", why:"код не выяснен"}`; непустой не той длины → `{flaw:"неверно", why:\`должно быть ${IKPU_DIGITS} цифр, а тут N\`}`; не только цифры → `«в коде есть не только цифры»`. `packageCode`/`vatPct` вне словаря → `"неверно"`. `mxik`/`barcode` дают дыру только когда они НЕПУСТЫ и неверны (пустых у нас 0 из 62 с обеих сторон — «нет» тут значило бы «все карточки дырявые»). `marked` дырой не бывает никогда.
- [ ] **Step 4: Барель.** В `packages/shared/src/index.ts` после строки 50 (`export * from "./sources";`):
```ts
// Фискальный блок карточки СНЕКА (П6). Рядом с ./sources намеренно: там
// живёт `fiscalGaps` по `entity.attrs` (контур реестра/кофе), здесь —
// типизированный блок прайса. Общего у них ровно два имени: `IKPU_DIGITS` и
// союз `FiscalFlaw`, и оба берутся ОТТУДА, а не объявляются заново.
export * from "./fiscal";
```
- [ ] **Step 5:** `pnpm --filter @mydon/shared build && pnpm --filter @mydon/shared test` → GREEN; `pnpm -s typecheck` (проверяет заодно, что барель не сломался: TS2308 вылез бы именно здесь).
- [ ] **Step 6:** `git commit -m "feat(shared): фискальный блок карточки снека — контракт, словари ОКЕИ/НДС/КИЗ и валидаторы одним модулем (П6, R-P6-6/R-P6-9)" -- packages/shared/src/fiscal.ts packages/shared/src/fiscal.test.ts packages/shared/src/index.ts`

---

### Task 3: Core — единственный писатель фискального блока, блок `fiscal` в каталоге, событие и правило

**Files:** Modify `apps/core/src/vending/vending.service.ts` (`VendingProductRow` стр. 510–521; `products()` стр. 2092–2108), `apps/core/src/vending/vending.controller.ts` (импорты class-validator стр. 2–20; DTO рядом с `SetProductRulesDto` стр. 243–260; конструктор контроллера стр. 470–478; роут рядом с `setProductRules` стр. 554), `apps/core/src/vending/vending.controller.test.ts` (после набора «StockCountsDto: потолок окна», стр. 47+), `apps/core/src/vending/vending.module.ts` (`providers` стр. 38–49), `apps/core/src/rules/rules.ts` (блок «Снек-автоматы: полевой контур (П4)» стр. 405–430), `apps/core/src/rules/rules.test.ts`, `tools/smoke-core.mjs` (массив `ЗАПИСЬ` стр. 565+, чтение `/vending/products` стр. 127, счётчик сценариев в последней строке стр. 1917), `docs/DATA_SOURCES.md` (раздел «Товары: почему 42% выручки идут мимо кассы», абзац «Правило живёт в `packages/shared`», стр. 248–250). Create `apps/core/src/vending/product-fiscal.service.ts`, `apps/core/src/vending/product-fiscal.service.test.ts`.

**Interfaces (consumes):** `ProductFiscal`, `ProductFiscalPatch`, `validateFiscalPatch`, `fiscalReady`, `normalizeFiscalInput`, `VAT_RATES`, `PACKAGE_CODES` (`@mydon/shared`, T2); `vendingProduct`, `event`, `auditLog` (`@mydon/db`, T1); `DB`/`Db` (`apps/core/src/db/db.module.ts`); образец писателя `setProductRules` (`vending.service.ts:2120`, транзакция в конце метода) и его DTO (`vending.controller.ts:243`, роут `:554`); `RULE_EVENT_TYPES` (`apps/core/src/rules/rules.ts:601`); `str`/`num` — помощники форматирования правил (там же).

**Interfaces (produces):**
```ts
/** apps/core/src/vending/product-fiscal.service.ts */
export type FiscalUpdateResult =
  | { ok: true; product: string; before: ProductFiscal; after: ProductFiscal;
      readyBefore: boolean; readyAfter: boolean }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid"; errors: string[] };

@Injectable()
export class ProductFiscalService {
  constructor(@Inject(DB) private readonly db: Db) {}
  async update(productId: string, patch: ProductFiscalPatch, actor: string, now: Date): Promise<FiscalUpdateResult>;
}

/** apps/core/src/vending/vending.service.ts — VendingProductRow прирастает ОДНИМ полем */
export interface VendingProductRow {
  /* …существующие девять полей… */
  /**
   * Фискальный блок (П6). Тип импортируется из `@mydon/shared` обеими
   * сторонами (Core и панель), поэтому шесть полей описаны РОВНО ОДИН раз, а
   * зеркала выросли на строку каждое. Полный переезд `VendingProductRow` в
   * shared — вне охвата среза (спека §10).
   */
  fiscal: ProductFiscal;
}

/** apps/core/src/vending/vending.controller.ts */
export class SetProductFiscalDto { productId!: string; ikpu?: string | null; mxik?: string | null;
  barcode?: string | null; vatPct?: number; packageCode?: string; marked?: boolean; actor?: string }

@Post("product-fiscal") setProductFiscal(@Body() dto: SetProductFiscalDto): Promise<FiscalUpdateResult>
```

Что обязана делать реализация:
- **Пустой патч → `BadRequestException("нечего менять: укажи хотя бы одно фискальное поле")`.** Образец `setProductRules` (`vending.service.ts:2123`): пустой патч — почти наверняка потерянное поле формы, а не намерение ничего не менять.
- **`before`/`after` в аудите — ВЕСЬ блок из шести полей, а не тронутые ключи.** Запись «поменяли ИКПУ» без соседних полей не отвечает на вопрос «а чек по ней собирался?» — ровно разрыв, названный в описи §4.2.
- **Запись, событие и аудит — в ОДНОЙ транзакции**, и аудит пишется `tx.insert(auditLog)`, а НЕ `AuditService.record` (`apps/core/src/audit/audit.service.ts:25`): у сервиса свой хендл БД, и его запись пережила бы откат — журнал показывал бы правку, которой в карточке нет. Тот же выбор уже сделан в `refill.service.ts:134` и `vending.service.ts:2190`.
- **Адресация по `productId`, а не по имени** (в отличие от `product-price` и `product-rules`): резолв по алиасу добавил бы путь, где спорное имя молча уводит 17-значный код на чужую карточку (`productIndex.explain → conflict`, `packages/shared/src/stock-history.ts:315`).
- **`now` — параметром.** Проверка `updatedAt` не должна зависеть от стенных часов; контроллер передаёт `new Date()`, и это единственное место, где часы читаются.

- [ ] **Step 1: Тесты сервиса RED.** Создать `apps/core/src/vending/product-fiscal.service.test.ts`:
```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { auditLog, event, vendingProduct } from "@mydon/db";
import { ProductFiscalService } from "./product-fiscal.service";

const КАРТОЧКА = {
  id: "p-lit",
  name: "Lit Energy Blueberry CAN 0,45",
  ikpu: null as string | null,
  mxik: null as string | null,
  vatPct: 12,
  barcode: null as string | null,
  packageCode: "796",
  marked: false,
};

/**
 * Стенд БД: `select` отдаёт карточку, транзакция ЗАПОМИНАЕТ порядок вставок.
 *
 * Проверяемое утверждение — «событие и аудит уехали ВНУТРИ той же
 * транзакции», и доказывает его только то, что все три вызова пришли на `tx`,
 * а не на внешний `db`. Заглушка нарочно не даёт внешнему `db.insert`
 * молча сработать: он бросает.
 */
function стенд(строка: typeof КАРТОЧКА | null = КАРТОЧКА) {
  const записи: { таблица: unknown; values: Record<string, unknown> }[] = [];
  const tx = {
    update: (t: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => { записи.push({ таблица: t, values: patch }); },
      }),
    }),
    insert: (t: unknown) => ({
      values: async (v: Record<string, unknown>) => { записи.push({ таблица: t, values: v }); },
    }),
  };
  const db = {
    select: () => ({ from: () => ({ where: () => ({ limit: async () => (строка ? [строка] : []) }) }) }),
    transaction: async (fn: (t: typeof tx) => Promise<void>) => { await fn(tx); },
    insert: () => { throw new Error("аудит обязан писаться внутри транзакции, а не своим хендлом"); },
  } as never;
  return { db, записи };
}

const МОМЕНТ = new Date("2026-08-26T09:00:00.000Z");

describe("Фискальный блок карточки: единственный писатель (П6, R-P6-5)", () => {
  it("пустой патч — отказ 400, а не молчаливое «ок»", async () => {
    const { db, записи } = стенд();
    await assert.rejects(
      () => new ProductFiscalService(db).update("p-lit", {}, "panel", МОМЕНТ),
      (e: unknown) => e instanceof BadRequestException,
    );
    assert.equal(записи.length, 0, "пустой патч не имеет права дойти до базы");
  });

  it("неверное значение — reason «invalid» с русским текстом, а не 500", async () => {
    const { db, записи } = стенд();
    const итог = await new ProductFiscalService(db).update("p-lit", { ikpu: "2202002001010032" }, "panel", МОМЕНТ);
    assert.deepEqual(итог, { ok: false, reason: "invalid", errors: ["ИКПУ должен быть 17 цифр или пусто"] });
    assert.equal(записи.length, 0);
  });

  it("неизвестный productId — not_found, а не 500", async () => {
    const { db } = стенд(null);
    assert.deepEqual(await new ProductFiscalService(db).update("нет", { vatPct: 0 }, "panel", МОМЕНТ), {
      ok: false,
      reason: "not_found",
    });
  });

  it("before/after в аудите — ВЕСЬ блок из шести полей, а не тронутые ключи", async () => {
    const { db, записи } = стенд();
    await new ProductFiscalService(db).update("p-lit", { ikpu: "02202003001086002" }, "panel", МОМЕНТ);
    const аудит = записи.find((з) => з.таблица === auditLog)!;
    const ПОЛЯ = ["ikpu", "mxik", "vatPct", "barcode", "packageCode", "marked"];
    assert.deepEqual(Object.keys(аудит.values.before as object).sort(), [...ПОЛЯ].sort());
    assert.deepEqual(Object.keys(аудит.values.after as object).sort(), [...ПОЛЯ].sort());
    // Иначе журнал отвечает «поменяли ИКПУ» и не отвечает «а чек собирался?».
    assert.equal((аудит.values.after as { packageCode: string }).packageCode, "796");
  });

  it("action и target названы так, как их будут искать в /audit", async () => {
    const { db, записи } = стенд();
    await new ProductFiscalService(db).update("p-lit", { marked: true }, "person:u1", МОМЕНТ);
    const аудит = записи.find((з) => з.таблица === auditLog)!;
    assert.equal(аудит.values.action, "vending.product.set_fiscal");
    assert.equal(аудит.values.target, "p-lit");
    assert.equal(аудит.values.actorRef, "person:u1");
    assert.equal(аудит.values.actorKind, "human");
  });

  it("update, событие и аудит уходят в ОДНОЙ транзакции и в этом порядке", async () => {
    const { db, записи } = стенд();
    await new ProductFiscalService(db).update("p-lit", { vatPct: 0 }, "panel", МОМЕНТ);
    assert.deepEqual(записи.map((з) => з.таблица), [vendingProduct, event, auditLog]);
  });

  it("readyBefore/readyAfter считаются по блоку ДО и ПОСЛЕ правки", async () => {
    const { db, записи } = стенд();
    const итог = await new ProductFiscalService(db).update("p-lit", { ikpu: "02202003001086002" }, "panel", МОМЕНТ);
    assert.equal(итог.ok, true);
    assert.equal((итог as { readyBefore: boolean }).readyBefore, false, "до правки ИКПУ не было — чек не собирался");
    assert.equal((итог as { readyAfter: boolean }).readyAfter, true);
    // Ровно эти два поля читает `when` правила: без них брифинг залило бы
    // рутиной 52 карточек × 6 полей.
    const событие = записи.find((з) => з.таблица === event)!;
    assert.equal((событие.values.payload as { readyAfter: boolean }).readyAfter, true);
    assert.equal(событие.values.type, "vending.product_fiscal_changed");
  });

  it("пустая строка в ИКПУ очищает поле, отсутствие ключа — не трогает", async () => {
    const { db, записи } = стенд({ ...КАРТОЧКА, ikpu: "02202003001086002", barcode: "4870204391234" });
    await new ProductFiscalService(db).update("p-lit", { ikpu: null }, "panel", МОМЕНТ);
    const upd = записи.find((з) => з.таблица === vendingProduct)!;
    assert.equal(upd.values.ikpu, null, "сброс — это значение, а не «не трогать»");
    assert.ok(!("barcode" in upd.values), "штрих-код в патче не назван и в UPDATE попасть не должен");
  });

  it("`now` берётся из параметра: updatedAt равен переданному моменту", async () => {
    const { db, записи } = стенд();
    await new ProductFiscalService(db).update("p-lit", { marked: true }, "panel", МОМЕНТ);
    assert.equal((записи[0].values as { updatedAt: Date }).updatedAt.toISOString(), МОМЕНТ.toISOString());
  });
});
```
- [ ] **Step 2: Тесты DTO RED.** Дописать в `apps/core/src/vending/vending.controller.test.ts`:
```ts
describe("SetProductFiscalDto: вход держит форму, а не только сервис (П6)", () => {
  it("16 цифр отвергнуты СООБЩЕНИЕМ ДОНОРА — владелец уже читает его в mydon-stock", async () => {
    const dto = plainToInstance(SetProductFiscalDto, { productId: "0f8e1a4c-1111-4222-8333-444455556666", ikpu: "2202002001010032" });
    const ошибки = await validate(dto);
    assert.equal(ошибки.length, 1);
    assert.deepEqual(Object.values(ошибки[0].constraints ?? {}), ["ИКПУ должен быть 17 цифр или пусто"]);
  });

  it("пустая строка гасится в null ДО сервиса (сброс поля)", async () => {
    const dto = plainToInstance(SetProductFiscalDto, { productId: "0f8e1a4c-1111-4222-8333-444455556666", ikpu: "  " });
    assert.deepEqual(await validate(dto), []);
    assert.equal(dto.ikpu, null, "«» — это сброс, и он обязан доехать значением, а не строкой");
  });

  it("vatPct вне набора 12/0/15 отвергнут, а 0 — принят", async () => {
    const годный = plainToInstance(SetProductFiscalDto, { productId: "0f8e1a4c-1111-4222-8333-444455556666", vatPct: 0 });
    assert.deepEqual(await validate(годный), []);
    const кривой = plainToInstance(SetProductFiscalDto, { productId: "0f8e1a4c-1111-4222-8333-444455556666", vatPct: 7 });
    assert.equal((await validate(кривой)).length, 1);
  });

  it("packageCode вне словаря ОКЕИ отвергнут — 1218841 это идентификатор каталога, а не единица", async () => {
    const dto = plainToInstance(SetProductFiscalDto, { productId: "0f8e1a4c-1111-4222-8333-444455556666", packageCode: "1218841" });
    assert.equal((await validate(dto)).length, 1);
  });

  it("productId — uuid: адресуемся по карточке, а не по спорному имени", async () => {
    const dto = plainToInstance(SetProductFiscalDto, { productId: "Snickers 50gr", marked: true });
    assert.equal((await validate(dto)).length, 1);
  });
});
```
- [ ] **Step 3: Тесты правила RED.** Дописать в `apps/core/src/rules/rules.test.ts`:
```ts
describe("Правило фискальной готовности (П6)", () => {
  const ctx = (readyBefore: boolean, readyAfter: boolean) => ({
    type: "vending.product_fiscal_changed",
    payload: { product: "Lit Energy Blueberry CAN 0,45", readyBefore, readyAfter },
  });

  it("молчит, пока готовность не изменилась", () => {
    // 52 карточки × 6 полей рутинной правки залили бы брифинг; ценность несёт
    // ровно СМЕНА состояния «чек соберётся».
    assert.deepEqual(applyRules(ctx(true, true) as never), []);
    assert.deepEqual(applyRules(ctx(false, false) as never), []);
  });

  it("переход «не собирался → соберётся» даёт заметку, и обратный тоже", () => {
    const вверх = applyRules(ctx(false, true) as never);
    assert.equal(вверх.length, 1);
    assert.equal(вверх[0].urgency, "briefing");
    assert.match(вверх[0].text, /Чек соберётся/);
    const вниз = applyRules(ctx(true, false) as never);
    assert.equal(вниз.length, 1);
    assert.match(вниз[0].text, /Чек больше не соберётся/);
  });

  it("оба новых типа П6 попали в RULE_EVENT_TYPES", () => {
    // Урок N5 (rules.ts:527): `/rules/pending` фильтрует журнал по этому
    // списку, и без записи тип не попадёт туда НИКОГДА.
    assert.ok(RULE_EVENT_TYPES.includes("vending.product_fiscal_changed"));
  });
});
```
> Проверку `vending.record_cancelled` в этом же наборе дописывает T7 — она красная до него и в T3 не заводится.
- [ ] **Step 4:** `pnpm --filter @mydon/shared build && pnpm --filter core build && pnpm --filter core test` → RED.
- [ ] **Step 5: Сервис.** Создать `apps/core/src/vending/product-fiscal.service.ts`. Ядро метода:
```ts
  async update(productId: string, patch: ProductFiscalPatch, actor: string, now: Date): Promise<FiscalUpdateResult> {
    const тронуто = (Object.keys(patch) as (keyof ProductFiscalPatch)[]).filter((k) => patch[k] !== undefined);
    if (тронуто.length === 0) throw new BadRequestException("нечего менять: укажи хотя бы одно фискальное поле");

    // Нормализация ДО проверки: владелец копирует код группами («022 0200-…»),
    // и разделители набора не повод отказать.
    const norm: ProductFiscalPatch = { ...patch };
    for (const k of ["ikpu", "mxik", "barcode"] as const) {
      if (norm[k] !== undefined) norm[k] = normalizeFiscalInput(norm[k]);
    }
    const errors = validateFiscalPatch(norm);
    if (errors.length > 0) return { ok: false, reason: "invalid", errors };

    const [row] = await this.db
      .select({ id: vendingProduct.id, name: vendingProduct.name, ikpu: vendingProduct.ikpu, mxik: vendingProduct.mxik,
                vatPct: vendingProduct.vatPct, barcode: vendingProduct.barcode,
                packageCode: vendingProduct.packageCode, marked: vendingProduct.marked })
      .from(vendingProduct).where(eq(vendingProduct.id, productId)).limit(1);
    if (!row) return { ok: false, reason: "not_found" };

    const before: ProductFiscal = { ikpu: row.ikpu, mxik: row.mxik, vatPct: row.vatPct,
      barcode: row.barcode, packageCode: row.packageCode, marked: row.marked };
    // ВЕСЬ блок, а не тронутые ключи: без соседних полей журнал не отвечает на
    // вопрос «а чек по ней собирался?» (опись §4.2).
    const after: ProductFiscal = { ...before, ...norm } as ProductFiscal;
    const readyBefore = fiscalReady(before);
    const readyAfter = fiscalReady(after);

    await this.db.transaction(async (tx) => {
      await tx.update(vendingProduct).set({ ...norm, updatedAt: now }).where(eq(vendingProduct.id, productId));
      await tx.insert(event).values({
        source: "owner",
        type: "vending.product_fiscal_changed",
        payload: { product: row.name, before, after, readyBefore, readyAfter, actor },
      });
      // tx.insert, а НЕ AuditService.record: у того свой хендл БД, и его
      // запись пережила бы откат — журнал показывал бы правку, которой в
      // карточке нет (тот же выбор в refill.service.ts:134).
      await tx.insert(auditLog).values({
        actorKind: "human", actorRef: actor,
        action: "vending.product.set_fiscal", target: productId, before, after,
      });
    });
    return { ok: true, product: row.name, before, after, readyBefore, readyAfter };
  }
```
- [ ] **Step 6: Чтение каталога.** В `vending.service.ts`: `import type { ProductFiscal } from "@mydon/shared";`, поле `fiscal` в `VendingProductRow` (докблок из «Interfaces»), и в `products()` — `select` уже берёт `*` (`this.db.select().from(vendingProduct)`), поэтому добирать колонки не надо; в маппинг добавляется:
```ts
        fiscal: {
          ikpu: p.ikpu,
          mxik: p.mxik,
          vatPct: p.vatPct,
          barcode: p.barcode,
          packageCode: p.packageCode,
          marked: p.marked,
        },
```
- [ ] **Step 7: DTO и роут.** В `vending.controller.ts` — рядом с `SetProductRulesDto` (`:243`):
```ts
/**
 * Фискальный блок карточки снека (П6). Адресуемся по `productId`, а не по
 * имени: у `product-price`/`product-rules` резолв по алиасу уместен (владелец
 * диктует боту), здесь он открыл бы путь, где спорное имя молча уводит
 * 17-значный код на чужую карточку.
 */
export class SetProductFiscalDto {
  @IsUUID()
  productId!: string;

  /** "" → null (сброс). Гашение пустой строки — тот же приём, что у StockCountsDto. */
  @IsOptional() @Transform(({ value }) => (String(value ?? "").trim() === "" ? null : value))
  @IsString() @Matches(/^\d{17}$/, { message: "ИКПУ должен быть 17 цифр или пусто" })
  ikpu?: string | null;

  @IsOptional() @Transform(({ value }) => (String(value ?? "").trim() === "" ? null : value))
  @IsString() @Matches(/^\d{17}$/, { message: "МХИК должен быть 17 цифр или пусто" })
  mxik?: string | null;

  @IsOptional() @Transform(({ value }) => (String(value ?? "").trim() === "" ? null : value))
  @IsString() @Matches(/^(\d{8}|\d{12}|\d{13})$/, { message: "Штрихкод должен быть 8/12/13 цифр или пусто" })
  barcode?: string | null;

  @IsOptional() @IsInt() @IsIn(VAT_RATES.map((r) => Number(r.code)))
  vatPct?: number;

  @IsOptional() @IsString() @IsIn(PACKAGE_CODES.map((p) => p.code))
  packageCode?: string;

  @IsOptional() @IsIn([true, false])
  marked?: boolean;

  @IsOptional() @IsString() @MaxLength(128)
  actor?: string;
}
```
и роут после `setProductRules` (`:554`):
```ts
  /** Фискальный блок товара (П6): ИКПУ, МХИК, НДС, штрихкод, ОКЕИ, маркировка. */
  @Post("product-fiscal")
  setProductFiscal(@Body() dto: SetProductFiscalDto) {
    const { productId, actor, ...patch } = dto;
    // `new Date()` — здесь и только здесь: сервису часы приходят параметром,
    // иначе окно и `updatedAt` было бы нечем проверить тестом.
    return this.productFiscal.update(productId, patch, actor ?? "panel", new Date());
  }
```
Конструктор контроллера (`:470`) получает `private readonly productFiscal: ProductFiscalService`; `vending.module.ts` — `ProductFiscalService` в `providers` (в `exports` не нужен: вне модуля потребителей нет).
- [ ] **Step 8: Правило.** В `apps/core/src/rules/rules.ts`, в блок «Снек-автоматы: полевой контур (П4)» (после правила `vending.refill_detected`, `:421-429`):
```ts
  {
    // Только ПЕРЕСЕЧЕНИЕ границы «чек соберётся»: 52 карточки × 6 полей
    // рутинной правки залили бы брифинг, а ценность несёт ровно смена
    // состояния. В `immediate` не выносим: правка карточки не стоит ночного
    // звонка.
    id: "vending.product_fiscal_changed",
    eventType: "vending.product_fiscal_changed",
    urgency: "briefing",
    when: (c) => c.payload.readyBefore !== c.payload.readyAfter,
    format: (c) =>
      c.payload.readyAfter === true
        ? `🧾 Чек соберётся: ${str(c.payload.product)} — фискальные поля заполнены`
        : `🧾 Чек больше не соберётся: ${str(c.payload.product)} — проверь фискальные поля`,
  },
```
- [ ] **Step 9: Смоук.** В `tools/smoke-core.mjs`: в шаг чтения `/vending/products` (`:127`) добавить `проверить`, что у строки есть блок `fiscal` с шестью ключами; в массив `ЗАПИСЬ` — два шага:
```js
  {
    // Фискальная правка (П6). Юнит-заглушка БД CHECK'и не исполняет, а весь
    // смысл миграции — именно они: 16-значный код обязан быть отбит ДО базы
    // (DTO), а корректный — записан и прочитан обратно.
    имя: "фискальный блок: правка карточки прайса",
    path: "/vending/product-fiscal",
    body: () => ({ productId: P6_КАРТОЧКА, ikpu: "02202003001086002", vatPct: 0, packageCode: "778", marked: true }),
    проверить: (о) => {
      if (о?.ok !== true) throw new Error(`правка отклонена: ${JSON.stringify(о)}`);
      if (о.readyBefore !== false || о.readyAfter !== true) {
        throw new Error(`готовность не пересекла границу: ${о.readyBefore}→${о.readyAfter}`);
      }
    },
    после: async () => {
      const прайс = await читать("/vending/products");
      const строка = прайс.find((p) => p.id === P6_КАРТОЧКА);
      if (строка?.fiscal?.ikpu !== "02202003001086002") throw new Error("ИКПУ не доехал до каталога");
      if (строка.fiscal.vatPct !== 0) throw new Error("ставка 0 — законное значение, а её потеряли");
      if (строка.fiscal.packageCode !== "778" || строка.fiscal.marked !== true) throw new Error("ОКЕИ/маркировка не сохранились");
    },
  },
  {
    имя: "фискальный блок: 16 цифр отбиты русским текстом донора",
    path: "/vending/product-fiscal",
    body: () => ({ productId: P6_КАРТОЧКА, ikpu: "2202002001010032" }),
    ожидатьСтатус: 400,
    проверить: (о) => {
      const текст = JSON.stringify(о);
      if (!текст.includes("17 цифр")) throw new Error(`400 без причины для владельца: ${текст}`);
    },
  },
```
`P6_КАРТОЧКА` берётся ПЕРЕД массивом — первым `id` из `/vending/products` засеянного прайса (`seed-vending.js` в цепочке CI). Если шаг `ЗАПИСЬ` сегодня не умеет ждать 400, добавить поддержку `ожидатьСтатус` в `проверитьЗапись` (`:1734`) одной веткой: сегодня он трактует не-2xx как провал, и «ожидаемый отказ» выразить нечем.
- [ ] **Step 10: Счётчик сценариев.** Поднять число в последней строке `tools/smoke-core.mjs` (`console.log(\`…, 13 сценариев.\`)`), если добавлялись `проверить*`-функции; в этой задаче добавлены только шаги массива `ЗАПИСЬ`, и он считается сам — проверить глазами, что строка отчёта не врёт.
- [ ] **Step 11: `docs/DATA_SOURCES.md`.** После абзаца «Правило живёт в `packages/shared` (`fiscalGaps`)…» (`:248-250`) — новый абзац:
```
С П6 у фискальных полей ДВА дома, и это осознанно. `entity(type='product').attrs`
(«ИКПУ», «упаковка», «НДС», «штрихкод») обслуживает карточки РЕЕСТРА — туда
смотрят «Фискальная готовность», кольцо полноты карточки и список товаров; там
же живёт кофейный контур с общим `08476001003000000` и семизначным
идентификатором упаковки Multikassa. Шесть типизированных колонок
`vending_product` (`ikpu`, `mxik`, `vat_pct`, `barcode`, `package_code`,
`marked`) обслуживают карточку СНЕКА — прайс, к которому привязаны склад,
заливки и продажи. `package_code` там — код ОКЕИ («796» штука), а НЕ
семизначный идентификатор каталога: это разные величины, и сложить их в одну
колонку значит получить поле, где два числа значат разное, а выглядят
одинаково. Единственный писатель типизированного блока — `ProductFiscalService`
(`POST /vending/product-fiscal`), след — `audit_log` с `action =
vending.product.set_fiscal` и полным `before`/`after`.
```
- [ ] **Step 12:** `pnpm --filter @mydon/shared build && pnpm --filter core build && pnpm --filter core test` → GREEN; `pnpm -s typecheck`. На scratch-БД: `createdb` → `migrate.js` → `seed.js` → `seed-vending.js` → `SMOKE_SCRATCH=1 node tools/smoke-core.mjs` → ожидание: оба новых шага записи зелёные, `dropdb`.
- [ ] **Step 13:** `git commit -m "feat(core): фискальный блок карточки снека — единственный писатель, POST /vending/product-fiscal, блок fiscal в каталоге и правило в брифинг (П6, R-P6-5)" -- apps/core/src/vending/product-fiscal.service.ts apps/core/src/vending/product-fiscal.service.test.ts apps/core/src/vending/vending.service.ts apps/core/src/vending/vending.controller.ts apps/core/src/vending/vending.controller.test.ts apps/core/src/vending/vending.module.ts apps/core/src/rules/rules.ts apps/core/src/rules/rules.test.ts tools/smoke-core.mjs docs/DATA_SOURCES.md`

---

### Task 4: CC — секция «Фискальные данные» в карточке снека и чип готовности

**Files:** Modify `apps/cc/src/lib/core.ts` (`VendingProductRow` стр. 206–223; клиент `setVendingProductRules` стр. 2300–2307 — новый рядом), `apps/cc/src/lib/core-types.test.ts` (набор компиляторных сверок, стр. 24+), `apps/cc/src/app/vending/actions.ts` (после `saveVendingProductRules`, стр. 38–70), `apps/cc/src/components/product-rules-panel.tsx` (строка списка стр. 96–118, блок правки стр. 122–128), `apps/cc/src/components/product-rules-panel.test.tsx` (фикстуры `rows` стр. 11–14 — **обязаны получить `fiscal`, иначе файл не соберётся**). Create `apps/cc/src/components/product-fiscal-form.tsx`, `apps/cc/src/components/product-fiscal-form.test.tsx`.

**Interfaces (consumes):** `ProductFiscal`, `ProductFiscalPatch`, `validateFiscalPatch`, `fiscalReady`, `fiscalFlaws`, `VAT_RATES`, `PACKAGE_CODES`, `MARKING` (`@mydon/shared`, T2); `POST /vending/product-fiscal` и `FiscalUpdateResult` (T3); конвенция мутирующих форм `CLAUDE.md:57-67`, эталон `apps/cc/src/components/customs-rates.tsx:17-33` и его тест `customs-rates.test.tsx:45-59`; `count` (`apps/cc/src/lib/format.ts:71`); `ActionResult`/`failure` (`apps/cc/src/app/vending/actions.ts:6`, `:12`).

**Interfaces (produces):**
```ts
/** apps/cc/src/lib/core.ts */
import type { ProductFiscal } from "@mydon/shared";
// РЕЭКСПОРТА НЕТ НАМЕРЕННО: имя `ProductFiscal` в apps/cc уже занято
// React-компонентом карточки реестра (`components/product-card-sections.tsx:38`),
// и одно имя на две разные вещи не собралось бы в первом же файле, которому
// нужны обе. Тип берут прямым импортом из `@mydon/shared`.

export interface VendingProductRow {
  /* …существующие девять полей… */
  /** Фискальный блок карточки снека (П6). Форма — `ProductFiscalForm`. */
  fiscal: ProductFiscal;
}

/** Итог правки фискального блока (П6). `errors` приходит только при reason='invalid'. */
export type VendingFiscalResult =
  | { ok: true; product: string; readyBefore: boolean; readyAfter: boolean }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "invalid"; errors: string[] };

/** Фискальный блок товара: пишет только панель, только по id карточки. */
setVendingProductFiscal: (input: { productId: string; actor?: string } & ProductFiscalPatch) =>
  send<VendingFiscalResult>("/vending/product-fiscal", "POST", input),

/** apps/cc/src/app/vending/actions.ts */
export async function saveVendingProductFiscal(domain: string, form: FormData): Promise<ActionResult>

/** apps/cc/src/components/product-fiscal-form.tsx */
export function ProductFiscalForm({
  domain, row, onDone,
}: { domain: string; row: VendingProductRow; onDone: (saved?: string | null) => void }): JSX.Element
```

Что обязана делать реализация:
- **Дом формы — лист «Правила закупа»** (`product-rules-panel.tsx`): владелец уже открывает там строку кнопкой «Править», и вторая карточка того же товара на соседнем листе была бы вторым ответом на один вопрос. Витрины реестра (`product-card-sections.tsx`, `product-card-360.tsx`, `products-book.tsx`) НЕ трогаются — они обслуживают кофейный контур (R-P6-5).
- **Ровно по конвенции `CLAUDE.md:57-67`:** `onSubmit` + `event.preventDefault()` + `new FormData(event.currentTarget)` → server action в `startTransition`; при `res.ok` — сброс ошибки, `onDone(...)`, `router.refresh()`; при отказе — `setError(res.message)` и **поля сохраняют ввод**. Никакого `<form action={fn}>`: React 19 сбрасывает неуправляемые поля после экшена, и одна ошибка Core стоила бы владельцу всего 17-значного набора.
- **Клиентская проверка — тем же `validateFiscalPatch`**, что и в Core: текст ошибки в обоих местах одинаковый, потому что функция одна, а не потому, что кто-то переписал строку.
- **Пустое поле nullable-типа → `null` (сброс)**; пустой `<select>` невозможен по построению. При `reason === "invalid"` сообщение — ПЕРВАЯ строка `errors`, чтобы владелец видел ПРИЧИНУ, а не «Не получилось».
- **Открытая правка показывает `RuleForm` и `ProductFiscalForm` друг под другом одним блоком** «карточка товара», и обе — под тем же `key={editingRow.id}` (иначе переключение «Править» на соседнюю строку не переприменит `defaultValue` — находка 1 ревью П5a, `product-rules-panel.tsx:122-127`).

- [ ] **Step 1: Тесты RED.** Создать `apps/cc/src/components/product-fiscal-form.test.tsx`:
```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VendingProductRow } from "../lib/core";
import { ProductFiscalForm } from "./product-fiscal-form";

const mocks = vi.hoisted(() => ({ saveVendingProductFiscal: vi.fn(), refresh: vi.fn(), onDone: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../app/vending/actions", () => ({
  saveVendingProductFiscal: mocks.saveVendingProductFiscal,
  saveVendingProductRules: vi.fn(),
  submitVendingPurchase: vi.fn(),
}));

const row: VendingProductRow = {
  id: "p-lit", name: "Lit Energy Blueberry CAN 0,45", category: "drink",
  purchasePrice: 9000, salePrice: 15000, packSize: 12, isActive: true,
  excludedFromPurchase: false, fixedPurchaseQty: null,
  fiscal: { ikpu: null, mxik: null, vatPct: 12, barcode: null, packageCode: "796", marked: false },
};

describe("Форма «Фискальные данные»", () => {
  beforeEach(() => vi.resetAllMocks());

  it("отказ Core — введённые 17 цифр остались в поле (CLAUDE.md:57-67)", async () => {
    // Ровно та причина, по которой форма не переехала на <form action={fn}>:
    // React 19 сбрасывает неуправляемые поля после экшена, и одна ошибка Core
    // стоила бы владельцу всего набора.
    mocks.saveVendingProductFiscal.mockResolvedValue({ ok: false, message: "ИКПУ должен быть 17 цифр или пусто" });
    const user = userEvent.setup();
    render(<ProductFiscalForm domain="vendhub" row={row} onDone={mocks.onDone} />);
    const ikpu = screen.getByLabelText("ИКПУ");
    await user.type(ikpu, "02202003001086002");
    await user.click(screen.getByRole("button", { name: "Сохранить фискальные данные" }));
    expect(await screen.findByText("ИКПУ должен быть 17 цифр или пусто")).toBeVisible();
    expect(ikpu).toHaveValue("02202003001086002");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("сообщение об ошибке приходит русским текстом Core, а не «Не получилось»", async () => {
    mocks.saveVendingProductFiscal.mockResolvedValue({ ok: false, message: "Код упаковки — 3 цифры ОКЕИ" });
    const user = userEvent.setup();
    render(<ProductFiscalForm domain="vendhub" row={row} onDone={mocks.onDone} />);
    await user.click(screen.getByRole("button", { name: "Сохранить фискальные данные" }));
    expect(await screen.findByText("Код упаковки — 3 цифры ОКЕИ")).toBeVisible();
    expect(screen.queryByText("Не получилось")).toBeNull();
  });

  it("удачное сохранение зовёт router.refresh() и закрывает форму", async () => {
    mocks.saveVendingProductFiscal.mockResolvedValue({ ok: true, message: "Фискальные данные «Lit Energy Blueberry CAN 0,45» сохранены" });
    const user = userEvent.setup();
    render(<ProductFiscalForm domain="vendhub" row={row} onDone={mocks.onDone} />);
    await user.click(screen.getByRole("button", { name: "Сохранить фискальные данные" }));
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
    expect(mocks.onDone).toHaveBeenCalledWith("Фискальные данные «Lit Energy Blueberry CAN 0,45» сохранены");
  });

  it("ставка НДС, упаковка и маркировка — <select> со словарём, а не свободный ввод", async () => {
    render(<ProductFiscalForm domain="vendhub" row={row} onDone={mocks.onDone} />);
    // 17-значный код без гейта уже опасен; давать свободно вписать «7 %» или
    // «1218841» значило бы завести «заполнено, но неверно» второй дверью.
    expect(screen.getByLabelText("Ставка НДС").tagName).toBe("SELECT");
    expect(screen.getByLabelText("Код упаковки (ОКЕИ)").tagName).toBe("SELECT");
    expect(screen.getByLabelText("Маркировка (КИЗ)").tagName).toBe("SELECT");
    // 1218841 — идентификатор каталога Multikassa; его тут быть не может.
    expect(screen.queryByRole("option", { name: /1218841/ })).toBeNull();
    expect(screen.getByRole("option", { name: /Штука/ })).toBeInTheDocument();
  });

  it("пустое поле ИКПУ уходит как сброс, а не как строка «»", async () => {
    mocks.saveVendingProductFiscal.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    const заполненный = { ...row, fiscal: { ...row.fiscal, ikpu: "02202003001086002" } };
    render(<ProductFiscalForm domain="vendhub" row={заполненный} onDone={mocks.onDone} />);
    await user.clear(screen.getByLabelText("ИКПУ"));
    await user.click(screen.getByRole("button", { name: "Сохранить фискальные данные" }));
    const form = mocks.saveVendingProductFiscal.mock.calls[0]?.[1] as FormData;
    expect(form.get("ikpu")).toBe("");
  });

  it("подпись ОКЕИ объясняет, что это НЕ идентификатор каталога (R-P6-7)", () => {
    render(<ProductFiscalForm domain="vendhub" row={row} onDone={mocks.onDone} />);
    expect(screen.getByText(/единица измерения, не идентификатор каталога/i)).toBeVisible();
  });
});
```
Дописать в `apps/cc/src/components/product-rules-panel.test.tsx`:
```tsx
  it("строка товара показывает чип «чек соберётся» / «дыр: N»", () => {
    render(<ProductRulesPanel domain="vendhub" products={rows} />);
    // «Нет ИКПУ» и «ИКПУ из 16 цифр» — разные беды, и обе обязаны считаться
    // дырой, а не молчаливой готовностью.
    expect(screen.getByText("чек соберётся")).toBeVisible();
    expect(screen.getByText("дыр: 1")).toBeVisible();
  });

  it("правка открывает ОБЕ формы — правила и фискальные данные — одним блоком", async () => {
    const user = userEvent.setup();
    render(<ProductRulesPanel domain="vendhub" products={rows} />);
    await user.click(screen.getByRole("button", { name: "Править Snickers 50gr" }));
    expect(screen.getByLabelText("Блок, шт")).toBeVisible();
    expect(screen.getByLabelText("ИКПУ")).toBeVisible();
  });
```
Дописать в `apps/cc/src/lib/core-types.test.ts`:
```ts
  it("`VendingProductRow` панели несёт ТОТ ЖЕ `ProductFiscal`, что и shared", () => {
    // Компиляторная сверка (приём П5b): объявится в lib/core.ts своя копия
    // шести полей — этот файл перестанет собираться, а не разъедется молча.
    const блокОбщий: SharedProductFiscal = {
      ikpu: "02202003001086002", mxik: null, vatPct: 12,
      barcode: null, packageCode: "796", marked: false,
    };
    const строка: VendingProductRow = {
      id: "p1", name: "Snickers 50gr", category: "snack", purchasePrice: 7000, salePrice: 15000,
      packSize: 10, isActive: true, excludedFromPurchase: false, fixedPurchaseQty: 48,
      fiscal: блокОбщий,
    };
    expect(строка.fiscal.packageCode).toBe("796");
  });
```
(в шапке файла — `ProductFiscal as SharedProductFiscal` в импорте из `@mydon/shared` и `VendingProductRow` в импорте из `./core`).
- [ ] **Step 2: Фикстуры.** В `product-rules-panel.test.tsx` обеим строкам `rows` добавить `fiscal`: у `p1` — заполненный блок (`ikpu: "01806001001086002"`, `packageCode: "796"`), у `p2` — `ikpu: null` (одна дыра). Без этого файл не собирается: поле обязательное.
- [ ] **Step 3:** `pnpm --filter cc test` → RED.
- [ ] **Step 4: Клиент и типы.** `apps/cc/src/lib/core.ts`: импорт типа, поле `fiscal` в `VendingProductRow`, тип `VendingFiscalResult`, клиент `setVendingProductFiscal` рядом с `setVendingProductRules` (`:2300`).
- [ ] **Step 5: Server action.** В `apps/cc/src/app/vending/actions.ts` после `saveVendingProductRules`:
```ts
/**
 * Фискальный блок товара (лист «Правила закупа», П6).
 *
 * Пустое текстовое поле — это СБРОС (`null`), а не «не трогать»: у ИКПУ,
 * МХИК и штрих-кода пусто законно и значит «не выясняли». `<select>` пустым не
 * бывает по построению, поэтому три словарных поля едут всегда.
 *
 * Причина отказа берётся из `errors` Core, а не заменяется общим «Не
 * получилось»: владелец должен прочитать, ЧТО именно не так с 17-значным
 * кодом (тот же урок, что в `product-rules.ts` про причину вместо шпаргалки).
 */
export async function saveVendingProductFiscal(domain: string, form: FormData): Promise<ActionResult> {
  const productId = String(form.get("productId") ?? "").trim();
  if (productId === "") return { ok: false, message: "Не указана карточка товара" };
  const текст = (name: string): string | null => {
    const raw = String(form.get(name) ?? "").trim();
    return raw === "" ? null : raw;
  };
  const patch = {
    ikpu: текст("ikpu"),
    mxik: текст("mxik"),
    barcode: текст("barcode"),
    vatPct: Number(form.get("vatPct")),
    packageCode: String(form.get("packageCode") ?? ""),
    marked: String(form.get("marked") ?? "0") === "1",
  };
  // Тот же валидатор, что в Core: текст ошибки один, потому что функция одна.
  const errors = validateFiscalPatch(patch);
  if (errors.length > 0) return { ok: false, message: errors[0] };
  try {
    const res = await core.setVendingProductFiscal({ productId, ...patch, actor: "panel" });
    if (!res.ok) {
      return { ok: false, message: res.reason === "invalid" ? res.errors[0] : "Карточка товара не найдена" };
    }
    revalidatePath(`/domain/${domain}`);
    return { ok: true, message: `Фискальные данные «${res.product}» сохранены` };
  } catch (err) {
    return failure(err);
  }
}
```
- [ ] **Step 6: Форма.** Создать `apps/cc/src/components/product-fiscal-form.tsx` — клиентский компонент, скопированный по структуре с `RuleForm` (`product-rules-panel.tsx:26-78`): `"use client"`, `useRouter`, `useState`, `useTransition`, `<form className="form card" onSubmit={…}>`. Поля:
  - `<input name="ikpu" inputMode="numeric" defaultValue={row.fiscal.ikpu ?? ""}>` с `<span>ИКПУ</span>`, аналогично `mxik` («МХИК») и `barcode` («Штрихкод (EAN)»);
  - `<select name="vatPct">` по `VAT_RATES` (`<span>Ставка НДС</span>`), `<select name="packageCode">` по `PACKAGE_CODES` (`<span>Код упаковки (ОКЕИ)</span>` + `<small className="hint">единица измерения, не идентификатор каталога</small>`), `<select name="marked">` по `MARKING` (значения `"0"`/`"1"`);
  - скрытое `<input type="hidden" name="productId" value={row.id}>`;
  - кнопка `Сохранить фискальные данные` (подпись отличается от соседней «Сохранить» намеренно: в одном блоке две формы, и роль по имени обязана быть однозначной для читалки и для теста);
  - хвост: `fiscalFlaws(row.fiscal)` строкой на дыру — «ИКПУ: должно быть 17 цифр, а тут 16».
- [ ] **Step 7: Чип и второй блок.** В `product-rules-panel.tsx`:
```tsx
              {/* Чип фискальной готовности — та же формулировка, что на
                  карточке реестра (`product-card-sections.tsx:38-45`): владелец
                  не должен переучиваться, переходя между двумя витринами. */}
              {fiscalReady(p.fiscal) ? (
                <span className="pill ok">чек соберётся</span>
              ) : (
                <span className="pill bad">дыр: {count(fiscalFlaws(p.fiscal).length)}</span>
              )}
```
и в блоке правки — вторая форма под первой, тем же `key`:
```tsx
      {editingRow && (
        <div key={editingRow.id}>
          <RuleForm domain={domain} row={editingRow} onDone={close} />
          <ProductFiscalForm domain={domain} row={editingRow} onDone={close} />
        </div>
      )}
```
> `key` переезжает на обёртку, а не дублируется на обеих формах: причина прежняя (`:122-127`) — переключение «Править» без «Отмена» обязано ПЕРЕМОНТИРОВАТЬ неуправляемые поля, и одна обёртка делает это для обеих.
- [ ] **Step 8:** `pnpm --filter cc test` → GREEN; `pnpm -s typecheck && pnpm -s lint`.
- [ ] **Step 9:** `git commit -m "feat(cc): секция «Фискальные данные» в карточке снека и чип готовности на листе правил закупа (П6, R-P6-5)" -- apps/cc/src/lib/core.ts apps/cc/src/lib/core-types.test.ts apps/cc/src/app/vending/actions.ts apps/cc/src/components/product-fiscal-form.tsx apps/cc/src/components/product-fiscal-form.test.tsx apps/cc/src/components/product-rules-panel.tsx apps/cc/src/components/product-rules-panel.test.tsx`

---

### Task 5: Бот — «карточка &lt;товар&gt;» с фискальным блоком (**после T7**)

**Files:** Modify `apps/bot/src/core-client.ts` (`vendingProducts()` стр. 1104–1106 — возврат расширяется; новый тип рядом с `VendingCashSession` стр. 274+), `apps/bot/src/core-client.test.ts`, `apps/bot/src/handler.ts` (импорт стр. 36 рядом с `product-rules`; ветка ДО `isRuleCommand`, стр. 259). Create `apps/bot/src/product-card.ts`, `apps/bot/src/product-card.test.ts`.

**Interfaces (consumes):** `GET /vending/products` через существующий `CoreClient` (токен не нужен — это GET); `ProductFiscal`, `fiscalFlaws`, `PACKAGE_CODES`, `MARKING` (`@mydon/shared`, T2); блок `fiscal` в ответе каталога (T3); `normalizeProductName` (`packages/shared/src/vending-calc.ts:49`); формулировка отказа `product-rules.ts:145` («Имя должно совпадать с карточкой или алиасом»); приём префикса без `\b` — `isRuleCommand` (`apps/bot/src/product-rules.ts:27`).

**Interfaces (produces):**
```ts
/** apps/bot/src/core-client.ts */
/**
 * Строка прайса для КАРТОЧКИ (П6) — ровно те поля, которые она печатает.
 *
 * Не `VendingProductRow`: полный перенос этого типа в `@mydon/shared` спека
 * выносит за охват (§10), а объявить в боте копию под тем же именем значило бы
 * завести третье зеркало под видом одного. Общим стал ровно фискальный блок.
 */
export interface VendingProductCard {
  id: string;
  name: string;
  category: "drink" | "snack" | "other";
  purchasePrice: number | null;
  salePrice: number | null;
  packSize: number;
  isActive: boolean;
  excludedFromPurchase: boolean;
  fixedPurchaseQty: number | null;
  fiscal: ProductFiscal;
}
vendingProducts(): Promise<VendingProductCard[]>

/** apps/bot/src/product-card.ts */
/** Префикс без \b — он не срабатывает после кириллицы (то же, что в isRuleCommand). */
export function isProductCardTrigger(text: string): boolean;   // /^карточка(\s|:|$)/i
export function parseProductCardCommand(text: string): string | null;
export function formatProductCard(row: VendingProductCard): string;
export const PRODUCT_CARD_HINT: string;
```

Что обязана делать реализация:
- **Роутинг — ДО `isRuleCommand`** (`handler.ts:259`) и до `parseIntent`: «карточка …» ни с одним существующим префиксом не пересекается, и уходить в разбор намерения ей незачем.
- **Поиск строки — по канону `normalizeProductName`**, по `name` карточки. Не нашлось — дословная формулировка отказа правил закупа: «Товар «X» не найден в прайсе вендинга. Имя должно совпадать с карточкой или алиасом.»
- **Пустое поле печатается как «—», а не пропускается:** «не выясняли» — это ответ, а исчезнувшая строка читается как «всё в порядке».
- **Правка фискальных полей из бота — ВНЕ ОХВАТА, и тривиальной части здесь нет.** 17-значный код, набранный на телефоне в подвале, — ровно тот ввод, который производит «заполнено, но неверно»; у цены есть гейт ±20 % (`setProductPrice`, `vending.service.ts:2612`), у ИКПУ гейта нет и быть не может: второй такой же код неотличим от опечатки.

- [ ] **Step 1: Тесты RED.** Создать `apps/bot/src/product-card.test.ts`:
```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatProductCard, isProductCardTrigger, parseProductCardCommand } from "./product-card";
import type { VendingProductCard } from "./core-client";

const СТРОКА: VendingProductCard = {
  id: "p-snick", name: "Snickers 50gr", category: "snack",
  purchasePrice: 7000, salePrice: 15000, packSize: 10, isActive: true,
  excludedFromPurchase: false, fixedPurchaseQty: 48,
  fiscal: { ikpu: "01806001001086002", mxik: null, vatPct: 12, barcode: null, packageCode: "796", marked: false },
};

describe("Команда «карточка <товар>»", () => {
  it("«карточка Snickers 50gr» разобрана, «что закупать» — нет", () => {
    assert.equal(isProductCardTrigger("карточка Snickers 50gr"), true);
    assert.equal(parseProductCardCommand("карточка Snickers 50gr"), "Snickers 50gr");
    assert.equal(parseProductCardCommand("карточка: Snickers 50gr"), "Snickers 50gr");
    // Чужие префиксы не перехватываем: «карточка» стоит ДО isRuleCommand, и
    // жадный разбор увёл бы туда половину полевых фраз.
    assert.equal(isProductCardTrigger("что закупать"), false);
    assert.equal(isProductCardTrigger("новая карточка"), false, "заведение карточки сотрудника — чужой поток");
  });

  it("голая «карточка» — подсказка, а не запрос в Core", () => {
    assert.equal(parseProductCardCommand("карточка"), null);
    assert.equal(parseProductCardCommand("карточка   "), null);
  });
});

describe("Печать карточки товара", () => {
  it("печатает фискальный блок целиком и подписывает ОКЕИ словом", () => {
    const текст = formatProductCard(СТРОКА);
    assert.match(текст, /Snickers 50gr/);
    assert.match(текст, /ИКПУ.*01806001001086002/);
    assert.match(текст, /НДС.*12 %/);
    assert.match(текст, /796.*Штука/, "код ОКЕИ без подписи владельцу ничего не говорит");
    assert.match(текст, /Маркировка.*Не требуется/);
  });

  it("пустое поле печатается как «—», а не пропускается", () => {
    const текст = formatProductCard(СТРОКА);
    // Исчезнувшая строка читается как «всё в порядке»; «—» читается как «не
    // выясняли», и это ответ.
    assert.match(текст, /МХИК.*—/);
    assert.match(текст, /Штрихкод.*—/);
  });

  it("дыры печатаются списком, а «чек соберётся» — одной строкой", () => {
    assert.match(formatProductCard(СТРОКА), /Чек соберётся/);
    const дырявый = { ...СТРОКА, fiscal: { ...СТРОКА.fiscal, ikpu: null } };
    const текст = formatProductCard(дырявый);
    assert.match(текст, /Чек не соберётся/);
    assert.match(текст, /ИКПУ.*код не выяснен/);
  });

  it("правила закупа и цены — в той же карточке, чтобы за ними не ходить второй командой", () => {
    const текст = formatProductCard({ ...СТРОКА, excludedFromPurchase: true });
    assert.match(текст, /7 000/);
    assert.match(текст, /блок 10/i);
    assert.match(текст, /фикс 48/i);
    assert.match(текст, /не закупаем/i);
  });
});
```
Дописать в `apps/bot/src/core-client.test.ts` компиляторную сверку:
```ts
  it("фискальный блок строки прайса — ТОТ ЖЕ тип, что в @mydon/shared", () => {
    const блок: SharedProductFiscal = { ikpu: null, mxik: null, vatPct: 12, barcode: null, packageCode: "796", marked: false };
    const строка: VendingProductCard = {
      id: "p1", name: "Snickers 50gr", category: "snack", purchasePrice: 7000, salePrice: 15000,
      packSize: 10, isActive: true, excludedFromPurchase: false, fixedPurchaseQty: null, fiscal: блок,
    };
    assert.equal(строка.fiscal.vatPct, 12);
  });
```
- [ ] **Step 2:** `pnpm --filter @mydon/shared build && pnpm --filter bot build && pnpm --filter bot test` → RED.
- [ ] **Step 3: Клиент.** В `apps/bot/src/core-client.ts` объявить `VendingProductCard` (импорт `ProductFiscal` из `@mydon/shared`) и расширить возврат `vendingProducts()`. Докблок метода дописать: «Возврат расширен под карточку (П6). Существующий потребитель (`staff-refill.ts:763`) берёт два поля и не правится: расширение типа для него безопасно».
- [ ] **Step 4: Модуль карточки.** Создать `apps/bot/src/product-card.ts`. `formatProductCard` — одно сообщение:
```
🧾 Snickers 50gr (снек)
Закуп 7 000 сум · витрина 15 000 сум · блок 10 · фикс 48 · закупаем

Фискальные данные:
• ИКПУ: 01806001001086002
• МХИК: —
• НДС: 12 %
• Штрихкод: —
• Упаковка: 796 — Штука
• Маркировка: Не требуется

✅ Чек соберётся.
```
Для дырявой карточки хвост заменяется на `⚠️ Чек не соберётся:` и по строке на дыру из `fiscalFlaws` («• ИКПУ: код не выяснен»). Правку из бота НЕ предлагаем ни словом — вместо этого хвост: «Править фискальные поля — в панели: VendHub → Правила закупа → Править.»
- [ ] **Step 5: Роутинг.** В `apps/bot/src/handler.ts` — ветка ПЕРЕД `if (isRuleCommand(text))` (`:259`):
```ts
  // Карточка товара — ЧТЕНИЕ (П6). До parseIntent и до правил закупа: префикс
  // «карточка …» ни с чем не пересекается, а «новая карточка» — чужой поток и
  // ловится своим триггером раньше по маршруту сотрудника.
  if (isProductCardTrigger(text)) {
    const имя = parseProductCardCommand(text);
    if (имя === null) return { text: PRODUCT_CARD_HINT };
    try {
      const прайс = await deps.core.vendingProducts();
      const ключ = normalizeProductName(имя);
      const строка = прайс.find((p) => normalizeProductName(p.name) === ключ);
      if (!строка) {
        return { text: `Товар «${имя}» не найден в прайсе вендинга. Имя должно совпадать с карточкой или алиасом.` };
      }
      return { text: formatProductCard(строка) };
    } catch (err) {
      console.error("Ошибка чтения карточки товара:", err);
      return { text: "Не удалось получить карточку товара из MYDON Core. Попробуй ещё раз чуть позже." };
    }
  }
```
- [ ] **Step 6:** `pnpm --filter bot build && pnpm --filter bot test` → GREEN; `pnpm -s typecheck && pnpm -s lint`.
- [ ] **Step 7:** `git commit -m "feat(bot): «карточка <товар>» печатает фискальный блок и дыры (П6, R-P6-5)" -- apps/bot/src/product-card.ts apps/bot/src/product-card.test.ts apps/bot/src/core-client.ts apps/bot/src/core-client.test.ts apps/bot/src/handler.ts`

---

### Task 6: Разовый перенос донора — `packages/db/src/import-fiscal.ts`

**Files:** Create `packages/db/src/import-fiscal.ts`, `packages/db/src/import-fiscal.test.ts`. Modify `packages/db/package.json` (скрипт `db:import:fiscal`, рядом с `db:import:stock-history`), `docs/DEPLOY.md` (раздел разового переноса, рядом с рунбуком `import-stock-history.js`).

**Interfaces (consumes):**
- `productIndex(products, aliases)` / `resolveCatalogName(index, raw)` — `packages/shared/src/stock-history.ts:398` / `:372` (тот же индекс каталога, что у `backfill-product-ids.ts` и `import-stock-history.ts`; приоритет «имя карточки главнее алиаса» живёт ВНУТРИ них, здесь не переоткрывается).
- `classifyIkpu(code, dict)`, `normalizeFiscalInput(raw)` — `packages/shared/src/fiscal.ts` (Task 2 этого плана).
- `разобратьАргументы(argv)` — `packages/db/src/backfill-product-ids.ts:362` (**импортируется как есть, не копируется**: спека прямо требует ту же строку режима, которая не врёт, что и у бэкфилла).
- `sqlDonor`-паттерн (не сама функция — своя, с другим запросом) — `packages/db/src/import-stock-history.ts:471` (`postgres(url, { prepare: false, max: 1, connect_timeout: 10 })`, донор ТОЛЬКО SELECT).
- `vendingProduct` (`ikpu`/`mxik`/`vatPct`/`barcode`/`packageCode`/`marked`/`packSize`) и `entity` (`type`, `name`, `attrs`) — `packages/db/src/schema.ts` (после Task 1: `vendingProduct` начинается на текущей строке `1390` + сдвиг Task 1; сверять по живому файлу, см. «Отклонения» п. 8).
- `FISCAL_FIELDS`, `IKPU_DIGITS` — `packages/shared/src/sources.ts:121`, `:187` (ключи `attrs["ИКПУ"]`/`attrs["штрихкод"]` — те же слова, дословно).

**Interfaces (produces):**
```ts
/** packages/db/src/import-fiscal.ts */

/** Строка донора `products` — только колонки, нужные фискальному переносу. */
export interface DonorFiscalProductRow {
  id: number;
  name: string;
  ourvend_name: string | null;
  ikpu_code: string | null;
  barcode: string | null;
  is_marked: boolean;
}

/** Строка справочника донора `dictionary_entries` с `key='ikpu'`: код → подпись. */
export interface DonorIkpuDictRow {
  code: string;
  name: string;
}

export interface FiscalDonorReader {
  products(): Promise<DonorFiscalProductRow[]>;
  ikpuDict(): Promise<DonorIkpuDictRow[]>;
}

/** Причина, по которой донорское значение НЕ поехало в карточку. */
export type FiscalSkipReason =
  | "category"        // R-P6-9: код помечен «(категория)» в справочнике донора
  | "unknown_ikpu"     // classifyIkpu → unknown (нет в справочнике или спор с суффиксом)
  | "conflict"         // непустое значение на нашей стороне отличается от донорского
  | "length_defect"    // наш код не 17 цифр — CHECK 0072 его бы и не принял
  | "name_conflict"    // спор имени: ключ — и имя одной карточки, и алиас другой
  | "unresolved";      // донорская строка не нашла карточку вовсе

export interface FiscalFieldReport {
  /** raw (донорское имя) → канон → значение — карта решения, потолок печати 50 (§5, R-FW-S3). */
  written: { raw: string; canon: string; value: string }[];
  skipped: { raw: string; reason: FiscalSkipReason; detail: string }[];
}

export interface PackSizeMismatch {
  product: string;
  ours: number;
  donor: number;
}

export interface FiscalImportReport {
  apply: boolean;
  ikpu: FiscalFieldReport;
  barcode: FiscalFieldReport;
  marked: FiscalFieldReport;
  /** Только печатаются, никогда не пишутся (R-P6-14). */
  packSizeMismatches: PackSizeMismatch[];
  /** Донорские строки, не нашедшие карточку прайса вовсе (не путать с skipped выше). */
  unresolvedDonorNames: string[];
}

/**
 * Чистая функция решения — без БД, без Postgres, тестируется массивами.
 *
 * Три «первых источника» разные (R-P6-2/R-P6-14): ИКПУ и штрихкод в первую
 * очередь берутся из `entity.attrs` реестра (наши данные важнее донора), и
 * только для того, чего там нет, — из донора, причём ИКПУ донора допускается
 * ТОЛЬКО SKU-уровневый (R-P6-9). `marked` источника в реестре не имеет вовсе —
 * только донор, и только «поднимается».
 */
export function planFiscalImport(input: {
  /** Карточки прайса: id, канон, текущие ikpu/barcode/marked (что уже НЕ пусто — не трогаем). */
  priceCards: { id: string; canon: string; ikpu: string | null; barcode: string | null; marked: boolean }[];
  /** Карточки реестра с фискальными attrs, ещё не сопоставленные с прайсом. */
  registryCards: { name: string; attrs: Record<string, unknown> }[];
  donorProducts: DonorFiscalProductRow[];
  donorIkpuDict: DonorIkpuDictRow[];
  priceIndex: ReturnType<typeof import("@mydon/shared").productIndex>;
}): {
  ikpu: { productId: string; canon: string; value: string; source: "entity" | "donor" }[];
  barcode: { productId: string; canon: string; value: string; source: "entity" }[];
  marked: { productId: string; canon: string }[];
  skipped: { field: "ikpu" | "barcode"; raw: string; reason: FiscalSkipReason; detail: string }[];
  packSizeMismatches: PackSizeMismatch[];
  unresolvedDonorNames: string[];
};

export async function importFiscal(
  db: import("./index").Database,
  donor: FiscalDonorReader,
  opts: { apply: boolean },
): Promise<FiscalImportReport>;
```

Поведение, которое обязана держать реализация (спека `docs/superpowers/specs/2026-08-26-p6-fiscal-design.md:772-858`, R-P6-9, R-P6-14):

- **Флаги.** Ровно `--dry-run`/`--apply`, разбираются `разобратьАргументы` из `backfill-product-ids.ts` (импорт, не копия). **БЕЗ ФЛАГОВ — ПРИМЕРКА** — асимметрия с `backfill-product-ids.ts` (там без флагов пишет, потому что его зовёт `ci.yml`) названа в докблоке ОБОИХ файлов дословно: «этот скрипт CI не зовёт, он ходит в прод руками», иначе кто-то «выровняет» их поведение и получит случайную запись.
- **Коды возврата.** `DATABASE_URL` не задан → 1 (как везде). `STOCK_DATABASE_URL` не задан → **2**, с текстом «донор mydon-stock не подключён — это не поломка скрипта, а не выданное окружение» (дословно приём `import-stock-history.ts:678`). Хост донора и MYDON печатаются `new URL(url).host` — никогда полная строка с паролем.
- **Резолв донорского имени** — `productIndex`/`resolveCatalogName` над каталогом `vendingProduct` (не `entity`!): донорское имя пробуется как `products.name`, потом как `products.ourvend_name` (тот же порядок, что П8a, R-FW-P1). Спор (`kind: "conflict"`) → строка в `unresolvedDonorNames`, причина `name_conflict`, привязка не делается — тот же принцип необратимости, что у `backfill-product-ids.ts` (`бэкфиллWhere` держит `isNull`).
- **`ikpu` — первый источник `entity.attrs["ИКПУ"]`.** Карточки реестра (`entity` где `type='product'`) сопоставляются с карточкой прайса ТЕМ ЖЕ `productIndex`, только по имени карточки реестра как «сырому» входу. Где `attrs["ИКПУ"]` непусто (после `normalizeFiscalInput`) и ровно `IKPU_DIGITS` цифр — пишем это значение (`source: "entity"`), НЕ обращаясь к донору вовсе для этой карточки. Где на нашей стороне НИЧЕГО нет (ни в `attrs`, ни уже в `vending_product.ikpu`) — берём донорский `ikpu_code`, но только если `classifyIkpu(code, справочник)` вернул `{kind:"sku"}`; `{kind:"category"}` → `skipped` причиной `"category"`; `{kind:"unknown", why}` → `skipped` причиной `"unknown_ikpu"`, `detail = why`.
- **Конфликт значений.** `vending_product.ikpu` УЖЕ непусто (из прошлого прогона или правки в панели) и донор несёт ДРУГОЕ значение того же товара → `skipped` причиной `"conflict"`, `detail` вида `«у нас <X>, донор <Y>»`. Непустое НЕ затирается никогда (R-P6-14) — это касается и `entity.attrs`-источника: если `vending_product.ikpu` уже заполнен (например той же карточкой в прошлом прогоне), повторная запись пропускается, даже если значение совпадает — план пишет ТОЛЬКО туда, где `ikpu IS NULL`.
- **Дефект длины на нашей стороне.** Значение из `entity.attrs["ИКПУ"]`, у которого после `normalizeFiscalInput` цифр не 17 (пример из описи — `Coca-Cola ZeroS CAN 0.25`, `2202002001010032`, 16 цифр) — `skipped` причиной `"length_defect"`: миграция 0072 такое значение и не приняла бы CHECK'ом, поэтому скрипт отбраковывает его САМ, до единого UPDATE, а не роняет транзакцию на середине.
- **`barcode` — только `entity.attrs["штрихкод"]`.** У донора штрихкод пуст (0 из 62, опись §2), поэтому второго источника у этого поля НЕТ вовсе — пишется, только если `vending_product.barcode IS NULL` и `attrs["штрихкод"]` непусто и валидной длины (`BARCODE_DIGITS` из `fiscal.ts`); дефект длины и конфликт — теми же причинами, что у `ikpu`.
- **`marked`.** ЕДИНСТВЕННЫЙ источник — донорский `is_marked = true`; пишется, только если ТЕКУЩЕЕ `vending_product.marked = false`. `true → false` не пишется НИКОГДА (только подъём).
- **`mxik`, `vat_pct`, `package_code` — не трогаются ни при каких данных** (R-P6-8/R-P6-14): миграция уже проставила умолчания (`12`/`796`), донор не несёт отклонений или данных вовсе.
- **`pack_size` — только печатается.** Донорское поле «Блок, шт» (живой EAV донора, опись §1.7, 10 значений) сопоставляется с нашим `vendingProduct.packSize` по канону; расхождения уходят в `packSizeMismatches`, ничего не пишется (R-P6-14: это правило закупа владельца, а не фискальное поле).
- **Идемпотентность.** Повторный `--apply` обязан дать **нули по всем трём счётчикам `written`**: первый прогон закрывает `ikpu IS NULL`/`barcode IS NULL`/`marked = false`, второй находит эти условия уже неверными для тех же строк.
- **Границы транзакции.** Одна транзакция на весь `--apply` (как у `RecordCancelService` в Task 7, ниже) — при отказе посреди записи репорт по уже собранному плану печатается ДО текста ошибки (`ImportWriteFailure`-подобный класс, приём `import-stock-history.ts:131`), а сама транзакция откатывается целиком: частичная фискальная правка хуже, чем «ничего не записалось, попробуй снова» — в отличие от `import-stock-history.ts`, где пачки идемпотентны и повтор дожимает остаток, здесь план строится ЗАРАНЕЕ одним снимком БД, и повторный прогон после отказа пересчитает его заново, а не продолжит с середины.
- **Карта решения и отчёт** — по образцу `картаРешения`/`отчёт` (`backfill-product-ids.ts:333`/`:311`): потолок печати 50 строк на каждое поле, разделы `skipped` группируются по причине с текстом ПОЧЕМУ, `ИТОГИ(json)` последней строкой (приём `import-stock-history.ts:645`) с полями `{ apply, ikpu, barcode, marked, packSizeMismatches, unresolved }` — по нему сверяется выкатка.

- [ ] **Step 1: Тесты RED.** Создать `packages/db/src/import-fiscal.test.ts`:
```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { productIndex } from "@mydon/shared";
import { planFiscalImport, type DonorFiscalProductRow, type DonorIkpuDictRow } from "./import-fiscal";

const products = [{ id: "p1", name: "Snickers 50gr" }, { id: "p2", name: "Lit Energy Blueberry CAN 0,45" }];
const index = productIndex(products, []);

const СПРАВОЧНИК: DonorIkpuDictRow[] = [
  { code: "02202002001000000", name: "Газнапитки (категория)" },
  { code: "01806001001086002", name: "Сникерс 50гр" }, // SKU, без «(категория)»
];

function базовыйВвод(over: Partial<Parameters<typeof planFiscalImport>[0]> = {}) {
  return {
    priceCards: [{ id: "p1", canon: "Snickers 50gr", ikpu: null, barcode: null, marked: false }],
    registryCards: [],
    donorProducts: [] as DonorFiscalProductRow[],
    donorIkpuDict: СПРАВОЧНИК,
    priceIndex: index,
    ...over,
  };
}

describe("Перенос фискального блока: приоритет источников (R-P6-2/R-P6-14)", () => {
  it("ИКПУ из entity.attrs побеждает и донор не спрашивается вовсе", () => {
    const план = planFiscalImport(базовыйВвод({
      registryCards: [{ name: "Snickers 50gr", attrs: { ИКПУ: "01806001001086002" } }],
      donorProducts: [{ id: 1, name: "Snickers 50gr", ourvend_name: null, ikpu_code: "09999999999999999", barcode: null, is_marked: false }],
    }));
    assert.deepEqual(план.ikpu, [{ productId: "p1", canon: "Snickers 50gr", value: "01806001001086002", source: "entity" }]);
  });

  it("нашего значения нет — донорский SKU-код пишется", () => {
    const план = planFiscalImport(базовыйВвод({
      donorProducts: [{ id: 1, name: "Snickers 50gr", ourvend_name: null, ikpu_code: "01806001001086002", barcode: null, is_marked: false }],
    }));
    assert.deepEqual(план.ikpu, [{ productId: "p1", canon: "Snickers 50gr", value: "01806001001086002", source: "donor" }]);
  });

  it("категорийный код донора не пишется и попадает в отчёт с причиной «category»", () => {
    const план = planFiscalImport(базовыйВвод({
      donorProducts: [{ id: 1, name: "Snickers 50gr", ourvend_name: null, ikpu_code: "02202002001000000", barcode: null, is_marked: false }],
    }));
    assert.equal(план.ikpu.length, 0);
    assert.deepEqual(план.skipped, [{ field: "ikpu", raw: "Snickers 50gr", reason: "category", detail: "Газнапитки (категория)" }]);
  });

  it("код, которого нет в справочнике донора, не пишется — причина unknown_ikpu", () => {
    const план = planFiscalImport(базовыйВвод({
      donorProducts: [{ id: 1, name: "Snickers 50gr", ourvend_name: null, ikpu_code: "00000000000000001", barcode: null, is_marked: false }],
    }));
    assert.equal(план.ikpu.length, 0);
    assert.equal(план.skipped[0].reason, "unknown_ikpu");
  });

  it("непустое значение на нашей стороне не затирается — уходит в conflict", () => {
    const план = planFiscalImport({
      ...базовыйВвод(),
      priceCards: [{ id: "p1", canon: "Snickers 50gr", ikpu: "01806001001086002", barcode: null, marked: false }],
      donorProducts: [{ id: 1, name: "Snickers 50gr", ourvend_name: null, ikpu_code: "01806001001086003", barcode: null, is_marked: false }],
    });
    assert.equal(план.ikpu.length, 0);
    assert.equal(план.skipped[0].reason, "conflict");
    assert.match(план.skipped[0].detail, /01806001001086002.*01806001001086003/);
  });

  it("16-значный код нашей стороны отбракован как length_defect, а не пишется как есть", () => {
    const план = planFiscalImport(базовыйВвод({
      registryCards: [{ name: "Snickers 50gr", attrs: { ИКПУ: "2202002001010032" } }], // 16 цифр
    }));
    assert.equal(план.ikpu.length, 0);
    assert.equal(план.skipped[0].reason, "length_defect");
  });

  it("marked только поднимается: true → false скрипт не пишет никогда (нет такого источника)", () => {
    const план = planFiscalImport(базовыйВвод({
      priceCards: [{ id: "p1", canon: "Snickers 50gr", ikpu: null, barcode: null, marked: true }],
      donorProducts: [{ id: 1, name: "Snickers 50gr", ourvend_name: null, ikpu_code: null, barcode: null, is_marked: false }],
    }));
    assert.equal(план.marked.length, 0, "донор не может ПОНИЗИТЬ marked — у понижения нет источника в модели вовсе");
  });

  it("marked поднимается false → true от донора", () => {
    const план = planFiscalImport(базовыйВвод({
      donorProducts: [{ id: 1, name: "Snickers 50gr", ourvend_name: null, ikpu_code: null, barcode: null, is_marked: true }],
    }));
    assert.deepEqual(план.marked, [{ productId: "p1", canon: "Snickers 50gr" }]);
  });

  it("attrs['упаковка'] (семизначная) в package_code не попадает — плана на это поле нет вовсе (R-P6-7)", () => {
    // Сознательно нет ни одного поля `packageCode` в результате planFiscalImport —
    // это структурная проверка контракта, не поведения: функция физически не
    // может записать то, чего нет в её возвращаемом типе.
    const план = planFiscalImport(базовыйВвод({
      registryCards: [{ name: "Snickers 50gr", attrs: { упаковка: "1218841" } }],
    }));
    assert.ok(!("packageCode" in план), "package_code не источник этого скрипта — только миграция и панель");
  });

  it("спор имени (donor name — и алиас, и чужое имя карточки) уходит в unresolvedDonorNames", () => {
    const спорныйИндекс = productIndex(products, [{ productId: "p2", alias: "Snickers 50gr" }]);
    const план = planFiscalImport({
      ...базовыйВвод(),
      priceIndex: спорныйИндекс,
      donorProducts: [{ id: 1, name: "Snickers 50gr", ourvend_name: null, ikpu_code: "01806001001086002", barcode: null, is_marked: false }],
    });
    assert.deepEqual(план.unresolvedDonorNames, ["Snickers 50gr"]);
  });

  it("карта решения ограничена печатью 50 — сама структура плана предела не знает (потолок печатает отчёт)", () => {
    const много = Array.from({ length: 60 }, (_, i) => ({
      id: i, name: `Товар ${i}`, ourvend_name: null, ikpu_code: `0180600100108${String(i).padStart(4, "0")}`, barcode: null, is_marked: false,
    }));
    const карточки = много.map((d, i) => ({ id: `p${i}`, canon: d.name, ikpu: null, barcode: null, marked: false }));
    const индекс60 = productIndex(много.map((d, i) => ({ id: `p${i}`, name: d.name })), []);
    const план = planFiscalImport({
      priceCards: карточки, registryCards: [], donorProducts: много,
      donorIkpuDict: много.map((d) => ({ code: d.ikpu_code!, name: `Товар ${d.id} (не категория)` })),
      priceIndex: индекс60,
    });
    assert.equal(план.ikpu.length, 60, "план не режет — режет печать отчёта, а не расчёт");
  });
});
```
- [ ] **Step 2:** `pnpm --filter @mydon/shared build && pnpm --filter @mydon/db build && pnpm --filter @mydon/db test` → RED (модуля нет).
- [ ] **Step 3: `planFiscalImport` — чистая функция решения.** Реализовать в `import-fiscal.ts` по сигнатуре из «Interfaces (produces)»: для каждой `priceCard` найти сопоставленную `registryCard` через `priceIndex.explain(registryCard.name)` (`kind: "hit"` и `id === priceCard.id`); для каждого `donorProduct` резолвить имя (`name`, при `miss` — `ourvend_name`) тем же индексом; при `ikpu`/`barcode` уже непустых на `priceCard` — конфликт при расхождении, пропуск (без записи в `skipped`) при совпадении. Держать функцию БЕЗ побочных эффектов — только маппинг входных структур в план; вся история дефектов уже в тестах Step 1.
- [ ] **Step 4:** `pnpm --filter @mydon/db test` → GREEN на `planFiscalImport`.
- [ ] **Step 5: Донорский ридер и `importFiscal`.** Дописать в `import-fiscal.ts`:
```ts
import postgres from "postgres";

function sqlFiscalDonor(url: string, schema = "public"): { reader: FiscalDonorReader; close(): Promise<void> } {
  const client = postgres(url, { prepare: false, max: 1, connect_timeout: 10 });
  return {
    reader: {
      products: async () =>
        (await client`
          select id, name, ourvend_name, ikpu_code, barcode, is_marked
            from ${client(schema)}.products
           order by id`) as unknown as DonorFiscalProductRow[],
      ikpuDict: async () =>
        (await client`
          select e.code, e.name
            from ${client(schema)}.dictionary_entries e
            join ${client(schema)}.dictionaries d on d.id = e.dict_id
           where d.key = 'ikpu'
           order by e.code`) as unknown as DonorIkpuDictRow[],
    },
    close: async () => client.end({ timeout: 5 }),
  };
}

export async function importFiscal(
  db: Database,
  donor: FiscalDonorReader,
  opts: { apply: boolean },
): Promise<FiscalImportReport> {
  const [priceRows, registryRows, donorProducts, donorIkpuDict] = await Promise.all([
    db.select({ id: vendingProduct.id, name: vendingProduct.name, ikpu: vendingProduct.ikpu, barcode: vendingProduct.barcode, marked: vendingProduct.marked, packSize: vendingProduct.packSize }).from(vendingProduct),
    db.select({ name: entity.name, attrs: entity.attrs }).from(entity).where(eq(entity.type, "product")),
    donor.products(),
    donor.ikpuDict(),
  ]);
  const priceIndex = productIndex(priceRows.map((r) => ({ id: r.id, name: r.name })), []);
  const план = planFiscalImport({
    priceCards: priceRows.map((r) => ({ id: r.id, canon: r.name, ikpu: r.ikpu, barcode: r.barcode, marked: r.marked })),
    registryCards: registryRows.map((r) => ({ name: r.name, attrs: r.attrs as Record<string, unknown> })),
    donorProducts,
    donorIkpuDict,
    priceIndex,
  });

  let ikpuWritten = 0, barcodeWritten = 0, markedWritten = 0;
  if (opts.apply) {
    try {
      await db.transaction(async (tx) => {
        for (const p of план.ikpu) { await tx.update(vendingProduct).set({ ikpu: p.value }).where(and(eq(vendingProduct.id, p.productId), isNull(vendingProduct.ikpu))); ikpuWritten += 1; }
        for (const p of план.barcode) { await tx.update(vendingProduct).set({ barcode: p.value }).where(and(eq(vendingProduct.id, p.productId), isNull(vendingProduct.barcode))); barcodeWritten += 1; }
        for (const p of план.marked) { await tx.update(vendingProduct).set({ marked: true }).where(and(eq(vendingProduct.id, p.productId), eq(vendingProduct.marked, false))); markedWritten += 1; }
      });
    } catch (err) {
      throw new ImportFiscalWriteFailure(планВОтчёт(план, opts.apply, 0, 0, 0), err);
    }
  }
  return планВОтчёт(план, opts.apply, opts.apply ? ikpuWritten : план.ikpu.length, opts.apply ? barcodeWritten : план.barcode.length, opts.apply ? markedWritten : план.marked.length);
}
```
`планВОтчёт` — маленькая чистая функция, собирающая `FiscalImportReport` из `план` плюс фактические счётчики (`written`), с картой решения (`raw → canon → value`) и `skipped` по каждому полю; `ImportFiscalWriteFailure` — класс по образцу `ImportWriteFailure` (`import-stock-history.ts:131`), несёт частичный отчёт и исходную ошибку. `WHERE isNull(...)`/`eq(..., false)` в самом UPDATE — та же страховка, что у `бэкфиллWhere` (`backfill-product-ids.ts:211`): между расчётом плана и записью могло пройти время (панель), и повторная проверка в SQL не даёт затереть то, что успели вписать руками.
- [ ] **Step 6: Отчёт и точка входа.** Дописать `formatFiscalReport(r: FiscalImportReport): string` (режим первой строкой, таблица «поле · к записи · записано · пропущено», карта решения потолком 50 — `картаРешения`-приём, `ИТОГИ(json)` последней строкой) и `main()` — разбор флагов через `разобратьАргументы` (импорт из `./backfill-product-ids`), коды возврата 1/2, `sqlFiscalDonor`, вызов `importFiscal`, `process.exit(0)`, `require.main === module` — один в один структура `import-stock-history.ts:659-703`.
- [ ] **Step 7: Тест непустого пути записи и идемпотентности.** Дописать в `import-fiscal.test.ts` (стаб БД в файле, тем же приёмом, что у `tasks.test.ts` — `select`/`update`/`transaction` цепочки-заглушки):
```ts
describe("Идемпотентность и границы записи", () => {
  it("--dry-run не пишет ни одной строки — update не вызывается вовсе", async () => {
    let updateCalled = false;
    const db = { select: () => ({ from: () => ({ where: async () => [] }) }), transaction: async () => { updateCalled = true; } } as never;
    await importFiscal(db, { products: async () => [], ikpuDict: async () => [] }, { apply: false });
    assert.equal(updateCalled, false);
  });

  it("повторный --apply даёт нули по всем счётчикам, когда план пуст", async () => {
    const report = планВОтчёт({ ikpu: [], barcode: [], marked: [], skipped: [], packSizeMismatches: [], unresolvedDonorNames: [] }, true, 0, 0, 0);
    assert.deepEqual({ ikpu: report.ikpu.written.length, barcode: report.barcode.written.length, marked: report.marked.written.length }, { ikpu: 0, barcode: 0, marked: 0 });
  });
});

describe("Флаги и коды возврата (переиспользуют backfill-product-ids)", () => {
  it("--apply и --dry-run вместе — отказ", () => {
    const р = разобратьАргументы(["--apply", "--dry-run"]);
    assert.equal(р.ok, false);
  });
  it("--dryrun (опечатка) — отказ, а не молчаливая запись", () => {
    const р = разобратьАргументы(["--dryrun"]);
    assert.equal(р.ok, false);
  });
  it("без флагов — ПРИМЕРКА для этого скрипта (отличие от бэкфилла — своя строка режима в main())", () => {
    // разобратьАргументы() без аргументов возвращает dryRun:false (её умолчание —
    // «запись», как у backfill-product-ids); import-fiscal.ts обязан САМ
    // инвертировать пустой ввод до вызова importFiscal, чтобы ЕГО собственная
    // асимметрия («без флагов — примерка») не зависела от чужого умолчания.
    const р = разобратьАргументы([]);
    assert.equal(р.dryRun, false, "чужая функция ничего не знает про инверсию — её меняет вызывающий main()");
  });
});
```
- [ ] **Step 8:** `pnpm --filter @mydon/db build && pnpm --filter @mydon/db test` → GREEN; `pnpm -s typecheck && pnpm -s lint`.
- [ ] **Step 9: Скрипт запуска и документация.** В `packages/db/package.json` рядом с `"db:import:stock-history": "node dist/import-stock-history.js"` добавить `"db:import:fiscal": "node dist/import-fiscal.js"`. В `docs/DEPLOY.md` — новый пункт рунбука рядом с существующим переносом истории склада: те же два прогона, `</dev/null` в хвосте, ожидаемые числа из §9 плана (раздел «Выкатка» ниже).
- [ ] **Step 10:** `git commit -m "feat(db): разовый перенос фискальных полей mydon-stock — ИКПУ/штрихкод/маркировка, приоритет entity.attrs, категорийные коды в отчёт (П6, R-P6-9/R-P6-14)" -- packages/db/src/import-fiscal.ts packages/db/src/import-fiscal.test.ts packages/db/package.json docs/DEPLOY.md`

---

### Task 7: Сторно снек-записей + «Мои записи» + проводка автора

**Files:** Create `apps/core/src/vending/record-cancel.service.ts` (+test). Modify `apps/core/src/vending/vending.controller.ts` (+test — DTO рядом с `StockCountsDto:363`, роуты рядом с `refills`/`stock`/`cash` §599-635 текущей нумерации), `apps/core/src/vending/vending.service.ts` (+test — `stockCounts()` `1674-1746`: добавить `id`, фильтр сторно; `CashSessionRow` `326-330` и `cashSessions()` `3010-3025`: поле `source`; новый метод `myRecords()`), `apps/core/src/vending/vending.module.ts` (`providers`/`exports`, рядом с `ProductFiscalService` из Task 3), `apps/core/src/rules/rules.ts` (+`rules.test.ts` — блок «Снек-автоматы», рядом с новым правилом Task 3), `apps/core/src/system/config-spec.ts` (+test — ключ `SNACK_CANCEL_WINDOW_HOURS`), `apps/core/src/registry/actions.service.ts` (+test — `121-131`/`262-269`), `apps/bot/src/core-client.ts` (+test — `VendingCashSession` `137`, `setVendingStock` `506-514`, `recordVendingCash` `520-534`), `apps/bot/src/handler.ts` (`227-243`, `552-563` — резолв `personId`), `apps/bot/src/menu.ts` (+`menu.test.ts` — пункт после `fix`, `144`), `apps/bot/src/staff.ts` (роутинг пункта), `apps/bot/src/cash-intake.ts` (+test — `formatCashSessions`, `91-123`), `tools/smoke-core.mjs`, `docs/PLAN_STOCK_ABSORPTION.md` (закрыть П6 в чек-листе среза). Create `apps/bot/src/my-records.ts` (+test).

**Interfaces (consumes):** `ProductFiscal`/`fiscalReady` — Task 2/3 (не пересекается по коду, но `record-cancel.service.ts` регистрируется в том же `vending.module.ts`, что и `ProductFiscalService`). `can(roles, perm)`, `Permission` — `packages/shared/src/roles.ts:100`, `:38-51` (право `system.admin` уже в матрице, `:50`; `owner: [...PERMISSIONS]`, `:96`). `readIntSetting(db, key, fallback, logger?)` — `apps/core/src/system/settings.ts:40`. `ConfigSpec`/`CONFIG_SPECS`/`inRange` — `apps/core/src/system/config-spec.ts:15-27`/`:99`/`:63-68`. `personIdOf(ref)` — `apps/core/src/registry/actions.service.ts:70-74`. Двухшаговое подтверждение с кнопками в разных рядах и строгим разбором `callback_data` — образец `apps/bot/src/coffee-fix.ts` целиком (79 строк): `parseCoffeeFixCallback` `:32-37`, `startCoffeeFix` `:40-58`, `handleCoffeeFixCallback` `:61-79`.

**Interfaces (produces):**
```ts
/** apps/core/src/vending/record-cancel.service.ts */
export type CancelKind = "refill" | "stock_count" | "cash";

export interface CancelActor {
  /** Карточка сотрудника. Анонимного пути нет: единственный вызывающий — бот. */
  personId: string;
  /** Строка для audit_log.actorRef: «person:<uuid>» — формат personIdOf(). */
  ref: string;
}

export type CancelResult =
  | { ok: true; kind: CancelKind; stornoId: string; label: string; alreadyCancelled: boolean }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "not_yours" }
  | { ok: false; reason: "too_old"; hours: number };

@Injectable()
export class RecordCancelService {
  constructor(@Inject(DB) private readonly db: Db) {}
  /** `now` параметром — окно 24 ч обязано проверяться тестом, а не стенными часами. */
  async cancel(kind: CancelKind, id: string, actor: CancelActor, now: Date): Promise<CancelResult>;
}

/** apps/core/src/vending/vending.service.ts — добавка к существующему файлу */
export interface MyRecordRow {
  kind: CancelKind;
  /** Для refill — id строки; для stock_count — id ПЕРВОЙ строки ввода (R-P6-11); для cash — id сессии. */
  id: string;
  createdAt: string;
  /** Готовая русская строка для бота — тот же язык, что у ленты «Действия». */
  label: string;
}

/** apps/bot/src/my-records.ts */
export type MyRecordsCallback = { kind: "cancel"; entry: CancelKind; id: string } | { kind: "keep" };
export function isMyRecordsTrigger(text: string): boolean;
/** Строгий разбор: данные кнопки приходят снаружи, доверять им нельзя. `mr:c:<r|s|k>:<uuid>` | `mr:keep`. */
export function parseMyRecordsCallback(data: string): MyRecordsCallback | null;
export async function startMyRecords(person: PersonRow, deps: { core: CoreClient }): Promise<StaffReply>;
export async function askCancel(cb: MyRecordsCallback & { kind: "cancel" }, person: PersonRow, deps: { core: CoreClient }): Promise<StaffReply>;
export async function handleMyRecordsCallback(
  cb: MyRecordsCallback,
  person: PersonRow,
  deps: { core: CoreClient },
): Promise<{ answer: string; message?: string }>;
```

Поведение (спека `docs/superpowers/specs/2026-08-26-p6-fiscal-design.md:860-1057`, R-P6-3/R-P6-10…R-P6-13):

- **Три ветки `RecordCancelService.cancel` в ОДНОЙ транзакции**, права читаются В CORE (не приходят снаружи): `person.roles` по `actor.personId` → `can(roles, "system.admin")`. Без права — только СВОЯ запись (`createdBy === actor.ref` у refill/cash, `personId === actor.personId` у stock_count) и только в пределах `readIntSetting(db, "SNACK_CANCEL_WINDOW_HOURS", 24)` часов от **`created_at`** (не `performed_at`/`counted_at` — R-P6-12).
  - `refill` — ДЕЛЬТА: сторно-строка `{...original, id: undefined, qty: -original.qty, source: "storno", reversesId: original.id, clientKey: \`storno:${original.id}\`, performedAt: now, createdBy: actor.ref}`, `.onConflictDoNothing({target: vendingRefill.clientKey})` — идемпотентность БЕСПЛАТНО через уже существующий уникальный `vending_refill_client_key`. Пусто вернулось (уже сторнировано) → `{ok:true, alreadyCancelled:true}`, склад НЕ трогаем. Иначе — `vendingStock` `onConflictDoUpdate` возврат `+original.qty`.
  - `stock_count` — СНИМОК: выбрать ВЕСЬ ввод `WHERE source='own' AND countedAt=original.countedAt AND personId=original.personId`; на КАЖДУЮ строку — своя сторно-метка (`qty` копируется, `source:"storno"`, `reversesId: строка.id`, `note:"отмена"`); уникальный `vending_stock_count_storno_key` (Task 1) делает повтор безвредным на уровне каждой строки. `vendingStock` (текущий остаток) НЕ трогаем — R-P6-10.
  - `cash` — ДЕНЬГИ: противознак по `receivedAmount`/`totalSpent`/`remainder` и по каждой строке `categories[].lines[].amount`/`subtotal`, `source:"storno"`, `reversesId: original.id`.
  - В той же транзакции — `event` (`vending.record_cancelled`, payload `{kind, recordId, stornoId, label, author, cancelledBy}`) и `auditLog` (`action: \`vending.${kind}.cancel\`, before: original, after: сторно`).
- **`vending.controller.ts`**: `CancelRecordDto { @IsUUID() personId! }`, три `@Post("refills/:id/cancel")`/`@Post("stock-counts/:id/cancel")`/`@Post("cash/:id/cancel")` (ДО параметрических маршрутов вида `:id` без суффикса не мешают — суффикс отличает путь), `MyRecordsDto { @IsUUID() person!; @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(15) limit? }`, `@Get("my-records")`. Ответ сервиса `not_yours`/`too_old` → `403 ForbiddenException` с текстом причины (не `400`: запрос корректен, отказ — по правам), `not_found` → `404`.
- **`stockCounts()` (`vending.service.ts:1674`)**: добавить `id: vendingStockCount.id` в `select` (строка `1695`) и в `StockCountRow` (`packages/shared/src/vending-reports.ts:1079` — аддитивное поле, тип не ломается); в `условие` (`:1689`) добавить `ne(vendingStockCount.source, "storno")` и `sql\`NOT EXISTS (SELECT 1 FROM vending_stock_count s2 WHERE s2.source = 'storno' AND s2.reverses_id = ${vendingStockCount.id})\`` — отменённая строка исчезает из истории ЦЕЛИКОМ (и оригинал, и метка), а не показывается зачёркнутой (R-P6-10: «обе строки уходят из чтений»).
- **`cashSessions()` (`:3010`)** и `CashSessionRow` (`:326`) получают `source: r.source` (колонка уже есть после Task 1; сегодня `select()` берёт её автоматически как `*`-подобный маппинг полей — добавить явно в объект результата строки `3016-3024`); `apps/bot/src/cash-intake.ts:formatCashSessions` (`113-123`) — ветка `s.source === "storno" ? "↩️ Отмена: …" : "•"`, чтобы «получил −150 000» не читалось как обычная запись.
- **`myRecords(personId, limit=15)`** — новый метод `VendingService`: три независимых запроса, слитые и отсортированные по `createdAt DESC`, обрезанные `limit`.
  - `refill`: `select` по `vendingRefill` `where personId = ${personId} and source <> 'storno' and not exists (select 1 from vending_refill s2 where s2.client_key = 'storno:' || vending_refill.id)`, маппинг в `label` вида `🍫 Заправка автомата ${serial}: ${product} ×${qty}` (тот же текст, что у ленты «Действия», `actions.service.ts:262-269`).
  - `cash`: `select` по `vendingCashSession` `where createdBy = 'person:' || ${personId} and source <> 'storno' and not exists (select 1 from vending_cash_session s2 where s2.reverses_id = vending_cash_session.id)`, `label` вида `💰 Касса закупа: получил ${amount} сум`.
  - `stock_count` — ЕДИНИЦА ОТМЕНЫ ВВОД, а не строка (R-P6-11), группировка через CTE (приём `db.execute(sql\`...\`)`, тот же, что в `ourvend-parity.service.ts:411-418` — `as unknown as MyRecordStockRow[]`, интерполяция таблицы через `${vendingStockCount}`, а не имя строкой):
    ```ts
    interface MyRecordStockRow { id: string; countedAt: Date; positions: number }

    const stockGroups = (await this.db.execute(sql`
      with groups as (
        select min(id::text)::uuid as id, counted_at as "countedAt", count(*)::int as positions
        from ${vendingStockCount}
        where source = 'own' and person_id = ${personId}
        group by counted_at, person_id
      )
      select g.id, g."countedAt", g.positions
      from groups g
      where not exists (
        select 1 from ${vendingStockCount} s
        where s.source = 'storno' and s.reverses_id = g.id
      )
      order by g."countedAt" desc
      limit ${limit}
    `)) as unknown as MyRecordStockRow[];
    ```
    `min(id::text)::uuid` как ключ группы — UUID сначала приводится к тексту,
    потому что PostgreSQL 15 не определяет агрегат `min(uuid)`. Получившийся
    ключ детерминирован ПОВТОРНО (одно и то же значение при двух чтениях), но
    НЕ хронологичен. Отмена атомарна (Task 7, ветка `stock_count` — вся
    транзакция), поэтому у ВСЕХ строк группы одна судьба: проверка через
    `reverses_id = g.id` (представитель группы) равносильна проверке всей
    группы. `label` — `📦 Пересчёт склада: N позиций` (N = `positions`).
  - Три массива сливаются в JS (`[...refills, ...cash, ...stockGroups].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)`), а не одним SQL `UNION` — источники разной формы (id/label уже посчитаны раздельно), и `UNION` по трём разнородным `select`ам менее читаем, чем три коротких запроса + сортировка в коде.
- **`config-spec.ts`**: новая запись в `CONFIG_SPECS` (после блока «Вендинг: катовер учёта OurVend», `:260-338`) — `{ key: "SNACK_CANCEL_WINDOW_HOURS", label: "Вендинг: окно самостоятельной отмены записи, часов", kind: "number", fallback: "24", help: "Сколько часов автор может сам отменить свою запись (заправку, пересчёт, кассу). Владелец (system.admin) отменяет без лимита. 24 ч — правило донора mydon-stock, у нас оно новое: если мешает — поднимай, а не обходи.", validate: inRange(1, 720) }`.
- **`actions.service.ts`**: запрос `snackRefills` (`121-131`) добирает `source: vendingRefill.source`; `ActionRow.kind` (`39-51`) получает `"vending_refill_cancelled"`; цикл `for (const r of snackRefills)` (`262-269`) ветвится: `r.source === "storno" ? "↩️ Отмена заправки автомата ${r.serial}: ${r.product} ×${Math.abs(r.qty)}" : "🍫 Заправка автомата ${r.serial}: ${r.product} ×${r.qty}"`; в `push(...)` четвёртый аргумент (kind) тоже становится условным: `r.source === "storno" ? "vending_refill_cancelled" : "vending_refill"`. `personIdOf` не трогается.
- **`core-client.ts` (бот) — проводка автора (Отклонение №9)**: `setVendingStock(items, personId?: string)` (`506-514`) добавляет `personId` в тело, только если задан; `recordVendingCash(receivedAmount, categories, createdBy?: string)` (`520-534`) добавляет `createdBy` в тело. `apps/bot/src/handler.ts`: в ветке `isCashPrefixed` (`227`) и `isStockCommand` (`554`) — ПЕРЕД вызовом `deps.core.recordVendingCash`/`setVendingStock` резолвить `const person = await deps.core.personByChat(String(chatId)).catch(() => null)`, передавать `"person" in person ? \`person:${person.id}\` : undefined` (cash) / `person && "id" in person ? person.id : undefined` (stock). Не найден — запись уходит без автора, как раньше (не ошибка).
- **`my-records.ts`** — ОДИН В ОДИН структура `coffee-fix.ts`, но три вида вместо одного: `KIND_CODE`/`CODE_KIND` `{refill:"r", stock_count:"s", cash:"k"}`, `callback_data` формат `mr:c:<r|s|k>:<uuid>` / `mr:keep` (тот же паттерн, что `fx:del:<r|c|s>:<uuid>` в `coffee-fix.ts:34`). `startMyRecords` зовёт `deps.core.myRecords(person.id)`, печатает список (не больше 15, свежие сверху; `stock_count`-строка — с числом позиций, не как двадцать отдельных); пустой список — третье состояние: «Записей пока нет — заправь, посчитай склад или запиши кассу, и они появятся здесь», а не «всё хорошо». `askCancel` показывает ОДНУ выбранную запись целиком и предлагает подтверждение ДВУМЯ кнопками в РАЗНЫХ рядах (`coffee-fix.ts:52-57`). `handleMyRecordsCallback` зовёт `deps.core.cancelVendingRecord(cb.entry, cb.id, person.id)`; ответ сервиса `too_old`/`not_yours` — тексты «Записи старше N часов отменяет владелец» (N — из ответа Core, не из константы бота) / «Отменять можно только свои записи»; успех для `stock_count` ДОПОЛНИТЕЛЬНО несёт «Пересчёт отменён и убран из истории. Текущий остаток склада он больше не задаёт — если остаток неверен, посчитай заново» (R-P6-10).
- **`menu.ts`** (после `fix`, `:144`): `{ id: "mine", label: "✏️ Мои записи", perm: "tasks.own", ready: true, match: isMyRecordsTrigger }`. «↩️ Ошибся — исправить» (кофе, DELETE) НЕ трогается и не сливается — разные контракты (R-P6-3).
- **Смоук** (`tools/smoke-core.mjs`): фискальная правка уже добавлена Task 3; здесь — три сценария сторно (`POST refills/cancel` → сумма `qty` по автомату = 0, склад вернулся; `POST stock-counts/cancel` → `GET stock-counts` не показывает ни оригинал, ни метку; `POST cash/cancel` → `GET cash` показывает обе строки, сумма журнала = 0) плюс `GET my-records` (не больше 15, отменённых нет). Счётчик сценариев в последней строке файла поднимается на число добавленных `assert`.

- [ ] **Step 1: Тесты RED — `record-cancel.service.test.ts`.** Стаб БД тем же приёмом, что у `tasks.test.ts` (см. Task 5 этого плана и `apps/core/src/tasks/tasks.test.ts` в дереве). Создать `apps/core/src/vending/record-cancel.service.test.ts`:
```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RecordCancelService } from "./record-cancel.service";

const ВЛАДЕЛЕЦ = { personId: "owner-1", ref: "person:owner-1" };
const АВТОР = { personId: "person-1", ref: "person:person-1" };
const МОМЕНТ = new Date("2026-08-26T10:00:00+05:00");

function stub(opts: {
  original: Record<string, unknown> | undefined;
  roles?: string[];
  inserted?: Record<string, unknown>[];
  groupRows?: Record<string, unknown>[];
  /** true — вставка сторно-строки конфликтует (повторная отмена): onConflictDoNothing().returning() отдаёт []. */
  conflictOnInsert?: boolean;
}) {
  const inserted = opts.inserted ?? [];
  let updateCalls = 0;
  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (opts.original ? [opts.original] : []),
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: (v: Record<string, unknown>) => {
        const row = { id: `s-${inserted.length}`, ...v };
        return {
          onConflictDoNothing: () => ({
            returning: async () => {
              if (opts.conflictOnInsert) return [];
              inserted.push(row);
              return [row];
            },
          }),
          returning: async () => {
            inserted.push(row);
            return [row];
          },
        };
      },
    }),
    update: () => ({
      set: () => ({
        where: () => ({
          returning: async () => {
            // Единственный UPDATE в ветке «заправка» — возврат товара на
            // склад (`vendingStock.onConflictDoUpdate`, тот же приём, что у
            // `RefillService.create`, `refill.service.ts:120-135`). Считаем
            // ЛЮБОЙ вызов — реализация не должна звать его при конфликте.
            updateCalls += 1;
            return [{}];
          },
        }),
      }),
    }),
  };
  return {
    db: {
      select: () => ({
        from: () => ({
          where: async () => (opts.groupRows ?? (opts.original ? [opts.original] : [])),
        }),
      }),
      transaction: async (cb: (t: typeof tx) => unknown) => cb(tx),
    } as never,
    inserted,
    updateCallCount: () => updateCalls,
  };
}

describe("Сторно заправки — дельта (R-P6-10)", () => {
  it("сторно-строка несёт противознак, склад возвращается", async () => {
    const { db, inserted } = stub({ original: { id: "r1", qty: 6, clientKey: "k1", createdBy: "person:person-1", createdAt: МОМЕНТ, machineSerial: "2508160376", productName: "Snickers 50gr" }, roles: ["operator"] });
    const s = new RecordCancelService(db);
    const res = await s.cancel("refill", "r1", АВТОР, МОМЕНТ);
    assert.equal(res.ok, true);
    assert.ok(inserted.some((r) => r.qty === -6 && r.reversesId === "r1" && r.source === "storno"));
  });

  it("повторная отмена безвредна: onConflictDoNothing по clientKey, склад не тронут дважды", async () => {
    const { db, inserted, updateCallCount } = stub({
      original: { id: "r1", qty: 6, clientKey: "k1", createdBy: "person:person-1", createdAt: МОМЕНТ, machineSerial: "2508160376", productName: "Snickers 50gr" },
      conflictOnInsert: true, // повтор: уникальный vending_refill_client_key уже занят сторно-строкой первого нажатия
    });
    const res = await new RecordCancelService(db).cancel("refill", "r1", АВТОР, МОМЕНТ);
    assert.equal(res.ok, true);
    assert.equal(res.ok && res.alreadyCancelled, true);
    assert.equal(res.ok && res.kind, "refill");
    assert.equal(inserted.length, 0, "конфликтная вставка не должна попасть в список «записанного»");
    assert.equal(updateCallCount(), 0, "склад второй раз не трогаем — первое нажатие уже вернуло товар");
  });
});

describe("Сторно пересчёта — метка на ВЕСЬ ввод (R-P6-11)", () => {
  it("qty копируется, а не меняет знак; обе строки (оригинал и метка) уходят из чтений", async () => {
    const original = { id: "c1", qty: "19.00", countedAt: МОМЕНТ, personId: "person-1", productName: "Кола 12", source: "own" };
    const group = [original, { id: "c2", qty: "5.00", countedAt: МОМЕНТ, personId: "person-1", productName: "Спрайт", source: "own" }];
    const { db, inserted } = stub({ original, groupRows: group });
    const res = await new RecordCancelService(db).cancel("stock_count", "c1", АВТОР, МОМЕНТ);
    assert.equal(res.ok, true);
    assert.equal(inserted.filter((r) => r.source === "storno").length, 2, "своя метка на КАЖДУЮ строку ввода");
    assert.ok(inserted.every((r) => "qty" in r ? String(r.qty) === "19.00" || String(r.qty) === "5.00" : true), "qty копируется, не отрицается");
  });
});

describe("Сторно кассы — противознак по суммам и статьям (R-P6-10)", () => {
  it("суммы и строки статей меняют знак", async () => {
    const original = {
      id: "cash1", receivedAmount: "2400000.00", totalSpent: "376300.00", remainder: "2023700.00",
      categories: [{ name: "базар", subtotal: 376300, lines: [{ label: "базар", amount: 376300 }] }],
      createdBy: "owner", createdAt: МОМЕНТ,
    };
    const { db, inserted } = stub({ original });
    const res = await new RecordCancelService(db).cancel("cash", "cash1", ВЛАДЕЛЕЦ, МОМЕНТ);
    assert.equal(res.ok, true);
    const сторно = inserted.find((r) => r.source === "storno");
    assert.equal(сторно!.receivedAmount, "-2400000.00");
  });
});

describe("Права доступа (R-P6-12)", () => {
  it("автор в пределах окна — можно; за окном — too_old с числом часов", async () => {
    const давно = new Date(МОМЕНТ.getTime() - 25 * 3600_000);
    const { db } = stub({ original: { id: "r1", qty: 6, createdBy: "person:person-1", createdAt: давно, clientKey: "k1" } });
    const res = await new RecordCancelService(db).cancel("refill", "r1", АВТОР, МОМЕНТ);
    assert.deepEqual(res, { ok: false, reason: "too_old", hours: 24 });
  });

  it("окно считается по created_at, а не по performed_at", async () => {
    // performedAt старый, createdAt свежий — отмена обязана пройти.
    const { db } = stub({ original: { id: "r1", qty: 6, createdBy: "person:person-1", createdAt: МОМЕНТ, clientKey: "k1", performedAt: new Date("2020-01-01") } });
    const res = await new RecordCancelService(db).cancel("refill", "r1", АВТОР, МОМЕНТ);
    assert.equal(res.ok, true);
  });

  it("чужая запись — not_yours", async () => {
    const { db } = stub({ original: { id: "r1", qty: 6, createdBy: "person:чужой", createdAt: МОМЕНТ, clientKey: "k1" } });
    const res = await new RecordCancelService(db).cancel("refill", "r1", АВТОР, МОМЕНТ);
    assert.deepEqual(res, { ok: false, reason: "not_yours" });
  });

  it("несуществующая запись — not_found", async () => {
    const { db } = stub({ original: undefined });
    const res = await new RecordCancelService(db).cancel("refill", "нет", АВТОР, МОМЕНТ);
    assert.deepEqual(res, { ok: false, reason: "not_found" });
  });
});
```
- [ ] **Step 2:** `pnpm --filter @mydon/db build && pnpm --filter core build && pnpm --filter core test` → RED (модуля нет).
- [ ] **Step 3: `RecordCancelService`.** Реализовать по «Interfaces (produces)» и списку веток выше; права — читать `person` по `actor.personId` (`db.select().from(person).where(eq(person.id, actor.personId)).limit(1)`), `can(row?.roles ?? [], "system.admin")`; окно — `readIntSetting(this.db, "SNACK_CANCEL_WINDOW_HOURS", 24)`.
- [ ] **Step 4:** `pnpm --filter core test` → GREEN на `record-cancel.service.test.ts`.
- [ ] **Step 5: Контроллер, сервис, правило, настройка.** Внести правки из «Поведение» выше в `vending.controller.ts` (+`vending.controller.test.ts`: «пустой `personId` — 400», «отмена без прав автора — 403 not_yours», «`MyRecordsDto.limit` вне 1..15 — 400»), `vending.service.ts` (`stockCounts()`, `cashSessions()`, `CashSessionRow`, `myRecords()`), `vending.module.ts` (добавить `RecordCancelService` в `providers`, рядом с `ProductFiscalService` из Task 3), `rules.ts` (правило `vending.record_cancelled`, без `when` — редкое событие по построению, владелец узнаёт о каждой), `config-spec.ts` (`SNACK_CANCEL_WINDOW_HOURS`, +`config-spec.test.ts`: «валидация принимает 1..720, отвергает 0 и 721»).
- [ ] **Step 6:** `pnpm --filter core build && pnpm --filter core test` → GREEN; `pnpm -s typecheck`.
- [ ] **Step 7: Лента «Действия».** Внести правку `actions.service.ts` (запрос + `push`) из «Поведение» выше. Дописать в `actions.service.test.ts`:
```ts
it("сторно-заправка подписана «Отмена заправки», а не заправкой на минус", () => {
  // вставить в фикстуру vendingRefill строку source='storno', qty=-6,
  // проверить label содержит "Отмена заправки" и НЕ содержит "×-6"
});
it("автор сторно-строки — тот, кто отменил (createdBy сторно-строки), а не автор оригинала", () => {
  // personId сторно-строки берётся из ЕЁ СОБСТВЕННОГО personId/createdBy —
  // RecordCancelService пишет created_by=actor.ref в сторно-строку заправки
  // (унаследовано от original через spread, затем перезаписано), не оригинала
});
```
- [ ] **Step 8:** `pnpm --filter core test` → GREEN.
- [ ] **Step 9: Бот — проводка автора.** Внести правку `core-client.ts` (`setVendingStock`/`recordVendingCash`) и `handler.ts` (резолв `person` в двух ветках) из «Поведение» выше. Дописать в `core-client.test.ts`: «`setVendingStock` шлёт `personId`, когда передан», «`recordVendingCash` шлёт `createdBy`, когда передан», «оба поля не попадают в тело, когда не переданы (обратная совместимость)».
- [ ] **Step 10:** `pnpm --filter bot build && pnpm --filter bot test` → GREEN.
- [ ] **Step 11: Бот — экран «Мои записи».** Создать `apps/bot/src/my-records.ts` и `apps/bot/src/my-records.test.ts` по «Interfaces (produces)» и «Поведение» выше, тестами:
```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isMyRecordsTrigger, parseMyRecordsCallback, startMyRecords, handleMyRecordsCallback } from "./my-records";

describe("Триггер и разбор callback", () => {
  it("«мои записи» ловится, «мои задачи» — нет", () => {
    assert.equal(isMyRecordsTrigger("мои записи"), true);
    assert.equal(isMyRecordsTrigger("Мои Записи"), true);
    assert.equal(isMyRecordsTrigger("мои задачи"), false);
  });
  it("callback_data чужого формата отвергнут разбором", () => {
    assert.equal(parseMyRecordsCallback("mr:c:x:00000000-0000-4000-8000-000000000000"), null);
    assert.equal(parseMyRecordsCallback("fx:del:r:00000000-0000-4000-8000-000000000000"), null, "чужой префикс — не наш формат");
  });
  it("подтверждение — две кнопки в разных рядах", async () => {
    const person = { id: "p1", name: "Т", role: null, tgUsername: null, tgChatId: "1", active: "1" } as never;
    const core = { myRecords: async () => [{ kind: "refill", id: "r1", createdAt: new Date().toISOString(), label: "🍫 Заправка …" }] } as never;
    const reply = await startMyRecords(person, { core });
    const rows = reply.keyboard && "inline_keyboard" in reply.keyboard ? reply.keyboard.inline_keyboard : [];
    assert.ok(rows.length >= 1);
  });
  it("пустой список — третье состояние, а не «всё хорошо»", async () => {
    const person = { id: "p1", name: "Т", role: null, tgUsername: null, tgChatId: "1", active: "1" } as never;
    const core = { myRecords: async () => [] } as never;
    const reply = await startMyRecords(person, { core });
    assert.match(reply.text, /записей пока нет/i);
  });
  it("отказ «старше N часов» называет число из ответа Core, а не константу", async () => {
    const person = { id: "p1", name: "Т", role: null, tgUsername: null, tgChatId: "1", active: "1" } as never;
    const core = { cancelVendingRecord: async () => { throw Object.assign(new Error(), { status: 403, body: { reason: "too_old", hours: 24 } }); } } as never;
    const res = await handleMyRecordsCallback({ kind: "cancel", entry: "refill", id: "r1" }, person, { core });
    assert.match(res.message ?? "", /24/);
  });
  it("успешная отмена пересчёта предупреждает про остаток склада", async () => {
    const person = { id: "p1", name: "Т", role: null, tgUsername: null, tgChatId: "1", active: "1" } as never;
    const core = { cancelVendingRecord: async () => ({ ok: true, kind: "stock_count", stornoId: "s1", label: "…", alreadyCancelled: false }) } as never;
    const res = await handleMyRecordsCallback({ kind: "cancel", entry: "stock_count", id: "c1" }, person, { core });
    assert.match(res.message ?? "", /остаток склада/i);
  });
});
```
`CoreClient.cancelVendingRecord`/`myRecords` (см. Step 9 клиент — добавляются здесь же в `core-client.ts`, метод `myRecords(personId): Promise<MyRecordRow[]>` → `GET /vending/my-records?person=<id>`, `cancelVendingRecord(kind, id, personId): Promise<CancelResult>` → `POST /vending/{refills|stock-counts|cash}/:id/cancel`, отказ `403` бросает исключение с `.status`/`.body` — тот же паттерн, что у существующих ошибок Core в `core-client.ts` (`class CoreError`/аналог, если уже есть — переиспользуется, не заводится второй).
- [ ] **Step 12: Меню и роутинг.** `menu.ts` — пункт `mine` из «Поведение» выше; `menu.test.ts`: «пункт „✏️ Мои записи“ доступен любому подключённому (`tasks.own` — базовое право)», «„↩️ Ошибся — исправить“ остался на месте». `staff.ts` — роутинг триггера/callback рядом с обработкой `isCoffeeFixTrigger`/`parseCoffeeFixCallback` (тот же приём подключения нового потока к общему циклу сотрудника, что у coffee-fix).
- [ ] **Step 13:** `pnpm --filter bot build && pnpm --filter bot test` → GREEN; `pnpm -s typecheck && pnpm -s lint`.
- [ ] **Step 14: История касс — подпись отмены.** `cash-intake.ts:formatCashSessions` (`113-123`) — ветка `source==="storno"`; `cash-intake.test.ts`: «сторно-касса подписана «↩️ Отмена», а не обычной записью».
- [ ] **Step 15: Смоук.** Дописать в `tools/smoke-core.mjs` четыре сценария из «Поведение» выше (три сторно + `my-records`), поднять счётчик сценариев в последней строке файла на добавленное число `assert`.
- [ ] **Step 16:** Полный прогон: `pnpm -s typecheck && pnpm -s lint && TURBO_FORCE=true pnpm -s test`; smoke на scratch-БД (`createdb → migrate.js → seed.js → seed-vending.js → backfill-product-ids.js → smoke-import.mjs → smoke-core.mjs → dropdb`).
- [ ] **Step 17:** `docs/PLAN_STOCK_ABSORPTION.md` §П6 — отметить закрытыми фискальный блок, журналы и «Мои записи» (EAV-конструктор и гранулярные права — решением R-P6-4, не оставлять открытыми).
- [ ] **Step 18:** `git commit -m "feat(core,bot): сторно снек-записей (заправка/пересчёт/касса) сторнирующей строкой, «Мои записи» в боте, проводка автора, подпись в ленте «Действия» (П6, R-P6-3/R-P6-10…R-P6-13)" -- apps/core/src/vending apps/core/src/rules apps/core/src/system/config-spec.ts apps/core/src/system/config-spec.test.ts apps/core/src/registry/actions.service.ts apps/core/src/registry/actions.service.test.ts apps/bot/src/my-records.ts apps/bot/src/my-records.test.ts apps/bot/src/menu.ts apps/bot/src/menu.test.ts apps/bot/src/staff.ts apps/bot/src/core-client.ts apps/bot/src/core-client.test.ts apps/bot/src/handler.ts apps/bot/src/cash-intake.ts apps/bot/src/cash-intake.test.ts packages/shared/src/vending-reports.ts tools/smoke-core.mjs docs/PLAN_STOCK_ABSORPTION.md`

---

## Выкатка и чек-лист

Адаптировано из §9 спеки под конвенцию этого плана «миграция — следующая свободная» (Global Constraints): везде ниже `<NNNN>` — число, вычисленное на шаге 1 задачи 1 и перепроверенное сторожем `migrations.test.ts` непосредственно перед мержем (П7 и «Инкассации» идут параллельно и могут занять соседний номер раньше).

1. Ветка `feat/p6-fiscal` уже существует и создана правильно (`git checkout -b` сразу после `main`, до какого-либо `git push`). Перед PR — `git merge origin/main` (или rebase, если история короче альтернативы) и повторный пересчёт `<NNNN>`, если номер занят.
2. PR → CI зелёный (lint, typecheck, build, test, smoke-цепочка) → финальное ревью ветки → adversarial-ревью ×4 (прод-данные read-only, безопасность, UX, конвенции/docs) → волна фиксов, если найдены → squash-мерж.
3. Дождаться деплоя и сверить, что выкачено ИМЕННО это: `GET /health` → `commit` совпадает с мержем (каталог обновляется за секунды, образ собирается минуты — [[feedback_deployed_vs_running]]).
   **Плановая запись в прод №1** — миграцию `<NNNN>` применяет автодеплой; сверить, что 52 карточки прайса получили `vat_pct = 12` и `package_code = '796'`, а `ikpu` у всех `NULL`.
4. **Плановая запись в прод №2 — разовый перенос.** Сначала примерка, потом запись; оба прогона через `docker exec -i` и оба с `</dev/null` в хвосте (без него остаток скрипта уходит в контейнер, и шаги после молча не выполняются — [[feedback_docker_compose_run_eats_stdin]], `docs/DEPLOY.md:121`):

   ```bash
   docker exec -i mydon-core node packages/db/dist/import-fiscal.js --dry-run </dev/null
   docker exec -i mydon-core node packages/db/dist/import-fiscal.js --apply   </dev/null
   ```

   Что читать в примерке ДО `--apply` (числа — из описи спеки, замер прода 26.08; расхождение значит, что донор изменился после сверки, и решать это данными, а не флагом):
   * строка режима говорит «ПРИМЕРКА» — если «ЗАПИСЬ», флаг набран неверно;
   * `conflict` (ИКПУ есть с обеих сторон и расходятся) — ожидание **7 строк** (5 «донор грубее», 1 `Lit Energy Blueberry` SKU-vs-SKU; восьмое пересечение совпало и в счёт не идёт);
   * `length_defect` — ожидание **1 строка**: `Coca-Cola ZeroS CAN 0.25`, `2202002001010032`, 16 цифр;
   * `unresolvedDonorNames` — ожидание **22 строки** (14 слитых дублей `… [слит→N]`, 2 служебные, 6 живых напитков под другой формулировкой + `Moxito Mango CAN 0.45`);
   * `category` — ожидание порядка **24 донорских строк** (10 разных кодов, подписанных «(категория)»);
   * `marked` — ожидание до **27** карточек;
   * `ikpu` (написанных) — число из отчёта. Нижняя граница, которую можно назвать заранее: **не меньше 11** карточек, о которых реестр не знает вовсе и у которых донор несёт SKU-код (верхняя граница донорского вклада — 20 SKU-строк; сколько из них резолвится, показывает только примерка — см. «Открытые вопросы» ниже);
   * `packSizeMismatches` — ожидание **9 пар, 5 расхождений**; скрипт их НЕ пишет, только печатает.

   Повторный `--apply` обязан дать нули по всем трём счётчикам `written` (`ikpu`/`barcode`/`marked`) — это и есть доказательство идемпотентности.
5. Проверка витрин:
   * `GET /vending/products` — у карточек есть блок `fiscal` (Task 3);
   * панель «VendHub → Правила закупа» — чип «чек соберётся»/«дыр: N», правка фискального блока сохраняется, ошибка Core не стирает ввод (Task 4);
   * бот: «карточка Snickers 50gr» → карточка с фискальным блоком (Task 5);
   * бот: «мои записи» → список; отмена заправки → в «Действиях» (`/team/actions`) строка «↩️ Отмена заправки…», в `/audit` — `vending.refill.cancel` с before/after (Task 7);
   * `/audit` с фильтром `action` = `vending.product.set_fiscal` — правки видны.
6. Действия ВЛАДЕЛЬЦА (кодом не делаются):
   * **6 алиасов напитков** — завести в `vending_alias`, чтобы донорские строки нашли карточку: `Flash Bubble Gum CAN 0.45` → `Flash Up Bubble Gum CAN 0,45`; `Flash CAN 0.45` → `Flash Up Energy CAN 0,45`; `Flash Mojito CAN 0.45` → `Flash Up Mojito Straw CAN 0,45`; `Laimon Berries CAN 0.33` → `Laimon Fresh Berries CAN 0,33`; `Laimon Mango CAN 0.33` → `Laimon Fresh Mango CAN 0,33`; `Lit Energy Mango CAN 0.45` → `Lit Energy Mango Coco CAN 0,45`. После них перенос можно прогнать повторно — он идемпотентен (нули по written, новые — по вновь резолвящимся именам).
   * **`Moxito Mango CAN 0.45` ↔ `Moxito Fresh Mango CAN 0,5`** — объём не сходится (0,45 против 0,5). Один товар или два? Кодом не решается.
   * **`Lit Energy Blueberry CAN 0,45`** — наш `02202003001086002` против донорского `02202003001086003`: оба SKU-уровня, верен один.
   * **`Coca-Cola ZeroS CAN 0.25`** — наш код `2202002001010032` короче на цифру; вернуть ведущий ноль (или взять код заново из Multikassa).
   * **9 значений «Блок, шт»** — сверить с нашим `pack_size` (5 расходятся, печатает `import-fiscal.js --dry-run`) и поправить командой бота «блок <товар> <N>», если наши числа устарели.
   * **Роль `owner`** — если она до сих пор не проставлена ни у кого (`person.roles`; предупреждение `docs/PLAN_STOCK_ABSORPTION.md:330-337`), отмена «без лимита» (R-P6-12) не сработает ни у кого, включая владельца, а в handler.ts (Отклонение №9) `personByChat` для владельца тоже резолвится только при наличии карточки `person`.
7. Отложенная проверка: в первый же брифинг после правок посмотреть, что `vending.product_fiscal_changed` и `vending.record_cancelled` доходят заметками, а не копятся немыми строками в журнале событий.
8. Память и план: `docs/PLAN_STOCK_ABSORPTION.md` §П6 (Task 7, шаг 17) — отметить закрытыми фискальный блок, журналы и «Мои записи»; EAV-конструктор и гранулярные права закрыть решением R-P6-4 (потребности нет), а не оставлять открытыми пунктами.

---

## Самопроверка плана

### 1. Покрытие спеки

| Раздел спеки | Кто закрывает |
|---|---|
| §1 Цель (7 вопросов владельца) | Все семь задач: вопрос 1–4 → Task 1–5, вопрос 5 → Task 6, вопрос 6–7 → Task 7 |
| §2 Инвентаризация | Фон для рулингов, отдельной задачи не требует |
| §3 R-P6-1…R-P6-4 | Приняты контроллером ДО этого плана (см. спеку §3 и `.superpowers/sdd/2026-08-26-sloy-p6-fiscal/progress.md`); реализация — в R-P6-5 и далее |
| §3 R-P6-5 (шесть колонок, единственный писатель) | Task 1 (схема) + Task 3 (`ProductFiscalService`) |
| §3 R-P6-6 (CHECK в SQL, словарь в коде) | Task 1 (CHECK'и) + Task 2 (`VAT_RATES`/`PACKAGE_CODES`/`MARKING`, DTO `@IsIn`) |
| §3 R-P6-7 (`package_code` = ОКЕИ, не Multikassa) | Task 2 (словарь + докблок) + Task 4 (подпись формы) + Task 6 (`attrs["упаковка"]` НЕ читается вовсе — структурно, не условием) |
| §3 R-P6-8 (НДС 12 по умолчанию) | Task 1 (`DEFAULT 12`) + Task 6 (`vat_pct` не трогает никогда) |
| §3 R-P6-9 (категорийность решает справочник донора) | Task 2 (`classifyIkpu`) + Task 6 (использует его, `category`/`unknown_ikpu`) |
| §3 R-P6-10 (три формы сторно) | Task 1 (структурные ограничения — CHECK на `qty`, частичные индексы) + Task 7 (три ветки `RecordCancelService`) |
| §3 R-P6-11 (единица отмены пересчёта — ввод) | Task 7 (`stockCounts()`/`myRecords()` группируют по `(source, countedAt, personId)`, отмена — весь ввод) |
| §3 R-P6-12 (окно 24 ч по `created_at`, `system.admin` — без лимита) | Task 7 (`RecordCancelService`, настройка `SNACK_CANCEL_WINDOW_HOURS`) |
| §3 R-P6-13 (отмену видно в «Действиях» и `/audit`) | Task 7 (`actions.service.ts`, `auditLog` во всех трёх ветках) |
| §3 R-P6-14 (перенос пишет три поля, не затирает непустое) | Task 6 (полностью) |
| §4 Общие ограничения | Раздел «Global Constraints» этого плана |
| §5 Задачи 1–7 | Task 1–7 этого плана 1:1 |
| §6 Данные и миграции | Task 1 (миграция) + Task 7 (новая настройка) |
| §7 События и правила | Task 3 (`vending.product_fiscal_changed`) + Task 7 (`vending.record_cancelled`) |
| §8 Тесты (все подпункты) | Распределены по Step 1 каждой задачи — см. списки тестов внутри Task 1–7 |
| §9 Выкатка | Раздел «Выкатка и чек-лист» этого плана |
| §10 Вне охвата | Сверено построчно (14 пунктов) — ни одна задача 6–7 их не затрагивает: нет EAV, нет второго справочного механизма, нет `deletions_log` отдельной таблицей, нет approval-гейта на отмену, нет переноса категорийных ИКПУ, нет данных МХИК, нет переноса `pack_size`, нет каталожного идентификатора Multikassa в `package_code`, нет правки фискальных полей из бота, нет отмены приёмки накладной/строк `purchase`, нет пересчётов/касс в ленте «Действия», нет списка «Мои записи» в панели, нет слияния с кофейным «Ошибся — исправить», нет полного переноса `VendingProductRow` в shared, нет read-token |
| §11 Открытые вопросы | Перенесены дословно в раздел «Открытые вопросы» ниже — не решены здесь и не выдуманы |

### 2. Скан плейсхолдеров

Прогнан по всему тексту, добавленному этим дописыванием (Task 6, Task 7, «Выкатка», «Отклонения» пп. 8–9): `TBD`/`TODO`/«добавить обработку»/«аналогично Task N» — ноль совпадений. Один настоящий дефект найден и исправлен ДО публикации: тест «повторная отмена безвредна» в Step 1 задачи 7 был пустым телом с комментарием вместо `assert` — переписан на стаб с `conflictOnInsert` и реальными проверками (`alreadyCancelled: true`, ноль новых insert, ноль update). Других пустых тел не найдено.

### 3. Согласованность типов

- `CancelResult`/`CancelActor`/`CancelKind` в Task 7 — дословно те же поля и литералы объединений, что в спеке `:868-897`, без переименований.
- `ProductFiscal`/`normalizeFiscalInput`/`classifyIkpu` в Task 6 импортируются из Task 2 (`packages/shared/src/fiscal.ts`), не переобъявляются — `planFiscalImport` использует `productIndex`/`ReturnType<typeof import("@mydon/shared").productIndex>`, ту же дверь, что Task 1/Task 3 нигде не трогают.
- `MyRecordRow` (Task 7, `vending.service.ts`) и возврат `CoreClient.myRecords()` (Task 7, `core-client.ts`) совпадают по полям (`kind`/`id`/`createdAt`/`label`) — новый тип, конфликта имён в дереве нет (проверено: `grep -rn "MyRecordRow" apps/ packages/` на момент дописывания даёт ноль совпадений).
- `StockCountRow.id` (Task 7) — аддитивное поле к типу, который уже читают панель (`apps/cc/src/lib/core.ts:162`) и Task 4/Task 5 этого плана; ни одна из более ранних задач не деструктурирует `StockCountRow` по фиксированному списку полей (проверено по тексту Task 3–5 выше), так что добавление поля их не ломает.
- `CashSessionRow.source` (Task 7) — аддитивное поле к Core-локальному типу (`vending.service.ts:326`, не в `@mydon/shared`); бот получает его через `VendingCashSession` (`core-client.ts:137`), которую Task 7 правит тем же шагом — рассинхронизации между Core-ответом и типом бота не остаётся.
- SQL-группировка `stock_count` по вводу в `myRecords()` дописана целиком (CTE `with groups as (...)`, приём `db.execute(sql\`...\`)` по образцу `ourvend-parity.service.ts:411-418`) — при первом дописывании плана она оставалась словесной, это закрыто до публикации.

### 4. Матрица пересечений (файл × задача)

Только файлы, которые трогает БОЛЬШЕ ОДНОЙ задачи — полный список по каждой задаче см. «Карта файлов» выше. Пусто — задача файл не трогает.

| Файл | T1 | T2 | T3 | T4 | T5 | T6 | T7 |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `packages/db/src/schema.ts` | ✅ | | | | | | |
| `packages/shared/src/index.ts` | | ✅ | | | | | |
| `packages/shared/src/fiscal.ts` | | ✅ | | | | (импорт) | |
| `apps/core/src/vending/vending.controller.ts` | | | ✅ | | | | ✅ |
| `apps/core/src/vending/vending.controller.test.ts` | | | ✅ | | | | ✅ |
| `apps/core/src/vending/vending.service.ts` | | | ✅ | | | | ✅ |
| `apps/core/src/vending/vending.module.ts` | | | ✅ | | | | ✅ |
| `apps/core/src/rules/rules.ts` | | | ✅ | | | | ✅ |
| `apps/core/src/rules/rules.test.ts` | | | ✅ | | | | ✅ |
| `tools/smoke-core.mjs` | | | ✅ | | | | ✅ |
| `apps/cc/src/lib/core.ts` (+`core-types.test.ts`) | | | (читает `fiscal`) | ✅ | | | |
| `apps/bot/src/core-client.ts` (+test) | | | | | ✅ | | ✅ |
| `apps/bot/src/handler.ts` | | | | | ✅ | | ✅ |
| `packages/db/package.json` | | | | | | ✅ | |
| `docs/DEPLOY.md` | | | | | | ✅ | |
| `docs/DATA_SOURCES.md` | | | ✅ | | | | |
| `docs/PLAN_STOCK_ABSORPTION.md` | | | | | | | ✅ |

**Волна 1 (T1 ∥ T2):** пересечение по таблице — ноль общих файлов (`schema.ts`/`schema.test.ts`/`migrations.test.ts`/`drizzle/*` против `fiscal.ts`/`fiscal.test.ts`/`index.ts`). Подтверждено.

**Волна 2 (T3 ∥ T6):** пересечение по таблице — ноль общих файлов (`vending.*`/`rules.*`/`docs/DATA_SOURCES.md` против `import-fiscal.*`/`package.json`/`docs/DEPLOY.md`). Общая ЗАВИСИМОСТЬ у обеих — Task 2 (`fiscal.ts`), но она из волны 1 и уже закрыта до начала волны 2. Подтверждено.

**Волна 3 (T4 ∥ T7):** пересечение по таблице — ноль общих файлов (`apps/cc/**` против `apps/core/src/vending/**`+`apps/core/src/rules/**`+`apps/core/src/system/config-spec.ts`+`apps/core/src/registry/actions.service.ts`+`apps/bot/**`+`tools/smoke-core.mjs`+`docs/PLAN_STOCK_ABSORPTION.md`). Подтверждено. Оба читают тип `ProductFiscal`/`fiscal: ...` в ответе `products()`, но это ЧТЕНИЕ уже готового поля из Task 3 (волна 2), не гонка за один и тот же файл.

**T3 и T7 НЕ параллельны (уже зафиксировано в плане выше, здесь — подтверждение по матрице):** шесть общих файлов (`vending.controller.ts`(+test), `vending.service.ts`, `vending.module.ts`, `rules.ts`(+test), `tools/smoke-core.mjs`) — таблица выше показывает их явно. Порядок T3 → T7 обязателен.

**Волна 4 (T5, после T7):** таблица показывает ДВА общих файла с T7, а не один, как называет вводный абзац «Параллельность и порядок» (там назван только `core-client.ts`/`core-client.test.ts`) — `handler.ts` тоже общий (T5 правит роутинг «карточка <товар>», T7 этого плана правит роутинг резолва `personId` в ветках `isCashPrefixed`/`isStockCommand`, Отклонение №9). Это НЕ противоречие: оба общих файла указывают на ОДИН И ТОТ ЖЕ вывод (T5 после T7), просто причин для него две, а не одна — вводный абзац стоит читать с этим уточнением, отдельно его не правим (правка чужого текста вне охвата этого дописывания).

## Открытые вопросы

Ровно один вопрос спеки (§11) остаётся открытым и после этого дописывания — он и не может быть закрыт кодом, только отчётом примерки:

**Сколько именно карточек прайса получит `ikpu` из донора при `--apply`.** Опись даёт границы (20 SKU-строк у донора; 37 донорских строк с ИКПУ резолвятся в 37 карточек; не меньше 11 SKU-кодов закрывают карточки, о которых реестр не знает вовсе), но пересечение «SKU ∧ резолвится» она не измеряла. `import-fiscal.js --dry-run` обязан его напечатать (Task 6, отчёт) — назвать число заранее значило бы выдумать данные, а срез именно против этого построен (R-P6-2).

Технический вопрос, найденный при первом дописывании (точная SQL-группировка `stock_count` по вводу для `myRecords()`), закрыт до публикации — CTE выписан целиком в «Поведение» Task 7 (см. «Согласованность типов» п. 3 выше).

Решения, которые ждут ВЛАДЕЛЬЦА (6 алиасов, `Moxito Mango`, конфликт `Lit Energy Blueberry`, дефект `Coca-Cola ZeroS`, 9 значений «Блок, шт», роль `owner`) — открытыми вопросами СРЕЗА не являются: код для них готов, они перечислены шагом 6 «Выкатки», и ни один не блокирует мерж (см. спеку §11, дословно то же решение).
