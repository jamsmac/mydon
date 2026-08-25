# П5b «Аналитика снек-контура» — дизайн

Дата: 2026-08-25. Срез плана поглощения `docs/PLAN_STOCK_ABSORPTION.md` §П5 (после П5a «Что купить», П4 «Полевой снек-контур»).
Донор: `~/Developer/mydon-stock/app/reports.py` (`margin_by_machine` 567, `dead_stock` 591, `price_changes` 622, `price_dynamics` 551, `weekly_extras_text` 655, `digest_text` 814), `price_gap_report.py`, `ourvend.py:221–302`.
Инвентаризации: `.superpowers/sdd/2026-08-25-sloy-P5b-analitika/inventory-{donor,monorepo,prod}.md`.

## 1. Зачем и что решает

Владелец видит деньги снек-контура: **маржу по автоматам и товарам**, **мёртвый сток**, **изменения цен** (закупочных и витринных), **разрыв витрины с эталоном**, получает **недельную сводку** в понедельник и видит **здоровье сбора OurVend** (сегодня 12 отказов подряд никто не заметил). Всё считается ядром один раз, бот и панель показывают одни и те же числа.

## 2. Факты прода, на которых стоит дизайн (25.08.2026)

| Факт | Следствие |
|---|---|
| Деньги есть: `sale.amount`/`qty` (545 строк/30 дн, 8 974 000 сум), `purchase_price` 52/52, алиасы 34/34 → покрытие себестоимости 100 % | маржа считается без новых данных |
| `product_sale`/`machine_sale` — скользящие 7-дневные окна, суммирование по `captured_at` завышает ×36 | **все деньги — только из `sale`** (R-P5b-1) |
| `sale.dt` = закрытый бизнес-день Ташкента; БД в UTC | границы дней/недель задавать явно по Ташкенту (shared `tashkent-time.ts`) |
| Витринной цены нет ни в одной таблице; факт витрины выводим = `amount/qty`, у всех 34 SKU одинаков на обоих автоматах | `price_gap` невозможен без эталона → колонка `vending_product.sale_price` (R-P5b-6) |
| Истории закупочных цен нет: `vending_purchase_order` пуст, событий по цене 0 | взвешенная себестоимость — по мере появления накладных; сейчас — текущая `purchase_price` (R-P5b-2) |
| SKLAD 4S/5S/6S (`status≠in_service`) отдают заглушки 7960 «единиц» и 45 млн сум «остатка» | фильтр `in_service` во всех отчётах остатков и продаж (R-P5b-1) |
| Кофейные автоматы: `coffee_sale` пуст | отчёты честно называют себя «снек-автоматы (OurVend)» (R-P5b-9) |
| Синк OurVend падает с 24.08 (аборт приёма слотов 10 с); `urgency:"weekly"` объявлен, но никем не доставляется; подписок нет, но у всех 7 person есть `tg_chat_id` и работает `notification_delivery` | хот-фикс синка отдельно (PR до П5b); недельный канал — сделать; получатели — по ролям (R-P5b-7, R-P5b-8) |

## 3. Рулинги

- **R-P5b-1 Источник денег и множество автоматов.** Выручка/штуки — `sale` (`dt`, `machineSerial` канон, `product` канон через `vending_alias`, `qty`, `amount`). Автоматы — только `machine_card.status = 'in_service'` и с продажами/остатком в окне; остатки в автоматах — `machine_stock` (последний день) тех же автоматов. `product_sale`/`machine_sale`/`machine_slot` в денежной аналитике не используются.
- **R-P5b-2 Себестоимость товара.** `costIndex()`: (1) взвешенная по принятым накладным `vending_purchase_order` за `COST_WINDOW_DAYS` (90) — `Σ(price×qty)/Σqty` из `positions` со `received_at` в окне; (2) иначе `vending_product.purchase_price`; (3) иначе «без себестоимости» (штуки считаются в `unknownUnits`, в маржу не входят; **0 ≠ известная цена**). Сегодня (1) пусто, работает (2) — 100 % покрытие.
- **R-P5b-3 Маржа.** По проданному (донор): `revenue = Σamount`, `cogs = Σ qty×cost`, `margin = revenue − cogs`, `pct = margin/revenue`. Разрезы: автомат → товар; товар → автоматы. Окно по умолчанию 30 дней (1..90). Отрицательная маржа и маржа < `MARGIN_LOW_PCT` (15) помечаются ⚠️.
- **R-P5b-4 Мёртвый сток.** Окно `DEAD_STOCK_DAYS` (21). Товар «двигался», если в окне есть продажа (`sale`), заливка по снимкам (`vending_refill_event.slots[].product`) или принятая накладная с ним. Позиции: склад (`vending_stock.quantity>0`) и автоматы в строю (`machine_stock` последний день, qty>0). Оценка по `costIndex`; без цены — «цена закупки неизвестна». Флаг глобален по товару для склада; по автоматам — по паре (автомат, товар): товар может стоять в одном автомате и продаваться в другом.
- **R-P5b-5 Изменения цен.** Две ленты за окно (30 дн, 1..180): **закупочные** — из событий `vending.price_changed` (бот «цена») и из принятых накладных (цена позиции против `purchase_price` на момент приёмки; для этого `receiveOrder` начинает писать `vending.purchase_price_observed {product, price, orderId}`); **витринные** — из `sale`: цена дня = `amount/qty` (округление до 1 сум), переход день-к-дню с |Δ| > `PRICE_CHANGE_PCT` (5). Донорский «динамика по месяцам» — только в панели: средняя витринная и закупочная по месяцам.
- **R-P5b-6 Витрина против эталона.** Миграция 0068: `vending_product.sale_price numeric(12,2) null` (эталон витрины, слово владельца). Писатели: бот «цена продажи <товар> <сум>» (без гейта ±20 %, но с подтверждением «точно» при |Δ|>20 % от факта); бот «витрина как факт» — заполняет `sale_price` = факт за 14 дней для товаров без эталона (одноразовый бутстрап, печатает список). Отчёт `price_gap`: факт (14 дн) против `sale_price`; разрыв > `PRICE_GAP_PCT` (5) → строка; `lost = (sale_price − fact) × qty` для положительных разрывов; товары без эталона — отдельным списком «эталон не задан» (не нулевая строка). В OurVend ничего не пишем (R-OV read-only).
- **R-P5b-7 Недельная сводка.** Понедельник 08:05 Ташкент, окно — предыдущая ISO-неделя (пн–вс по Ташкенту). Состав: выручка/штуки/маржа по автоматам и Δ к прошлой неделе; топ-5 и худшие-3 товара по марже; заливки (по снимкам / записано мастером); приходы (принятые накладные); инвентаризации склада; мёртвый сток (топ-5 по оценке); изменения цен за неделю; здоровье сбора (успех/отказ прогонов, лаг снапшота, паритет). Доставка: бот, всем `person` с ролью `owner`/`admin` и `tg_chat_id`, дедуп `notification_delivery` ключом `weekly-digest:<IYYY-IW>:<personId>`; повтор по требованию — команда «итоги недели». События правил с `urgency:"weekly"` (сегодня `sales.drop`) подмешиваются в сводку тем же механизмом, что `briefing`-сигналы (ack только показанных). Подписки как таблица — не заводим (по ролям; opt-out — бэклог).
- **R-P5b-8 Здоровье сбора OurVend вместо «живой сверки».** Живого запроса к OurVend из бота нет (коннектор живёт в агентах по крону) — не переносим. Вместо этого: `GET /ourvend/health` (последние N прогонов `vending_sync_run`, серия отказов, лаг `slot_snapshot`/`ourvend_sale_snapshot`, паритет за 7 дней), правило `ourvend.sync_failed_streak` (`urgency:"immediate"`) при ≥3 отказах подряд (эмитит Core после каждого прогона с `failed`), команда бота «сверка» = паритет + здоровье. «Живая сверка по требованию» — бэклог.
- **R-P5b-9 Кофе вне охвата.** Все тексты и заголовки — «снек-автоматы (OurVend)»; кофейные автоматы не упоминаются как «нет данных».
- **R-P5b-10 Один расчёт, общие типы.** Формы ответов новых отчётов — в `@mydon/shared` (`vending-reports.ts`), Core их отдаёт, бот и панель импортируют типы оттуда (не дублируют трижды, как план П5a).
- **R-P5b-11 Настройки, не константы.** `DEAD_STOCK_DAYS=21`, `PRICE_CHANGE_PCT=5`, `PRICE_GAP_PCT=5`, `COST_WINDOW_DAYS=90`, `MARGIN_LOW_PCT=15` — ключи `config-spec.ts`, панель «Система», база важнее env; читаются `readIntSetting`.

## 4. Данные

- Миграция **0068**: `vending_product.sale_price numeric(12,2) null` (+ CHECK `sale_price > 0`); индекс `event(type, occurred_at)` уже есть.
- Новые события: `vending.sale_price_changed {product, oldPrice, newPrice, actor}`; `vending.purchase_price_observed {product, price, orderId, receivedAt}` (пишется в `receiveOrder`); `ourvend.sync_failed_streak {streak, lastError, since}`.
- Таблиц подписок нет; `notification_delivery` — существующий дедуп.

## 5. Алгоритмы (чистые функции в `packages/shared/src/vending-reports.ts`)

- `marginByMachine(rows: SaleRow[], cost: CostIndex, opts)` → `MarginReport { days, from, to, machines: MarginMachine[], products: MarginProduct[], totals, unknownUnits }`.
- `deadStock(stockRows, machineStockRows, movementKeys: Set<product|machine:product>, cost, days)` → `DeadStockReport { days, warehouse: DeadRow[], machines: DeadRow[], totalValue, noPriceCount }`.
- `priceChanges(purchaseEvents, retailDaily, pct)` → `PriceChangesReport { purchase: Change[], retail: Change[] }`; `retailDaily` строится из `sale` (цена дня = round(amount/qty)).
- `priceGap(retailFact14, salePrices, pct)` → `PriceGapReport { rows: Gap[], noReference: string[], lostTotal }`.
- `weekCompare(current: WeekTotals, previous: WeekTotals)` → Δ штуки/выручка/маржа с знаками; `isoWeekTashkent(date)`.
- Все функции без БД, покрыты тестами с фикстурами, повторяющими прод (SKLAD-заглушка, товар без цены, `amount/qty` не кратно 1000).

## 6. Интерфейсы

Core (`apps/core/src/vending/analytics.service.ts`, `analytics.controller.ts`):
- `GET /vending/margin?days=30` → `MarginReport`
- `GET /vending/dead-stock?days=21` → `DeadStockReport`
- `GET /vending/price-changes?days=30` → `PriceChangesReport` (+ `monthly` для панели)
- `GET /vending/price-gap?days=14` → `PriceGapReport`
- `POST /vending/sale-price {product, price, confirmed?}` (ServiceTokenGuard) → `{ product, oldPrice, newPrice }`; `POST /vending/sale-price/bootstrap {days?}` → `{ set: [...], skipped: [...] }`
- `GET /vending/weekly-digest?week=IYYY-IW` → `WeeklyDigest` (JSON; текст собирает бот)
- `GET /ourvend/health` → `OurvendHealth { runs: [...], failedStreak, lastSuccessAt, slotsLagMin, salesLagH, parity }`
- Кеш 5 мин + single-flight + троттл (как усушка) на все GET-отчёты.
Бот (владелец): «маржа [N]», «мёртвый сток», «цены [N]», «витрина», «цена продажи <товар> <сум> [точно]», «витрина как факт», «итоги недели», «сверка»; HELP. Сводка в пн 08:05 (планировщик как у брифинга, `withRetries`).
Панель: лист `reports:margin` («Маржа»), `reports:dead_stock` («Мёртвый сток»), `reports:prices` («Цены»: изменения, витрина против эталона, динамика по месяцам); у «Правил закупа» — колонка «Витрина (эталон)» только для чтения; секция «Здоровье сбора» на вкладке «Снек». Лист `reports:cost` (кофе) не трогаем.

## 7. Ошибки и пустые состояния

Нет продаж в окне → «продаж за N дн. нет» (не нули как «всё хорошо»); автомат без остатка на последний день → пропуск с предупреждением `stock_missing`; товар без себестоимости → `unknownUnits` и список; `sale_price` не задан → «эталон не задан»; Core недоступен → «Core не ответил» (как у усушки); отказ сбора ≥3 подряд → немедленный сигнал владельцу.

## 8. Тесты и приёмка

Shared: фикстуры из прод-чисел (маржа Olma 1 621 385 / 27.6 %, dead_stock 5 строк / 290 500 сум, витринный переход LaimonFresh 15000→12000). Core: стабы как в `vending.service.test.ts`; smoke-core — все GET и обе записи; smoke-panel — три листа. Бот: тексты и резка ≤ 3500; недельная сводка — дедуп по ключу и «ack только показанных». Adversarial перед PR: прод-данные (SELECT), безопасность, UX, конвенции.

## 9. Вне охвата (бэклог)

Живой запрос к OurVend по требованию; подписки/opt-out; маржа кофе; PNG-графики; поставщик и лучшая цена за 90 дней; горизонт склада N дней; нечёткие алиасы.
