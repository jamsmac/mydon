# Хвосты снек-контура — дизайн (8 задач поверх П8b)

Дата: 2026-08-26. Срез добирает хвосты четырёх предыдущих (П4 · П5a · П5b · П8a):
мёртвые поверхности (Core считает — никто не показывает), зеркала типов, не
доведённые до `@mydon/shared`, и три недоделки, которые сами срезы записали в
бэклог. Опись (SELECT-only, ничего не правилось):
`.superpowers/sdd/2026-08-26-hvosty-snek/inventory.md`.

**Зависимость:** задачи 7 и 8 строятся поверх **П8b** (`RetentionService`,
`sync-runs.ts`, `parity-streak.ts`, три новых поля `OurvendHealth`). Срез
реализуется ПОСЛЕ мержа П8b в `main`; база ветки — `origin/main` **c860a1c**
(П8a, #215).

## 1. Цель

Один вопрос владельца на задачу — и на каждый сегодня нет ответа:

| # | Вопрос владельца | Почему ответа нет |
|---|---|---|
| 1 | «Сколько было на складе в июне?» | 460 импортированных инвентаризаций видны только через `curl`: `GET /vending/stock-counts` есть, потребителя нет ни в панели, ни в боте |
| 2 | «Почему сумма из панели не находится поиском?» | снек-листы печатают числа с U+00A0 рядом с числами без него |
| 3 | «Я завёл 11 карточек — где мои строки?» | бэкфилл `product_id` обходит `vending_stock`/`machine_slot` и не доходит до `vending_refill`/`vending_stock_count` |
| 4 | «Что детектор насчитал по этому автомату?» | клиент `vendingRefillEvents` в панели написан и не вызывается ни разу |
| 5 | «Не разъехались ли формы отчётов?» | `Shrink*` и `VendingPlan*` живут тремя рукописными копиями; переименование поля компилятор не поймает |
| 6 | «Почему повторный smoke роняет детектор?» | у `detect`/`list` нет впрыскиваемых часов, фикстуры зависят от стенных |
| 7 | «Что чистит `vending_stock_count`?» | ничего; таблица растёт ежедневным `ingestStock` плюс 460 импортированных строк |
| 8 | «Была ли авария на ТОЙ неделе?» | блок здоровья в понедельничном письме подписан неделей, а числа берёт на момент отправки |

## 2. Инвентаризация (проверено в коде рабочего дерева и ветки П8b)

### Что уже есть и переиспользуется

| Факт | Где |
|---|---|
| `GET /vending/stock-counts` + троттл `burst/sustained` 12/мин | `apps/core/src/vending/vending.controller.ts:591` |
| `stockCounts(days = 90, product?, now = new Date())`, потолки `730` / `2000` строк | `apps/core/src/vending/vending.service.ts:1658`, константы `:135`, `:144`, `:150` |
| Контракт `StockCountRow` / `StockCountsReport` (в ответе НЕТ `note`) | `packages/shared/src/vending-reports.ts:985`, `:996` |
| `StockCountsDto` с `@Max(730)` и гашением пустой строки | `apps/core/src/vending/vending.controller.ts:357` |
| Коды предупреждений `history_capped` и `stock_missing` уже в союзе | `packages/shared/src/vending-reports.ts:847-856` |
| Колонка `vending_stock_count.note` в схеме есть | `packages/db/src/schema.ts:1588` |
| `note` у СВОИХ строк = **кто считал** (`note: actor`) | `apps/core/src/vending/vending.service.ts:1526` |
| `note` у ИМПОРТИРОВАННЫХ строк = **место** (R-FW-P2) | `packages/db/src/import-stock-history.ts:310` |
| Клиент `vendingRefillEvents(days = 14)` — 0 вызовов вне `lib/core.ts` | `apps/cc/src/lib/core.ts:2401`, тип `VendingRefillEvent` `:341` |
| `RefillEventRow` в Core — та же форма | `apps/core/src/vending/refill-events.service.ts:61` |
| `detect(days = 2)` со стенными часами внутри | `apps/core/src/vending/refill-events.service.ts:111`, `const сейчас = new Date()` `:113` |
| `list(days = 14)` с `Date.now()` внутри, зажат `DETECT_DAYS_MAX = 30` | там же `:391`, `:392-393`; `LIST_LIMIT = 500` `:25` |
| `RefillEventsListDto` с `@Max(30)` | `apps/core/src/vending/vending.controller.ts:431` |
| `money()` возвращает сырой `toLocaleString("ru-RU")` (U+00A0), `count()`/`amount()` NBSP срезают | `apps/cc/src/lib/format.ts:15-19`, `:58`, `:63` |
| `бэкфиллWhere()` = `and(eq(name), isNull(id))`, `backfillProductIds()` обходит ДВЕ таблицы | `packages/db/src/backfill-product-ids.ts:75`, `:120` |
| Скрипт бэкфилла в CI против настоящего Postgres | `.github/workflows/ci.yml:82` |
| Образец флагов `--dry-run` / `--apply` и отказа при их совмещении | `packages/db/src/import-stock-history.ts:662-665` |
| `Shrink*` в Core: `ShrinkRefillDay`…`ShrinkReport` | `apps/core/src/vending/shrinkage.service.ts:83-127` |
| `ShrinkItem` / `ShrinkSummary` УЖЕ в shared | `packages/shared/src/vending-field.ts:171`, `:184` |
| Копия `Shrink*` + `VendingPlan*` в боте | `apps/bot/src/core-client.ts:274-341`, `:204-263` |
| Копия в панели, под другими именами и с инлайненным `summary` | `apps/cc/src/lib/core.ts:227-306`, `:159-224` |
| План закупа в Core зовётся иначе: `PlanMachine` / `PlanWarning` / `PurchasePlan` | `apps/core/src/vending/vending.service.ts:499`, `:512`, `:531` |
| `SlotPlanRow` (поле-в-поле = `VendingPlanSlot`) и `PurchaseSummary` уже в shared | `packages/shared/src/vending-plan.ts:116`, `packages/shared/src/vending-calc.ts:239` |
| Образец реэкспорта и компиляторных сверок | `apps/cc/src/lib/core.ts:308-334`, `apps/cc/src/lib/core-types.test.ts`, `apps/bot/src/core-client.test.ts:95-115` |
| `WeeklyDigest` в боте — уже реэкспорт из shared | `apps/bot/src/core-client.ts:399-410` |
| Группа `reports` навигации, лист «Приход» | `apps/cc/src/lib/domain-nav.ts:97`, `:123` |
| `TABLE_BACKED_LEAVES` + `isTableBackedLeaf` | `apps/cc/src/lib/domain-nav.ts:236`, `:277` |
| Образец листа-отчёта целиком (окно, пустое состояние, `ReportWarnings`) | `apps/cc/src/components/dead-stock-view.tsx` |
| `ReportWindow` (переключатель `?days=`) | `apps/cc/src/components/report-window.tsx` |
| `ReportWarnings` + списки `COVERED_BY_*` | `apps/cc/src/components/report-warnings.tsx` |
| Разбор `?days=` и «список исключений» листьев в странице | `apps/cc/src/app/domain/[domain]/page.tsx:691`, `:699`, `:2490-2523` |

### Что приезжает из П8b (читалось только как `git diff origin/main...HEAD`)

| Факт | Где в `mydon-p8b` |
|---|---|
| `RetentionService` с четырьмя целями, пачками по 5000, бюджетом 60 с, событием `system.retention`, кроном `10 4 * * 0` | `apps/core/src/vending/retention.service.ts` |
| `RetentionTarget` = `{ table, name, idCol, ageCol, olderThanDays }`, `batchQuery()` | там же |
| Пол окна ретенции у снимков — 180 (`atLeast(180, …)`) | `apps/core/src/system/config-spec.ts:313-321`, валидатор `:81` |
| Индексы времени под ретенцию (миграция 0070), объяснение «почему НЕ CONCURRENTLY» | `packages/db/drizzle/0070_retention_time_idx.sql` |
| `lastSuccessRunAt(db)`, `lastRunStatus(db)`, `rawStaleHours()`, `syncStaleThreshold()`, `cutoverThreshold()` | `apps/core/src/ourvend/sync-runs.ts` |
| `parityStreak(events, threshold, today)` → `ParityStreak { greenDays, threshold, readyForCutover, days: ParityDay[], lastRed, since }`, окно показа 14 | `packages/shared/src/parity-streak.ts` |
| `ParityDay { date, ok, salesChecked, stockChecked, note }` | там же |
| `OurvendHealth` + `snapshotStale` / `parityStreak` / `cutoverThreshold` | `packages/shared/src/vending-reports.ts:912-972` |
| `WeeklyDigestService.digest(week?, now)`, ключ кеша `weekly-digest|<неделя>|<ташкентские сутки>`, `ЗДОРОВЬЕ_НЕИЗВЕСТНО`, `здоровьеСбора(now)` | `apps/core/src/vending/weekly-digest.service.ts` |
| `WeeklyDigest.health: OurvendHealth` (панель этот тип НЕ читает — потребитель один, бот) | `packages/shared/src/vending-reports.ts:1126-1160` |
| Блок здоровья в письме: `здоровье(h)`, `строкаЗастоя`, `строкаСнапшота`, `строкаСерии` | `apps/bot/src/weekly-digest.ts:245-262` |
| `failedStreak(runs)` + `STREAK_SCAN_LIMIT = 200` | `apps/core/src/vending/sync-streak.ts` |
| Последняя миграция — **0070** | `packages/db/drizzle/` |

## 3. Рулинги

### R-H-1 Охват — ровно восемь задач описи, в её порядке

**Решение.** В срез входят задачи 1–8 из §4 описи и ничего больше. Явно вне:
пачечная вставка в детекторе (O9), уникальный индекс дедупа сторожа для
мультиреплики (O10), read-token для денежных GET (O11) — последний уходит в
П8 п. 3–5 вместе с гашением `STOCK_DATABASE_URL` и выводом панели `:8080`.
Всё, что требует решения владельца (пороги по автоматам, заведение 11 карточек,
подписки на рассылку), — не задача среза.

**Почему.** Три предыдущих среза закрыли 24 пункта ревью волнами фиксов; хвост,
который остался, — это ровно восемь дешёвых работ с видимой ценностью. O9 —
оптимизация без сегодняшнего симптома (детектор получил
`CORE_INGEST_TIMEOUT_MS = 60_000`), а трогать идемпотентность
`unique(machine_serial, window_to)` ради неё дороже пользы. O10 стоит ноль при
одной реплике Core (R-FW-S7 это уже принял). O11 — размер L: Core, панель, бот,
агенты, `.env.example`, оба `docker-compose`, `docs/DEPLOY.md`, — и повторяет
урок SERVICE_TOKEN-катовера про «токен в `.env` БЕЗ рестарта, потом мёрж».

**Чем платим, если ошиблись.** Взяв O11 сюда, получаем срез, который нельзя
выкатить одним PR без окна простоя записи; взяв O9 — риск сломать дедуп
детектора там, где сегодня ничего не болит. Оставив всё восемь как есть — тот
же список хвостов уезжает в четвёртый срез подряд.

### R-H-2 Лист «История склада» переиспользует существующий роут

**Решение.** Лист зовёт `GET /vending/stock-counts?days=` (потолок 730, дефолт
90) — нового эндпоинта нет. Строки группируются по суткам `dt` (свежие сверху),
внутри суток — по `note`. Русские заголовки, честное пустое состояние.
Единственное изменение Core — **аддитивное поле `note: string | null` в
`StockCountRow`**: колонка в базе есть (`schema.ts:1588`), но в ответ не
попадает, и без неё группировать не по чему. Это добавление поля, а не новый
эндпоинт и не новый фильтр (`?product=` уже есть и лист им пользуется).

**Почему.** Ответы API аддитивны — новое поле не ломает ни одно зеркало
(конвенция репозитория, проверена реэкспортами П5b). Второй роут ради одной
колонки завёл бы вторую реализацию окна, кеша и троттла; первый же расчёт
разошёлся бы с этим.

**Отдельно — про `note`.** Оно означает РАЗНОЕ у разных источников:
у `source = 'own'` это **кто считал** (`vending.service.ts:1526`, `note: actor`),
у `source = 'stock-import'` — **место донора** («1 Склад (основной)»,
«2 Холодильник», «3 Oq apparat (склад)», `import-stock-history.ts:310`,
R-FW-P2). Лист обязан подписывать группу по `source`, а не звать всё «местом»:
иначе имя оператора встанет в заголовок как склад.

**Чем платим, если ошиблись.** Свой эндпоинт — второй потолок окна, который
однажды разойдётся с `STOCK_COUNTS_DAYS_MAX` и молча обрежет историю (ровно
дефект, который чинил R-FW-P3). Единый заголовок «место» — владелец читает
«Рустам» как название склада и заводит его в справочник.

### R-H-3 Числа снек-листов — без U+00A0

**Решение.** `money()` (`format.ts:15`) ОСТАЁТСЯ с неразрывным пробелом и
получает докблок, который перечисляет, кто её ещё зовёт и почему. Снек-листы
переводятся на `count()` (число) и `amount()` (сумма с «сум»), локальные копии
форматтеров в них удаляются. Тесты утверждают БАЙТ: символа U+00A0 в выводе снек-листа
отсутствует, а в `money()` — присутствует.

**Список к правке (проверен в дереве):**

| Файл | Что заменить |
|---|---|
| `apps/cc/src/components/shrinkage-view.tsx` | `money()` на `:100`, `:101`, `:160`, `:164`, `:244` → `amount()`; локальная `n` (`:21`) → `count` |
| `apps/cc/src/components/purchase-plan-view.tsx` | локальная `n` (`:11`, сырой `toLocaleString`) → `count`; денежные места `:75`, `:170` → `amount`/`count` |
| `apps/cc/src/components/sales-view.tsx` | локальная `money` (`:4`) → `count` (лист печатает «сум» своим `<span class="u">`) на `:50`, `:51`, `:55`, `:56`, `:60`, `:61`, `:125` |
| `apps/cc/src/components/supply-views.tsx` | локальная `money` (`:5-6`) → `count` с сохранением ветки `null → "—"`; `:93`, `:116` |
| `apps/cc/src/components/vending-panel.tsx` | локальная `sum` (`:240`) и голые `toLocaleString` на `:254`, `:271`, `:393`, `:418` → `count` |

Уже чистые (`amount`/`count`): `margin-view.tsx`, `dead-stock-view.tsx`,
`vending-prices-view.tsx`.

**Вне списка, с причиной:** `stock-panel.tsx:21-22` — это карточка ингредиента
(`/card/[id]`, контур сырья), не снек-лист; `all-sales-view.tsx:4-9` и
`prices-view.tsx:13` живут внутри «По источникам» (`sources-view.tsx`) — смешанный
контур, своя развёртка. Опись называла `stock-panel.tsx`; строки там верные,
но лист не снековый, и тянуть его сюда значит расширять охват без вопроса
владельца.

**Почему `money()` не трогаем.** Её зовут **42 раза** по всей панели (опись
называла 37 — пересчитано в дереве), в том числе в GLOBERENT и финансах, где
NBSP уместен: там число не копируют в бота. Правка `money()` — это правка
сорока двух мест разом в срезе, где никто их не смотрит.

**Чем платим, если ошиблись.** Сегодня скопированная из панели сумма молча не
находится ни поиском по странице, ни в боте — тот самый баг, которым файл
объясняет существование `count()`/`amount()` (`format.ts:50-57`). Правкой
`money()` вместо листов — тихая перерисовка сорока двух чужих мест без единого
теста под ними.

### R-H-4 Бэкфилл `product_id` дотягивается до заливок и инвентаризаций

**Решение.** Расширяется СУЩЕСТВУЮЩИЙ скрипт
`packages/db/src/backfill-product-ids.ts` → `packages/db/dist/backfill-product-ids.js`
(в описи и в задании он назван `packages/db/scripts/backfill-product-ids.js` —
каталога `packages/db/scripts/` в репозитории нет, запуск идёт через `dist`,
`.github/workflows/ci.yml:82` и `package.json` → `db:backfill:product-ids`).
Цепочка резолва (после волны фиксов, S3 — см. §13): точное каноническое
имя карточки главнее алиаса, ровно тот же `productIndex` из `@mydon/shared`.
`ourvend_name` в бэкфилле НЕ участвует — такой колонки в MYDON нет, это поле
схемы донора mydon-stock, доступное только импорту при прямом подключении к
донору (историческая формулировка этого абзаца — «алиас → ourvend_name →
имя» — была неточной уже на момент написания). Добавляются две цели: `vending_refill`
(`product_name` + `product_id`, `schema.ts:1693`) и `vending_stock_count`
(`schema.ts:1576`). Идемпотентность — прежняя `бэкфиллWhere` (`isNull`).
Флаги `--dry-run` (считает и печатает, ничего не пишет) и `--apply`. Имена, для
которых карточки нет, печатаются списком и остаются `NULL`.

**Прогон на проде — ЕДИНСТВЕННАЯ запланированная запись среза** (шаг 4 выкатки).

**Про умолчание без флагов.** Голый запуск остаётся ЗАПИСЬЮ, как сегодня:
`ci.yml:82` вызывает скрипт без аргументов, и весь смысл того шага — исполнить
настоящий `UPDATE` против настоящего Postgres (сценарий N2). `--apply` —
явный синоним умолчания; `--dry-run` вместе с `--apply` — отказ с текстом, как
в `import-stock-history.ts:665`.

**Почему.** Импорт истории честно назвал владельцу 11 неопознанных имён
(`import-stock-history.ts:624-628`), но когда владелец заведёт карточки,
привязать 15 импортированных строк нечем — повторный прогон бэкфилла их просто
не видит. Петля «скрипт назвал проблему → владелец починил → система
подхватила» разомкнута ровно в последнем звене.

**Чем платим, если ошиблись.** Своя копия резолва (например, в миграции)
разойдётся с Core на первом же новом алиасе — это уже записано в шапке скрипта
и подтверждено правкой П8a (`productIndex` вынесен в shared именно за это).
Дефолт `--dry-run` — зелёный шаг CI, который ничего не проверяет.

### R-H-5 Журнал детектора — лист рядом со снек-отчётами

**Решение.** Новый лист «Журнал заливок» (`type: "refill_events"`) в группе
`reports`, сразу за «Усушкой». Клиент — СУЩЕСТВУЮЩИЙ
`core.vendingRefillEvents(days)` (`apps/cc/src/lib/core.ts:2401`), снимать его
не надо. Колонки: **автомат · товар · единиц · обнаружено · источник**. Окно
`?days=` — до 90 суток.

**Про потолок 90.** Сегодня чтение зажато `DETECT_DAYS_MAX = 30`
(`refill-events.service.ts:392`) и `@Max(30)` в `RefillEventsListDto`
(`vending.controller.ts:431`) — то есть потолок СКАНА снимков случайно
переиспользован как потолок ЧТЕНИЯ журнала. Заводится собственная константа
`LIST_DAYS_MAX = 90`, DTO поднимается до `@Max(90)`. Панель предлагает
`[14, 30, 90]` — ровно те окна, которые сервер отдаёт целиком.

**Почему.** Детектор каждые 3 часа пишет `vending_refill_event` (окна, штуки,
слоты, сопоставление с записью оператора), а владелец видит только агрегат
`refillDays` в карточке усушки — сам журнал доступен только через `curl`. Два
потолка разные по природе: скан снимков за 30 суток — это четверть миллиона
строк в память (комментарий на `:117-121`), чтение журнала — `limit(500)` по
индексированной колонке `window_to`. Предлагать в панели окно, которое сервер
молча зажмёт, нельзя — это тот же класс ошибки «не то, что измеряли», который
чинили `строкаЗастоя` и три состояния сбора.

**Чем платим, если ошиблись.** Оставив клиент без потребителя — код детектора
остаётся непроверяемым витриной, а мёртвый клиент однажды снимут вместе с
живым. Оставив `@Max(30)` и нарисовав кнопку «90 дн» — лист показывает
тридцать суток под подписью «90».

### R-H-6 `Shrink*` и `VendingPlan*` переезжают в `@mydon/shared`

**Решение.** В `packages/shared/src/vending-reports.ts` (рядом с уже живущими
там формами отчётов) объявляются:

* `ShrinkRefillDay`, `ShrinkMachine`, `ShrinkWarningCode`, `ShrinkWarning`,
  `ShrinkReport` — переносом из `apps/core/src/vending/shrinkage.service.ts:83-127`;
* `PlanMachine`, `PlanWarning`, `PurchasePlan` — переносом из
  `apps/core/src/vending/vending.service.ts:499`, `:512`, `:531`.

`ShrinkItem`/`ShrinkSummary` остаются в `packages/shared/src/vending-field.ts:171,184`,
`SlotPlanRow` — в `vending-plan.ts:116`, `PurchaseSummary` — в `vending-calc.ts:239`:
они УЖЕ общие, и переезд ради соседства был бы диффом без выигрыша.
`vending-reports.ts` их импортирует (файл уже импортирует из `vending-calc.ts`,
`vending-field` идёт следом).

Бот и панель переходят на реэкспорт **с сохранением своих имён через
`as`** — ни один вызывающий не правится:

```ts
// apps/cc/src/lib/core.ts и apps/bot/src/core-client.ts
export type {
  ShrinkItem, ShrinkSummary, ShrinkRefillDay, ShrinkMachine,
  ShrinkWarningCode, ShrinkWarning, ShrinkReport,
  SlotPlanRow as VendingPlanSlot,
  PlanMachine as VendingPlanMachine,
  PlanWarning as VendingPlanWarning,
  PurchasePlan as VendingPlan,
} from "@mydon/shared";
```

Панель дополнительно алиасит усушку под своими именами
(`ShrinkItem as VendingShrinkageItem` и т. д.). Ноль изменений поведения.
Сверки — компиляторные, тем же приёмом, что `core-types.test.ts` и
`core-client.test.ts:95-115`.

**Почему.** Копий три, и они уже разъехались: панель переписала союз кодов
предупреждений в другом порядке (`core.ts:276-283` против
`shrinkage.service.ts:106-112`) и инлайнила `summary` вместо `ShrinkSummary`
(`core.ts:255-266`), а Core и панель зовут план закупа разными именами
(`PurchasePlan` против `VendingPlan`). Структурная типизация переименование
поля пропустит, и панель нарисует `undefined`. Ровно этот риск П5b закрыл для
аналитики и оставил открытым для усушки и плана.

**Чем платим, если ошиблись.** Переименование `ShrinkMachine.refillDays` в
Core сегодня ничего не ломает при сборке — обнаруживается в проде пустой
колонкой. Переименовав вызывающих вместо алиасов, получаем стострочный дифф в
листах ради нуля выигрыша и текстовый конфликт с П8b в тех же файлах.

### R-H-7 Впрыскиваемые часы у детектора

**Решение.** `detect(days = DETECT_DAYS_DEFAULT, now = new Date())` и
`list(days = LIST_DAYS_DEFAULT, now = new Date())` в
`apps/core/src/vending/refill-events.service.ts`. Внутри логики (включая
приватные помощники, которые они зовут) НЕ остаётся ни одного `new Date()` /
`Date.now()` — момент приходит параметром, суточные границы считаются
ташкентскими помощниками (`tashkentDay`, `tashkentDayStartOf` из
`packages/shared/src/tashkent-time.ts`), смещение зоны второй копией не
заводится (R-FW-11). Контроллер (`vending.controller.ts:648`, `:737`) зовёт без
`now` — умолчание и есть «сейчас», как у `stockCounts` (`:592`). Тесты подают
фиксированные часы.

**Почему.** Так уже устроены соседи: `ShrinkageService.report(days, now, ctx)`
(`shrinkage.service.ts:220`), `alertDaily(now)` (`:518`),
`VendingService.stockCounts(days, product, now)` (`vending.service.ts:1658`), и
докблок последнего прямо называет причину: прогон, пересекающий полночь
Ташкента, иначе считает окно от двух разных дней. Сегодня фикстуры детектора
привязаны к стенным часам (`refill-events.service.test.ts:190`, `:403`), и
повторный smoke на той же базе в течение часа роняет два шага.

**Чем платим, если ошиблись.** Нестабильный smoke, который приучают
перезапускать, — и он же однажды промолчит на настоящей регрессии. Сигнатуры
аддитивны (`now` с умолчанием), так что цена правки — ноль.

### R-H-8 Ретенция `vending_stock_count` — свой ключ, не `SNAPSHOT_RETENTION_DAYS`

**Решение.** Пятая цель в `RetentionService` (П8b) — `vending_stock_count`,
тем же кроном (воскресенье 04:10 Ташкента), тем же событием `system.retention`,
теми же пачками по 5000 под общим бюджетом 60 с. Настройка — **своя**:

```
key:      STOCK_COUNT_RETENTION_DAYS
label:    «Вендинг: хранить историю инвентаризаций склада, дней»
kind:     number
fallback: "730"          // = потолок ?days= у /vending/stock-counts
validate: atLeast(730, "нужно не меньше 730 (окно чтения истории склада)")
// пол РАВЕН дефолту: ключом можно только ПРОДЛИТЬ хранение, урезать — нельзя
```

Колонка возраста — **`dt`, а не `counted_at`**, и граница считается как
`tashkentDay(now − N·сут)`, то есть голыми сутками `YYYY-MM-DD`.

**Почему отдельный ключ.** `SNAPSHOT_RETENTION_DAYS` (180) описывает СНИМКИ:
`slot_snapshot`, `product_sale`, `machine_sale` — телеметрию, которая
пересчитывается следующим сбором. Инвентаризация склада — ручной труд
владельца, её не восстановить ничем; 460 импортированных строк начинаются с
2025-08-17 и под окном 180 суток исчезли бы в первое же воскресенье.

**Почему `dt`, а не `counted_at`.** Читатель фильтрует именно `dt`
(`vending.service.ts:1673-1678`), и резать по другой колонке значит давать
гарантию «окно ретенции ≥ окна чтения» приблизительно, а не точно. Кроме того
`dt` — тип `date`: сравнение `date`-колонки с `timestamptz`-границей Postgres
приводит к UTC-полуночи, то есть к 05:00 по Ташкенту — ровно та ошибка на пять
часов, которой стоил урок VendCash. Поэтому `RetentionTarget` получает
необязательное `cutoffAs: "date" | "timestamp"` (умолчание `"timestamp"` —
поведение четырёх существующих целей не меняется), и для новой цели граница
уходит в SQL строкой `YYYY-MM-DD`.

**Почему пол 730 РАВЕН дефолту 730.** 730 — это ровно потолок `?days=` у
`/vending/stock-counts` (`STOCK_COUNTS_DAYS_MAX`, `vending.service.ts:144`):
лист истории умеет запросить два года, и всё, что он умеет запросить, обязано
лежать в базе. Поэтому ключ умеет только ПРОДЛИТЬ хранение (1095, 3650) и не
умеет урезать: значение ниже 730 отбивает валидатор панели, а `Math.max(730, …)`
в `sweep()` держит тот же пол против env — база важнее env, но пол важнее обоих.
Это ровно принцип П8b: `SNAPSHOT_RETENTION_DAYS` зажат полом 180 =
`DEAD_STOCK_DAYS_MAX`, самым широким живым потребителем, потому что окно
ретенции не бывает уже окна витрины. Текст `help` говорит это словами: «Ниже
730 панель не примет: 730 — потолок окна у листа «История склада», и всё, что
уже нарезано, вернуть нечем. Увеличить можно.»

**Чем платим, если ошиблись.** Повесив историю на `SNAPSHOT_RETENTION_DAYS`,
теряем полтора года ручных инвентаризаций одним воскресеньем и без следа.
Поставив пол НИЖЕ окна чтения (365, как предлагал черновик этой спеки),
заводим настройку, которой владелец молча режет историю ПОД уже работающим
листом: лист на окне 730 показывает год, объяснить это нечем, а признание
footgun'а в тексте `help` его не убирает — дословный урок R-FW-S8 из П8b, где
пол подняли с 90 до 180 по этой же причине. Взяв `counted_at` вместо `dt` —
строка с `dt` внутри окна чтения может исчезнуть, и лист покажет дырку без
объяснения.

### R-H-9 Здоровье сбора в письме — за ОТЧЁТНУЮ неделю

**Решение.** В `WeeklyDigest` добавляется **аддитивное** поле
`weekHealth: WeeklyHealth`; существующее `health: OurvendHealth` остаётся тем,
чем было, — состоянием НА МОМЕНТ отправки. Блок письма печатает сначала числа
недели, потом — прежние строки «сейчас», подписанные словом «сейчас»; строка
застоя (`строкаЗастоя`) и строка снапшота не меняются вовсе.

`WeeklyHealth` считается по окну `[понедельник недели, понедельник следующей)`:

* прогоны/отказы — новым `runsInWindow(db, window, limit)` в
  `apps/core/src/ourvend/sync-runs.ts`;
* «последний успех недели» — тем же `lastSuccessRunAt(db, window?)`, которому
  добавляется НЕОБЯЗАТЕЛЬНЫЙ параметр окна; существующие вызовы без окна
  (`OurvendHealthService`, `SyncStaleService`) не правятся и ведут себя как
  раньше;
* худшая серия отказов внутри недели — новой чистой `worstFailedStreak(runs)`
  рядом с `failedStreak` в `apps/core/src/vending/sync-streak.ts`;
* дни паритета — из `parityStreak(...).days` (П8b), отфильтрованных по
  `d.date` в границах недели; поля дня (`день_ok`, `день_продаж_сверено`,
  `день_остатков_сверено`, `день_расхождений`) уже разбирает
  `packages/shared/src/parity-streak.ts`, второй разбор не заводится.

Кеш — СУЩЕСТВУЮЩИЙ ключ сводки `weekly-digest|<неделя>|<ташкентские сутки>`
(`weekly-digest.service.ts`, `ReportCache` из `report-cache.ts`). Второго кеша нет.

**Почему.** Письмо про неделю 2026-34, ушедшее в понедельник 35-й, сегодня
показывает аварию 35-й недели: блок подписан неделей, а числа взяты моментом
отправки. Это тот же класс ошибки, что чинили `строкаЗастоя` и три состояния
сбора в панели. Аддитивное поле вместо переопределения `health` — потому что
`failedStreak` означает «сколько подряд падает ПРЯМО СЕЙЧАС», и подсунуть под
это имя недельное число значит соврать под старой подписью; а `staleHours`,
`snapshotStale` и лаги за неделю не имеют смысла вовсе — они про «сейчас» по
построению. Потребитель `WeeklyDigest` ровно один — бот
(`apps/bot/src/weekly-digest.ts`), панель этот тип не читает, так что цена
поля — три строки в зеркале бота.

**Граница окна показа паритета.** `parityStreak.days` обрезан
`PARITY_STREAK_WINDOW = 14`. Понедельничное письмо всегда попадает внутрь, но
`?week=` глубже двух недель — нет: тогда `parityDays` пуст и в
`warnings` уезжает `health_unavailable` с текстом «дни паритета за эту неделю
вне окна счёта серии». Молчаливый пустой список читался бы как «сверки не
было».

**Чем платим, если ошиблись.** Оставив как есть — понедельничное письмо
приписывает прошлой неделе сегодняшнюю аварию, и владелец ищет её в логах
не того дня. Переписав `health` вместо добавления — витрины бота, которые
сегодня честно говорят «⛔ сбор стоит N ч», начинают говорить это про неделю,
которая давно кончилась.

## 4. Общие ограничения (действуют на все восемь задач)

* TypeScript strict, без `any`.
* Русский в UI, тестах и документации; идентификаторы — английские.
  Экспортируемые имена общего слоя — латиницей (правило `report-cache.ts`).
* Время — только `packages/shared/src/tashkent-time.ts`; вторая копия смещения
  запрещена (R-FW-11). Голые сутки — `YYYY-MM-DD`, ISO-неделя — `IYYY-IW`.
* Настройки — только через `apps/core/src/system/config-spec.ts` (`CONFIG_SPECS`,
  поля `key/label/kind/fallback/help/validate`) с русским `help`; чтение —
  `readIntSetting`; база важнее env.
* `@Throttle` — только именованные лимитеры `burst`/`sustained` (сторожевой тест
  `vending.controller.test.ts:15`); `default` не работает.
* Мутации — под `ServiceTokenGuard`; чтения — без токена (изменение этого —
  П8 п. 3–5, см. R-H-1).
* Документация (`docs/DATA_SOURCES.md`, `docs/DEPLOY.md`) правится ВНУТРИ той
  задачи, которой она нужна, а не отдельным коммитом в конце.
* Записей в прод нет, кроме одной по R-H-4.
* Докблок объясняет ПОЧЕМУ и обязан оставаться правдой.
* Ноль ≠ «всё хорошо»: пустая выборка рендерится третьим состоянием
  («не считали»), а не зелёной галкой.
* Деньги — «N сум», проценты — «N %» (с пробелом), минус — U+2212.

## 5. Дизайн по компонентам

Порядок = порядок выполнения. Задачи 1–6 независимы от П8b, 7–8 требуют его в `main`.

### Задача 1 — Лист «История склада» (M, O1, R-H-2)

**`packages/shared/src/vending-reports.ts`** — аддитивное поле:

```ts
export interface StockCountRow {
  dt: string;            // сутки пересчёта, YYYY-MM-DD по Ташкенту
  product: string;
  qty: number;
  source: string;        // 'own' | 'stock-import'
  countedAt: string;
  /**
   * Пометка строки. ЗНАЧИТ РАЗНОЕ У РАЗНЫХ ИСТОЧНИКОВ (R-H-2):
   * `own` — КТО считал (`ingestStock` пишет сюда actor),
   * `stock-import` — МЕСТО донора («2 Холодильник», R-FW-P2).
   * `null` — пометки нет; выдумывать «Основной склад» нельзя.
   */
  note: string | null;
}
```

**`apps/core/src/vending/vending.service.ts`** — в `stockCounts()`:
добавить `note: vendingStockCount.note` в `select` (`:1683-1689`) и в маппинг
строк (`:1700+`). Больше в Core ничего: окно, потолки, кеш, троттл, оба
предупреждения (`history_capped`, `stock_missing`) остаются как есть.

**`apps/cc/src/lib/core.ts`**:

```ts
// в существующий блок `export type { … } from "@mydon/shared"` (:308-334)
StockCountRow, StockCountsReport,

// рядом с vendingDeadStock (:2392)
/** История пересчётов склада (П8a). Окно зажимает ядро: 1..730, дефолт 90. */
vendingStockCounts: (days = 90, product?: string) =>
  get<StockCountsReport>(
    `/vending/stock-counts?days=${days}${product ? `&product=${encodeURIComponent(product)}` : ""}`,
  ),
```

**`apps/cc/src/components/stock-history-view.tsx`** (новый) — по образцу
`dead-stock-view.tsx`:

```ts
export const STOCK_HISTORY_WINDOWS = [30, 90, 365, 730] as const;
const TAB = "reports:stock_history";

export function StockHistoryTables({ report }: { report: StockCountsReport }): JSX.Element
export async function StockHistoryView(
  { domain, days, q }: { domain: string; days: number; q: string },
): Promise<JSX.Element>
```

Разметка:

* `<ReportWindow domain tab={TAB} days windows={STOCK_HISTORY_WINDOWS} />`;
* строка-подпись: «Пересчёты склада за N дн. · с ДД.ММ.ГГГГ · M строк»,
  при фильтре — «· товар «X»»;
* группировка: `dt` вниз по датам (свежие сверху) → внутри суток по паре
  `(source, note)`; заголовок группы —
  `note ?? "без пометки"` плюс `small`-пояснение
  «место» для `stock-import` и «кто считал» для `own` (R-H-2);
* строка позиции: товар · `count(qty)` шт · время из `countedAt` (`when()`);
* пустое состояние (третье состояние, а не зелёная галка):
  * без фильтра — «Инвентаризаций за окно нет. Пересчёты копятся сами: их
    пишет бот («склад …») и панель — история появится после первого счёта.»;
  * с фильтром — предупреждение `stock_missing` от Core уже говорит нужное,
    лист его не дублирует (`covered = ["stock_missing"]`);
* `<ReportWarnings warnings={report.warnings} covered={COVERED_BY_STOCK_HISTORY} />`,
  где `export const COVERED_BY_STOCK_HISTORY: AnalyticsWarningCode[] = ["stock_missing"]`
  в `report-warnings.tsx`; `history_capped` НЕ покрыт — про обрезку окна лист
  сам не говорит.

**`apps/cc/src/lib/domain-nav.ts`**: в `VENDHUB_GROUPS` → `reports`, сразу за
`{ label: "Приход", type: "purchase" }`:
`{ label: "История склада", type: "stock_history" }` — приход отвечает «что
привезли», история склада «что лежало». В `TABLE_BACKED_LEAVES` (`:236`)
добавить `"stock_history"` с комментарием: считается на чтении
(`/vending/stock-counts`), своих карточек реестра не заводит — счёт по `byType`
всегда 0, и чип бы погас.

**`apps/cc/src/app/domain/[domain]/page.tsx`**: разбор окна рядом с
`deadStockDays` (`:699`), рендер рядом с остальными снек-листами (`:1976-1986`),
`"stock_history"` — в список исключений (`:2490-2523`).

**`docs/DATA_SOURCES.md`**: к абзацу про `vending_stock_count` (`:961-962`) —
где смотреть («Отчёты → История склада») и что `note` значит у разных
источников.

### Задача 2 — Числа снек-листов без U+00A0 (S, O3, R-H-3)

Правки — по таблице R-H-3. Дополнительно:

**`apps/cc/src/lib/format.ts`** — докблок у `money()`:

```
/**
 * Сумма с разделителями разрядов. Валюта проекта — сум.
 *
 * ОСТАЁТСЯ С U+00A0 НАМЕРЕННО. Числа, которые владелец КОПИРУЕТ и сверяет с
 * ботом, печатают `count()`/`amount()` — они NBSP срезают. Здесь неразрывный
 * пробел уместен: `money()` зовут 42 раза, в основном в GLOBERENT и финансах,
 * где число читают глазами, а не ищут поиском по странице. Снек-контур на неё
 * больше не опирается (срез «Хвосты», R-H-3) — если новый снек-лист позовёт
 * `money()`, это регрессия, а не выбор.
 */
```

### Задача 3 — Бэкфилл `product_id` на заливки и инвентаризации (S, O5, R-H-4)

**`packages/db/src/backfill-product-ids.ts`**:

```ts
/** Одна таблица бэкфилла: имя товара + пустая ссылка на карточку. */
interface BackfillTarget {
  name: string;                       // человеческая подпись отчёта
  table: PgTable;
  nameColumn: AnyPgColumn;
  idColumn: AnyPgColumn;
}

export const BACKFILL_TARGETS: BackfillTarget[] = [
  { name: "Склад вендинга (vending_stock)",           table: vendingStock,      … },
  { name: "Планограмма (machine_slot)",               table: machineSlot,       … },
  { name: "Заливки (vending_refill)",                 table: vendingRefill,     … },
  { name: "История склада (vending_stock_count)",     table: vendingStockCount, … },
];

export async function backfillProductIds(
  db: Database,
  opts: { dryRun?: boolean } = {},
): Promise<Record<"stock" | "slots" | "refills" | "stockCounts", BackfillResult>>
```

`бэкфиллWhere` обобщается по типам колонок, предикат не меняется:
`and(eq(nameColumn, raw), isNull(idColumn))`. При `dryRun` считается тот же
резолв и печатается «обновилось БЫ N», `UPDATE` не выполняется.
`main()` разбирает `process.argv` тем же способом, что
`import-stock-history.ts:662-665`: `--apply` и `--dry-run` вместе — отказ с
объяснением; без флагов — запись (см. R-H-4).

Отчёт печатает по строке на цель: «обновлено N / осталось NULL M (имена…)»
через существующий `отчёт()`; список неразрешённых имён — тот же, что владелец
уже видел в отчёте импорта.

**`docs/DEPLOY.md`** — рядом с блоком разовых скриптов (`:89-107`):

```
docker exec -i mydon-core node packages/db/dist/backfill-product-ids.js --dry-run </dev/null
docker exec -i mydon-core node packages/db/dist/backfill-product-ids.js --apply   </dev/null
```

с напоминанием про `</dev/null` (`DEPLOY.md:121` — иначе остаток скрипта уходит
в контейнер и шаги после молча не выполняются).

### Задача 4 — Журнал детектора заливок в панели (S, O6, R-H-5)

**`apps/core/src/vending/refill-events.service.ts`**:

```ts
/**
 * Потолок ЧТЕНИЯ журнала — СВОЙ, а не `DETECT_DAYS_MAX`.
 *
 * У детектора 30 суток — это потолок СКАНА СНИМКОВ (четверть миллиона строк в
 * память, см. комментарий в `detect`). Чтение журнала — `limit(LIST_LIMIT)` по
 * индексированной `window_to`, и держать его на чужом потолке значит показывать
 * владельцу тридцать суток под кнопкой «90 дн».
 */
export const LIST_DAYS_MAX = 90;
// list(): зажать(days, LIST_DAYS_DEFAULT, LIST_DAYS_MAX)
```

**`apps/core/src/vending/vending.controller.ts:431`** — `RefillEventsListDto`:
`@Max(90)`, докблок про два разных потолка (страховка HTTP-входа обязана
совпадать с зажимом сервиса — как у `StockCountsDto`, `:357`).

**`apps/cc/src/components/refill-events-view.tsx`** (новый):

```ts
export const REFILL_EVENT_WINDOWS = [14, 30, 90] as const;
const TAB = "reports:refill_events";
export function RefillEventsTable({ rows }: { rows: VendingRefillEvent[] }): JSX.Element
export async function RefillEventsView({ domain, days }: { domain: string; days: number })
```

Колонки (R-H-5):

| Колонка | Источник | Правило |
|---|---|---|
| автомат | `name`; если `name === serial` — «карточки автомата нет» (тот же текст, что `margin-view.tsx:123`) | — |
| товар | `slots[].product` + `coilId` — строка на слот под шапкой события | пустой `slots` — «слоты не записаны» |
| единиц | `count(units)` в шапке, `count(delta)` в строке слота | — |
| обнаружено | окно `windowFrom` — `windowTo` через `when()` | — |
| источник | `matchedRefillId === null ? "только снимки" : "снимки + запись оператора"` | «только снимки» — НЕ ошибка: заливка = факт снимка (R-P4-2), запись оператора — уточнение |

Пустое состояние: «За N дн. детектор заливок не находил. Он смотрит снимки
слотов каждые 3 часа и пишет событие при приходе от `REFILL_DETECT_MIN_UNITS`
единиц — пусто значит «не привозили», а не «не считали».»

**Навигация**: `{ label: "Журнал заливок", type: "refill_events" }` в `reports`
сразу за «Усушкой» (усушка говорит, куда делось, журнал — что привезли);
`"refill_events"` — в `TABLE_BACKED_LEAVES` и в список исключений `page.tsx`.

### Задача 5 — Формы `Shrink*` / `VendingPlan*` в `@mydon/shared` (M, O2, R-H-6)

Перенос по R-H-6, ноль изменений поведения. Порядок правки — по одному пакету
за раз, чтобы `pnpm -s typecheck` показывал ровно одну причину:

1. `packages/shared/src/vending-reports.ts` — восемь новых объявлений
   (`ShrinkRefillDay`, `ShrinkMachine`, `ShrinkWarningCode`, `ShrinkWarning`,
   `ShrinkReport`, `PlanMachine`, `PlanWarning`, `PurchasePlan`) с
   перенесёнными докблоками; импорты `ShrinkItem`/`ShrinkSummary` из
   `./vending-field`, `SlotPlanRow` из `./vending-plan`, `PurchaseSummary` из
   `./vending-calc`.
2. `apps/core/src/vending/shrinkage.service.ts` — объявления заменяются на
   `import type { … } from "@mydon/shared"` + реэкспорт (внутренние
   вызывающие Core импортируют оттуда же, где импортировали).
3. `apps/core/src/vending/vending.service.ts` — то же для трёх форм плана.
4. `apps/bot/src/core-client.ts` — блок `export type { … } from "@mydon/shared"`
   (`:399-410`) пополняется, локальные объявления `:204-263` и `:274-341`
   удаляются.
5. `apps/cc/src/lib/core.ts` — блок реэкспорта (`:308-334`) пополняется с
   алиасами (`ShrinkItem as VendingShrinkageItem` и т. д.), локальные
   объявления `:159-224` и `:227-306` удаляются. Инлайненный `summary` в
   `VendingShrinkageMachine` становится `ShrinkSummary` — поля те же,
   вызывающие не правятся.

Одно расхождение фиксируется явно: союз `ShrinkWarningCode` берётся в порядке
Core (`shrinkage.service.ts:106-112`), панельный порядок (`core.ts:276-283`)
исчезает вместе с копией. Набор членов одинаков — поведение не меняется.

### Задача 6 — Впрыскиваемые часы `detect` / `list` (S, O8, R-H-7)

`apps/core/src/vending/refill-events.service.ts`:

```ts
async detect(days = DETECT_DAYS_DEFAULT, now = new Date()): Promise<DetectResult>
async list(days = LIST_DAYS_DEFAULT, now = new Date()): Promise<RefillEventRow[]>
```

`const сейчас = new Date()` (`:113`) и `Date.now()` (`:393`) удаляются; `now`
протягивается во все производные моменты, включая границу публикации событий
(`const порог = new Date(now.getTime() - MATCH_PAD_MS)`, `:336`) и окна поиска
человеческих записей (`:238`, `:243`). Докблок обеих функций объясняет ПОЧЕМУ
параметр (тем же текстом, что `stockCounts`: прогон, пересекающий полночь
Ташкента, иначе считает окно от двух разных дней). Контроллер не правится.

Сторож правила: тест утверждает, что в файле нет `new Date()` / `Date.now()`
нигде, кроме значений параметров по умолчанию.

### Задача 7 — Ретенция `vending_stock_count` (S, O4, R-H-8; **после мержа П8b**)

**`apps/core/src/system/config-spec.ts`** — ключ `STOCK_COUNT_RETENTION_DAYS`
по R-H-8, рядом с `SNAPSHOT_RETENTION_DAYS` (`:313`).

**`apps/core/src/vending/retention.service.ts`**:

```ts
/** Порог, если `STOCK_COUNT_RETENTION_DAYS` не задан. Дублирует фолбэк `config-spec.ts`. */
export const STOCK_COUNT_RETENTION_DAYS_FALLBACK = 730;

interface RetentionTarget {
  …
  /**
   * Тип границы. `"date"` — колонка `date`, граница уходит голыми сутками
   * `YYYY-MM-DD`: сравнение `date`-колонки с `timestamptz` Postgres приводит к
   * UTC-полуночи, то есть к 05:00 по Ташкенту (урок VendCash на пять часов).
   */
  cutoffAs?: "date" | "timestamp";
}
```

В `sweep(now)` — пятая цель:

```ts
const stockCountDays = Math.max(
  // ПОЛ 730 = ДЕФОЛТ 730 (R-H-8). Ключ умеет только ПРОДЛИТЬ хранение: 730 —
  // потолок `?days=` у /vending/stock-counts, и окно ретенции уже него молча
  // режет данные ПОД уже работающим листом «История склада» (урок R-FW-S8).
  730,
  Math.trunc(await readIntSetting(this.db, "STOCK_COUNT_RETENTION_DAYS",
                                  STOCK_COUNT_RETENTION_DAYS_FALLBACK, this.logger)),
);
…
{ table: vendingStockCount, name: "vending_stock_count",
  idCol: vendingStockCount.id, ageCol: vendingStockCount.dt,
  olderThanDays: stockCountDays, cutoffAs: "date" },
```

`batchQuery()` для `cutoffAs === "date"` подставляет `tashkentDay(cutoff)`
вместо `Date`. Всё остальное — пачки, бюджет, событие в `finally`, `capped`,
`aborted` — механика П8b без изменений.

**Миграция 0071** — индекс под новую цель (см. §6).

**`docs/DATA_SOURCES.md`**: абзац «сколько живёт история склада» — дефолт 730,
пол 730 и прямая фраза: настройка умеет только ПРОДЛИТЬ хранение, урезать
историю ниже окна чтения листа «История склада» нельзя ни из панели, ни из env.

### Задача 8 — Здоровье сбора в письме за отчётную неделю (M, O7, R-H-9; **после мержа П8b**)

**`packages/shared/src/vending-reports.ts`**:

```ts
/**
 * Здоровье сбора ЗА ОТЧЁТНУЮ НЕДЕЛЮ (R-H-9) — рядом с `health`, а не вместо.
 *
 * `OurvendHealth` отвечает на вопрос «как дела СЕЙЧАС»: `staleHours`,
 * `snapshotStale` и лаги про момент по построению, а `failedStreak` значит
 * «сколько подряд падает прямо сейчас». Подсунуть под эти имена недельные
 * числа — соврать под старой подписью; поэтому неделя едет своим полем.
 */
export interface WeeklyHealth {
  /** Та же ISO-неделя, что у письма (`IYYY-IW`) — подпись и числа обязаны совпадать. */
  week: string;
  /** Прогонов, НАЧАТЫХ в [понедельник, следующий понедельник). */
  runs: number;
  success: number;
  partial: number;
  failed: number;
  /** Самая длинная серия отказов ВНУТРИ недели. 0 — отказов не было. */
  worstFailedStreak: number;
  /** Последний успех НЕДЕЛИ (ISO). `null` — успехов в неделе не было ВОВСЕ (не «ноль часов»). */
  lastSuccessAt: string | null;
  /** Дни паритета недели, свежие сверху. Пустой — см. `warnings` письма. */
  parityDays: ParityDay[];
  parityGreen: number;
  parityRed: number;
}

export interface WeeklyDigest {
  …
  health: OurvendHealth;   // СЕЙЧАС — не трогаем
  weekHealth: WeeklyHealth; // за отчётную неделю
  warnings: AnalyticsWarning[];
}
```

**`apps/core/src/ourvend/sync-runs.ts`**:

```ts
/** Полуинтервал `[from, to)` — окно недели. `lte` по концу воскресенья втянул бы полночь понедельника в обе недели. */
export interface RunWindow { from: Date; to: Date }

/** Прогонов больше, чем в неделе бывает, не читаем: 8 прогонов/сут × 7 + запас. */
export const WEEK_RUNS_LIMIT = 200;

// окно НЕОБЯЗАТЕЛЬНОЕ: вызывающие без него (OurvendHealthService, SyncStaleService) не правятся
export async function lastSuccessRunAt(db: Db, window?: RunWindow): Promise<Date | null>
export async function runsInWindow(db: Db, window: RunWindow, limit = WEEK_RUNS_LIMIT): Promise<SyncRunFacts[]>
```

**`apps/core/src/vending/sync-streak.ts`**:

```ts
/**
 * САМАЯ ДЛИННАЯ серия отказов внутри набора — не то же, что `failedStreak`.
 * `failedStreak` считает от свежего края и отвечает «падает ли сейчас»; здесь
 * вопрос другой — «была ли на неделе дыра и какой длины». `running`
 * пропускается, `partial`/`success` серию рвут — те же два решения, что у соседа.
 */
export function worstFailedStreak(runs: readonly SyncRunFacts[]): number
```

**`apps/core/src/vending/weekly-digest.service.ts`** — рядом с
`здоровьеСбора(now)` появляется `здоровьеНедели(неделя, начало, конец, now)`,
под своим `catch` тем же приёмом (отказ спутника не роняет письмо: деньги
недели от него не зависят). Возвращает `WeeklyHealth` и, при пустых
`parityDays` из-за окна показа, — предупреждение
`{ code: "health_unavailable", message: "Дни паритета за эту неделю вне окна счёта серии (14 дней) — смотри /ourvend/parity/streak" }`.
Оба вызова идут в существующем `Promise.all` внутри `сводка()`; кеш — тот же
ключ `weekly-digest|<неделя>|<ташкентские сутки>`, второго нет.

Константа `ЗДОРОВЬЕ_НЕИЗВЕСТНО` получает пару — `НЕДЕЛЯ_НЕИЗВЕСТНА:
WeeklyHealth` (нули, `lastSuccessAt: null`, пустые `parityDays`) по тому же
правилу: «не посчитали» ≠ «всё хорошо».

**`apps/bot/src/core-client.ts`** — `WeeklyHealth` в блок реэкспорта (`:399-410`).

**`apps/bot/src/weekly-digest.ts`** — `здоровье(h)` (`:245`) становится
`здоровье(d: WeeklyDigest)` и печатает:

```
🩺 Здоровье сбора OurVend
За неделю: прогонов 56 · успешных 54 · частичных 1 · отказов 1 · худшая серия 1
Паритет недели: 5 зелёных / 2 красных
Сейчас: <строкаЗастоя>            ← без изменений
Сейчас: <строкаСнапшота>          ← без изменений
Сейчас: <состояниеСбора> · последний успех <момент>
<прогоныСтрока> / <свежестьСтрока> / <паритетСтрока> / <строкаСерии>  ← без изменений
```

Пустая неделя (`runs === 0`) печатает «За неделю прогонов не было — сбор не
запускался», а не «отказов 0».

## 6. Данные и миграции

* **Миграция 0071** `0071_stock_count_retention_idx.sql` (задача 7):
  `CREATE INDEX IF NOT EXISTS "vending_stock_count_dt_idx" ON "vending_stock_count" USING btree ("dt");`
  Причины — тем же текстом, что 0070: существующий
  `vending_stock_count_product_dt_idx (product_name, dt)` под условие
  `where dt < cutoff order by dt limit 5000` не годится (ведущая колонка не та),
  `CONCURRENTLY` в транзакции мигратора запрещён и повесил бы автодеплой молча,
  `IF NOT EXISTS` — защитный паттерн 0067/0069/0070. Индекс регистрируется в
  `packages/db/src/schema.ts` в списке индексов `vendingStockCount` (`:1595`),
  снапшот drizzle обновляется `db:generate`, страж-тест схемы — как у 0069/0070.
* **Схема больше не меняется.** `vending_stock_count.note` (`:1588`),
  `vending_refill.product_id` (`:1693`), `vending_stock_count.product_id`
  (`:1576`) уже существуют — задачи 1 и 3 работают с готовыми колонками.
* **Новая настройка** (`config-spec.ts`): `STOCK_COUNT_RETENTION_DAYS`,
  `fallback "730"`, `validate: atLeast(730, …)` — пол равен дефолту и равен
  потолку `?days=` листа истории: ключом можно только продлить хранение
  (R-H-8). Русский `help` говорит это словами.
  На отчёты она не влияет, поэтому в ключ кеша не входит; `PUT /system` и так
  зовёт `invalidateReports()` (`system.controller.ts:24-49`).
* **Записей в прод — одна**: прогон бэкфилла (`--apply`), шаг 4 выкатки.
  Ретенция начнёт удалять сама, в первое воскресенье после деплоя, — и на
  сегодняшних данных удалит **0 строк**: самая старая инвентаризация
  2025-08-17, порог по умолчанию 730 суток.

## 7. События и правила

* **Новых событий нет.** Ретенция `vending_stock_count` пишет СУЩЕСТВУЮЩЕЕ
  `system.retention` (П8b, `RETENTION_EVENT`) с `table: "vending_stock_count"` —
  второй тип событий про одну и ту же чистку заставил бы читателя гадать,
  какой из них полный.
* **Новых правил нет** — значит, и записи в `RULE_EVENT_TYPES` не требуется
  (урок П5b N5: правило без записи там не подберётся `/rules/pending`;
  здесь правил нет вовсе).
* Существующие правила снек-контура не трогаются: `machine.idle` (`rules.ts:142`),
  `machine.offline` (`:151`), `machine.low_stock` (`:157`), `ourvend.parity`
  (`:318`), `ourvend.snapshot_quarantine` (`:328`), `vending.shrinkage_alert`
  (`:396`), `vending.refill_detected` (`:407`), `ourvend.sync_failed_streak`
  (`:423`), `ourvend.sync_stale` (`:440`), `weekly-digest.no_recipients`
  (`:462`), плюс `ourvend.cutover_ready` из П8b.
* Задача 8 меняет ТЕКСТ письма, а не сигналы: `urgency:"weekly"`-заметки
  подмешиваются `formatWeeklyDigest` (`weekly-digest.ts:363`) как раньше, и
  бюджет частей (`WEEKLY_MAX_PARTS`) считается по тем же строкам — блок
  здоровья вырастает на две строки, что в бюджет входит.

## 8. Тесты

Стиль по пакетам: Core — `node:test` + `assert`, стабы БД в самом файле;
панель — `vitest` + Testing Library, `apps/cc/src/components/<имя>.test.tsx`;
бот — `node:test`; shared — `packages/shared/src/*.test.ts`.

### Задача 1

`apps/core/src/vending/vending.service.test.ts` (дополнить):
* «в строке истории едет `note` — без него лист не сгруппирует по месту»;
* «окно ВКЛЮЧАЕТ сегодняшние сутки» — существующий тест не трогается.

`apps/cc/src/components/stock-history-view.test.tsx` (новый), по образцу
`dead-stock-view.test.tsx`:
* «сутки идут свежими сверху, внутри суток — группы по пометке»;
* «пометка импортированной строки подписана «место», своей — «кто считал»»;
* «пустая история без фильтра — третье состояние «пересчёты копятся сами», а не зелёная галка»;
* «`history_capped` показывается хвостом «Посчитано не всё», `stock_missing` — нет (лист покрыт)»;
* «лист заведён в навигации сразу за «Приходом» и признан table-backed»
  (`isTableBackedLeaf("stock_history") === true`) — по образцу
  `shrinkage-view.test.tsx:238-240`.

### Задача 2

`apps/cc/src/lib/format.test.ts` (новый):
* «`count()` и `amount()` не содержат U+00A0» — сравнение БАЙТА:
  `expect(count(1_234_567)).not.toContain("\u00a0")`;
* «`money()` U+00A0 сохраняет» — пин на решение R-H-3:
  `expect(money(1_234_567)).toContain("\u00a0")`;
* «`amount()` = `money()` без NBSP» — обе формы дают одну строку после замены.

`apps/cc/src/components/snack-format.test.tsx` (новый, сторожевой — тем же
приёмом, что `vending.controller.test.ts:15`): читает пять снек-листов из
`apps/cc/src/components/` (`shrinkage-view.tsx`, `purchase-plan-view.tsx`,
`sales-view.tsx`, `supply-views.tsx`, `vending-panel.tsx`) через `node:fs` и
утверждает «снек-лист не заводит своего форматтера чисел»: ни одного
`toLocaleString(` и ни одного вызова `money(` в файле. Тест объясняет в
докблоке, почему сторож по исходнику, а не по рендеру: три из пяти листов —
асинхронные серверные компоненты, ходящие в Core, и отрендерить их в юните
дороже, чем прочитать.

`shrinkage-view.test.tsx` и `purchase-plan-view.test.tsx` (дополнить):
* «в выводе листа нет неразрывного пробела» — на уже существующих фикстурах.

### Задача 3

`packages/db/src/backfill-product-ids.test.ts` (дополнить):
* «цели бэкфилла — четыре таблицы, включая `vending_refill` и `vending_stock_count`»;
* «`--dry-run` резолвит имена и НЕ зовёт `update`» (стаб считает вызовы);
* «`--apply` и `--dry-run` вместе — отказ, а не «победил последний»»;
* существующий тест предиката `бэкфиллWhere` (`:69`) не трогается.

CI (`.github/workflows/ci.yml:82`) остаётся прежней командой без флагов —
шаг по-прежнему исполняет настоящий `UPDATE` против настоящего Postgres.

### Задача 4

`apps/core/src/vending/refill-events.service.test.ts` (дополнить):
* «окно чтения журнала зажато 90 сутками, а не 30: потолок скана снимков — не потолок чтения».

`apps/core/src/vending/vending.controller.test.ts` (дополнить):
* «`RefillEventsListDto` принимает `days=90` и отбивает `days=91`» — по образцу
  теста границы 730 у `StockCountsDto` (`:54-56`).

`apps/cc/src/components/refill-events-view.test.tsx` (новый):
* «событие без записи оператора подписано «только снимки», с записью — «снимки + запись оператора»»;
* «автомат без карточки подписан «карточки автомата нет», тем же текстом, что маржа»;
* «пустой журнал — «не привозили», а не «не считали»»;
* «лист заведён в навигации сразу за «Усушкой» и признан table-backed».

### Задача 5

`packages/shared/src/vending-reports-contracts.test.ts` (дополнить): набор
полей `ShrinkReport` и `PurchasePlan`.

`apps/cc/src/lib/core-types.test.ts` (дополнить, по образцу `:46-70`):
общая фикстура `ShrinkReport` присваивается типу панели
`VendingShrinkageReport`, общая `PurchasePlan` — `VendingPlan`. Утверждение
теста — то же, что у соседей: сверка ломается ровно тогда, когда реэкспорт
заменят объявлением.

`apps/bot/src/core-client.test.ts` (дополнить, по образцу `:95-115`): то же для
`ShrinkReport` / `VendingPlan` бота.

Отдельно — «союз кодов предупреждений усушки объявлен ОДИН раз»: фикстура с
каждым из шести кодов (`snapshots_stale`, `no_sales_day`, `machine_dead`,
`no_counted_days`, `sales_unknown_product`, `machine_error`) присваивается
`ShrinkWarningCode`, лишний литерал не компилируется.

### Задача 6

`apps/core/src/vending/refill-events.service.test.ts` (переписать фикстуры на
фиксированные часы):
* «детектор считает окно от переданного момента, а не от стенных часов»;
* «повторный прогон с тем же `now` новых событий не даёт» — идемпотентность
  проверяется детерминированно, а не «пока не наступил следующий час»;
* «событие публикуется только по окнам старше `MATCH_PAD_MS` от переданного `now`»;
* сторож: «в `refill-events.service.ts` нет `new Date()`/`Date.now()` вне
  значений параметров по умолчанию».

### Задача 7

`apps/core/src/vending/retention.service.test.ts` (дополнить, стиль файла — П8b):
* «чистит ПЯТЬ таблиц: к четырём добавилась `vending_stock_count`»;
* «граница истории склада по умолчанию — 730 суток»;
* «пол 730 держится и против env: панель отобьёт 365, окружение — нет, а
  `Math.max` в `sweep()` — да»;
* «720 суток в настройке НЕ сужают окно, 1095 — расширяют: ключ умеет только
  продлить хранение»;
* «граница для `vending_stock_count` уходит голыми сутками `YYYY-MM-DD`, а не
  моментом» — иначе `date`-колонка сравнивается с UTC-полуночью и режет на пять
  часов раньше;
* «удалено 0 — ни события, ни строки в результате» (правило П8b не сломано
  новой целью).

`packages/db` — страж схемы: индекс `vending_stock_count_dt_idx` объявлен, и
мигратор на уже применённой базе — no-op.

### Задача 8

`packages/shared/src/parity-streak.test.ts` (дополнить): «дни серии режутся
границами недели: понедельник входит, воскресенье предыдущей — нет».

`apps/core/src/vending/sync-streak.test.ts` (дополнить):
* «худшая серия недели — самая длинная, а не последняя»;
* «`running` серию не рвёт, `partial` рвёт» — те же два решения, что у
  `failedStreak`.

`apps/core/src/vending/weekly-digest.service.test.ts` (дополнить):
* «прогоны письма считаются по окну `[понедельник, следующий понедельник)`:
  прогон в полночь понедельника следующей недели в неделю НЕ входит»;
* «авария ТЕКУЩЕЙ недели не попадает в письмо о прошлой» — регрессионный тест
  на сам дефект O7;
* «`weekHealth` посчитан, `health` остался «сейчас» — два разных набора чисел в
  одном ответе»;
* «неделя вне окна счёта серии: `parityDays` пуст И в `warnings` есть
  `health_unavailable`» — молчаливый пустой список запрещён;
* «падение недельного здоровья не роняет письмо: деньги недели на месте,
  причина в `warnings`» (тот же приём, что у `здоровьеСбора`).

`apps/bot/src/weekly-digest.test.ts` (дополнить):
* «блок здоровья печатает сначала неделю, потом строки «сейчас», подписанные
  словом «сейчас»»;
* «неделя без прогонов — «сбор не запускался», а не «отказов 0»»;
* «строка застоя и строка снапшота не изменились» — сверка текста с
  `analytics-brief.ts` (правило «два отчёта об одних числах говорят одно»).

### Дымовые

`tools/smoke-core.mjs`:
* шаг `GET /vending/refill-events?days=90` — потолок чтения (рядом с
  существующим `?days=14`, `:81`);
* шаг `GET /vending/stock-counts?days=90` (`:88`) дополняется проверкой, что у
  строки есть ключ `note`;
* три существующих шага детектора (`:441`, `:458`, `:483`) не трогаются — они и
  есть проверка того, что впрыснутые часы ничего не сломали.

`tools/smoke-panel.mjs` — два шага рядом с существующими (`:88-96`):
`{ path: "/domain/vendhub?tab=reports:stock_history", должно: "Пересчёты склада" }`,
`{ path: "/domain/vendhub?tab=reports:refill_events", должно: "Журнал заливок" }`.

`tools/smoke-import.mjs` не трогается (требует `SMOKE_SCRATCH=1` либо имя базы
`*smoke*`, R-FW-S4).

**Полный прогон перед PR:** `pnpm -s lint && pnpm -s typecheck && pnpm -s build && pnpm -s test`;
smoke на scratch-БД: `createdb → migrate.js → seed.js → seed-vending.js →
backfill-product-ids.js → smoke-import.mjs → smoke-core.mjs → smoke-panel.mjs → dropdb`.

## 9. Выкатка и чек-лист

Предусловие: **П8b смёржен в `main`**, задачи 7 и 8 переписаны поверх его кода
(перечитать `retention.service.ts`, `sync-runs.ts`, `parity-streak.ts`,
`OurvendHealth` заново, а не опираться на то, что описано здесь по диффу).

1. Ветка `feat/hvosty-snek` от свежего `main`. Первой командой после
   переключения на `main` — создание ветки: фолбэк вида `|| git push` молча
   отправляет `main` в прод, а автодеплой ходит каждые 2 минуты.
2. PR → CI зелёный (lint, typecheck, build, test, smoke-цепочка со скриптом
   бэкфилла) → adversarial-ревью → squash-мерж.
3. Дождаться деплоя и сверить, что выкачено ИМЕННО это: `GET /health` →
   `commit` совпадает с мержем (каталог обновляется за секунды, образ
   собирается минуты). Миграция 0071 применяется автодеплоем.
4. **Единственная запись в прод (R-H-4).** Сначала примерка, потом запись —
   тем же паттерном разового скрипта, что описан в `docs/DEPLOY.md:89-107`:
   `backfill-product-ids.js --dry-run`, затем `--apply`, оба через
   `docker exec -i mydon-core` и оба с `</dev/null` в хвосте.
   Ожидание: `vending_stock` и `machine_slot` — 0 новых (уже прогонялись),
   `vending_refill` + `vending_stock_count` — привязки по тем именам, которым
   владелец успел завести карточки; **11 имён без карточки остаются `NULL`** и
   печатаются списком. Ноль привязок — законный результат, если владелец
   карточек ещё не завёл; это не повод считать шаг проваленным.
   `</dev/null` обязателен: без него остаток скрипта уходит в контейнер и шаги
   после молча не выполняются (`DEPLOY.md:121`).
5. Проверка витрин:
   * `GET /vending/stock-counts?days=730` — строки содержат `note`;
   * панель «Отчёты → История склада» — 460 импортированных строк видны,
     сгруппированы по датам и пометкам;
   * панель «Отчёты → Журнал заливок» на окне 90 дн. — события детектора;
   * панель «Отчёты → Усушка», «План закупа», «Журнал продаж», «Приход» и
     «Полевая работа → Снек» — суммы копируются и находятся поиском по
     странице (нет U+00A0);
   * `GET /vending/refill-events?days=90` отдаёт 90-суточное окно, `days=91` —
     400.
6. Отложенная проверка ретенции: в ближайший понедельник посмотреть события
   `system.retention` за воскресенье 04:10 — записи `vending_stock_count` быть
   НЕ должно (удалять на сегодняшних данных нечего: самая старая строка
   2025-08-17 при пороге 730, то есть первые кандидаты на чистку появятся не
   раньше августа 2027). Запись раньше срока = граница считается не по `dt` или
   порог тронули в обход валидатора — опустить его ниже 730 панель не даёт.
7. Отложенная проверка письма: следующая недельная сводка в понедельник 08:05 —
   блок здоровья говорит «За неделю…» с числами недели и отдельно «Сейчас…».
   Если на неделе была авария, а сейчас всё хорошо, в письме обязаны быть обе
   строки — это и есть приёмка O7.
8. Память и план: `docs/PLAN_STOCK_ABSORPTION.md` — снять из бэклога `:425`
   (ретенция `vending_stock_count`), переформулировать `:428` (индекс дедупа
   остаётся, см. R-H-1), оставить `:426` (read-token) открытым для П8 п. 3–5.

## 10. Вне охвата

Из §3 описи и решений владельца — не трогаем и не обсуждаем в этом срезе:

| Пункт | Почему |
|---|---|
| Пачечная вставка событий детектора (O9) | оптимизация без сегодняшнего симптома; риск тронуть идемпотентность `unique(machine_serial, window_to)` выше пользы (R-H-1) |
| Уникальный индекс дедупа сторожа застоя (O10) | ценность ноль при одной реплике Core; R-FW-S7 уже принял гонку осознанно |
| Read-token для денежных GET (O11) | размер L, трогает Core, панель, бота, агентов, оба `docker-compose` и `docs/DEPLOY.md`; уместнее в П8 п. 3–5 вместе с гашением `STOCK_DATABASE_URL` и выводом панели `:8080` |
| Заведение 11 карточек прайса | действие владельца; техническая половина — задача 3 |
| Пороги `SHRINK_ALERT_UZS` по автоматам | какие числа — решает владелец |
| Живой запрос к OurVend по требованию | заменён здоровьем сбора (R-P5b-8); в кабинете только чтение |
| Таблица подписок и opt-off рассылки | получатели по ролям `owner`/`manager`, состав решает владелец |
| Маржа кофе, PNG/HTML-графики, поставщик и лучшая цена, горизонт склада, нечёткие алиасы имён | продуктовые решения и отсутствующие данные; нечёткое сопоставление явно отвергнуто в П8a (R-FW-P1) |
| Правка `money()` в остальных 42 местах панели | вне снек-контура, без тестов под ними (R-H-3) |
| `stock-panel.tsx`, `all-sales-view.tsx`, `prices-view.tsx` | контур сырья и лист «По источникам» — не снек-листы (R-H-3) |
| Унификация приоритета резолва между `VendingService.resolveProduct` (Core, ингест слотов/продаж — алиас главнее имени, НЕ тронут S3) и `productIndex.explain` (`@mydon/shared`, бэкфилл/импорт — имя главнее алиаса ПОСЛЕ S3) | два резолвера, две разные точки в жизненном цикле данных (ингест vs разовые скрипты пост-фактум); расхождения на сегодняшнем каталоге нет (см. §13, S3 — 0 коллизий на прод-данных), но принцип разный — унификация трогает горячий путь ингеста и заслуживает отдельного среза, а не побочной правки волны фиксов |

## 11. Открытые вопросы

Нет. Все восемь задач закрываются кодом, не требуют решений владельца и
опираются на факты, проверенные в рабочем дереве (`origin/main` c860a1c) и в
ветке `mydon-p8b`.


## 12. Аддендум после реализации

Пять мест, где код среза разошёлся с буквой этой спеки. Каждое проверено в
рабочем дереве и зафиксировано коммитами задач 1–8; смысл рулингов не менялся
ни в одном из пяти — менялись адрес, форма или недостающая деталь, без которой
спека не собиралась в код.

**1. `StockCountsReport` получил ВТОРОЕ аддитивное поле — `since: string`
(T1).** R-H-2 говорит, что единственное изменение Core — поле `note`. Но
подпись листа, которую задаёт эта же спека («Пересчёты склада за N дн. · с
ДД.ММ.ГГГГ · M строк»), без `since` печатается только двумя способами, и оба
плохи: либо панель заводит ВТОРУЮ копию правила окна (`− (дни − 1)` по
Ташкенту — прямо запрещено R-FW-11), либо подписывает окно датой самой старой
ПОКАЗАННОЙ строки, что при `history_capped` — прямая ложь. Первые сутки окна
уже вычисляются внутри `stockCounts()` и выбрасывались; отдать их наружу — три
символа диффа, и прецедент рядом: `DeadStockReport.since` живёт ровно за этим.

**2. Сторож снек-форматтеров запрещает `toLocaleString("ru-RU")` БЕЗ второго
аргумента, а не любой `toLocaleString(` (T2).** Спека формулирует сторож как
«ни одного `toLocaleString(`», но `vending-panel.tsx` форматирует этим вызовом
ДАТУ (`toLocaleString("ru-RU", { timeZone: "Asia/Tashkent", … })`), а в списке
правок R-H-3 этой строки нет вовсе — буквальный сторож упал бы на строке,
которую спека менять не просит. Проверяемое утверждение здесь другое: «лист не
заводит своего форматтера ЧИСЕЛ», и регулярка на форму без опций ловит ровно
все пять локальных форматтеров и все четыре голых числовых вызова, не трогая
единственную дату.

**3. `parityDaysInWeek` — новая чистая функция в
`packages/shared/src/parity-streak.ts` (T8).** §8 требует тест «дни серии
режутся границами недели» именно в `parity-streak.test.ts`, а нарезка по
неделе — это правило, а не вызов. Оставь фильтр инлайном в
`weekly-digest.service.ts` — и тест лёг бы не туда, где живёт код, а второе
правило «что такое сутки» встало бы рядом с уже существующим `предыдущийДень`.
Функция однострочная и чистая: сравнение голых суток `YYYY-MM-DD` строками
лексикографически совпадает с календарным порядком, поэтому второй арифметики
дат в файле не появилось.

**4. `WeeklyDigestService` получил ЧЕТВЁРТЫЙ аргумент конструктора —
`OurvendParityService` (T8).** Спека говорит «дни паритета — из
`parityStreak(...).days`», но не называет, кто их приносит. Цикла нет и правки
модуля не потребовалось: `OurvendParityService` УЖЕ провайдер и экспорт
`VendingModule`, и живёт он там ровно потому, что `OurvendModule` импортирует
`VendingModule`, а не наоборот. Правится один стенд —
`weekly-digest.service.test.ts`, где сервис собирается руками.

**5. Ссылка спеки на «место донора» в `note` поправлена (R-H-2, R-H-4).**
Спека цитирует `import-stock-history.ts:310` — по этой строке лежит `note`
ЗАКУПКИ (`note` донорской накладной). Место пересчёта складывает
`importNote(row.location_name)` в `packages/shared/src/stock-history.ts`
(докблок рядом), а в базу оно уезжает через
`packages/db/src/import-stock-history.ts`. Смысл рулинга не меняется, меняется
адрес: реализующий по цитате `:310` открыл бы не тот код.

### Замечено при реализации (на рулинги не влияет)

- **Поля `ParityDay` — `date`, `ok`, `salesChecked`, `stockChecked`, `note`.**
  Проза R-H-9 перечисляет «поля дня» русскими ключами payload (`день_ok`,
  `день_расхождений` и т. д.) — так они называются В ЖУРНАЛЕ СОБЫТИЙ, и
  `parity-streak.ts` действительно судит день по ним. Но ВИТРИННАЯ форма дня,
  на которую ссылается `WeeklyHealth.parityDays`, называет свои поля
  латиницей и поля «расхождений» не имеет вовсе — вместо него `note`. Код
  задачи 8 несуществующего поля не использует; расхождение чисто в прозе.
- **`WeeklyDigest.weekHealth` — поле ОБЯЗАТЕЛЬНОЕ, и его пришлось добавить
  ещё в две фикстуры бота**, не названные в «Files» задачи 8:
  `apps/bot/src/weekly-delivery.test.ts` (литерал типа `WeeklyDigest` — без
  поля не компилируется) и `apps/bot/src/bot.test.ts` (нетипизированный
  литерал, но форматтер сводки читает `weekHealth` первым, и без него тест
  «итоги недели» падал бы в рантайме). Необязательное поле здесь было бы
  хуже: «неделя не посчиталась» и «поля нет» — разные ответы, и второй молча
  вернул бы блок к числам момента отправки.

### Правка после ревью (fix round 1, задача 8)

Форма `WeeklyHealth` из §3 R-H-9 приросла тремя полями и одним переименованием.
Причины — по одной на каждое, все найдены ревью на реальных путях деградации.

- **`lastSuccessAt` → `lastDataAt`.** Разряд `success` считает СТРОГО
  `status === "success"`, а момент приходит из `lastSuccessRunAt`, который по
  общему правилу репозитория считает успехом и `partial` («донёс данные»).
  Неделя из одних `partial` печатала бы «успешных 0 … последний успех 23.08» —
  одно слово на два смысла в одной строке письма. Правило не менялось,
  переименовано поле.
- **`running: number` и `runs` = сумма четырёх разрядов.** `runs` считался
  длиной выборки и включал незакрытые прогоны, которых не было ни в одном из
  трёх разрядов: «прогонов 57 · успешных 54 · частичных 1 · отказов 1» не
  сходилось, а зависший прогон ПРОШЛОЙ недели — сигнал сам по себе — был
  невидим.
- **`partialWeek: boolean`.** Неделя, которая ещё идёт, отдаёт числа за
  неполные сутки, и «отказов 0» читалось бы как итог семи. Сегодня флаг
  взвестись не может (`нормализоватьНеделю` гасит текущую и будущую неделю в
  предыдущую) — он сторож на случай, если это ограничение снимут.
- **`capped: boolean` + предупреждение `history_capped`.** Потолок чтения
  (`WEEK_RUNS_LIMIT = 200`) срабатывал молча, и обрезанный счёт выглядел
  посчитанным: «отказов 3» за неделю с зациклившимся кроном увело бы владельца
  от аварии. Различить «ровно 200» и «больше 200» позволяет чтение на один
  прогон сверх потолка.

Отдельно — **дни паритета получили СВОЙ `catch`** (`WeeklyDigestService
.дниПаритета`), а не общий с прогонами. Под общим отказ скана `event`
обнулял `runs`, и письмо печатало «за неделю прогонов не было — сбор не
запускался» о неделе, в которой сбор отработал 56 раз: «не посчитали»
превращалось не в «всё хорошо», а в утверждение о несуществующем факте. Тем же
приёмом и по той же причине гасит паритет `OurvendHealthService`.

## 13. Аддендум волны фиксов «Хвосты снек-контура»

После §12 несколько параллельных adversarial-ревью волны фиксов
(`.superpowers/sdd/2026-08-26-sloy-hvosty-snek/`: `adversarial-conventions.md`,
`adversarial-security.md`, `adversarial-ux.md`, `adversarial-prod-data.md`,
`final-review.md`) нашли конкретные дефекты по путям A (`apps/core`,
`packages`, `tools`, `.env.example`), B (`apps/bot`, `apps/cc`) и C (`docs`,
этот файл). Рулинги ниже фиксируют, что волна фиксов закрывает, — не новые
решения, а дисциплина «спека остаётся правдой» из §4 плана. T8-переименование
`lastSuccessAt` → `lastDataAt` и `partialWeek` как СТОРОЖ (а не достижимый
сегодня флаг) уже описаны в «Правка после ревью (fix round 1, задача 8)» выше
и здесь не повторяются.

### S1–S3 (безопасность, `apps/core` + `packages/db` — A)

- **S1.** `packages/db/src/backfill-product-ids.ts` — белый список argv
  (`--dry-run`, `--apply`, ничего другого): нераспознанный флаг —
  `exit(1)` ДО первого запроса. Раньше опечатка вида `--dryrun` молча
  переводила скрипт в режим записи, а строка режима лгала «флагов не было».
- **S2.** `POST /system/retention/run` (`RetentionController`, путь
  `system/retention`) — под глобальным `ServiceTokenGuard`, `@Throttle({
  burst: { limit: 2, ttl: 60_000 } })`, тело `RetentionRunDto = { dryRun?:
  boolean }`, ответ `{ dryRun: boolean; tables: RetentionResult[] }` (все
  ПЯТЬ целей разом, включая «удалено 0» — `includeEmpty: true`, крон о нулях
  молчит, ручной вызов — нет). Смысл — не расписание (крон не тронут):
  единственный сырой SQL среза (`date < голые сутки`) до этого маршрута не
  исполнялся живым Postgres НИ РАЗУ — и, вскрыв это, роут сразу нашёл живой
  баг П8b (см. ниже). Шаг `tools/smoke-core.mjs` на scratch проверяет это на
  вставленной строке с `dt` на 800 суток в прошлом. Документация —
  `docs/DEPLOY.md`, раздел «Катовер учёта OurVend (П8b)». Реализовано и
  слито коммитом `9f2e29f`.
  **Найдено этим же маршрутом ДО того, как баг успел бы что-то сломать в
  проду (не в задании, но обязательный побочный фикс):** `Date` в сыром
  параметре шаблона `sql` уходит в postgres.js без типа колонки и падает ДО
  сервера («Received an instance of Date») — без фикса четыре из пяти целей
  ретенции (`slot_snapshot`, `product_sale`, `machine_sale`,
  `vending_sync_run`) обрывались бы циклом каждое воскресенье. Крон П8b
  (воскресенье 04:10 Ташкент) ЕЩЁ НИ РАЗУ не срабатывал на момент находки —
  первый плановый прогон только 31.08.2026, — так что баг не успел сломать
  что-то молча в проду: его поймал ручной маршрут S2 за несколько дней ДО
  первого настоящего крона. Юнит-стенд этого в принципе не видел (рендерит
  `JSON.stringify(params)`, а не исполняет запрос). Исправлено
  (`RetentionService.граница()` — граница всегда строка) коммитом
  `3fc4e8f`, ДО 31.08; `docs/DEPLOY.md` и `docs/PLAN_STOCK_ABSORPTION.md`
  предупреждают, что 31.08 всё равно будет ПЕРВЫМ прогоном ретенции вообще
  (не восстановлением пропусков) и почти наверняка уйдёт в `capped: true`
  на нескольких целях — штатно, не авария.
- **S3.** `productIndex.explain` (`packages/shared/src/stock-history.ts`) —
  точное каноническое имя карточки теперь проверяется ПЕРВЫМ, алиас —
  только если точного имени нет (раньше было наоборот: алиас первым мог
  молча увести чужие строки на другой товар). Если имя одновременно точно
  совпадает с ОДНОЙ карточкой и алиасом на ДРУГУЮ — это `kind: "conflict"`:
  `resolveProductIds` (`packages/db/src/backfill-product-ids.ts`) строку не
  привязывает и не кладёт в «осталось NULL», а печатает отдельной строкой
  («конфликт: «‹имя›» — это и имя карточки «‹X›», и алиас карточки «‹Y›».
  Строка НЕ привязана: уберите лишний алиас и прогоните ещё раз»).
  `--dry-run` печатает карту `raw → канон (источник: имя карточки / алиас)` —
  ровно два источника. `ourvend_name` в этой карте НЕ участвует и участвовать
  не может: такой колонки в MYDON нет вовсе (подтверждено прод-ревью,
  `adversarial-prod-data.md`) — это поле схемы ДОНОРА mydon-stock, видимое
  только импорту при прямом подключении к донору (см. правку R-H-4 выше и
  P1 ниже). Реализовано и слито коммитом `aa6ff93`.
  **Бэклог (не эта волна):** `VendingService.resolveProduct` в
  `apps/core/src/vending/vending.service.ts` (живой резолвер ингеста
  слотов/продаж) приоритет НЕ менял — там по-прежнему `aliases.get(…) ??
  name`, то есть алиас проверяется раньше имени. `productIndex.explain`
  (эта правка) и `VendingService.resolveProduct` теперь расходятся
  ПРИНЦИПОМ приоритета; на сегодняшнем прод-каталоге расхождения в
  результате нет (0 коллизий, см. прод-ревью), но унификация — отдельная
  задача, не эта волна (см. §10 «Вне охвата»).

### UX-1…6 (панель и бот — B)

Тексты — цитаты рулингов `adversarial-ux.md`. UX-1…4 и минорные тексты панели
(«История склада», «Журнал заливок») реализованы и слиты коммитом `72b1245`
(`apps/cc`); UX-6 (бот) — коммитом `7ffdde9` (`apps/bot`); UX-5 —
коммитом `37564e0` (`apps/core`, догрузка A после того, как B в своём
отчёте зафиксировал «UX-5 не мой» и указал точный файл/строки) — все три
сверены буквально с диффом или с `git show HEAD:…`.

- **UX-1.** Заголовок группы импорта без места → «место не указано» (без
  технических строк вроде «импорт истории mydon-stock»). ✅ `72b1245`.
- **UX-2.** Свои строки: подпись «кто считал» показывается, только если
  пометка не пуста и не равна `'owner'`; для `'owner'` заголовок группы —
  «владелец» (строчными — перевод системного литерала, не имя), для пустой
  пометки — «инвентаризация MYDON». ✅ `72b1245` (`шапкаГруппы` в
  `stock-history-view.tsx`).
- **UX-3.** «с {since}» печатается только когда `!history_capped`; при
  обрезке — «показаны последние N записей, с {since} — сузьте окно или
  задайте товар», где `{since}` — дата самой старой из ПОКАЗАННЫХ строк
  (`подписьОкна` считает её `reduce` по `report.rows`, а не берёт
  `report.since`). ✅ `72b1245`.
- **UX-4.** Текст без ключа настройки: «…пишет событие, когда приход в слот
  достиг порога детектора (настройка «Вендинг: порог детектора заливки», по
  умолчанию 10 шт) — пусто значит «не привозили», а не «не считали»» —
  вместо голого `REFILL_DETECT_MIN_UNITS`. ✅ `72b1245`, текст цитируется
  дословно из `refill-events-view.tsx`.
- **UX-5 (закрыт, коммит `37564e0`).** `/ourvend/health` и
  `/ourvend/parity/streak` — внутренние JSON-эндпоинты Core за докер-сетью,
  владелец их ничем не откроет; все пять строк письма теперь зовут в
  единственное живое место на его стороне — команду «сверка» боту
  (`apps/bot/src/analytics-brief.ts`, отдаёт здоровье сбора и паритет одним
  ответом). Коды предупреждений НЕ менялись (`health_unavailable`,
  `history_capped`, `journal_short`) — бот и панель гасят повторы по коду,
  не по тексту. Финальные тексты (`apps/core/src/vending/weekly-digest.service.ts`,
  общий хвост — константа `СПРОСИТЬ_БОТА = "команда «сверка» в боте"`):

  | Место | Код | Текст |
  |---|---|---|
  | `ПАРИТЕТ_ВНЕ_ОКНА` | `health_unavailable` | «Серия паритета не достаёт до этой недели (окно 14 дней) — текущее состояние: команда «сверка» в боте.» |
  | `ПРОГОНЫ_ОБРЕЗАНЫ` | `history_capped` | «Прогонов за неделю больше потолка чтения (200) — числа блока посчитаны по самым свежим прогонам окна; что со сбором сейчас — команда «сверка» в боте.» |
  | `здоровьеСбора` (отказ расчёта «сейчас») | `health_unavailable` | «Здоровье сбора не посчиталось (‹причина›) — деньги недели в письме честные, а состояние сбора сейчас покажет команда «сверка» в боте.» |
  | `дниПаритета` (отказ счёта дней недели) | `health_unavailable` | «Дни паритета за неделю ‹YYYY-WW› не посчитались (‹причина›) — прогоны сбора в письме настоящие, а сверка за эту неделю недоступна: напишите боту «сверка».» |
  | `здоровьеНедели` (внешний `catch`) | `health_unavailable` | «Здоровье сбора за неделю ‹YYYY-WW› не посчиталось (‹причина›) — деньги недели в письме честные, а состояние сбора сейчас покажет команда «сверка» в боте.» |
  | `ЖУРНАЛ_НЕ_ДОСТАЁТ` | `journal_short` | без изменений: «Журнал прогонов начинается с 06.08.2026 — за эту неделю данных нет.» (адреса роутов не нёс) |

  Новый сторож в `weekly-digest.service.test.ts` собирает предупреждения
  ВСЕХ ветвей письма разом (неделя вне окна серии, отказ дней паритета,
  отказ здоровья «сейчас», отказ журнала прогонов, обрезка по
  `WEEK_RUNS_LIMIT`) и падает на любой строке с `/ourvend/`, `/vending/`
  или `/system/` — плюс проверка, что веток набралось не меньше пяти
  (иначе сторож однажды позеленел бы на пустом списке). Находка M5
  адверсариал-UX закрыта.
- **UX-6.** Бот: строка «Прогоны (N): успешных … · частичных … · с отказом
  …» из недельного письма УБРАНА целиком (не переименована) — она считала
  последние 20 прогонов (не неделю и не момент) почти той же лексикой, что
  строка «За неделю: …» тремя строками выше; в команде «сверка» строка
  остаётся как была (это единственное её место, окно там названо самой
  командой). ✅ `7ffdde9` (`apps/bot/src/weekly-digest.ts`, `здоровье()`).
  Минорные тексты панели — убрать префикс «Журнал заливок ·» в лиде (✅
  `72b1245`, лид больше не повторяет имя вкладки), пустое состояние «Истории
  склада» с окном и подсказкой расширить (✅ `72b1245`, `ПустаяИстория`),
  предупреждение при достижении `LIST_LIMIT=500` у журнала заливок (✅
  `72b1245`, `RefillEventsView` теперь читает `{ rows, capped }`).

  **S5 (безопасность, бот — B, тоже подтверждено `7ffdde9`).** `weekHealth`
  читается через `d.weekHealth === undefined`, а не безусловным
  разыменованием: старый Core (окно рестарта, откат образа) отдаёт сводку
  БЕЗ этого поля, и раньше `w.runs` бросал бы `TypeError` — `withRetries`
  падал трижды подряд на одном месте, и понедельничное письмо не уходило бы
  вовсе (следующее — только через неделю). Теперь секция печатает «За
  неделю: здоровье недели недоступно — числа ниже только про момент», а
  деньги недели и состояние момента уходят как есть.

### FR-M1 / FR-M2 (финальное ревью — B)

- **FR-M1.** `VendingPurchase`/`VendingPurchaseItem` в
  `apps/cc/src/lib/core.ts` и `apps/bot/src/core-client.ts` — снести
  рукописные копии, реэкспорт `PurchaseSummary`/`PurchaseItem` из
  `@mydon/shared` через `as`-алиасы (тот же приём, что у `Shrink*`). ✅
  `apps/cc` слито коммитом `72b1245`, `apps/bot` — коммитом `7ffdde9` (плюс
  `AllocationPolicy` и двусторонний сторож формы).
- **FR-M2.** `apps/cc/src/components/snack-format.test.tsx` — включить
  `stock-history-view.tsx` и `refill-events-view.tsx` в список `СНЕК_ЛИСТЫ`
  (докблок `money()` обещал покрытие всех снек-листов, эти два в список не
  попали). ✅ `72b1245`.

### P1–P5 (прод-данные, read-only ревью — A/B, докблоки скрипта у A)

Замер 26.08.2026, `46.62.144.36`, только чтение (`adversarial-prod-data.md`).

- **P1.** `normalizeProductName` (`packages/shared/src/vending-calc.ts`)
  складывает десятичную запятую к точке МЕЖДУ ЦИФРАМИ (регэксп
  `/(\d),(\d)/g` — «Кофе, чай» не трогает) — на живом каталоге закрывает 4 из
  11 неразобранных имён `vending_stock_count` без единого действия владельца
  (три совпадают с уже существующей карточкой, одно — с уже существующим
  алиасом); без этого фикса владелец, следуя старой инструкции
  `docs/DEPLOY.md`, завёл бы дубль карточки (`Fanta CAN 0,25` / `Fanta can
  0.25` — уже случившийся на проде пример ровно этой ошибки). Проверено на
  каталоге (52 карточки, 109 алиасов): новых коллизий ключа — 0. ✅ `aa6ff93`.
- **P2.** `ORDER BY` истории склада получает третий ключ — `vendingStockCount.id`
  (`apps/core/src/vending/vending.service.ts`): на проде 46 пар (день, товар,
  место) содержат по ДВЕ строки (у 41 из них числа разные), и без
  тай-брейкера порядок между ними отдавал сам Postgres, не гарантированно
  одинаковый между двумя чтениями. Тест сверяет и порядок строк, и то, что
  последним ключом сортировки уехал именно PK. ✅ `aa6ff93`.
- **P3.** Своя история («История склада») копится с 26.08.2026 — два
  пересчёта владельца от 25.08.2026 предшествуют таблице
  `vending_stock_count` (она заведена миграцией, применённой 25.08.2026
  23:25 Ташкента) и в списке не появятся; видны только в
  `event.vending.stock.recounted`.
- **P4.** `WeeklyDigest.stocktakes` (поля `positions`/`lastCountedAt` — ИМЕНА
  ТЕ ЖЕ, СМЫСЛ ИЗМЕНИЛСЯ) переключён на `vending_stock_count` по `dt`
  голыми сутками — прежний счёт по `vending_stock` (перезаписной таблице
  ТЕКУЩЕГО остатка) занижал прошлые недели до нуля и «плыл» задним числом на
  каждом новом пересчёте: числа прошлых недель перестали быть нулями. ✅
  `9f2e29f` (`apps/core/src/vending/weekly-digest.service.ts`,
  `работаЗаНеделю`).
- **P5.** `WeeklyHealth.journalSince: string | null` — ташкентские сутки
  самого раннего прогона в журнале `vending_sync_run` (`null` — журнал пуст
  вовсе); без него недели раньше 06.08.2026 молча получали `runs: 0`.
  Реализовано через `firstRunAt(db)` (`apps/core/src/ourvend/sync-runs.ts`)
  и новый код предупреждения `AnalyticsWarningCode` — **`journal_short`**
  (не `health_unavailable`: там «не посчиталось», здесь «посчитано верно,
  данных за неделю не существует»), текст «Журнал прогонов начинается с
  06.08.2026 — за эту неделю данных нет.» (`ЖУРНАЛ_НЕ_ДОСТАЁТ`,
  `weekly-digest.service.ts`). Бот печатает в самой строке чисел («хвосты,
  `702e8bb`»): «За неделю прогонов нет: журнал прогонов начинается с
  {ДД.ММ.ГГГГ} — за эту неделю данных нет», а предупреждение `journal_short`
  в хвосте письма гасит ПО КОДУ (`покрытоЗдоровьем`, коммит `9ef2c1a`) — не
  по совпадению текста: первая редакция гасила по строке, третий аддендум B
  это снял. ✅ `9f2e29f` (core) + `702e8bb`/`9ef2c1a` (bot).

P6–P10 из того же прод-ревью в эту волну не входят: P6/P9 чинятся сами
накоплением новых данных (перезапуск Core, работа детектора заливок), P7/P8
— решение владельца, явно отложенное автором ревью, P10 — устаревшая шапка
докблока `packages/db/src/backfill-product-ids.ts`, правка внутри пути A, вне
охвата документации.
