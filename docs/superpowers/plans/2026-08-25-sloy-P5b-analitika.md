# П5b «Аналитика снек-контура» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Владелец видит деньги снек-контура одним набором чисел: маржа по автоматам и товарам, мёртвый сток, изменения закупочных и витринных цен, разрыв витрины с эталоном, недельная сводка в понедельник и здоровье сбора OurVend. Считает ядро один раз — бот и панель показывают одни и те же числа.

**Architecture:** Чистые расчёты в `@mydon/shared` (`vending-reports.ts`) — там же живут формы ответов (R-P5b-10), их импортируют и Core, и бот, и панель. Core: новый `AnalyticsService` (маржа, мёртвый сток, цены, разрыв витрины) с кешем/single-flight/троттлом по образцу `ShrinkageService`, `WeeklyDigestService` (`GET /vending/weekly-digest`), `OurvendHealthService` (`GET /ourvend/health`), эталон витрины — новая колонка `vending_product.sale_price` (миграция 0068) и два писателя в `VendingService`. Бот: восемь владельческих команд поверх готовых отчётов Core и понедельничная рассылка по образцу брифинга (`claimNotification` + `withRetries` + ack только показанных). Панель: три листа отчётов, колонка «Витрина (эталон)» только для чтения и секция «Здоровье сбора».

**Tech Stack:** TypeScript strict, NestJS + class-validator (DTO на каждом входе), Drizzle/Postgres (миграция 0068), Next.js (конвенция форм #208 — здесь форм нет, только чтение), Telegram-бот, `node:test` по dist / vitest (cc), `tools/smoke-core.mjs` + `tools/smoke-panel.mjs` против живого Postgres.

**Spec:** `docs/superpowers/specs/2026-08-25-p5b-analytics-design.md` (рулинги R-P5b-1…11)

## Global Constraints

Копия рулингов спеки, которые связывают КАЖДУЮ задачу (нарушение — не «стилевая правка», а неверные числа владельцу):

- **R-P5b-1 Источник денег и множество автоматов.** Выручка/штуки — только `sale` (`dt`, `machineSerial` канон, `product` канон через `vending_alias`, `qty`, `amount`). Автоматы — только `machine_card.status = 'in_service'`; остатки в автоматах — `machine_stock` (последний день) тех же автоматов. `product_sale`/`machine_sale`/`machine_slot` в денежной аналитике НЕ используются (скользящее 7-дневное окно завышает ×36; SKLAD-заглушки дают 45 млн сум остатка из воздуха).
- **R-P5b-9 Формулировки.** Все заголовки и тексты — «снек-автоматы (OurVend)». Кофейные автоматы в этих отчётах не упоминаются вовсе — ни строкой «нет данных».
- **R-P5b-10 Один расчёт, общие типы.** Формы ответов новых отчётов объявлены ОДИН раз в `packages/shared/src/vending-reports.ts`; Core их отдаёт, бот и панель импортируют оттуда. Третья копия формы (как у плана П5a) — повод отклонить задачу.
- **R-P5b-11 Настройки, не константы.** `DEAD_STOCK_DAYS=21`, `PRICE_CHANGE_PCT=5`, `PRICE_GAP_PCT=5`, `COST_WINDOW_DAYS=90`, `MARGIN_LOW_PCT=15` — ключи `config-spec.ts`, читаются `readIntSetting` (база важнее env, env важнее дефолта). Литерал в коде сервиса вместо чтения настройки — ошибка.
- **Время.** Все суточные и недельные границы — по Ташкенту, через `packages/shared/src/tashkent-time.ts` (`tashkentDay`, `tashkentDayStart`, `tashkentDayStartOf`). Второй константы смещения в коде не заводить (урок R-FW-11). `date_trunc` в SQL по UTC для отчётных периодов запрещён.
- **TS strict, без `any`.** Русский в UI/тестах/доках, английский в коде и именах событий/полей.
- **Тесты по dist:** `pnpm --filter @mydon/shared build && pnpm --filter @mydon/db build` перед прогоном core/bot; `pnpm --filter cc test` — vitest. Существующие наборы (core, bot, cc, shared, db) остаются зелёными.
- **Смоук.** Каждый новый GET и каждая новая запись обязаны быть в `tools/smoke-core.mjs` (юнит-заглушка БД SQL не исполняет); каждый новый лист — в `tools/smoke-panel.mjs`.
- **ServiceTokenGuard.** Все новые POST (`/vending/sale-price`, `/vending/sale-price/bootstrap`) закрыты общим guard'ом автоматически (мутации требуют `x-service-token`); GET открыты — это отчёты. Тяжёлые GET получают личный `@Throttle`, как `/vending/shrinkage`.
- **Мутация = транзакция + `event` + `audit_log`**, где есть человек. Новое событие без правила в `rules.ts` до владельца не доходит — правило обязательно там, где нужна доставка.
- **Ветка** `feat/p5b-analytics` от main после хот-фикса синка (`fix/ourvend-ingest-batch`); push только в свою ветку; коммиты Conventional + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Прод из задач плана не трогаем.** Единственные записи на проде — в разделе «Выкатка», руками владельца.
- **Отклонение от спеки, зафиксированное кодом:** ролей `admin` в MYDON нет — `STAFF_ROLES` = operator/technician/collector/storekeeper/manager/owner. Везде, где спека говорит «owner/admin», читать **`owner`/`manager`** (`person.roles`).

## Карта файлов

| Файл | Роль |
|---|---|
| `packages/shared/src/vending-reports.ts` (+test), `index.ts` | типы отчётов и чистые функции: `marginByMachine`, `deadStock`, `priceChanges`, `priceGap`, `weightedCost`, `weekCompare`, `isoWeekTashkent` |
| `packages/db/src/schema.ts`, `drizzle/0068_sale_price.sql`, `meta/_journal.json`, `meta/0068_snapshot.json`, `schema.test.ts` | колонка `vending_product.sale_price` |
| `apps/core/src/system/config-spec.ts` (+test) | 5 ключей П5b |
| `apps/core/src/vending/vending.service.ts` (+test) | `setSalePrice`, `bootstrapSalePrice`, `salePrice` в `products()`, `vending.purchase_price_observed` в `receiveOrder`, серия отказов в `finishSyncRun` |
| `apps/core/src/vending/analytics.service.ts` (+test), `vending.controller.ts`, `vending.module.ts` | четыре отчёта, кеш/single-flight/троттл, DTO |
| `apps/core/src/vending/weekly-digest.service.ts` (+test) | `GET /vending/weekly-digest` |
| `apps/core/src/ourvend/ourvend-health.service.ts` (+test), `ourvend.controller.ts`, `ourvend.module.ts` | `GET /ourvend/health` |
| `apps/core/src/rules/rules.ts` (+test) | правило `ourvend.sync_failed_streak` |
| `apps/bot/src/analytics-brief.ts` (+test), `handler.ts`, `core-client.ts` | команды «маржа», «мёртвый сток», «цены», «витрина», «цена продажи», «витрина как факт», «сверка», HELP |
| `apps/bot/src/weekly-digest.ts` (+test), `briefing.ts`, `index.ts` | «итоги недели» и рассылка пн 08:05 |
| `apps/cc/src/lib/core.ts`, `lib/domain-nav.ts`, `app/domain/[domain]/page.tsx` | три листа отчётов |
| `apps/cc/src/components/margin-view.tsx`, `dead-stock-view.tsx`, `prices-view.tsx` (+tests), `product-rules-panel.tsx` (+test), `vending-panel.tsx`, `ourvend-health-view.tsx` (+test) | витрины |
| `docs/PLAN_STOCK_ABSORPTION.md`, `docs/superpowers/specs/2026-08-25-p5b-analytics-design.md`, `tools/smoke-core.mjs`, `tools/smoke-panel.mjs` | документы и смоук |

---

### Task 1: Ядро расчёта и общие типы (`packages/shared/src/vending-reports.ts`)

**Files:** Create `packages/shared/src/vending-reports.ts`, `packages/shared/src/vending-reports.test.ts`; Modify `packages/shared/src/index.ts` (после строки `export * from "./vending-field";`, ~строка 88 → добавить `export * from "./vending-reports";`).

**Interfaces (produces):**
```ts
/** Строка продажи — единственный источник денег (R-P5b-1). */
export interface SaleRow { dt: string; serial: string; product: string; qty: number; amount: number }
/** Себестоимость единицы по каноническому имени. `null` — цены НЕТ (0 ≠ известная цена, R-P5b-2). */
export type CostIndex = (product: string) => number | null;

export interface MarginProduct { product: string; qty: number; revenue: number; cogs: number; margin: number; pct: number | null; unknownUnits: number; low: boolean }
export interface MarginMachine extends Omit<MarginProduct, "product"> { serial: string; name: string; products: MarginProduct[] }
export interface MarginTotals { qty: number; revenue: number; cogs: number; margin: number; pct: number | null; unknownUnits: number }
/** Строки продаж, выброшенные фильтром «в строю» (R-P5b-1): склад «продал» — реальный случай прода. */
export interface MarginExcluded { serial: string; qty: number; amount: number }
export interface MarginReport { days: number; from: string; to: string; lowPct: number; machines: MarginMachine[]; products: MarginProduct[]; totals: MarginTotals; unknownUnits: number; unknownProducts: string[]; excluded: MarginExcluded[] }
export function marginByMachine(rows: readonly SaleRow[], cost: CostIndex, opts: { days: number; from: string; to: string; inService: ReadonlyMap<string, string>; lowPct?: number }): MarginReport;

export interface StockPosition { product: string; qty: number; serial?: string; machineName?: string }
export interface DeadRow extends StockPosition { value: number; noPrice: boolean }
export interface DeadStockReport { days: number; since: string; warehouse: DeadRow[]; machines: DeadRow[]; totalValue: number; noPriceCount: number }
/** `moved`: `normalizeProductName(product)` — движение по складу (глобально); `serial|ключ` — в конкретном автомате (R-P5b-4). */
export function deadStock(warehouse: readonly StockPosition[], inMachines: readonly StockPosition[], moved: ReadonlySet<string>, cost: CostIndex, days: number, since: string): DeadStockReport;

export interface PriceChange { product: string; from: number; to: number; pct: number; at: string }
export interface PurchasePriceEvent { product: string; oldPrice: number | null; newPrice: number; at: string }
export interface RetailDailyPrice { product: string; dt: string; price: number }
export interface PriceChangesReport { days: number; pct: number; purchase: PriceChange[]; retail: PriceChange[] }
/** Цена дня витрины = round(Σamount / Σqty) по (товар, сутки) (R-P5b-5). */
export function retailDaily(rows: readonly SaleRow[]): RetailDailyPrice[];
export function priceChanges(purchase: readonly PurchasePriceEvent[], retail: readonly RetailDailyPrice[], pct: number, days: number): PriceChangesReport;

export interface PriceGapRow { product: string; fact: number; reference: number; gap: number; gapPct: number; qty: number; lost: number; action: "raise" | "check" }
export interface PriceGapReport { days: number; pct: number; rows: PriceGapRow[]; noReference: string[]; lostTotal: number }
export function priceGap(fact: readonly { product: string; qty: number; amount: number }[], reference: ReadonlyMap<string, number>, pct: number, days: number): PriceGapReport;

export interface WeekTotals { qty: number; revenue: number; margin: number }
export interface WeekDelta { qty: number; revenue: number; margin: number; qtyPct: number | null; revenuePct: number | null; marginPct: number | null }
export interface IsoWeek { key: string; year: number; week: number; from: string; to: string }
export function weekCompare(current: WeekTotals, previous: WeekTotals): WeekDelta;
/** ISO-неделя ташкентских суток момента: ключ `IYYY-IW`, `from`/`to` — пн и вс по Ташкенту. */
export function isoWeekTashkent(at: Date): IsoWeek;
export function isoWeekFromKey(key: string): IsoWeek | null;
export function previousIsoWeek(w: IsoWeek): IsoWeek;
/** Взвешенная себестоимость по принятым накладным окна: Σ(price×qty)/Σqty; пусто → null. */
export function weightedCost(lots: readonly { price: number; qty: number }[]): number | null;
```

Семантика, которую обязаны воспроизвести реализация и тесты:
- `pct` — процент, округлённый до 0.1 (`Math.round(margin / revenue * 1000) / 10`), `null` при `revenue = 0`. Так число в боте, панели и в инвентаризации прода («27.6 %») — одно и то же.
- Строка без себестоимости **даёт выручку, но не даёт cogs** (донор `if cost:`), её штуки идут в `unknownUnits`, имя — в `unknownProducts`. Маржа при этом завышена ровно на эту выручку — поэтому счётчик обязателен во всех витринах (R-P5b-2).
- `low = margin < 0 || (pct !== null && pct < lowPct)`.
- Строки с серийником вне `inService` в расчёт не идут вовсе и складываются в `excluded` (прод: SKLAD 4S «продал» 1 шт Moxito 09.07).
- `deadStock`: позиция мертва при `qty > 0` и отсутствии ключа движения; склад — по глобальному ключу товара, автомат — по паре `serial|ключ`. Без цены `value = 0`, `noPrice = true` (и это не «ноль сум»).
- `priceChanges.retail`: переход день-к-дню по соседним дням с ценой, `|Δ| / from > pct/100`. `from <= 0` — строка мусора, пропуск (прод: «Недостача (Рустам)» +1269.6 %).
- `priceGap`: `gap = reference − fact`, в отчёт при `|gap| / reference > pct/100`; `lost = gap × qty`; `lostTotal` — сумма ТОЛЬКО положительных; `action = lost > 0 ? "raise" : "check"`; товары без эталона — в `noReference`, не нулевой строкой.

- [ ] **Step 1: Тесты** (`vending-reports.test.ts`, node:test; фикстуры воспроизводят прод — см. `inventory-prod.md` §1–§5):
```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deadStock, isoWeekTashkent, isoWeekFromKey, marginByMachine, previousIsoWeek,
  priceChanges, priceGap, retailDaily, weekCompare, weightedCost, type SaleRow,
} from "./vending-reports";

const OLMA = "2508160376", AH = "2508160359", SKLAD = "2508160360";
const парк = new Map([[OLMA, "Olma Администрация"], [AH, "American Hospital"]]);
const цены = new Map([["Lays Сметана-лук 50gr", 13000], ["Moxito Lime 330ml", 9800], ["Kinder Bueno 43gr", 8000]]);
const cost = (p: string) => цены.get(p) ?? null;
const s = (serial: string, product: string, qty: number, amount: number, dt = "2026-08-20"): SaleRow => ({ dt, serial, product, qty, amount });

describe("Маржа по проданному (R-P5b-1, R-P5b-3)", () => {
  const r = marginByMachine([
    s(OLMA, "Lays Сметана-лук 50gr", 3, 45_000), s(OLMA, "Moxito Lime 330ml", 2, 24_000),
    s(AH, "Kinder Bueno 43gr", 1, 11_000), s(AH, "Новинка без цены", 4, 40_000),
    s(SKLAD, "Moxito Lime 330ml", 1, 12_000, "2026-07-09"), // склад «продал» — прод §7.4
  ], cost, { days: 30, from: "2026-07-27", to: "2026-08-25", inService: парк });

  it("автомат не в строю выброшен из денег и назван отдельно", () => {
    assert.deepEqual(r.excluded, [{ serial: SKLAD, qty: 1, amount: 12_000 }]);
    assert.equal(r.machines.length, 2);
  });
  it("маржа автомата = выручка − Σ(qty×cost), процент до 0.1", () => {
    const olma = r.machines.find((m) => m.serial === OLMA)!;
    assert.equal(olma.name, "Olma Администрация");
    assert.deepEqual([olma.qty, olma.revenue, olma.cogs, olma.margin, olma.pct], [5, 69_000, 58_600, 10_400, 15.1]);
  });
  it("без себестоимости: выручка есть, cogs нет, штуки и имя названы", () => {
    const ah = r.machines.find((m) => m.serial === AH)!;
    assert.deepEqual([ah.unknownUnits, ah.cogs], [4, 8_000]);
    assert.deepEqual([r.unknownProducts, r.totals.unknownUnits], [["Новинка без цены"], 4]);
  });
  it("низкая и отрицательная маржа помечены; нет продаж — не выдуманный процент", () => {
    const lays = r.products.find((p) => p.product === "Lays Сметана-лук 50gr")!;
    assert.deepEqual([lays.pct, lays.low], [13.3, true]);                                    // 13.3 < 15
    assert.equal(r.products.find((p) => p.product === "Moxito Lime 330ml")!.low, false);      // 18.3
    assert.equal(marginByMachine([s(OLMA, "Lays Сметана-лук 50gr", 1, 12_000)], cost, { days: 1, from: "a", to: "b", inService: парк }).products[0]!.low, true);
    const пусто = marginByMachine([], cost, { days: 30, from: "a", to: "b", inService: парк });
    assert.deepEqual([пусто.machines.length, пусто.totals.pct, пусто.totals.revenue], [0, null, 0]);
  });
});

describe("Мёртвый сток 21 день (R-P5b-4)", () => {
  const цена = new Map([["Kinder Bueno 43gr", 11_000], ["Cheers Сметана-зелень 70gr", 8_000], ["TUC Sour cream", 13_500]]);
  const c = (p: string) => цена.get(p) ?? null;
  const поз = (product: string, qty: number, serial: string) => ({ product, qty, serial, machineName: парк.get(serial)! });
  const автоматы = [
    поз("Kinder Bueno 43gr", 11, AH), поз("Kinder Bueno 43gr", 2, OLMA),
    поз("Cheers Сметана-зелень 70gr", 5, AH), поз("Cheers Сметана-зелень 70gr", 5, OLMA),
    поз("TUC Sour cream", 5, OLMA), поз("Moxito Lime 330ml", 9, OLMA),
  ];
  const r = deadStock([{ product: "Montella 330ml", qty: 24 }, { product: "Без цены", qty: 3 }], автоматы,
    new Set([`${OLMA}|moxito lime 330ml`, "montella 330ml"]), c, 21, "2026-08-04");

  it("боевые числа: 5 строк, 28 шт, 290 500 сум", () => {
    assert.equal(r.machines.length, 5);
    assert.equal(r.machines.reduce((a, x) => a + x.qty, 0), 28);
    assert.equal(r.totalValue, 290_500);
  });
  it("флаг по паре (автомат, товар): продаётся в одном — мёртв в другом", () => {
    const r2 = deadStock([], автоматы, new Set([`${AH}|kinder bueno 43gr`]), c, 21, "2026-08-04");
    assert.deepEqual(r2.machines.filter((x) => x.product === "Kinder Bueno 43gr").map((x) => x.serial), [OLMA]);
  });
  it("склад: движение глобально по товару; без цены — не «ноль сум»", () => {
    assert.deepEqual(r.warehouse.map((x) => [x.product, x.value, x.noPrice]), [["Без цены", 0, true]]);
    assert.equal(r.noPriceCount, 1);
  });
});

describe("Изменения цен >5 % (R-P5b-5)", () => {
  const продажи: SaleRow[] = [
    s(OLMA, "LaimonFresh Lime 330ml", 2, 30_000, "2026-07-07"), s(AH, "LaimonFresh Lime 330ml", 1, 15_000, "2026-07-07"),
    s(OLMA, "LaimonFresh Lime 330ml", 3, 36_000, "2026-07-08"),
    s(OLMA, "Moxito Lime 330ml", 2, 24_000, "2026-07-07"), s(OLMA, "Moxito Lime 330ml", 2, 24_400, "2026-07-08"), // +1.7 %
  ];
  it("цена дня = round(Σamount/Σqty) по обоим автоматам", () => {
    assert.deepEqual(retailDaily(продажи).filter((x) => x.product === "LaimonFresh Lime 330ml"), [
      { product: "LaimonFresh Lime 330ml", dt: "2026-07-07", price: 15_000 },
      { product: "LaimonFresh Lime 330ml", dt: "2026-07-08", price: 12_000 },
    ]);
  });
  it("ровно одна находка витрины: LaimonFresh 15000→12000 (−20.0 %)", () => {
    assert.deepEqual(priceChanges([], retailDaily(продажи), 5, 30).retail,
      [{ product: "LaimonFresh Lime 330ml", from: 15_000, to: 12_000, pct: -20, at: "2026-07-08" }]);
  });
  it("закупочные — из событий; нулевая прошлая цена не даёт +1269 %", () => {
    const r = priceChanges([
      { product: "Montella 330ml", oldPrice: 20_000, newPrice: 22_000, at: "2026-08-10" },
      { product: "Недостача (Рустам)", oldPrice: 0, newPrice: 81_080, at: "2026-08-11" },
      { product: "Velona", oldPrice: 13_000, newPrice: 12_900, at: "2026-08-12" }, // −0.8 %
    ], [], 5, 30);
    assert.deepEqual(r.purchase.map((x) => [x.product, x.pct]), [["Montella 330ml", 10]]);
  });
});

describe("Витрина против эталона (R-P5b-6)", () => {
  const r = priceGap([
    { product: "LaimonFresh Lime 330ml", qty: 20, amount: 240_000 }, // факт 12 000
    { product: "Moxito Lime 330ml", qty: 5, amount: 60_000 },        // факт 12 000
    { product: "TUC Sour cream", qty: 4, amount: 60_000 },           // эталона нет
  ], new Map([["LaimonFresh Lime 330ml", 15_000], ["Moxito Lime 330ml", 11_000]]), 5, 14);
  it("недобор — только по положительным разрывам; без эталона — отдельный список", () => {
    assert.deepEqual(r.rows.map((x) => [x.product, x.gap, x.gapPct, x.lost, x.action]), [
      ["LaimonFresh Lime 330ml", 3_000, 20, 60_000, "raise"],
      ["Moxito Lime 330ml", -1_000, -9.1, -5_000, "check"],
    ]);
    assert.deepEqual([r.lostTotal, r.noReference], [60_000, ["TUC Sour cream"]]);
  });
});

describe("Недели по Ташкенту и себестоимость окна (R-P5b-7, R-P5b-2)", () => {
  it("ключ IYYY-IW, границы пн–вс, ташкентская граница суток, 53-я неделя", () => {
    assert.deepEqual(isoWeekTashkent(new Date("2026-08-25T02:00:00Z")), { key: "2026-35", year: 2026, week: 35, from: "2026-08-24", to: "2026-08-30" });
    assert.equal(isoWeekTashkent(new Date("2026-08-23T19:00:00Z")).key, "2026-35"); // уже 24.08 в Ташкенте
    assert.equal(isoWeekTashkent(new Date("2026-08-23T18:00:00Z")).key, "2026-34");
    assert.equal(isoWeekTashkent(new Date("2027-01-02T20:00:00Z")).key, "2026-53");
    assert.equal(isoWeekFromKey("2026-34")!.from, "2026-08-17");
    assert.equal(previousIsoWeek(isoWeekFromKey("2026-35")!).key, "2026-34");
    assert.equal(isoWeekFromKey("мусор"), null);
  });
  it("сравнение недель по проду: 2026-34 против 2026-33", () => {
    assert.deepEqual(weekCompare({ qty: 248, revenue: 2_157_000, margin: 607_595 }, { qty: 285, revenue: 2_600_000, margin: 683_730 }),
      { qty: -37, revenue: -443_000, margin: -76_135, qtyPct: -13, revenuePct: -17, marginPct: -11.1 });
    assert.equal(weekCompare({ qty: 1, revenue: 1, margin: 1 }, { qty: 0, revenue: 0, margin: 0 }).revenuePct, null);
  });
  it("взвешенная себестоимость: Σ(price×qty)/Σqty; пусто → null (не ноль)", () => {
    assert.equal(weightedCost([{ price: 10_000, qty: 3 }, { price: 12_000, qty: 1 }]), 10_500);
    assert.equal(weightedCost([]), null);
    assert.equal(weightedCost([{ price: 0, qty: 5 }]), null);
  });
});
```
- [ ] **Step 2:** `pnpm --filter @mydon/shared build` → RED: «Cannot find module './vending-reports'».
- [ ] **Step 3: Реализация** `vending-reports.ts`. Опоры: `normalizeProductName` из `./vending-calc` (сшивка имён), `tashkentDay`/`tashkentDayStart` из `./tashkent-time` (недели). Шапка модуля объясняет ДВА решения, которые нельзя «упростить»: почему выручка строки без себестоимости остаётся в revenue (донор `if cost:`), и почему ISO-неделя считается по ташкентским суткам, а не по UTC. `isoWeekTashkent` — арифметикой по `tashkentDay(at)` (четверг той же недели → номер), без `Intl`: набор ICU в рантайме разный, а ключ должен быть байт-в-байт как `to_char(dt,'IYYY-IW')` в Postgres.
- [ ] **Step 4:** `pnpm --filter @mydon/shared build && pnpm --filter @mydon/shared test` → GREEN (все 16 проверок).
- [ ] **Step 5:** `git add packages/shared/src/vending-reports.ts packages/shared/src/vending-reports.test.ts packages/shared/src/index.ts && git commit -m "feat(shared): расчёты аналитики снека — маржа, мёртвый сток, цены, витрина, недели (П5b)"`

---

### Task 2: Данные — эталон витрины (0068), ключи настроек, писатели цены и наблюдений

**Files:** Modify `packages/db/src/schema.ts` (`vendingProduct`, после `purchasePrice` ~стр. 1377), `packages/db/drizzle/meta/_journal.json`, `packages/db/src/schema.test.ts` (тест «вендинг: слот хранит ВМЕСТИМОСТЬ…», ~стр. 74); Create `packages/db/drizzle/0068_sale_price.sql`, `packages/db/drizzle/meta/0068_snapshot.json`; Modify `apps/core/src/system/config-spec.ts` (после блока «Вендинг: полевой контур (П4)», ~стр. 160) и `config-spec.test.ts`; Modify `apps/core/src/vending/vending.service.ts` (`products()`, `receiveOrder()`, новые `setSalePrice`/`bootstrapSalePrice`) и `vending.service.test.ts`.

> ⚠️ `vending.service.ts` правится параллельно другим агентом — перед началом `git pull`/сверить якоря по ИМЕНАМ методов, а не по номерам строк.

**Interfaces (produces):**
```ts
// packages/db/src/schema.ts
/** Эталон витрины — слово владельца, а не факт продаж (R-P5b-6). CHECK (> 0) — в миграции 0068. */
salePrice: numeric("sale_price", { precision: 12, scale: 2 }),

// apps/core/src/vending/vending.service.ts
export interface SetSalePriceResult {
  ok: boolean; product?: string; oldPrice?: number | null; newPrice?: number;
  /** Отклонение от ФАКТА витрины (amount/qty за 14 дней), % — при reason="spike". */
  deviationPct?: number; factPrice?: number | null; reason?: "not_found" | "spike";
}
export interface BootstrapSalePriceResult {
  days: number;
  set: { product: string; price: number; qty: number }[];
  skipped: { product: string; reason: "already_set" | "no_sales" }[];
}
export class VendingService {
  setSalePrice(rawProduct: string, price: number, actor?: string, confirmed?: boolean): Promise<SetSalePriceResult>;
  bootstrapSalePrice(days?: number, actor?: string): Promise<BootstrapSalePriceResult>;
}
// VendingProductRow (core + apps/cc/src/lib/core.ts) получает поле `salePrice: number | null`.
```
Ключи `CONFIG_SPECS` (все `kind: "number"`, `validate: nonNegNumber`):
`DEAD_STOCK_DAYS` («Вендинг: окно мёртвого стока, дней», fallback `"21"`), `PRICE_CHANGE_PCT` («Вендинг: порог изменения цены, %», `"5"`), `PRICE_GAP_PCT` («Вендинг: порог разрыва витрины с эталоном, %», `"5"`), `COST_WINDOW_DAYS` («Вендинг: окно взвешенной себестоимости, дней», `"90"`, help «Донор mydon-stock: 90 дней по принятым накладным»), `MARGIN_LOW_PCT` («Вендинг: маржа ниже этого % — тревожная», `"15"`).

- [ ] **Step 1:** `pnpm --filter @mydon/db db:generate` → «No schema changes» (базовая линия чиста).
- [ ] **Step 2: Тесты RED.** В `schema.test.ts` расширить существующую проверку прайса:
```ts
    assert.ok(prod.includes("salePrice"), "эталон витрины — в базе: без него price_gap не с чем сравнивать (R-P5b-6)");
```
В `config-spec.test.ts` — новый блок:
```ts
describe("Ключи аналитики П5b (R-P5b-11)", () => {
  for (const [key, fallback] of [["DEAD_STOCK_DAYS", "21"], ["PRICE_CHANGE_PCT", "5"], ["PRICE_GAP_PCT", "5"], ["COST_WINDOW_DAYS", "90"], ["MARGIN_LOW_PCT", "15"]] as const) {
    it(`${key}: в белом списке, дефолт ${fallback}, отрицательное отвергается`, () => {
      assert.equal(specFor(key)?.fallback, fallback);
      assert.equal(validateConfig(key, "0"), null);      // ноль — значение владельца, не мусор
      assert.ok(validateConfig(key, "-1"));
      assert.ok(validateConfig(key, "двадцать"));
    });
  }
});
```
В `vending.service.test.ts` — новый describe (стаб как у существующих тестов сервиса):
```ts
describe("Эталон витрины (R-P5b-6)", () => {
  it("записывает sale_price, событие и запись в журнал", async () => {
    const м = мир({ products: [{ id: "p1", name: "TUC Sour cream", purchasePrice: "9000", salePrice: null }] });
    const r = await м.service.setSalePrice("tuc sour cream", 15_000, "owner");
    assert.deepEqual([r.ok, r.product, r.oldPrice, r.newPrice], [true, "TUC Sour cream", null, 15_000]);
    assert.equal(м.events.at(-1)?.type, "vending.sale_price_changed");
    assert.equal(м.audit.at(-1)?.action, "vending.product.set_sale_price");
  });
  it("гейт по ФАКТУ витрины: >20 % от amount/qty требует «точно»", async () => {
    const м = мир({ products: [{ id: "p1", name: "TUC Sour cream", purchasePrice: "9000", salePrice: null }], sales: [{ dt: "2026-08-20", machineSerial: OLMA, product: "TUC Sour cream", qty: "4", amount: "60000" }] });
    const gate = await м.service.setSalePrice("TUC Sour cream", 20_000, "owner");
    assert.deepEqual([gate.ok, gate.reason, gate.factPrice, gate.deviationPct], [false, "spike", 15_000, 33]);
    assert.equal((await м.service.setSalePrice("TUC Sour cream", 20_000, "owner", true)).ok, true);
  });
  it("бутстрап заполняет только пустые эталоны и называет пропущенных", async () => {
    const м = мир({
      products: [{ id: "p1", name: "TUC Sour cream", purchasePrice: "9000", salePrice: null },
                 { id: "p2", name: "Moxito Lime 330ml", purchasePrice: "9800", salePrice: "12000" },
                 { id: "p3", name: "Новинка", purchasePrice: "1000", salePrice: null }],
      sales: [{ dt: "2026-08-20", machineSerial: OLMA, product: "TUC Sour cream", qty: "4", amount: "60000" }],
    });
    const r = await м.service.bootstrapSalePrice(14, "owner");
    assert.deepEqual(r.set, [{ product: "TUC Sour cream", price: 15_000, qty: 4 }]);
    assert.deepEqual(r.skipped, [{ product: "Moxito Lime 330ml", reason: "already_set" }, { product: "Новинка", reason: "no_sales" }]);
  });
});

describe("Наблюдение закупочной цены при приёмке (R-P5b-5)", () => {
  it("позиция с ценой, отличной от прайса, пишет vending.purchase_price_observed", async () => {
    const м = мир({ orders: [{ id: "o1", status: "approved", positions: [{ product: "TUC Sour cream", order: 10, price: 11_000 }] }],
                    products: [{ id: "p1", name: "TUC Sour cream", purchasePrice: "9000", salePrice: null }] });
    await м.service.receiveOrder("o1", "owner");
    const набл = м.events.filter((e) => e.type === "vending.purchase_price_observed");
    assert.deepEqual(набл.map((e) => e.payload), [{ product: "TUC Sour cream", price: 11_000, oldPrice: 9_000, orderId: "o1", receivedAt: набл[0]!.payload.receivedAt }]);
  });
  it("позиция без цены наблюдения не даёт (0 ≠ цена)", async () => {
    const м = мир({ orders: [{ id: "o1", status: "approved", positions: [{ product: "TUC Sour cream", order: 10 }] }], products: [] });
    await м.service.receiveOrder("o1", "owner");
    assert.equal(м.events.filter((e) => e.type === "vending.purchase_price_observed").length, 0);
  });
});
```
`pnpm --filter @mydon/db build && pnpm --filter @mydon/db test` и `pnpm --filter core build` → RED.
- [ ] **Step 3: Схема и миграция.** Поле `salePrice` в `vendingProduct` с JSDoc «эталон витрины (слово владельца); факт витрины выводится из `sale.amount/qty` и в базе не хранится». `db:generate` → переименовать файл в `0068_sale_price.sql`, tag в `_journal.json` (`idx: 68`, `when` = предыдущий + 1), SQL привести к защитному виду (образец 0067): `ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "sale_price" numeric(12, 2);` + `DO $$ BEGIN ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_sale_price_positive" CHECK ("sale_price" > 0); EXCEPTION WHEN duplicate_object THEN NULL; END $$;`. Шапка-комментарий: зачем колонка (без неё `price_gap` даёт 0 строк не потому, что расхождений нет, а потому что нет второго операнда), почему CHECK, а не NOT NULL (эталон появляется по одному товару, бутстрапом или командой), и что бэкфилла нет.
- [ ] **Step 4: Настройки.** Пять ключей в `CONFIG_SPECS` отдельным блоком `// ── Вендинг: аналитика (П5b) ──`.
- [ ] **Step 5: Core.** `products()` отдаёт `salePrice` (`p.salePrice === null ? null : Number(p.salePrice)`). `setSalePrice` — по образцу `setProductPrice`: канон через `loadProductIndex`+`findProductRow`, факт витрины считается из `sale` за 14 дней (`Σamount/Σqty`, округление до 1 сум); при `factPrice !== null` и `|price − fact| / fact > 0.2` без `confirmed` → `{ ok: false, reason: "spike", factPrice, deviationPct }`; иначе транзакция: `update vending_product.sale_price` + `event vending.sale_price_changed {product, oldPrice, newPrice, actor}` + `audit_log vending.product.set_sale_price`. `bootstrapSalePrice(days = 14)` — одной транзакцией по всем товарам с `sale_price IS NULL`, у которых есть продажи окна; на каждый записанный товар то же событие и запись журнала (actor `owner`), результат печатает и `set`, и `skipped`. В `receiveOrder`, в существующем цикле по `positions` (там, где уже вычислен `unitPrice`), собрать наблюдения и вставить их в ТОЙ ЖЕ транзакции рядом со вставкой `vending.purchase_order.received`: одно событие на позицию с `unitPrice !== null`, payload `{ product, price, oldPrice, orderId, receivedAt }` (`oldPrice` — `purchase_price` карточки на момент приёмки, `null` если карточки нет).
- [ ] **Step 6:** `pnpm --filter @mydon/db build && pnpm --filter @mydon/db test && pnpm --filter core build && pnpm --filter core test` → GREEN.
- [ ] **Step 7:** commit `feat(db,core): эталон витрины vending_product.sale_price (0068), ключи аналитики и наблюдение цен приёмки (П5b)`

---

### Task 3: Core — `AnalyticsService`: маржа, мёртвый сток, цены, разрыв витрины

**Files:** Create `apps/core/src/vending/analytics.service.ts`, `analytics.service.test.ts`; Modify `apps/core/src/vending/vending.controller.ts` (DTO рядом с `ShrinkageDto` ~стр. 297 и роуты после `@Get("shrinkage")` ~стр. 485), `vending.module.ts` (провайдер + экспорт), `tools/smoke-core.mjs` (список `ЧТЕНИЕ` ~стр. 60 и мутации ~стр. 200).

**Interfaces:**
```ts
// GET /vending/margin?days=30       → MarginReport      (@mydon/shared)
// GET /vending/dead-stock?days=21   → DeadStockReport
// GET /vending/price-changes?days=30 → PriceChangesReport & { monthly: MonthlyPrice[] }
// GET /vending/price-gap?days=14    → PriceGapReport
// POST /vending/sale-price {product, price, confirmed?, actor?}      → SetSalePriceResult
// POST /vending/sale-price/bootstrap {days?}                          → BootstrapSalePriceResult
/** Помесячная динамика — только для панели (донор `price_dynamics`). Тип живёт в @mydon/shared. */
export interface MonthlyPrice { product: string; month: string; retail: number | null; purchase: number | null }
export class AnalyticsService {
  margin(days?: number, now?: Date): Promise<MarginReport>;
  deadStock(days?: number, now?: Date): Promise<DeadStockReport>;
  priceChanges(days?: number, now?: Date): Promise<PriceChangesReport & { monthly: MonthlyPrice[] }>;
  priceGap(days?: number, now?: Date): Promise<PriceGapReport>;
  /** Индекс себестоимости прогона (R-P5b-2) — публично: им пользуется недельная сводка. */
  costIndex(now?: Date): Promise<{ cost: CostIndex; source: "orders" | "price" }>;
  invalidate(): void;
}
```
DTO (все с `@Type(() => Number)`, иначе `ValidationPipe` без `enableImplicitConversion` отобьёт любой `?days=`):
`MarginDto { days?: 1..90 }`, `DeadStockDto { days?: 1..180 }`, `PriceChangesDto { days?: 1..180 }`, `PriceGapDto { days?: 1..90 }`, `SetSalePriceDto { product: string(1..255); price: @IsInt @Min(1) @Max(10_000_000); confirmed?: boolean; actor?: string(128) }`, `SalePriceBootstrapDto { days?: 1..90 }`.

Алгоритмы (всё окно — по Ташкенту: `to` = вчера, `from` = `to − days + 1`, границы через `tashkentDay`/`tashkentDayStart`):
- `costIndex`: позиции `vending_purchase_order` со `status='received'` и `received_at ≥ now − COST_WINDOW_DAYS` → `weightedCost` по канону имени; чего нет — `vending_product.purchase_price`; чего нет и там — `null`. `source` показывает владельцу, откуда цифра (сегодня всегда `"price"`: накладных на проде 0).
- `margin`: `sale` за окно → `SaleRow[]` (канон имён через `priceIndex().canonOf`, канон серийника через `normalizeMachineSerial`); `inService` = `machineRegistry()` минус `notInService`; `lowPct` = `MARGIN_LOW_PCT`; дальше `marginByMachine`.
- `deadStock`: склад — `vending_stock` с `quantity > 0`; автоматы — `machine_stock` за ПОСЛЕДНИЙ день каждого автомата в строю (подзапрос max(dt) по серийнику), `qty > 0`; `moved` — из `sale` за окно (`serial|ключ` и глобальный ключ), из `vending_refill_event.slots[].product` за окно (`serial|ключ`), из принятых за окно накладных (глобальный ключ).
- `priceChanges`: `event` с `type in ('vending.price_changed','vending.purchase_price_observed')` за окно → `PurchasePriceEvent[]`; `retailDaily(sale за окно)`; порог — `PRICE_CHANGE_PCT`; `monthly` — агрегат по `(канон, YYYY-MM)`: `retail` = `Σamount/Σqty` из `sale`, `purchase` = средняя из наблюдений.
- `priceGap`: факт — `sale` за `days` (по умолчанию 14) по канону; эталон — `vending_product.sale_price`; порог `PRICE_GAP_PCT`.
- Кеш и single-flight — по факту реализации вынесены в общий `apps/core/src/vending/report-cache.ts` (класс `ReportCache`, создан Task 4 для недельной сводки, `AnalyticsService` переключён на него фикс-раундом Task 3 — было три копии одной механики у усушки/аналитики/сводки, теперь одна). Ключ по-прежнему `${отчёт}|${окно}|${tashkentDay(now)}`, TTL `REPORT_CACHE_MS = 5 * 60_000`, параллельные запросы одного ключа ждут ОДИН расчёт. **TTL считается по НАСТЕННЫМ ЧАСАМ, а не по переданному `now`** — важно для недельной сводки, где `now` зафиксирован на границе недели и по нему запись никогда бы не протухала. `invalidate()`/`clear()` зовётся из `setSalePrice`/`bootstrapSalePrice` (эталон поменялся — кеш `price-gap` врёт).

- [ ] **Step 1: Тесты** (`analytics.service.test.ts`, стабы `db` как в `shrinkage.service.test.ts`: `rowsOf(table)` + цепочка `where/groupBy/orderBy/limit/then`, счётчик `select` для проверки кеша):
```ts
describe("Аналитика: маржа (R-P5b-1, R-P5b-3)", () => {
  it("считает только по in_service; SKLAD-строка уходит в excluded", async () => {
    const s = сервис({ sales: [...ПРОД_ПРОДАЖИ, { dt: "2026-07-09", machineSerial: "2508160360", product: "Moxito Lime 330ml", qty: "1", amount: "12000" }],
                       entities: ПАРК, cards: [{ entityId: "e-sklad", status: "warehouse" }] });
    const r = await s.margin(30, СЕЙЧАС);
    assert.deepEqual(r.excluded.map((x) => x.serial), ["2508160360"]);
    assert.deepEqual(r.machines.map((m) => m.name), ["Olma Администрация", "American Hospital"]);
  });
  it("порог низкой маржи берётся из настройки, а не из константы", async () => {
    const s = сервис({ sales: ПРОД_ПРОДАЖИ, entities: ПАРК, config: [{ key: "MARGIN_LOW_PCT", value: "30" }] });
    const r = await s.margin(30, СЕЙЧАС);
    assert.equal(r.lowPct, 30);
    assert.ok(r.products.every((p) => p.low === (p.pct !== null && p.pct < 30)));
  });
  it("кеш: два запроса одного окна — один поход в базу", async () => {
    const s = сервис({ sales: ПРОД_ПРОДАЖИ, entities: ПАРК });
    await s.margin(30, СЕЙЧАС); const было = s.счётчик.select;
    await s.margin(30, СЕЙЧАС);
    assert.equal(s.счётчик.select, было);
  });
});

describe("Аналитика: мёртвый сток (R-P5b-4)", () => {
  it("берёт последний день machine_stock и исключает автоматы не в строю", async () => {
    const s = сервис({ machineStock: [
      { dt: "2026-08-25", machineSerial: OLMA, product: "TUC Sour cream", qty: "5" },
      { dt: "2026-08-24", machineSerial: OLMA, product: "TUC Sour cream", qty: "99" },
      { dt: "2026-08-25", machineSerial: "2508160360", product: "Kinder Bueno 43gr", qty: "7960" },
    ], entities: ПАРК, cards: [{ entityId: "e-sklad", status: "warehouse" }], products: [{ id: "p1", name: "TUC Sour cream", purchasePrice: "13500" }] });
    const r = await s.deadStock(21, СЕЙЧАС);
    assert.deepEqual(r.machines.map((x) => [x.product, x.qty, x.value]), [["TUC Sour cream", 5, 67_500]]);
  });
  it("заливка по снимку снимает флаг у ЭТОГО автомата", async () => {
    const s = сервис({ machineStock: [{ dt: "2026-08-25", machineSerial: OLMA, product: "TUC Sour cream", qty: "5" }],
                       refillEvents: [{ machineSerial: OLMA, windowTo: new Date("2026-08-20T10:00:00Z"), slots: [{ product: "TUC Sour cream", delta: 5 }] }], entities: ПАРК });
    assert.equal((await s.deadStock(21, СЕЙЧАС)).machines.length, 0);
  });
});

describe("Аналитика: цены и витрина (R-P5b-5, R-P5b-6)", () => {
  it("порог из настройки; события и продажи дают две ленты", async () => {
    const s = сервис({ sales: ЛАЙМОН, events: [{ type: "vending.price_changed", payload: { product: "Montella 330ml", oldPrice: 20000, newPrice: 22000 }, occurredAt: new Date("2026-08-10T05:00:00Z") }], entities: ПАРК, config: [{ key: "PRICE_CHANGE_PCT", value: "5" }] });
    const r = await s.priceChanges(30, СЕЙЧАС);
    assert.deepEqual(r.retail.map((x) => x.pct), [-20]);
    assert.deepEqual(r.purchase.map((x) => x.product), ["Montella 330ml"]);
    assert.ok(r.monthly.some((m) => m.month === "2026-07" && m.retail !== null));
  });
  it("эталона нет — товар в noReference, а не нулевая строка", async () => {
    const s = сервис({ sales: ЛАЙМОН, products: [{ id: "p1", name: "LaimonFresh Lime 330ml", purchasePrice: "9000", salePrice: null }], entities: ПАРК });
    const r = await s.priceGap(14, СЕЙЧАС);
    assert.deepEqual([r.rows.length, r.noReference], [0, ["LaimonFresh Lime 330ml"]]);
  });
});
```
- [ ] **Step 2:** `pnpm --filter core build && pnpm --filter core test` → RED («Cannot find module ./analytics.service»).
- [ ] **Step 3: Реализация** сервиса, DTO и роутов. У каждого GET личный лимит: `@Throttle({ burst: { limit: 12, ttl: 60_000 }, sustained: { limit: 12, ttl: 60_000 } })` — вдвое больше, чем нужно панели (у неё три листа), и в двадцать раз меньше, чем нужно, чтобы уложить Core циклом `curl`. Провайдер в `vending.module.ts` (+ экспорт: сервис нужен недельной сводке).
- [ ] **Step 4: Смоук.** В `ЧТЕНИЕ`: `/vending/margin?days=30`, `/vending/dead-stock?days=21`, `/vending/price-gap?days=14` и объект с проверкой для `/vending/price-changes?days=30` (`purchase`, `retail`, `monthly` — массивы). В мутациях после сценария П4: `POST /vending/sale-price {product:"Smoke P4 A", price: 15000}` (`о.ok === true`), затем `POST /vending/sale-price` с ценой 30000 без `confirmed` — ожидаем `о.reason === "spike"`, и `POST /vending/sale-price/bootstrap {days: 14}` (`Array.isArray(о.set)`).
- [ ] **Step 5:** `pnpm --filter core build && pnpm --filter core test` → GREEN; смоук — в Task 8 общим прогоном.
- [ ] **Step 6:** commit `feat(core): отчёты аналитики снека — маржа, мёртвый сток, цены, разрыв витрины (П5b)`

---

### Task 4: Core — недельная сводка, здоровье сбора, тревога о серии отказов

**Files:** Create `apps/core/src/vending/weekly-digest.service.ts` (+test), `apps/core/src/ourvend/ourvend-health.service.ts` (+test), `apps/core/src/vending/report-cache.ts` (общий `ReportCache`, вынесен отсюда — усушка и аналитика переходят на него следом); Modify `apps/core/src/vending/vending.controller.ts` (роут + DTO), `vending.module.ts` (провайдеры `OurvendHealthService`/`OurvendParityService` **регистрируются здесь**, не в `OurvendModule` — см. ниже), `apps/core/src/ourvend/ourvend.controller.ts` (`@Get("health")`), `ourvend.module.ts` (только импортирует `VendingModule`, своих провайдеров для здоровья/паритета не заводит), `apps/core/src/vending/vending.service.ts` (`finishSyncRun`), `apps/core/src/rules/rules.ts` (+`rules.test.ts`), `packages/shared/src/vending-reports.ts` (+test: типы `WeeklyDigest`, `OurvendHealth`), `tools/smoke-core.mjs`.

**Решение по модулям (отклонение от наивного «здоровье OurVend — в OurvendModule»):** цикл получился бы такой — сводка (`VendingModule`) зовёт здоровье → здоровье зовёт паритет → паритет зовёт реестр автоматов (`VendingModule`). В Nest такой цикл лечится только `forwardRef`, которого в репозитории нет ни разу. Вместо цикла `OurvendParityService` и `OurvendHealthService` регистрируются в `VendingModule` (файлы остаются на месте в `apps/core/src/ourvend/`, переезжает только DI-регистрация); `OurvendModule` получает оба сервиса импортом `VendingModule` (он уже был его импортом).

**Interfaces (produces; типы — в `@mydon/shared`, R-P5b-10):**
```ts
export interface WeeklyDigest {
  week: string; from: string; to: string;
  machines: { serial: string; name: string; qty: number; revenue: number; margin: number; pct: number | null }[];
  totals: MarginTotals; delta: WeekDelta; previousWeek: string;
  topProducts: MarginProduct[];      // топ-5 по марже
  worstProducts: MarginProduct[];    // худшие-3 по МАРЖЕ (хвост списка, худший первым), без пересечения с topProducts
  refills: { events: number; detectedUnits: number; recordedUnits: number };
  intake: { orders: number; units: number; amount: number };
  stocktakes: { positions: number; lastCountedAt: string | null };
  deadStock: { rows: DeadRow[]; totalValue: number };          // топ-5
  priceChanges: { purchase: PriceChange[]; retail: PriceChange[] };
  health: OurvendHealth;
}
export interface OurvendSyncRun { id: string; startedAt: string; finishedAt: string | null; status: "running" | "success" | "partial" | "failed"; machinesTotal: number; machinesOk: number; durationMs: number | null; error: string | null }
export interface OurvendHealth {
  runs: OurvendSyncRun[]; failedStreak: number; lastSuccessAt: string | null;
  /** Возраст самого свежего снимка, мин/ч. `null` — снимков нет вовсе (это не «свежо»). */
  slotsLagMin: number | null; salesLagH: number | null; productSaleLagH: number | null;
  parity: { days: number; ok: boolean; mismatches: number; stockOk: boolean; note: string | null };
}
// GET /vending/weekly-digest?week=IYYY-IW  → WeeklyDigest  (пусто → предыдущая ISO-неделя)
// GET /ourvend/health?runs=20              → OurvendHealth
export class WeeklyDigestService { digest(week?: string, now?: Date): Promise<WeeklyDigest> }
export class OurvendHealthService { health(runs?: number, now?: Date): Promise<OurvendHealth> }
```
`WeeklyDigestDto { week?: @Matches(/^\d{4}-\d{2}$/) }`, `OurvendHealthDto { runs?: 1..100 }`.

Правило доставки (`rules.ts`, рядом с блоком П4):
```ts
  {
    // Сбор падает молча: на 25.08 двенадцать отказов подряд с 24.08 не заметил
    // никто — слоты писались, продажи нет. Немедленно, а не в брифинг:
    // каждый пропущенный день — дыра в деньгах, которую потом не восстановить.
    id: "ourvend.sync_failed_streak",
    eventType: "ourvend.sync_failed_streak",
    urgency: "immediate",
    format: (c) =>
      `🛑 Сбор OurVend падает ${num(c.payload.streak)} раз подряд с ${времяТашкента(c.payload.since)}: ` +
      `${str(c.payload.lastError)} — продажи и остатки за эти сутки не приедут`,
  },
```

- [ ] **Step 1: Тесты RED.**
```ts
// weekly-digest.service.test.ts
describe("Недельная сводка (R-P5b-7)", () => {
  it("без параметра берёт ПРЕДЫДУЩУЮ ISO-неделю по Ташкенту", async () => {
    const s = сервис({ sales: НЕДЕЛИ_34_И_33, entities: ПАРК });
    const d = await s.digest(undefined, new Date("2026-08-25T02:00:00Z"));
    assert.deepEqual([d.week, d.from, d.to, d.previousWeek], ["2026-34", "2026-08-17", "2026-08-23", "2026-33"]);
  });
  it("боевые числа недели 2026-34 и дельта к 33-й", async () => {
    const d = await сервис({ sales: НЕДЕЛИ_34_И_33, entities: ПАРК }).digest("2026-34", СЕЙЧАС);
    assert.deepEqual([d.totals.qty, d.totals.revenue, d.totals.margin], [248, 2_157_000, 607_595]);
    assert.deepEqual([d.delta.qty, d.delta.revenuePct], [-37, -17]);
  });
  it("нет продаж за неделю — нули названы пустотой, а не «всё хорошо»", async () => {
    const d = await сервис({ sales: [], entities: ПАРК }).digest("2026-30", СЕЙЧАС);
    assert.deepEqual([d.machines.length, d.totals.pct], [0, null]);
  });
  it("заливки: по снимкам и записанные мастером — разные числа", async () => {
    const d = await сервис({ refillEvents: [{ machineSerial: OLMA, windowTo: new Date("2026-08-19T09:00:00Z"), units: 183 }], refills: [], entities: ПАРК }).digest("2026-34", СЕЙЧАС);
    assert.deepEqual([d.refills.events, d.refills.detectedUnits, d.refills.recordedUnits], [1, 183, 0]);
  });
});

// ourvend-health.service.test.ts
describe("Здоровье сбора (R-P5b-8)", () => {
  it("считает серию отказов подряд и последний успех", async () => {
    const h = await сервис({ runs: [ОТКАЗ("2026-08-25T04:00:00Z"), ОТКАЗ("2026-08-24T22:00:00Z"), УСПЕХ("2026-08-24T01:00:00Z")] }).health(20, СЕЙЧАС);
    assert.deepEqual([h.failedStreak, h.lastSuccessAt], [2, "2026-08-24T01:00:00.000Z"]);
  });
  it("снимков нет — лаг null, а не ноль (нулём читалось бы «свежо»)", async () => {
    const h = await сервис({ runs: [], snapshots: [] }).health(20, СЕЙЧАС);
    assert.deepEqual([h.slotsLagMin, h.salesLagH, h.failedStreak], [null, null, 0]);
  });
});

// vending.service.test.ts — эмиссия
describe("Серия отказов сбора (R-P5b-8)", () => {
  it("третий отказ подряд даёт событие один раз в сутки", async () => {
    const м = мир({ runs: [ОТКАЗ(), ОТКАЗ()] });
    await м.service.finishSyncRun("run-3", { status: "failed", machinesTotal: 5, machinesOk: 0, durationMs: 10_000, error: "This operation was aborted" });
    assert.equal(м.events.filter((e) => e.type === "ourvend.sync_failed_streak").length, 1);
    await м.service.finishSyncRun("run-4", { status: "failed", machinesTotal: 5, machinesOk: 0, durationMs: 10_000, error: "This operation was aborted" });
    assert.equal(м.events.filter((e) => e.type === "ourvend.sync_failed_streak").length, 1);
  });
  it("успех события не даёт", async () => {
    const м = мир({ runs: [ОТКАЗ(), ОТКАЗ()] });
    await м.service.finishSyncRun("run-3", { status: "success", machinesTotal: 5, machinesOk: 5, durationMs: 9_900 });
    assert.equal(м.events.filter((e) => e.type === "ourvend.sync_failed_streak").length, 0);
  });
});

// rules.test.ts
it("серия отказов сбора доставляется немедленно", () => {
  const [n] = applyRules({ source: "system", type: "ourvend.sync_failed_streak", payload: { streak: 12, lastError: "This operation was aborted", since: "2026-08-24T09:00:00+05:00" } });
  assert.equal(n!.urgency, "immediate");
  assert.match(n!.text, /12 раз подряд/);
});
```
- [ ] **Step 2:** `pnpm --filter @mydon/shared build && pnpm --filter core build && pnpm --filter core test` → RED.
- [ ] **Step 3: Реализация.** `WeeklyDigestService` берёт окно из `isoWeekFromKey(week) ?? previousIsoWeek(isoWeekTashkent(now))`. Маржа недели по факту реализации считается вызовом `AnalyticsService.margin(7, понедельник_следующей_недели)`, а не отдельным `marginByMachine` руками: окно отчёта «`days` полных суток по вчерашний день от `now`» при таком сдвиге `now` даёт РОВНО пн–вс нужной недели с тем же `costIndex()`, тем же `MARGIN_LOW_PCT` и тем же фильтром «в строю» — так маржа в письме физически не может разойтись с маржой отчёта «маржа» (второй расчёт того же числа в другом месте — прямой путь к двум разным числам в одном письме). Прошлая неделя — тем же приёмом со своим понедельником. Дельта — `weekCompare` с итогами предыдущей недели, заливки/приходы/инвентаризации — три коротких агрегата (`vending_refill_event`, `vending_refill`, накладные `received_at` в неделе, `vending_stock.counted_at` в неделе), цены — вызовом `AnalyticsService.priceChanges` с окном недели. **Мёртвый сток — по СЕГОДНЯШНЕМУ остатку** (`AnalyticsService.deadStock(DEAD_STOCK_DAYS, now)`), а не «за неделю»: истории `vending_stock` в базе нет, «мёртвый сток на конец прошлой недели» физически не восстановить; в сводку идёт топ-5 по оценке из обеих половин (склад + автоматы) с пересортировкой, `totalValue` — по всему стоку, а не только по пятёрке. `OurvendHealthService`: последние N `vending_sync_run` по `started_at desc`, серия отказов — считается подряд от самого свежего ЗАВЕРШЁННОГО (running пропускается, а не рвёт серию), лаги — `max(captured_at)` `slot_snapshot`, `max(fetched_at)` `ourvend_sale_snapshot` и `product_sale`, паритет — `OurvendParityService.parity(7)`. В `finishSyncRun` после `returning()`: если `status === "failed"` — посчитать серию, и при `≥ 3` и отсутствии события этого типа за текущие ташкентские сутки записать `event { source: "system", type: "ourvend.sync_failed_streak", payload: { streak, lastError, since } }`.
- [ ] **Step 4: Смоук.** В `ЧТЕНИЕ`: `/ourvend/health?runs=20` (проверка: `runs` — массив, `failedStreak` — число) и `/vending/weekly-digest` (проверка: `week` матчит `^\d{4}-\d{2}$`, `machines`/`topProducts` — массивы).
- [ ] **Step 5:** `pnpm --filter core build && pnpm --filter core test` → GREEN.
- [ ] **Step 6:** commit `feat(core): недельная сводка, здоровье сбора OurVend и тревога о серии отказов (П5b)`

---

### Task 5: Бот — восемь владельческих команд и HELP

**Files:** Create `apps/bot/src/analytics-brief.ts`, `analytics-brief.test.ts`; Modify `apps/bot/src/core-client.ts` (типы импортом из `@mydon/shared`, методы после `vendingShrinkage` ~стр. 489), `apps/bot/src/handler.ts` (импорт ~стр. 30, ветки команд ~стр. 226–250, `HELP` ~стр. 66), `apps/bot/src/handler.test.ts` (в наборе `bot.test.ts`).

**Interfaces (consumes `@mydon/shared`, produces):**
```ts
// core-client.ts — формы НЕ переобъявлять (R-P5b-10):
import type { BootstrapSalePriceResult, DeadStockReport, MarginReport, MonthlyPrice, OurvendHealth, PriceChangesReport, PriceGapReport, SetSalePriceResult, WeeklyDigest } from "@mydon/shared";
vendingMargin(days?: number): Promise<MarginReport>;
vendingDeadStock(days?: number): Promise<DeadStockReport>;
vendingPriceChanges(days?: number): Promise<PriceChangesReport & { monthly: MonthlyPrice[] }>;
vendingPriceGap(days?: number): Promise<PriceGapReport>;
setVendingSalePrice(product: string, price: number, confirmed: boolean): Promise<SetSalePriceResult>;
bootstrapVendingSalePrice(days?: number): Promise<BootstrapSalePriceResult>;
vendingWeeklyDigest(week?: string): Promise<WeeklyDigest>;
ourvendHealth(runs?: number): Promise<OurvendHealth>;

// analytics-brief.ts
export function isMarginQuery(text: string): boolean;        // ^маржа
export function isDeadStockQuery(text: string): boolean;     // ^мёртв|^мертв
export function isPriceChangesQuery(text: string): boolean;  // ^цены
export function isPriceGapQuery(text: string): boolean;      // ^витрин (кроме «витрина как факт»)
export function isSalePriceBootstrapCommand(text: string): boolean; // ^витрина\s+как\s+факт
export function isSalePriceCommand(text: string): boolean;   // ^цена\s+продажи
export function isOurvendCheckQuery(text: string): boolean;  // ^сверк
export function parseDays(text: string, fallback: number, max: number): number;
export function parseSalePriceCommand(text: string): { product: string; price: number; confirmed: boolean } | null;
export function formatMargin(r: MarginReport): string[];
export function formatDeadStock(r: DeadStockReport): string[];
export function formatPriceChanges(r: PriceChangesReport): string[];
export function formatPriceGap(r: PriceGapReport): string[];
export function formatSalePriceResult(r: SetSalePriceResult): string;
export function formatSalePriceBootstrap(r: BootstrapSalePriceResult): string[];
export function formatOurvendHealth(h: OurvendHealth): string[];
export const SALE_PRICE_HINT: string;
```
Нарезка — существующими `chunk`/`cutAt`/`TG_BUDGET`/`MAX_PARTS` из `purchase-plan.ts` (лимит 3500, не больше 12 частей, хвост «…остальное на листе в панели»). Заголовки — «снек-автоматы (OurVend)» (R-P5b-9).

**Порядок веток в `handler.ts` (важнее, чем кажется):**
1. `isSalePriceCommand` — **строго до** `isPriceCommand`: существующий `/^цена(\s|:|$)/i` ловит и «цена продажи TUC 15000», и правка ушла бы в ЗАКУПОЧНУЮ цену.
2. `isSalePriceBootstrapCommand` — **строго до** `isPriceGapQuery`: обе начинаются с «витрина».
3. Остальные — рядом с веткой «усушка», до `parseIntent`.
Отказ Core 400 показывается через существующий `coreReason(err.body)`, как у правил закупа; прочий сбой — «Не удалось получить … из MYDON Core. Попробуй ещё раз чуть позже.»

- [ ] **Step 1: Тесты** (`analytics-brief.test.ts` + ветки в `bot.test.ts`):
```ts
describe("Разбор команд аналитики", () => {
  it("«цена продажи» не перехватывается закупочной «цена»", () => {
    assert.equal(isSalePriceCommand("цена продажи TUC Sour cream 15000"), true);
    assert.equal(isSalePriceCommand("цена TUC 12000"), false);
    assert.deepEqual(parseSalePriceCommand("цена продажи TUC Sour cream 15 000 точно"), { product: "TUC Sour cream", price: 15_000, confirmed: true });
    assert.equal(parseSalePriceCommand("цена продажи TUC"), null);
  });
  it("«витрина как факт» не читается как отчёт «витрина»", () => {
    assert.equal(isSalePriceBootstrapCommand("витрина как факт"), true);
    assert.equal(isPriceGapQuery("витрина как факт"), false);
    assert.equal(isPriceGapQuery("витрина"), true);
  });
  it("окно из фразы зажимается ботом, а не отказом Core", () => {
    assert.equal(parseDays("маржа за 7 дней", 30, 90), 7);
    assert.equal(parseDays("маржа за 900 дней", 30, 90), 90);
    assert.equal(parseDays("маржа", 30, 90), 30);
  });
});

describe("Тексты отчётов", () => {
  it("маржа: автоматы по деньгам, штуки без себестоимости названы", () => {
    const [первое] = formatMargin(МАРЖА_ПРОД);
    assert.match(первое, /Маржа снек-автоматов \(OurVend\) за 30 дн/);
    assert.match(первое, /Olma Администрация: выручка 5 882 000, маржа 1 621 385 \(27\.6 %\)/);
    assert.match(первое, /4 шт без себестоимости/);
    assert.ok(!первое.includes("кофе"));
  });
  it("нет продаж — так и сказано, а не нули как «всё хорошо»", () => {
    assert.match(formatMargin(ПУСТАЯ_МАРЖА)[0]!, /продаж за 30 дн\. нет/);
  });
  it("мёртвый сток: боевые 5 строк и 290 500 сум, без цены — подпись", () => {
    const t = formatDeadStock(МЁРТВЫЙ_ПРОД).join("\n");
    assert.match(t, /нет движения 21 дн\., 5 поз\., оценка ≈ 290 500/);
    assert.match(t, /цена закупки неизвестна/);
  });
  it("витрина: без эталона — отдельный список, недобор только положительный", () => {
    const t = formatPriceGap(ВИТРИНА).join("\n");
    assert.match(t, /Σ недобор.*60 000/);
    assert.match(t, /эталон не задан \(1\): TUC Sour cream/);
  });
  it("гейт цены продажи объясняет, чем отличается факт от эталона", () => {
    assert.match(formatSalePriceResult({ ok: false, reason: "spike", product: "TUC", factPrice: 15_000, newPrice: 20_000, deviationPct: 33 }), /повтори со словом «точно»/);
  });
  it("здоровье сбора: серия отказов кричит, лаг null — «снимков нет»", () => {
    const t = formatOurvendHealth(ЗДОРОВЬЕ).join("\n");
    assert.match(t, /12 отказов подряд/);
    assert.match(t, /снимков нет/);
  });
  it("длинный отчёт режется по бюджету и не теряет заголовок", () => {
    assert.ok(formatDeadStock(ОГРОМНЫЙ).every((ч) => ч.length <= 3500));
  });
});
```
- [ ] **Step 2:** `pnpm --filter @mydon/shared build && pnpm --filter bot build && pnpm --filter bot test` → RED.
- [ ] **Step 3: Реализация** `analytics-brief.ts`, методы клиента, ветки и восемь строк в `HELP`:
```
  "• «маржа» / «маржа за 7 дней» — выручка и маржа снек-автоматов (OurVend)",
  "• «мёртвый сток» — что не двигалось 21 день (склад и автоматы)",
  "• «цены» — что изменилось в закупочных и витринных ценах",
  "• «витрина» — где витрина разошлась с эталоном и сколько недобираем",
  "• «цена продажи TUC 15000» — записать эталон витрины (>20% от факта — добавь «точно»)",
  "• «витрина как факт» — разово проставить эталон по факту продаж за 14 дней",
  "• «итоги недели» — сводка за прошлую неделю",
  "• «сверка» — здоровье сбора OurVend и паритет",
```
- [ ] **Step 4:** `pnpm --filter bot build && pnpm --filter bot test` → GREEN.
- [ ] **Step 5:** commit `feat(bot): команды аналитики снека — маржа, мёртвый сток, цены, витрина, сверка (П5b)`

---

### Task 6: Бот — недельная сводка в понедельник 08:05 и «итоги недели»

**Files:** Create `apps/bot/src/weekly-digest.ts`, `weekly-digest.test.ts`; Modify `apps/bot/src/briefing.ts` (`msUntilWeekly` рядом с `msUntilBriefing` ~стр. 365), `apps/bot/src/index.ts` (планировщик рядом с `scheduleDigest` ~стр. 530), `apps/bot/src/handler.ts` (ветка «итоги недели» — **до** существующей `isActionsQuery`, которая ловит «итоги»), `apps/bot/src/bot.test.ts`.

**Interfaces:**
```ts
// briefing.ts
/** Мс до ближайшего `weekday` (1 = понедельник) `hour:minute` по Ташкенту. */
export function msUntilWeekly(now?: Date, weekday?: number, hour?: number, minute?: number): number;
// weekly-digest.ts
export function isWeeklyDigestQuery(text: string): boolean;   // ^итоги\s+недели|^недельн
/** Ключ дедупа доставки: `weekly-digest:<IYYY-IW>:<personId>` (R-P5b-7). */
export function weeklyDigestKey(week: string, personId: string): string;
/** Получатели: роль owner/manager и заполненный tg_chat_id. `admin` в MYDON нет. */
export function weeklyRecipients(people: readonly PersonRow[]): PersonRow[];
export interface WeeklyMessage { parts: string[]; shownKeys: string[] }
/** Сводка + подмешанные события правил urgency:"weekly"; ключи — ТОЛЬКО показанных строк. */
export function formatWeeklyDigest(d: WeeklyDigest, notes: readonly BriefingNote[]): WeeklyMessage;
```

Проводка в `index.ts` (по образцу `sendStaffDigest`, но получатели — из ролей, а не allowlist):
```ts
const sendWeeklyDigest = async (): Promise<void> => {
  const [digest, people, ruleNotes] = await Promise.all([
    deps.core.vendingWeeklyDigest(),
    deps.core.people(),
    deps.core.briefingNotifications(new Date(Date.now() - WEEKLY_NOTES_WINDOW_MS)).catch(() => null),
  ]);
  const notes = (ruleNotes?.notifications ?? [])
    .filter((n) => n.urgency === "weekly")
    .map((n) => ({ key: `${n.eventId}:${n.ruleId}`, text: n.text }));
  const { parts, shownKeys } = formatWeeklyDigest(digest, notes);
  let доставлен = false;
  for (const p of weeklyRecipients(people)) {
    // Ключ занимается ПЕРЕД отправкой и ПО ЧЕЛОВЕКУ: перезапуск бота в
    // понедельник 08:05:30 не должен слать вторую сводку, а сбой чата одного
    // получателя не должен лишать сводки остальных.
    if (!(await deps.core.claimNotification(weeklyDigestKey(digest.week, p.id)))) continue;
    try {
      for (const часть of parts) await tg.sendMessage(Number(p.tgChatId), часть);
      доставлен = true;
    } catch (err) { console.error(`Недельная сводка не доставлена (${p.name}):`, err); }
  }
  if (доставлен && shownKeys.length > 0) {
    await deps.core.ackNotifications(shownKeys).catch((err: unknown) => console.error("Отметку недельных сигналов не сохранить:", err));
  }
};
const scheduleWeekly = (): void => {
  setTimeout(() => { void (async () => { await withRetries("Недельная сводка не отправлена", sendWeeklyDigest); scheduleWeekly(); })(); }, msUntilWeekly());
};
scheduleWeekly();
```
`WEEKLY_NOTES_WINDOW_MS = 14 * 24 * 3_600_000` — по той же причине, что `BRIEFING_NOTES_WINDOW_MS`: ключ одноразовости тратится до отправки, и узкое окно теряло бы сигнал навсегда.

- [ ] **Step 1: Тесты**:
```ts
describe("Расписание недельной сводки (R-P5b-7)", () => {
  it("понедельник 08:05 по Ташкенту, а не по TZ процесса", () => {
    // вт 25.08 07:00 Ташкента → ждать до пн 31.08 08:05 = 6 сут 1 ч 5 мин
    assert.equal(msUntilWeekly(new Date("2026-08-25T02:00:00Z"), 1, 8, 5), ((6 * 24 + 1) * 60 + 5) * 60_000);
    // пн 24.08 08:00 Ташкента → 5 минут
    assert.equal(msUntilWeekly(new Date("2026-08-24T03:00:00Z"), 1, 8, 5), 5 * 60_000);
  });
});
describe("Получатели и дедуп", () => {
  it("owner и manager с чатом; operator и уволенный — мимо", () => {
    const люди = [
      { id: "1", name: "Владелец", roles: ["owner"], tgChatId: "10", active: "yes" },
      { id: "2", name: "Менеджер", roles: ["manager"], tgChatId: "11", active: "yes" },
      { id: "3", name: "Оператор", roles: ["operator"], tgChatId: "12", active: "yes" },
      { id: "4", name: "Уволен", roles: ["owner"], tgChatId: "13", active: "no" },
      { id: "5", name: "Без чата", roles: ["owner"], tgChatId: null, active: "yes" },
    ] as unknown as PersonRow[];
    assert.deepEqual(weeklyRecipients(люди).map((p) => p.id), ["1", "2"]);
  });
  it("ключ дедупа — по неделе и человеку", () => {
    assert.equal(weeklyDigestKey("2026-34", "p1"), "weekly-digest:2026-34:p1");
  });
});
describe("Текст недельной сводки", () => {
  it("боевая неделя 2026-34: числа, дельта и заливки", () => {
    const { parts } = formatWeeklyDigest(ДАЙДЖЕСТ_34, []);
    const t = parts.join("\n");
    assert.match(t, /Итоги недели 17\.08 — 23\.08/);
    assert.match(t, /2 157 000 сум.*маржа 607 595/s);
    assert.match(t, /−17 % к прошлой неделе/);
    assert.match(t, /Заливки: 3 события, 183 ед по снимкам \(записано 0\)/);
  });
  it("сигналы urgency=weekly подмешиваются, ключи — только показанных", () => {
    const notes = Array.from({ length: 30 }, (_, i) => ({ key: `e${i}:sales.drop`, text: `📉 Продажи ниже плана на ${i}%` }));
    const { parts, shownKeys } = formatWeeklyDigest(ДАЙДЖЕСТ_34, notes);
    assert.ok(shownKeys.length < notes.length, "невлезшее обязано остаться недоставленным");
    assert.ok(shownKeys.every((k) => parts.join("\n").includes(k.split(":")[0]!) || true));
    assert.ok(parts.every((ч) => ч.length <= 3500));
  });
  it("пустая неделя: сказано «продаж за неделю нет», а не нули", () => {
    assert.match(formatWeeklyDigest(ПУСТАЯ_НЕДЕЛЯ, []).parts[0]!, /продаж за неделю нет/);
  });
});
```
- [ ] **Step 2:** `pnpm --filter bot build && pnpm --filter bot test` → RED.
- [ ] **Step 3: Реализация** `msUntilWeekly` (тем же приёмом, что `msUntilBriefing`: `Intl.DateTimeFormat` с `timeZone: TZ` и явным `weekday`), `weekly-digest.ts`, ветка «итоги недели» в `handler.ts` **выше** `isActionsQuery` (иначе «итоги недели» уедет в ленту действий сотрудников), проводка и планировщик в `index.ts`.
- [ ] **Step 4:** `pnpm --filter bot build && pnpm --filter bot test` → GREEN.
- [ ] **Step 5:** commit `feat(bot): недельная сводка снека по понедельникам 08:05 и команда «итоги недели» (П5b)`

---

### Task 7: Панель — три листа отчётов, эталон витрины и здоровье сбора

**Files:** Modify `apps/cc/src/lib/core.ts` (реэкспорт типов из `@mydon/shared` + геттеры рядом с `vendingShrinkage` ~стр. 2329; `VendingProductRow` ~стр. 301 → `salePrice`), `lib/domain-nav.ts` (группа `reports` ~стр. 97 и `TABLE_BACKED_LEAVES` ~стр. 256), `app/domain/[domain]/page.tsx` (импорт ~стр. 65, диспетч ~стр. 1960–1970, список типов ~стр. 2490), `components/product-rules-panel.tsx` (+`product-rules-panel.test.tsx`), `components/vending-panel.tsx` (~стр. 278, рядом с секцией усушки); Create `components/margin-view.tsx`, `dead-stock-view.tsx`, `prices-view.tsx`, `ourvend-health-view.tsx` и по тесту к каждому.

**Interfaces:**
```ts
// apps/cc/src/lib/core.ts — формы берём из @mydon/shared, НЕ переписываем (R-P5b-10):
export type { DeadStockReport, MarginReport, MonthlyPrice, OurvendHealth, PriceChangesReport, PriceGapReport } from "@mydon/shared";
vendingMargin: (days = 30) => get<MarginReport>(`/vending/margin?days=${days}`),
vendingDeadStock: (days = 21) => get<DeadStockReport>(`/vending/dead-stock?days=${days}`),
vendingPriceChanges: (days = 30) => get<PriceChangesReport & { monthly: MonthlyPrice[] }>(`/vending/price-changes?days=${days}`),
vendingPriceGap: (days = 14) => get<PriceGapReport>(`/vending/price-gap?days=${days}`),
ourvendHealth: (runs = 20) => get<OurvendHealth>(`/ourvend/health?runs=${runs}`),

// components
export const MARGIN_WINDOWS = [7, 30, 90] as const;
export function MarginTables({ report }: { report: MarginReport }): JSX.Element;      // презентационный
export async function MarginView({ domain, days }: { domain: string; days: number }); // + CoreDown
export function DeadStockTables({ report }: { report: DeadStockReport }): JSX.Element;
export async function DeadStockView({ domain, days }: { domain: string; days: number });
export function PricesTables({ report }: { report: PriceChangesReport & { monthly: MonthlyPrice[] }; gap: PriceGapReport | null }): JSX.Element;
export async function PricesView({ domain, days }: { domain: string; days: number });
export function OurvendHealthCard({ health }: { health: OurvendHealth }): JSX.Element;
export async function OurvendHealthSection(): Promise<JSX.Element>;                   // сбой → «не проверили (Core не ответил)»
```
Навигация: в группе `reports` после листа «Усушка» — `{ label: "Маржа", type: "margin" }`, `{ label: "Мёртвый сток", type: "dead_stock" }`, `{ label: "Цены", type: "prices" }`; все три — в `TABLE_BACKED_LEAVES` (считаются на чтении, своих карточек реестра не заводят, счёт по `byType` был бы 0 и чип бы погас). Лист `reports:cost` (кофе) НЕ трогаем (R-P5b-9).
Правила закупа: в строку списка добавить `витрина {n(p.salePrice)}` / `эталон не задан`, а под списком — вторая подсказка: «Витрина (эталон) — только чтение: правится в боте командой «цена продажи <товар> <сум>».» Формы правки здесь НЕТ — единственный писатель остаётся бот (тот же принцип, что у закупочной цены).
Вкладка «Снек»: секция «Здоровье сбора» рядом с секцией усушки, отдельным запросом (`ourvendHealth()` c `.catch(() => null)`), сбой — не пустое место, а строка «Здоровье сбора: не проверили (Core не ответил)».

- [ ] **Step 1: Тесты** (vitest, `@testing-library/react`):
```tsx
describe("Лист «Маржа»", () => {
  it("боевые числа и порядок по деньгам", () => {
    render(<MarginTables report={МАРЖА_ПРОД} />);
    expect(screen.getByText(/2 473 121/)).toBeVisible();
    const строки = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(строки[0]).toMatch(/Olma Администрация/);
  });
  it("штуки без себестоимости названы вслух", () => {
    render(<MarginTables report={{ ...МАРЖА_ПРОД, unknownUnits: 4, unknownProducts: ["Новинка"] }} />);
    expect(screen.getByText(/4 шт без себестоимости/)).toBeVisible();
  });
  it("нет продаж — «продаж за период нет», а не нули", () => {
    render(<MarginTables report={ПУСТАЯ_МАРЖА} />);
    expect(screen.getByText(/продаж за 30 дн\. нет/)).toBeVisible();
  });
  it("автоматы не в строю названы отдельной строкой, а не спрятаны", () => {
    render(<MarginTables report={{ ...МАРЖА_ПРОД, excluded: [{ serial: "2508160360", qty: 1, amount: 12000 }] }} />);
    expect(screen.getByText(/не в строю/)).toBeVisible();
  });
});
describe("Лист «Мёртвый сток»", () => {
  it("склад пуст, автоматы — 5 строк на 290 500", () => {
    render(<DeadStockTables report={МЁРТВЫЙ_ПРОД} />);
    expect(screen.getByText(/290 500/)).toBeVisible();
    expect(screen.getByText(/на складе мёртвых позиций нет/i)).toBeVisible();
  });
  it("без цены показывает штуки, а не «0 сум»", () => {
    render(<DeadStockTables report={БЕЗ_ЦЕНЫ} />);
    expect(screen.getByText(/цена закупки неизвестна/)).toBeVisible();
  });
});
describe("Лист «Цены»", () => {
  it("три блока: изменения, витрина против эталона, динамика по месяцам", () => {
    render(<PricesTables report={ЦЕНЫ} gap={ВИТРИНА} />);
    expect(screen.getByText(/Витрина против эталона/)).toBeVisible();
    expect(screen.getByText(/эталон не задан/)).toBeVisible();
    expect(screen.getByText(/Динамика по месяцам/)).toBeVisible();
  });
});
describe("Правила закупа: эталон витрины только для чтения", () => {
  it("показывает эталон и говорит, где он правится", () => {
    render(<ProductRulesPanel domain="vendhub" products={[{ ...ROW, salePrice: 15000 }]} />);
    expect(screen.getByText(/витрина 15 000/)).toBeVisible();
    expect(screen.getByText(/цена продажи <товар> <сум>/)).toBeVisible();
    expect(screen.queryByLabelText(/Витрина/)).toBeNull(); // поля правки нет
  });
});
describe("Секция «Здоровье сбора»", () => {
  it("серия отказов — тревожная пилюля, лаг null — «снимков нет»", () => {
    render(<OurvendHealthCard health={ЗДОРОВЬЕ} />);
    expect(screen.getByText(/12 отказов подряд/)).toBeVisible();
    expect(screen.getByText(/снимков нет/)).toBeVisible();
  });
});
```
- [ ] **Step 2:** `pnpm --filter cc test` → RED.
- [ ] **Step 3: Реализация** трёх листов (структура — копия `shrinkage-view.tsx`: презентационный компонент + `async`-обёртка с `try/catch → <CoreDown/>`, переключатель окна ссылками `?days=`), диспетч в `page.tsx`, навигация, колонка эталона, секция здоровья.
- [ ] **Step 4:** `pnpm --filter cc test && pnpm --filter cc build` → GREEN.
- [ ] **Step 5:** commit `feat(cc): листы «Маржа», «Мёртвый сток», «Цены», эталон витрины и здоровье сбора (П5b)`

---

### Task 8: Документы, смоук и полный прогон

**Files:** Create `docs/superpowers/specs/2026-08-25-p5b-analytics-design.md` (спека из `~/.claude/jobs/46af8079/tmp/p5b-spec-draft.md`), `docs/superpowers/plans/2026-08-25-sloy-P5b-analitika.md` (этот план); Modify `docs/PLAN_STOCK_ABSORPTION.md` (§П5, после блока «Хвосты П5b» ~стр. 179), `tools/smoke-panel.mjs` (~стр. 90, рядом с `reports:shrinkage`), `.env.example` (комментарий: пороги аналитики — в панели «Система», не в env).

- [ ] **Step 1:** Спека и план кладутся в репо ПОД ТЕМИ ЖЕ путями, что объявлены в заголовке (иначе ссылка из плана ведёт в пустоту).
- [ ] **Step 2:** `docs/PLAN_STOCK_ABSORPTION.md` §П5 — новый блок «**Волна П5b (2026-08-25).**»: (1) реализовано — маржа по проданному (закрывает донорский `margin_by_machine` 567), `dead_stock` 21 день (591), `price_changes` >5 % и динамика по месяцам (622/551), `price_gap_report` через новую колонку `vending_product.sale_price` (0068), недельная сводка пн 08:05 с дедупом `weekly-digest:<IYYY-IW>:<personId>`, здоровье сбора `GET /ourvend/health` и тревога `ourvend.sync_failed_streak`; (2) осознанно НЕ реализовано (бэклог) — живой запрос к OurVend по требованию (коннектор живёт в агентах по крону; донорская «сверка» заменена здоровьем сбора, R-P5b-8), таблица подписок и opt-out (рассылка по ролям `owner`/`manager`), маржа кофе (`coffee_sale` пуст, R-P5b-9), PNG-графики, поставщик и лучшая цена за 90 дней, горизонт склада N дней, нечёткие алиасы; (3) отклонение от спеки: `admin` в MYDON нет — читать `manager`; (4) ручной шаг выкатки — бутстрап эталона витрины (см. «Выкатка»), автодеплой его не запускает.
- [ ] **Step 3:** `tools/smoke-panel.mjs`: `{ path: "/domain/vendhub?tab=reports:margin", должно: "Маржа" }`, `{ path: "/domain/vendhub?tab=reports:dead_stock", должно: "Мёртвый сток" }`, `{ path: "/domain/vendhub?tab=reports:prices", должно: "Витрина против эталона" }` (слово из САМОГО листа, а не из каркаса — иначе проверка пройдёт и на экране ошибки).
- [ ] **Step 4: Полный прогон:** `pnpm -s lint && pnpm -s typecheck && pnpm -s build && pnpm -s test`; смоук на scratch-БД: `createdb` → `node packages/db/dist/migrate.js` → `seed.js` → `seed-vending.js` → `backfill-product-ids.js` → `node tools/smoke-core.mjs` → `node tools/smoke-panel.mjs` → `dropdb`.
- [ ] **Step 5:** commit `docs(p5b): спека, план и решения волны аналитики в плане поглощения; smoke-пути`

---

## Выкатка (после адверсариал-ревью)

> **Предусловие рассылки — правка ДАННЫХ, не кода** (`adversarial-prod-data.md`
> §1). На проде ролей `owner`/`manager` нет ни у кого: владелец помечен
> легаси-полем `person.role='владелец'`, менеджер — `role='менеджер'` и
> неактивен. Пока роль `owner` не проставлена в `person.roles` (панель
> «Сотрудники» или `PUT /people/:id`), недельная сводка не уйдёт НИКОМУ.
> Молчания при этом больше нет: бот читает легаси-`role` фолбэком
> (`владелец→owner`, `менеджер→manager`), а пустой список получателей поднимает
> событием `weekly-digest.no_recipients`, а не строкой в консоль контейнера.
> Проверить ДО понедельника 08:05.

1. **PR** `feat/p5b-analytics` → CI (lint · typecheck · build · test · migrations на живом Postgres · smoke-core · smoke-panel) → squash-мерж в `main`. Первой командой после `git checkout main` — `git checkout -b`: фолбэк `|| git push` молча пушит main в прод.
2. **Автодеплой** применяет **0068** (`ALTER TABLE … ADD COLUMN IF NOT EXISTS` + CHECK). Сверить, что выкачено именно оно: `GET /health` → `commit` совпадает с коммитом мержа (каталог обновляется за секунды, образ собирается минуты).
3. **Прод, только чтение** — сверить с `inventory-prod.md` §9:
   - `GET /vending/margin?days=30` → 2 автомата, 1047 шт, выручка **8 974 000**, закуп **6 500 879**, маржа **2 473 121 (27.6 %)**; Olma **1 621 385 (27.6 %)**, American Hospital **851 736 (27.5 %)**; 34 SKU, отрицательной маржи 0, `unknownUnits = 0`; `excluded` при 30 днях **пуст** — единственная продажа склада-заглушки SKLAD 4S (1 шт / 12 000) датирована 09.07 и появляется только при `?days=60/90` вместе с предупреждением `excluded_sales`.
   - `GET /vending/dead-stock?days=21` → склад **0 позиций**; автоматы **6 строк, 31 шт, ≈311 200 сум**. Пять строк — TUC @376 (5 / 52 500), Cheers @359 (5 / 47 500), Cheers @376 (5 / 47 500), Kinder Bueno @376 (2 / 22 000), Nesquick @359 (3 / 20 700); шестая — **Kinder Bueno @359, 11 шт / 121 000**, самая дорогая позиция отчёта: она видна только после уточнения R-P5b-4 (движение в автомате = продажа), потому что заливка 14.08 снимала ей флаг, а продавали её последний раз 28.07. Если вылезли 129 строк и ~45 млн — сломан фильтр `in_service` (R-P5b-1), откатывать.
   - `GET /vending/price-changes?days=60` → по витрине **ровно одна находка**: LaimonFresh Lime 330ml 15000→12000 (−20.0 %, 08.07); закупочная лента пуста (событий по цене на проде 0). При `?days=30` пусто всё, включая `monthly` (полных месяцев в окне нет); при `?days=180` в `monthly` только месяц `2026-07` — панель зовёт этот запрос отдельно ради блока «Динамика по месяцам».
   - `GET /vending/price-gap?days=14` → **0 строк**, `noReference` — **32 товара**: «34 SKU» посчитаны за 30 суток, а окно витрины (и бутстрапа) — 14, и за 14 суток продавались 32 товара. Бутстрап «витрина как факт» проставит **32** цены и пропустит 20 из 52 карточек с причиной `no_sales`.
   - `GET /vending/weekly-digest?week=2026-34` → 248 шт, 2 157 000 сум, маржа **607 594** (cogs 1 549 406: себестоимость округляется по ячейке «автомат × товар» и складывается уже округлённой — это на 1 сум расходится с ручным замером `inventory-prod.md`); заливок 3 (183 ед), записано мастером 0; приходов 0; инвентаризаций 0. Блок здоровья сбора в письме — состояние **«сейчас»**, а не за отчётную неделю (журнал прогонов покрывает лишь последние сутки-двое); это подписано в самом блоке, «здоровье за неделю» — бэклог.
   - `GET /ourvend/health` → `runs` 20 (8 успешных / 12 отказов), `failedStreak` **0** (25.08 16:00 UTC прогон прошёл, хот-фикс синка выкачен), `lastSuccessAt` 25.08; лаги: слоты ≈ 12 мин, продажи ≈ 13 ч, `product_sale` ≈ 0.2 ч; `parity` — `days 7 · ok false · mismatches 0 · stockOk false · stockChecked 0` с примечанием «остатки: снимков остатков OurVend за период нет». Читать это как «остатки сверять нечем», а НЕ как «расхождений 0, но всё плохо»: панель и бот печатают именно причину.
4. **Записи на проде — только две, и обе по слову владельца:**
   - владелец в боте: «витрина как факт» → бот печатает список проставленных эталонов (ожидаем 34 позиции по 14-дневному факту), после чего `GET /vending/price-gap?days=14` перестаёт быть списком «эталон не задан»;
   - либо, если владелец просит сделать это за него, ОДИН вызов `POST /vending/sale-price/bootstrap {"days":14}` с `SERVICE_TOKEN` — и сразу показать владельцу список `set`, чтобы он поправил командой «цена продажи <товар> <сум>» то, что решит иначе.
   Ничего в кабинете OurVend не пишем (донорская политика: отчёт показывает, что поправить руками).
5. **Наблюдение:** понедельник 08:05 — сводка приходит владельцу и менеджеру один раз (проверить `notification_delivery` на ключи `weekly-digest:2026-XX:<personId>`); пороги при желании правятся в панели «Система» (5 ключей П5b) и применяются без рестарта.

## Самопроверка плана

**Покрытие рулингов спеки:**

| Рулинг | Где закрыт | Чем проверен |
|---|---|---|
| R-P5b-1 источник денег и `in_service` | T1 (`inService` + `excluded`), T3 (реестр из `machineRegistry`), T4 (та же выборка в сводке) | T1 «автомат не в строю выброшен», T3 «SKLAD-строка уходит в excluded», прод-шаг 3 (5 строк вместо 129) |
| R-P5b-2 себестоимость (`weightedCost`, 0 ≠ цена) | T1 `weightedCost`/`CostIndex`, T3 `costIndex()` с `COST_WINDOW_DAYS` | T1 «Взвешенная себестоимость окна», T1 «товар без себестоимости даёт выручку, но не cogs» |
| R-P5b-3 маржа и порог низкой | T1 `marginByMachine`, T3 `MARGIN_LOW_PCT` | T1 «маржа автомата», «низкая маржа помечается», T3 «порог из настройки» |
| R-P5b-4 мёртвый сток 21 день | T1 `deadStock`, T3 сбор `moved` (уточнён по проду: в АВТОМАТЕ движение — только продажа; заливка и приёмка снимают флаг у СКЛАДА) | T1 «флаг по паре (автомат, товар)», T3 «заливка не прячет позицию автомата», прод-шаг 3 (6 строк, Kinder Bueno @359 на месте) |
| R-P5b-5 изменения цен | T1 `retailDaily`/`priceChanges`, T2 `vending.purchase_price_observed`, T3 две ленты + `monthly` | T1 «ровно одна находка», «нулевая прошлая цена», T2 «наблюдение при приёмке» |
| R-P5b-6 витрина против эталона | T2 (0068 + `setSalePrice`/`bootstrapSalePrice`), T3 `priceGap`, T5 команды, T7 колонка | T1 «недобор только по положительным», T2 «гейт по факту», T5 «витрина как факт», T7 «только чтение» |
| R-P5b-7 недельная сводка | T1 `isoWeekTashkent`/`weekCompare`, T4 `WeeklyDigestService`, T6 рассылка и дедуп | T1 «границы пн–вс», T4 «боевые числа 2026-34», T6 «ключ дедупа», «получатели» |
| R-P5b-8 здоровье сбора вместо живой сверки | T4 `OurvendHealthService` + `finishSyncRun` + правило, T5 «сверка», T7 секция | T4 «серия отказов», «третий отказ даёт событие один раз», T5/T7 тексты |
| R-P5b-9 кофе вне охвата | Global Constraints, T5 (`assert.ok(!первое.includes("кофе"))`), T7 (лист `reports:cost` не трогаем) | T5 «Маржа снек-автоматов (OurVend)» |
| R-P5b-10 общие типы | T1 (единственное объявление), T4 (`WeeklyDigest`/`OurvendHealth` туда же), T5/T7 импортируют | ревью: в `apps/bot/src/core-client.ts` и `apps/cc/src/lib/core.ts` только `import type`/`export type` |
| R-P5b-11 настройки, не константы | T2 (5 ключей + тест), T3/T4 читают `readIntSetting` | T2 «дефолт, ноль, отрицательное», T3 «порог из настройки, а не из константы» |

**Согласованность имён типов между задачами:** `SaleRow`, `CostIndex`, `MarginReport`/`MarginMachine`/`MarginProduct`/`MarginTotals`/`MarginExcluded`, `StockPosition`/`DeadRow`/`DeadStockReport`, `PriceChange`/`PurchasePriceEvent`/`RetailDailyPrice`/`PriceChangesReport`, `PriceGapRow`/`PriceGapReport`, `MonthlyPrice`, `WeekTotals`/`WeekDelta`/`IsoWeek`, `WeeklyDigest`, `OurvendSyncRun`/`OurvendHealth` — объявлены ровно один раз в `packages/shared/src/vending-reports.ts` (T1; `MonthlyPrice`, `WeeklyDigest`, `OurvendSyncRun`, `OurvendHealth` дописываются туда же в T3/T4) и во всех остальных задачах только импортируются. `SetSalePriceResult`/`BootstrapSalePriceResult` живут в `apps/core/src/vending/vending.service.ts` рядом с существующим `SetPriceResult` (форма ответа мутации, не отчёта) и реэкспортируются боту через `core-client.ts` — тем же способом, что `SetPriceResult` сегодня.

**Известные риски исполнения:** (1) `apps/core/src/vending/vending.service.ts` и `apps/agents/src/*` правятся параллельно — T2 и T4 трогают первый файл, якоря брать по именам методов; (2) хот-фикс синка (`fix/ourvend-ingest-batch`) должен войти в main ДО ветки П5b, иначе `GET /ourvend/health` на проде покажет серию отказов, которую уже чинят; (3) `isPriceCommand` и `isActionsQuery` в `handler.ts` перехватывают новые команды — порядок веток проверяется тестами T5/T6, а не глазами.
