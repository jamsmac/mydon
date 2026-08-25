# П8a «История склада + сторож сбора» — дизайн

Дата: 2026-08-25. Часть §П8 плана поглощения (`docs/PLAN_STOCK_ABSORPTION.md`), **не зависящая от катовера** `OURVEND_ACCOUNTING_SOURCE=own`. Инвентаризации (SELECT-only): `.superpowers/sdd/2026-08-25-sloy-P8a-istoriya-sklada/inventory-{donor,monorepo,prod}.md`.

## 1. Что оказалось на самом деле (факты 25.08.2026)

| Донор mydon-stock | Строк | В mydon уже есть | Вывод |
|---|---|---|---|
| `purchases` | 342 (2025-08-18…2026-07-13, Σ 18 692 750) | `purchase` `source='stock'` 342, ключ `(source, ext_id)` — **1:1** | не импортировать; **синк заморожен** (единственный приход 29.07, дальше «приход 0»: окно по `created_at`, а все `created_at` = 15.07) → разовая сверка по `ext_id` |
| `ourvend_sales` | 1042 | `sale` `source='ourvend'` 1042 | 1:1, ничего |
| `ourvend_machine_stock` | 2788 | `machine_stock` 2788 | 1:1, ничего |
| `refills` | 455: **107 по живым автоматам** (Olma 88, AH 19), 348 на виртуальных «общих» | `vending_refill` **0** | импортировать 107; 348 — только архив |
| `stock_counts` | 603: **460 склад**, 143 по автоматам | `vending_stock` перезаписной (истории нет), `machine_stock` уже покрыт | импортировать 460 в **новую таблицу истории**; 143 — нет (конфликт с машинным снимком) |
| `sales` (ручные) | 1 (0 сум, тест) | `collection` 386 (свои) | нет |
| справочники, users, tasks | — | канон уже в `vending_product`/`vending_alias`/`entity` | нет |

Память «331/348/361/531» устарела: у донора 342/455/603/0. Инкассаций в доноре нет; их дыра (2025-07-30→2026-01-19, и ничего после 30.06.2026) — Срез К, вне П8a.

Сторож: за 24–25.08 было 12 отказов синка подряд, и никто не узнал. `ourvend.sync_failed_streak` (П5b) ловит явные `failed`; **зависший или не запускающийся коллектор** (нет ни `failed`, ни `success`) не ловит никто.

## 2. Рулинги

- **R-P8a-1 Ничего не переимпортировать.** Закупки/продажи/остатки автоматов не трогаем. Разовый `reconcile`: сверка `purchase(source='stock')` с донором по `ext_id` — отчёт «в mydon / в доноре / расхождения по qty·price·dt»; **дописать отсутствующие** (по ключу), **не удалять и не править** существующие (удалённые в доноре 39 id — известны, не воспроизводим). После сверки зеркало закупок объявляется финальным.
- **R-P8a-2 Заливы.** 107 строк по автоматам с серийником → `vending_refill`: `client_key = 'stock:refill:<id>'` (UNIQUE — идемпотентность), `machine_serial` = канон, `product_name` = канон через `vending_alias`/`normalizeProductName` (не резолвится → сырое имя + строка в отчёте), `qty`, `performed_at = dt 12:00 Asia/Tashkent`, `source = 'stock-import'`, `person_id = NULL`. Склад при импорте **не списывать** (остаток уже пересчитан владельцем 25.08; импорт — прошлое). 348 «общих» заливов — не импортировать; архив (п. R-P8a-5).
- **R-P8a-3 История инвентаризаций склада.** Новая таблица `vending_stock_count` (миграция 0069): `id`, `dt date`, `product_name` (канон), `product_id` (nullable FK), `qty numeric`, `source` (`'stock-import' | 'own'`), `ext_id` (nullable), `counted_at timestamptz`, `person_id` (nullable), `note`; UNIQUE `(source, ext_id)` для импорта и `(source, counted_at, product_name)` для своих. Импорт 460 складских `stock_counts` (`dt`, `qty`, `counted_at` донора, `ext_id = id`). **С этого среза `ingestStock` (бот «склад …», панель) пишет строку истории на каждую позицию пересчёта** — история копится сама. Чтение: `GET /vending/stock-counts?product=&days=` (для панели/бота позже; сейчас — смоук и сверка).
- **R-P8a-4 `OURVEND_EPOCH` — документ, не код.** Строки до 2026-01-01 (26 инвентаризаций напитков-2025, закупки по цене 0) импортируются как есть с их датами; в код рубеж не вводится. В `docs/DATA_SOURCES.md` — абзац «история до эпохи: ручные записи напитков 2025, цены закупа 0 = неизвестны».
- **R-P8a-5 Архив донора.** Перед гашением `STOCK_DATABASE_URL` (п. П8) снимается `pg_dump` донора в `/opt/backups/stock-archive/<дата>.sql.gz` (шаг выкатки, файловая система хоста, не БД mydon); 348 «общих» заливов и 143 машинных инвентаризаций живут там. В БД mydon — одно событие `stock.history.imported {refills, stockCounts, purchasesAdded, unresolved[]}` как отметка.
- **R-P8a-6 Сторож «нет успешного прогона».** Крон в Core каждые 30 мин (`*/30 * * * *`, Asia/Tashkent): если `lastSuccessAt` синка старше `SYNC_STALE_HOURS` (ключ настроек, 6) → событие `ourvend.sync_stale {hoursSinceSuccess, lastSuccessAt, lastRunStatus}` с дедупом раз в ташкентские сутки; правило `urgency:"immediate"` «⛔ Сбор OurVend: нет успешного прогона N ч (последний …)». `OurvendHealth` получает `staleHours` (число) — бот «сверка» и панель «Здоровье сбора» показывают предупреждение при `staleHours ≥ порога`. Порог читается `readIntSetting`, база важнее env.
- **R-P8a-7 Имена товаров.** Только точное сопоставление (алиасы + нормализация). 14 имён истории без `ourvend_name` (Flash/Laimon/Moxito CAN 0.45, `M&amp;Ms`, `O&#39;zbegim`, «Недостача (Рустам)») → импортируются с сырым именем и `product_id = NULL`, список печатается в отчёте и уходит в событие; HTML-энтити (`&amp;`, `&#39;`) декодируются перед нормализацией. «Недостача (Рустам)» — служебная строка, в `vending_stock_count` не импортируется (отчёт: «пропущено служебных N»).
- **R-P8a-8 Идемпотентность и порядок.** Один скрипт `packages/db/dist/import-stock-history.js` с флагами `--dry-run` (отчёт без записи) и `--apply`; читает `STOCK_DATABASE_URL` (read-only), пишет `DATABASE_URL`; повторный `--apply` → 0 новых. Порядок на проде: `--dry-run` → просмотр отчёта → `--apply` → архив pg_dump → (позже, П8) гасить `STOCK_DATABASE_URL`.
- **R-P8a-9 Не в этом срезе.** Гашение `STOCK_DATABASE_URL`, вывод панели :8080 и бота склада, заморозка БД — после катовера (П8); лист истории склада в панели — бэклог (данные уже будут); инкассации — Срез К.

## 3. Данные

- Миграция **0069** `vending_stock_count` (см. R-P8a-3) + индекс `(product_name, dt)`; регистрация в `schema`, страж-тест.
- `vending_refill.source` — если колонки нет, добавить `source text not null default 'own'` в 0069 (проверить схему: у заливок есть `client_key` UNIQUE, `person_id` nullable).
- Ключ настроек `SYNC_STALE_HOURS` (6, ≥ 1).
- События: `stock.history.imported`, `ourvend.sync_stale`; правило для второго.

## 4. Интерфейсы

- `packages/db/src/import-stock-history.ts` → `dist/import-stock-history.js [--dry-run|--apply]`: читает донор (`refills` ⋈ `machines` ⋈ `products`; `stock_counts` где `machine_id IS NULL` ⋈ `products`; `purchases` ⋈ `products`), пишет `vending_refill`, `vending_stock_count`, добивает `purchase`; печатает отчёт (таблица источник → найдено / записано / пропущено / не разрешено) и `process.exit(0)`. Чистая логика маппинга — в `packages/shared/src/stock-history.ts` (`mapRefill`, `mapStockCount`, `reconcilePurchases`, `decodeHtml`), покрыта тестами на фикстурах из донора (включая `[слит→N]`, HTML-энтити, серийник `C…`, дубли по естественному ключу — оставлять оба).
- Core: `GET /vending/stock-counts?product=&days=` (1..365, default 90) → `{ rows: [{dt, product, qty, source, countedAt}], warnings }`; `ingestStock` пишет историю; `OurvendHealth.staleHours`; крон и правило.
- Бот: «сверка» — строка «⛔ сбор стоит N ч» при `staleHours ≥ SYNC_STALE_HOURS`; панель: бейдж в «Здоровье сбора».

## 5. Проверки и приёмка

Тесты shared (маппинг), db (страж схемы, no-op мигратора), core (история при пересчёте, стораж: 5 ч → нет, 7 ч → событие, повтор в сутки → нет, следующие сутки → событие), bot/cc (тексты). Смоук: `GET /vending/stock-counts`, пересчёт → строка истории; скрипт импорта на scratch-БД с **фикстурным донором** (создать в той же scratch-БД схему `stock_donor` с таблицами `products/machines/refills/stock_counts/purchases` и 5–10 строками; `STOCK_DATABASE_URL` указывает на неё). Прод: `--dry-run` → ожидаем «refills 107 (unresolved ≤ 14 имён), stock_counts 460, purchases +0» → `--apply` → `vending_refill` 107, `vending_stock_count` 460 (+20 своих после ближайшего пересчёта).

## 6. Выкатка

1. PR → CI → squash → деплой (0069). 2. `docker compose … run --rm mydon-core node packages/db/dist/import-stock-history.js --dry-run </dev/null` → отчёт. 3. `--apply` (ЗАПИСЬ по плану). 4. Архив: `docker exec mydon-stock-db-1 pg_dump -U mydon mydon | gzip > /opt/backups/stock-archive/2026-08-26.sql.gz` (ЗАПИСЬ на ФС хоста). 5. Проверка: `GET /vending/refill-events?days=60` — 107 записей оператора видны как `vending_refill` (матчинга задним числом нет — окна детектора старше); `GET /vending/stock-counts?days=400` — 460 строк; `GET /ourvend/health` — `staleHours` < 6. 6. Память/план: числа донора 342/455/603/0; П8 п.1 — закрыт.

## Addendum после реализации (25.08)

Спека и план фиксировали намерение до кода; ниже — расхождения, которые
приняла реализация (T1/T3/T4), и почему они не портят рулинги R-P8a-1…9.

**Из Global Constraints (три отклонения):**

1. **`vending_refill.source` уже существовала** (`schema.ts`, `text("source").default("bot").notNull()`,
   было — «bot | panel»). Спека §3 допускала оба исхода. Новую колонку в
   0069 не заводили — только дописали JSDoc до «bot | panel | stock-import
   (разовый перенос истории mydon-stock, П8a)».
2. **Оба UNIQUE у `vending_stock_count` — частичные, не сплошные.**
   Сплошной `(source, counted_at, product_name)` отверг бы законные
   донорские дубли (5 групп дублей `stock_counts` по (dt, место, товар,
   qty) — реальность донора, не ошибка ввода, `inventory-donor.md` §2, §4.4).
   Ключ импорта — `(source, ext_id) WHERE ext_id IS NOT NULL`; ключ своих —
   `(source, counted_at, product_name) WHERE source = 'own'`.
3. **`OurvendHealth.staleHours: number | null` + `staleThresholdH: number`**,
   а не просто число. `null` = «успешных прогонов не было вовсе» — это не
   0 ч (тот же урок, что у `slotsLagMin`, R-P5b-8). `staleThresholdH` едет в
   ответе рядом, а не копией константы у каждого читателя: иначе бот и
   панель завели бы ЧЕТВЁРТУЮ копию шестёрки (`LAG_ALERT_H`/`HEALTH_LAG_HOURS`
   — про свежесть СНИМКОВ, а не про застой сбора; путать их нельзя).

**Способ запуска (два уточнения):** команда — `docker exec -i mydon-core`
(конвенция `DEPLOY.md:89`, разовый скрипт запускается в уже поднятом
контейнере тем же паттерном, что `migrate.js`), а не `docker compose run --rm`
из §6 черновика. Отдельного события `stock.refill.aggregate` (рекомендация
`inventory-donor.md` §5 для 348 «общих» заливов) не заводим: спека знает
ровно одну отметку `stock.history.imported {refills, stockCounts,
purchasesAdded, unresolved}`; 348 заливов и 143 инвентаризации по автоматам
живут только в архивном `pg_dump`, второй записи в БД для них нет.

**Из Task 3 (`import-stock-history.ts`), сверх Global Constraints:**

4. **`onConflictDoNothing({ where })`, не `targetWhere`.** У drizzle 0.45
   предикат частичного индекса в `onConflictDoNothing` называется `where`
   (`targetWhere` существует только у `onConflictDoUpdate` и вовсе не
   собирается). Итоговый SQL — `on conflict ("source","ext_id") where
   "ext_id" is not null do nothing`, исполнен настоящим Postgres в
   `tools/smoke-import.mjs`. План (Task 3/Task 4 «Interfaces») называл его
   `targetWhere` — поправлено там же, где встречалось.
5. **Событие `stock.history.imported` пишется на ФАКТ переноса, а не на
   факт запуска.** Повторный `--apply`, не записавший ни строки, второй
   отметки не оставляет — иначе журнал наполнялся бы нулевыми «импортами»
   при каждом перезапуске выкатки. Проверено тестом и смоуком: «после двух
   `--apply` событий ровно 1».
6. **Общей транзакции на весь перенос нет** (спека предполагала «одна
   транзакция на вид»). Каждая пачка идемпотентна по своему уникальному
   ключу — оборванный прогон чинится повтором; одна трёхсотстрочная
   транзакция дала бы только длинную блокировку без выигрыша в
   надёжности.
7. **Дробный `qty` заливов откладывается поимённо.** `refills.qty` у
   донора — `NUMERIC`, `vending_refill.qty` — `INTEGER`; дошедшая до
   Postgres дробь уронила бы всю пачку. Такие `id` уезжают в
   `refills.fractionalQty` (единственное расширение интерфейса `ImportSection`
   сверх плана) и печатаются отдельной строкой отчёта — решение по ним за
   владельцем, разовый импорт их не округляет и не пропускает молча.

**Число, уточнённое реализацией:** черновик §6/плана ожидал в `--dry-run`
«инвентаризации склада: найдено 461, служебных 1» (предполагая, что
служебная строка «Недостача (Рустам)» встретится среди `stock_counts`). SQL
Task 3 уже фильтрует `machine_id IS NULL` до подсчёта, а «Недостача
(Рустам)» у донора лежит в `purchases`, не в `stock_counts` — фактический
отчёт: найдено **460**, к записи **460**, служебных **0**. Числа R-P8a-3
(«460 складских») это не меняет — расхождение было только в разбивке
«найдено vs. служебных».

**Из Task 4 (`apps/core`), сверх Global Constraints:**

8. **Новый файл `apps/core/src/ourvend/sync-runs.ts`** (`lastSuccessRunAt()`,
   `lastRunStatus()`) — сверх карты файлов плана. Причина: запрос
   «последний успех» нужен и `SyncStaleService`, и `OurvendHealthService`;
   держать его в одном из них означало бы, что второй модуль его
   импортирует, а `OurvendHealthService.health()` внутри гоняет весь сырой
   SQL паритета — звать его из крона каждые 30 минут ради одной даты было
   бы платой ни за что. Третий модуль убирает выбор «кто у кого в
   зависимости» и делает граф ациклическим.
9. **Окно `GET /vending/stock-counts?days=` — «последние N суток ВКЛЮЧАЯ
   сегодня»** (`dt >= tashkentDay(now) − (days−1)`), как у отчёта о мёртвом
   стоке. Спека и план (Task 4 «Что обязана делать реализация») писали
   `− days`; разница в один день закреплена тестом и комментарием в коде —
   это то же соглашение, что уже действует для остальных суточных окон
   вендинга, и второе, конкурирующее, заводить не стали.

Ни одно из отклонений не меняет ни одной из цифр R-P8a-1…9 (342/107/460/455/603)
и не расширяет то, что срез пишет на прод: единственные записи по-прежнему
только `--apply` (шаг 3 выкатки) и `pg_dump`-архив (шаг 4).
