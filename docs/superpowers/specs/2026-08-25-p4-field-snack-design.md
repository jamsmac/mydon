# П4 «Полевой снек-контур» — дизайн

Дата: 2026-08-25. Срез плана поглощения mydon-stock (`docs/PLAN_STOCK_ABSORPTION.md` §П4). Ветка `feat/p4-field-snack`.
Доноры: mydon-stock (бот `app/bot.py:1134-1236`, усушка `app/reports.py:345-426`), старый Prisma-проект `~/Developer/mydon_1` (леджер/планограмма/инвентаризация S3–S6, задачи S8).

## 1. Факты, от которых строится дизайн (инвентаризация 25.08, прод read-only)

| Факт | Значение | Следствие |
|---|---|---|
| Заливки снека в mydon | `vending_refill` = **0 строк за всю историю**; мастер «Заполнил автомат» — заготовки, `ready:false` (`apps/bot/src/staff-refill.ts`, `menu.ts:136-141`) | людей это не спасёт: даже когда мастер заработает, оператор будет забывать |
| Снимки слотов | `slot_snapshot` каждые **3 ч** без пропусков, 19 дней; детектор «Σ положительных дельт ≥ 10» ловит заливки чисто: 6 событий / **430 ед. за 14 дней**, вне событий — 0 | **заливка = факт снимка**, запись оператора — уточнение, не источник |
| Продажи ↔ снимки | Olma 18–24.08: `sale` 190 vs Σ отрицательных дельт 186; в дни **без заливки** сходимость ровно 0 (5 дней из 7); расходится только в дни заливок (в 3-часовом окне приход и продажи гасятся) | усушку считать **по дням без заливки**, дни заливки — только приход |
| Мёртвые автоматы | SKLAD 4S/5S/6S (`warehouse`) отдают `quantity = capacity = 199` по всем слотам | фильтр по данным (все слоты полны до 199) + по статусу |
| Себестоимость | `vending_product.purchase_price` у 52/52; `avg_cost` нет; `purchase` (журнал) — 0 строк за 14 дней, имена битые | канон цены — `purchase_price`; порог 30 000 сум по нему |
| Порог уже бьёт | Olma за 14 дней: Kinder Bueno 9 ед × 11 000 = 99 000, Qurt 6 × 6 800 = 40 800; Σ «излишков» 39 ед (артефакт окон) | порог **по позиции**, излишки не зачитываются |
| Инвентаризация автомата | нет ни таблицы, ни маршрута; `WAREHOUSE_SPEC` §1.3 явно: «НЕ делаем — два „свежих“ числа об одном факте» | снимок 3 ч делает ручной пересчёт автомата лишним |
| Перемещения | `stock_movement.kind=transfer` — 0 строк; вендинг-склад один (`vending_stock` без `warehouse_id`); из 3 складов живёт 1 | в П4 не нужны |
| Люди | реально пишут боту двое (Рустам, Volody), только кофе, 21 запись/30 дн.; `task` — 4 строки, эмиссии нет | мастер ≤ 4 нажатий, переиспользовать `machine-picker`/`numpad`; задачи — не опора |
| `machine_stock` vs `machine_slot` | 0 расхождений на 24–25.08; переключатель на свой снапшот при `OURVEND_ACCOUNTING_SOURCE=own` **уже написан** (`supply.service.ts:191-232`) | гашение связи №1 = паритет остатков + флип флага, кода мало |
| Привязки | `machine_slot.product_id` NULL 210/210, `vending_stock.product_id` NULL 20/20 | бэкфилл при ingest — иначе ренейм товара обнулит историю |
| Мониторинг синка | `vending_sync_run` с 24.08: 9× `failed`, `machines_ok=0/5`, при этом снимки пишутся | статус врёт — чинить до того, как на поток встанет детектор |

## 2. Границы

**Делаем (П4):**
1. **Детектор заливок по снимкам** (авто-факт): события `vending_refill_event` из `slot_snapshot` (по автомату и окну 3 ч: Σ положительных дельт ≥ порога), со списком слотов/товаров/дельт; идемпотентно (unique по serial+window_to), крон после каждого сбора слотов.
2. **Мастер «Заполнил автомат» в боте** (человеческий факт): вход `mrefill` → пикер автомата → чек-лист **по плану** (`GET /vending/plan` слоты этого автомата: товар → сколько) → «✅ Загрузил по плану» одним нажатием ИЛИ правка количеств нумпадом → «➕ другой товар» → «✅ Готово». Пишет `vending_refill` (существующий `POST /vending/refills`, `clientKey`, списание `vending_stock`), `performedAt = now`. Сопоставление с детектором: событие детектора в окне ±3 ч того же автомата помечается `matched_refill_id`.
3. **Усушка автомата** (`GET /vending/shrinkage?days=14`): по дням **без заливочных событий**, по товару: `expected = q_start − sales_day`, `actual = q_end` (снимки 04:00 → 04:00 следующего дня по Ташкенту, ближайшие к границам суток), `loss = expected − actual`, `value = loss × purchase_price`; агрегат по товару за период; излишки (loss < 0) показываются, в сумму не входят. Порог `SHRINK_ALERT_UZS` (config-spec, дефолт 30 000) **по позиции за период**. Дни с заливкой — «приход N ед (по снимку), записано M ед (по мастеру)».
4. **Видимость**: событие `vending.shrinkage_alert` (в утренний брифинг через `rules.ts`), событие `vending.refill_recorded` из `RefillService.create` + эмиттер `machine.low_stock` (правило уже есть); лента «Действия» — заливка уже там; CC: секция «Усушка» на вкладке «Снек» + лист `reports:shrinkage`; бот: команда «усушка» (владелец) и строка в брифинге.
5. **Гашение связи №1 (`ourvend_machine_stock`)**: паритет остатков `ourvend_stock_snapshot` ↔ `machine_stock(stock)` в `OurvendParityService` (те же 7 зелёных дней, что у продаж, один флаг); подпись «обновляется каждые 10 минут» → «раз в сутки» при `own`; после флипа (отдельный ручной шаг после 7 дней) синк `machine_stock` из stock-БД не нужен.
6. **Гигиена**: бэкфилл `product_id` в `machine_slot` при ingest и в `vending_stock` при записи (через алиасы); фильтр мёртвых автоматов (все валидные слоты `quantity == capacity`) в плане/дефиците/прогнозе/детекторе; статус `vending_sync_run` = факт (если слоты записаны, а продажи упали — `partial`, не `failed`).

**Осознанно НЕ делаем (записать в план):**
- Ручная инвентаризация автомата задним числом — снимок каждые 3 ч точнее ручного счёта; §1.3 WAREHOUSE_SPEC остаётся в силе (R-P4-1).
- Перемещения между складами — склад вендинга один, движений 0; при появлении второго живого склада — отдельный срез.
- Списание вендинг-склада по детектору — детектор не знает, откуда товар (закуп/склад); списывает только человеческая запись.
- Эмиссия задач «заправить» — П7.
- Партии/срок годности вендинга, avg_cost — отдельно.

## 3. Данные

### 3.1 Миграция 0067
```
vending_refill_event(
  id uuid pk, machine_serial text not null, machine_id uuid null→entity,
  window_from timestamptz not null, window_to timestamptz not null,   -- соседние снимки
  units int not null,            -- Σ положительных дельт по валидным слотам
  slots jsonb not null,          -- [{coilId, product, before, after, delta}]
  matched_refill_id uuid null → vending_refill,   -- человеческая запись в окне ±3ч
  created_at timestamptz default now(),
  unique(machine_serial, window_to)
)
```
`vending_refill`: без изменений (есть `performedAt`, `clientKey`, `coilId`, `source`).
`machine_slot.product_id`, `vending_stock.product_id` — заполняются кодом (без миграции).
Config-spec: `SHRINK_ALERT_UZS` (number, дефолт 30000), `REFILL_DETECT_MIN_UNITS` (number, дефолт 10).

### 3.2 Расчёты (чистые функции `@mydon/shared`, `vending-field.ts`)
- `detectRefills(snapshots: {serial, capturedAt, slots[{coilId, product, quantity, capacity}]}[], minUnits)` → события по парам соседних снимков; слот участвует, если валиден и не «мёртвый» (см. `deadMachine`).
- `deadMachine(slots)`: все валидные слоты с товаром имеют `quantity >= capacity` и слотов ≥ 10 → true.
- `shrinkageByDay(days: {date, startSlots, endSlots, sales: Map<product, qty>, refillUnits}[], prices)` → по товару за период: `lossUnits`, `lossValue`, `surplusUnits`, `daysCounted`, `daysSkipped` (с заливкой), `noPrice`.
- `matchRefill(event, refills)` — ближайшая человеческая запись того же автомата в [window_from − 3ч, window_to + 3ч].

## 4. Интерфейсы
**Core** (`apps/core/src/vending`):
- `POST /vending/refill-events/detect` (агент/крон после сбора слотов; SERVICE_TOKEN) → `{ machines, events, matched }`; `GET /vending/refill-events?days=14`.
- `GET /vending/shrinkage?days=14` → `{ from, to, threshold, machines: [{ serial, name, items: [{product, lossUnits, lossValue, surplusUnits, daysCounted, alert}], total, refillDays: [{date, detectedUnits, recordedUnits}] }] , warnings }`.
- `RefillService.create` дополнительно пишет `event vending.refill_recorded`; `SupplyService`/`plan` — эмиттер `machine.low_stock` (по `machine_slot`: слот с товаром и `quantity ≤ 1` при capacity ≥ 5) — раз в сутки, дедуп по (serial, product, day).
- Парити: `GET /ourvend/parity` дополняется блоком `stock` (dt, checkedProducts, mismatches).
- `vending_sync_run`: статус `partial` когда слоты записаны, продажи — нет.

**Бот** (`apps/bot/src`): `staff-refill.ts` — реализовать `startMachineRefill`, шаги `rf:*`, ветка `conv.flow === "refill"` в `staff.ts`, `case "mrefill"`, `onObjectPicked` для flow `refill`; `menu.ts` → `ready:true`; команда владельца «усушка» → `formatShrinkage`; брифинг: строка «📉 Усушка ≥ порога: X (Olma) 99 000 сум» при событии.
**CC**: `reports:shrinkage` лист + секция на «Снек»; в «Остатки в автоматах» — подпись частоты по источнику.

## 5. Ошибки/пробелы (видимы)
Нет снимков > 6 ч → warning `snapshots_stale`; мёртвый автомат → пропущен с причиной; продажи за день отсутствуют → день не считается (`daysSkipped`, причина); нет цены → `noPrice`; событие без записи оператора → строка «заливка без записи» в отчёте (не алерт).

## 6. Тесты
shared: детектор (границы, мёртвый автомат, порог), усушка (дни с заливкой пропущены, излишки не в сумме, порог по позиции), matchRefill; core: detect идемпотентен, shrinkage со стабом, event/rule; bot: мастер по шагам (по плану/правка/другой товар/готово/отмена, «кнопка устарела», один слот беседы), форматтер; cc: секция/лист; smoke-core пути.

## 7. Рулинги
- **R-P4-1** Инвентаризация автомата — снимок OurVend; ручной пересчёт не делаем (§1.3 WAREHOUSE_SPEC в силе).
- **R-P4-2** Заливка = факт снимка (детектор); запись оператора — уточнение и единственный источник списания склада.
- **R-P4-3** Усушка считается по дням без заливок; порог по позиции; излишки не зачитываются; цена — `purchase_price`.
- **R-P4-4** Мёртвые автоматы фильтруются по данным (все слоты полны) и по статусу.
- **R-P4-5** Перемещений между складами в П4 нет.
- **R-P4-6** Гашение `machine_stock`-синка — через паритет остатков и тот же флаг `OURVEND_ACCOUNTING_SOURCE`; флип — ручной после 7 зелёных дней по обоим потокам.
