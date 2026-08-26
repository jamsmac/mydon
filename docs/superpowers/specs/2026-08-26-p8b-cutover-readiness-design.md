# П8b «Готовность к катоверу» — дизайн

Дата: 2026-08-26. Критический путь §П8 плана поглощения: флип `OURVEND_ACCOUNTING_SOURCE=own` после 7 зелёных дней паритета, затем гашение `STOCK_DATABASE_URL`. Инвентаризации (SELECT-only): `.superpowers/sdd/2026-08-26-sloy-P8b-cutover/inventory-{monorepo,prod}.md`.

## 1. Факты (26.08.2026)

| Факт | Следствие |
|---|---|
| Зелёных дней паритета **0**: единственное событие `ourvend.parity` (25.08 08:40) — от старой сборки без половины остатков; первая полная сверка — 26.08 08:40; семь подряд → не раньше **01.09 08:40** | нужен счётчик серии из ежедневных событий и сигнал «можно флипать» — без него решение о флипе «по памяти» |
| Остатки обе стороны пишут `dt = сегодня` (зеркало 07:50, агент 08:05), паритет 08:40 режет `dt < current_date` | снимок остатков сверяется на следующее утро — это норма, но streak считать по дате события |
| Продажи: `sale` 1042 строки, все `source='ourvend'`; в режиме `own` `buildUpserts` пишет тот же `source` и ключ → 264/264 совпадений, 0 новых строк | флип продаж безопасен |
| Остатки: `ourvend_stock_snapshot` содержит SKLAD 4S (`status='warehouse'`, 34 строки, 7028 «единиц» заглушки 199); `buildStockUpserts` не фильтрует «в строю» | после флипа `machine_stock` получал бы +34 фантомных строки/сутки → фильтр на записи |
| `accountingSource()` переключает только `sale`/`machine_stock`; зеркало закупок и мост П3 (`mirrorAlive`) завязаны на наличие `STOCK_DATABASE_URL`; третий читатель донора — дозаполнение `entity.attrs` из `machines` (реестр 31 карточка уже заполнен) | порядок runbook: сначала флип `own`, потом гашение URL (мост П3 включится сам, зеркало закупок остановится — оно и так заморожено с 29.07) |
| `fetchSourceRows` берёт снапшоты за `fetched_at > now()-3d`; сторож `SyncStaleService` следит только за `vending_sync_run` (прямой сбор) | в режиме `own` падение агента 08:05 на >3 суток остановит `sale`/`machine_stock` **без события** → сторож свежести снапшота |
| `OURVEND_ACCOUNTING_SOURCE` — env-only, `system_config` знает только `VENDING_ROUTE_ORDER` | флип из панели «Система» без рестарта: ключ в `config-spec` (база важнее env) |
| Ретенции нет: `slot_snapshot` +1680/сут, `product_sale` +361/сут, `event` ~320/сут; БД 93 МБ, диск 68 % | не горит, но заведём еженедельную чистку с окном ≥ максимального потребителя (180 дн) |
| `OurvendParityService` не в `cron-shutdown.test.ts` | добавить |

## 2. Рулинги

- **R-P8b-1 Зелёный день.** День (по Ташкенту, дата события `ourvend.parity`) зелёный, если `ok = true` И `остатки_ok = true` И `остатки_сверено > 0`. События старой формы (без полей остатков) — не зелёные. Серия = число подряд идущих зелёных дней до сегодняшнего (включительно, если событие за сегодня уже есть); любой красный или пропущенный день обнуляет.
- **R-P8b-2 Счётчик и сигнал.** `GET /ourvend/parity/streak` → `{ greenDays: number, threshold: number, readyForCutover: boolean, days: [{date, ok, salesChecked, stockChecked, note}] (последние 14), lastRed: date|null }`. Порог `CUTOVER_GREEN_DAYS` (7, ключ настроек). При достижении порога — событие `ourvend.cutover_ready {greenDays, since}` один раз (дедуп: пока не было флипа — не повторять чаще раза в сутки), правило `urgency:"immediate"`: «✅ Паритет OurVend зелёный N дн. подряд — можно переключать учёт на свой снапшот («Система → OURVEND_ACCOUNTING_SOURCE = own»)». Серия и порог — в `OurvendHealth` (`parityStreak`, `cutoverThreshold`), в боте «сверка» и панели «Здоровье сбора».
- **R-P8b-3 Источник учёта — настройка.** `OURVEND_ACCOUNTING_SOURCE` становится ключом `config-spec` (`stock | own`), читается через `settingValue` (база важнее env; env — фолбэк; дефолт — `stock`, **но если `STOCK_DATABASE_URL` не задан — `own`** независимо от остального: без зеркала учёт по-другому невозможен). Кеш чтения ≤ 60 с, чтобы флип из панели применялся без рестарта к ближайшему прогону синка. Смена значения пишет событие `ourvend.accounting_source_changed {from, to, actor}` + правило immediate («учёт переключён на …»).
- **R-P8b-4 Остатки в режиме `own` — только автоматы в строю.** `buildStockUpserts`/запись `machine_stock` из снапшота отбрасывает серийники не в строю (тот же реестр `notInService`/`inServicePark`) с одной строкой лога «пропущено N строк по автоматам не в строю»; для режима `stock` поведение не меняется (зеркало таких строк не даёт).
- **R-P8b-5 Сторож свежести снапшота (режим `own`).** В `SyncStaleService` (или сосед) — вторая проверка: если `accountingSource()==='own'` и `max(ourvend_sale_snapshot.fetched_at)` старше `SNAPSHOT_STALE_HOURS` (36) → событие `ourvend.snapshot_stale {hours, lastFetchedAt}` раз в сутки, правило immediate («⛔ Учётный снапшот OurVend не обновлялся N ч — продажи и остатки стоят»); в `OurvendHealth` — `snapshotLagH` уже есть как `salesLagH` — переиспользовать, добавить `snapshotStale: boolean`.
- **R-P8b-6 Гашение `STOCK_DATABASE_URL` — отдельный шаг runbook, после ≥3 зелёных дней в `own`.** Код при отсутствии переменной уже деградирует мягко (лог + skip); проверить тестами все три читателя (sales/supply/vending bridge) и дозаполнение `entity.attrs` (skip без ошибок). Компоуз-сеть `mydon-stock_default` остаётся до П8 п.3.
- **R-P8b-7 Ретенция.** Еженедельный крон (вс 04:10 Ташкент): удалить `slot_snapshot` старше `SNAPSHOT_RETENTION_DAYS` (180), `product_sale`/`machine_sale` старше 180, `vending_sync_run` старше 365; пачками по 5000 с лимитом времени; событие `system.retention {table, deleted}` в журнал (без правила). `event` не трогать. Потребители: детектор ≤ 30 дн, усушка ≤ 60, мёртвый сток ≤ 180 — окно не режет.
- **R-P8b-8 Runbook `docs/CUTOVER.md`.** Пошагово: (0) сигнал `cutover_ready`; (1) флип в панели «Система» → проверка утром: `sale`/`machine_stock` за вчера из снапшота (числа = зеркалу), паритет зелёный, SKLAD-строк нет; (2) 3 зелёных дня в `own`; (3) убрать `STOCK_DATABASE_URL` из `.env` + рестарт → мост П3 включился, зеркало закупок остановлено, `/ourvend/health` без ошибок; (4) далее П8 п.3–5. Откат на каждом шаге (вернуть значение/переменную). Что НЕ трогать: сеть compose, БД донора.
- **R-P8b-9 Вне охвата.** Вывод панели :8080/бота склада, заморозка БД донора, чистка сети — П8 п.3–5 после катовера; ретенция `event`/`raw_row` — нет.

## 3. Данные и настройки
Ключи `config-spec`: `OURVEND_ACCOUNTING_SOURCE` (`stock|own`), `CUTOVER_GREEN_DAYS` (7, ≥1), `SNAPSHOT_STALE_HOURS` (36, ≥1), `SNAPSHOT_RETENTION_DAYS` (180, ≥90). События: `ourvend.cutover_ready`, `ourvend.accounting_source_changed`, `ourvend.snapshot_stale`, `system.retention`. Правила для первых трёх. Миграций нет.

## 4. Интерфейсы
- Core: `GET /ourvend/parity/streak`; `OurvendHealth += { parityStreak, cutoverThreshold, snapshotStale }`; `PUT /system` уже умеет ключи (панель «Система»); `SyncStaleService` — вторая проверка; `RetentionService` (крон вс 04:10); `sales.service.ts` `accountingSource()` → async через настройки с кешем.
- Бот: «сверка» — строка «паритет: N зелёных дней подряд из 7» (+ «✅ можно переключать» при готовности); панель «Здоровье сбора» — та же строка/бейдж; настройка `OURVEND_ACCOUNTING_SOURCE` в листе «Система» с подсказкой.
- Типы — в `@mydon/shared` (`OurvendHealth`, `ParityStreak`).

## 5. Проверки
Тесты: streak из событий (старая форма = не зелёный; пропуск дня обнуляет; сегодня включительно), правило и дедуп; `accountingSource()` (env/база/фолбэк без URL; кеш 60 с); фильтр «в строю» в `buildStockUpserts` (SKLAD отбрасывается, живые нет); сторож снапшота (35 ч → нет, 37 → событие, повтор в сутки — нет; в режиме `stock` — не проверяет); ретенция (границы, пачки, событие); cron-shutdown для `OurvendParityService`/новых кронов. Смоук: `GET /ourvend/parity/streak`, `/ourvend/health` новые поля. Прод после выкатки (чтения): streak → 0 или 1 (если 26.08 08:40 зелёный), `readyForCutover=false`.

## 6. Аддендум (T6, 2026-08-26) — принятые отклонения от буквы спеки

Три отклонения зафиксированы кодом (см. план `docs/superpowers/plans/2026-08-26-sloy-P8b-cutover.md`
«Три отклонения от буквы спеки, зафиксированные кодом»), спека их не
предвидела дословно:

1. **Ключа `остатки_ok` в payload `ourvend.parity` нет.** §2 R-P8b-1
   формулирует зелёный день через `остатки_ok = true`, но `daily()`
   (`ourvend-parity.service.ts`) пишет числа `остатки_сверено`/
   `остатки_расхождений`, а не готовый флаг. Зелёность остатков
   ВЫВОДИТСЯ выражением `остатки_расхождений === 0 && остатки_сверено > 0`
   — ровно то же условие, что уже стоит в `parity()` при вычислении
   `stock.ok`. Четвёртую форму одного и того же вердикта не заводили.
2. **`accountingSource` — асинхронная и требует `db`.** Спека (§4) говорит
   «`accountingSource()` → async через настройки с кешем» уже верно по
   направлению, но не называет сигнатуру: `accountingSource(db: Db, now?:
   Date): Promise<AccountingSource>`. Шесть точек вызова, включая ДВА
   `onModuleInit` (`sales.service.ts`, `supply.service.ts`), стали `async`.
3. **`SupplyService` получил второй аргумент конструктора.** Реализация
   R-P8b-4 (фильтр «в строю») тянет реестр `notInService` из
   `VendingService.machineRegistry()` — `SupplyService(db, vending)`,
   `SupplyModule.imports: [VendingModule]`. Цикла нет: `VendingModule` про
   `SupplyModule` не знает — тот же паттерн, что уже использует
   `OurvendModule`.

Четыре уточнения, которые спека не детализировала и которые понадобились
в реализации:

1. **Событие `system.retention` несёт ещё и `olderThanDays`.** Спека §3
   называет только `{table, deleted}`; без верхней границы окна число
   «удалено 1680» нечем проверить (180 суток дефолт или актуальная
   настройка панели на момент прогона) — читатель журнала не смог бы
   отличить «сработал дефолт» от «сработала панельная правка».
   `RetentionResult = { table, deleted, olderThanDays, capped }`.
2. **`SYNC_RUN_RETENTION_DAYS = 365` — константа кода, не настройка
   панели.** Спека §3 заводит один ключ окна (`SNAPSHOT_RETENTION_DAYS`);
   `vending_sync_run` — диагностическая таблица прогонов синка, не витрина
   отчётов владельцу, и второй тумблер ради неё был бы лишним рычагом без
   второго потребителя.
3. **Отдельного `GET` для ретенции нет.** Конфигурация (окно, порог)
   видна в `GET /system/config` (уже общий эндпойнт настроек), результат
   каждого прогона — в журнале событий (`system.retention`). Заводить
   третью витрину одного и того же числа не стали.
4. **`ourvend.cutover_ready` не повторяется после флипа НИКОГДА**, а не
   «раз в сутки навсегда», как можно прочитать в §2 буквально. Условие
   эмиссии — три флага одновременно: порог взят, `accountingSource() ===
   "stock"` (после флипа в `own` эмиссия не идёт вовсе, дедуп по суткам
   этого случая уже не касается), и за текущие ташкентские сутки события
   ещё не было. После флипа звать переключать уже некуда — второй сигнал
   без адресата был бы шумом.

### Рулинги волны фиксов (26.08.2026, повторный adversarial)

Источники: `.superpowers/sdd/2026-08-26-sloy-P8b-cutover/fix-wave-brief.md`,
`adversarial-prod-data.md`, `adversarial-security.md`, `final-review.md`.
Распределение по пакетам (A — core/shared/db, B — bot/cc, C — docs) — в
`fix-wave-brief.md`; ниже только сами решения, коротко.

**Критерий и паритет:**

- **R-FW-P1a** Допуск паритета остатков — `STOCK_PARITY_TOLERANCE` (ключ настроек, 3, ≥ 0): расхождение только если `own.qty > stock.qty` либо `stock.qty − own.qty` больше допуска; «в допуске» считается отдельно от «совпало».
- **R-FW-P1b** Зелёный день = `parity(1)` (поля `день_ok`/`день_продаж_сверено`/`день_остатков_сверено`/`день_расхождений` события `ourvend.parity`); `parity(7)` остаётся 7-дневной витриной (`OurvendHealth.parity`), `parityStreak` читает поля дня — событие старой формы не зелёное.
- **R-FW-P2** Свежесть снапшота считается РАЗДЕЛЬНО по `ourvend_sale_snapshot` и `ourvend_stock_snapshot`; застой любой из двух даёт событие, текст называет какую («продаж»/«остатков»).
- **R-FW-P3** Паритет после флипа: в `own` при заданном `STOCK_DATABASE_URL` сверяет свой снапшот НАПРЯМУЮ с таблицами донора (`ourvend_sales`/`ourvend_machine_stock`, `parity.mode: "own-vs-donor"`); без URL — `mode: "retired"`, `note` «зеркала нет — сверять не с чем», серия не считается, `cutover_ready` не эмитится.

**Безопасность и целостность (`adversarial-security.md` major 1–3, minor 4–10):**

- **R-FW-S1** `parityScanLimit = min(порог + 14, 400)`; валидатор `CUTOVER_GREEN_DAYS` получает потолок ≤ 60.
- **R-FW-S2** Пропуск «не в строю» при записи остатков — серийники в лог-строке и в payload `supply.sync` (`skippedNotInService`); `Logger.warn`, если множество изменилось относительно прошлого прогона.
- **R-FW-S3** Ретенция — лог на каждую удалённую пачку; `system.retention` пишется в `finally` с фактически удалённым числом, `aborted: true` при обрыве.
- **R-FW-S4** Гонка инвалидации кеша источника (сброс после коммита vs уже летящий `accountingSource()`) — задокументирована как известный риск ≤ 60 с (размер кеша), отдельным механизмом в этой волне не закрывается.
- **R-FW-S5** `GET /system/config` для `OURVEND_ACCOUNTING_SOURCE` отдаёт `effective` — действующий источник с учётом фолбэка (`own` без `STOCK_DATABASE_URL`), панель показывает именно его.
- **R-FW-S6** `streak()` фильтрует `event.source = 'ourvend-accounting'` (тем же источником пишет `daily()`) — событие, подделанное через `POST /events` любым носителем токена, в серию не попадает.
- **R-FW-S7** `POST /ourvend/snapshot`: пустой день по автомату НЕ стирает существующие строки этого дня — удаление ключа `(dt, serial)` только при замене (пришли новые строки по тому же ключу).
- **R-FW-S8** Пол `SNAPSHOT_RETENTION_DAYS` = 180 закреплён в валидаторе И в коде, не только в `help`.
- **R-FW-S9** `machine_sale` в ретенции — оставлено без изменений (принятый риск: денежная дорожка коллектора без независимых читателей, кроме самой ретенции).
- **R-FW-S10** `RetentionService`: крон получает `{ protect: true }` (тот же приём, что у `S3`/`ShrinkageService`).

**Majors из `final-review.md` (M1–M3):**

- **M1** `SalesService.onModuleInit` оборачивает чтение `accountingSource()` в `try/catch` (лог `warn`, bootstrap не прерывается отказом БД на старте); регистрация крона — безусловно.
- **M2** `SalesSummary.source: "stock" | "own"` — явное поле режима; тексты трёх витрин (`apps/bot/src/sales-brief.ts`, `apps/cc/src/components/sales-view.tsx`, `apps/cc/src/components/reports-overview.tsx`) ветвятся по режиму, а не только по переопределённому `configured`.
- **M3** `config-spec` добавляет `OURVEND_ACCOUNTING_SOURCE.options` пустую опцию `""` первым пунктом («— по умолчанию (env) —», сброс к фолбэку); откат в `docs/CUTOVER.md` основной формулировкой — «выбрать `stock`» (это исполнимо в UI-`select`), пустая опция — альтернатива.
