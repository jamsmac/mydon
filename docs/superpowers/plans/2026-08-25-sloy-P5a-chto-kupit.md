# П5a «Что купить» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Довести существующий расчёт закупа вендинга до уровня донора vending-ops: политика «закуп → в автоматы первым», правила товара (исключён/фикс-количество/блок), раздача по маршруту и слотам, план в боте и панели, правила — данными.

**Architecture:** Расширяем чистое ядро `@mydon/shared` (`computePurchase` + новый модуль `vending-plan.ts`), Core собирает `GET /vending/plan` из тех же таблиц (`machine_slot`, `vending_stock`, `vending_product`, `machine_card`, `system_config`), бот и панель — только представление. Правила товара — 2 колонки `vending_product` (миграция 0066) + overlay в сиде; маршрут — ключ `VENDING_ROUTE_ORDER` в `config-spec`.

**Tech Stack:** TypeScript strict (без `any`), NestJS + class-validator, Drizzle/Postgres, Next.js (server components + client-формы по конвенции #208), Telegram-бот (plain text), `node:test` (shared/core/bot) и vitest (cc), pnpm/turbo.

**Spec:** `docs/superpowers/specs/2026-08-25-p5a-procurement-plan-design.md`

## Global Constraints
- Ветка `feat/p5a-procurement-plan`; прямой push в `main` запрещён (hookify); коммиты `feat:/fix:/docs:` с `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- TZ `Asia/Tashkent` (константа `TZ` из `@mydon/shared`); русский в UI и тестах, английский в коде и именах полей/событий.
- Ответы API аддитивны (R-P5a-6): старые поля `PurchaseItem`/`PurchaseSummary` и их значения не меняются; контрольный пример Приложения Г (`vending-calc.test.ts:133-175`) проходит без правок.
- Политика по умолчанию `purchase-first` (R-P5a-1); цена правится только «цена …» (R-P5a-2); маршрут — настройка, не колонка (R-P5a-3); в расчёт входят только `machine_card.status = in_service` (R-P5a-4); штуки не зависят от цены (R-P5a-7).
- Тесты гоняются по `dist`: всегда `pnpm --filter <pkg> build && pnpm --filter <pkg> test` (или `pnpm -s test` целиком). CC: `pnpm --filter cc test` (vitest) + `pnpm --filter cc lint`.
- Мутация в Core = транзакция + `event` + `audit_log` в одном `tx`; DTO с потолками (`@Max`), `ValidationPipe forbidNonWhitelisted` — клиент шлёт ровно DTO.
- Регексы бота без `\b` после кириллицы; число — один токен с группами по 3.
- Формы CC: `onSubmit` + `preventDefault` + `FormData(event.currentTarget)` → server action в `startTransition`; поля неуправляемые (`defaultValue`), сохраняют ввод при отказе; тест на это обязателен. Эталон `apps/cc/src/components/customs-rates.tsx`.
- Никаких изменений на проде из задач плана (сид на проде — ручной шаг раздела «Выкатка»).

---

## Карта файлов

| Файл | Роль |
|---|---|
| `packages/shared/src/vending-calc.ts` (+test) | расширение `computePurchase`: политика, `excluded`/`fixedQty`, поля раздачи, группа `excludedByRule`, новые итоги |
| `packages/shared/src/vending-plan.ts` (новый, +test), `packages/shared/src/index.ts` | `coilOrder`, `allocateByRoute`, `allocateBySlots`, `routeOrderFrom` |
| `packages/db/src/schema.ts`, `packages/db/drizzle/0066_purchase_rules.sql`, `drizzle/meta/_journal.json`, `meta/0066_snapshot.json` | колонки `excluded_from_purchase`, `fixed_purchase_qty` |
| `packages/db/src/seed-vending.ts` (+test `seed-vending.test.ts`) | `VENDING_PURCHASE_RULES`, `seedVendingRules()`, вызов в `main()` |
| `apps/core/src/system/config-spec.ts` (+test) | ключ `VENDING_ROUTE_ORDER` |
| `apps/core/src/vending/vending.service.ts` (+test), `vending.controller.ts` | `plan()`, `products()`, `setProductRules()`, фильтр `in_service`, позиции заявки с разбивкой, роуты `GET /vending/plan`, `GET /vending/products`, `POST /vending/product-rules` |
| `tools/smoke-core.mjs` | новые пути в `ЧТЕНИЕ`/`ЗАПИСЬ` |
| `apps/bot/src/core-client.ts`, `purchase-plan.ts` (новый, +test), `product-rules.ts` (новый, +test), `purchase-brief.ts` (+test), `handler.ts`, `index.ts`, `briefing.ts` (+test) | «план закупа», команды правил, `Reply.more`, строка брифинга |
| `apps/cc/src/lib/core.ts`, `apps/cc/src/app/vending/actions.ts` (новый), `apps/cc/src/components/purchase-plan-view.tsx` (новый, +test), `purchase-plan-submit.tsx` (новый), `product-rules-panel.tsx` (новый, +test), `apps/cc/src/lib/domain-nav.ts`, `apps/cc/src/app/domain/[domain]/page.tsx` | лист «План закупа» с кнопкой «Оформить закуп», лист «Правила закупа» |
| `docs/PLAN_STOCK_ABSORPTION.md`, `.env.example` | галочки П5 + «Решения волны П5a», переменная маршрута |

---

### Task 1: Ядро — политика раздачи и правила товара в `computePurchase`

**Files:**
- Modify: `packages/shared/src/vending-calc.ts:197-343` (интерфейсы `PurchaseItem`, `PurchaseSummary`, `PurchaseOptions`, функция `computePurchase`)
- Test: `packages/shared/src/vending-calc.test.ts` (новый `describe` в конце файла)

**Interfaces:**
- Consumes: существующие `PurchaseRow`, `PriceEntry { price; pack }`, `computePurchase(input, prices, opts)`.
- Produces (используют Task 2, 4, 5, 6):
```ts
export type AllocationPolicy = "purchase-first" | "warehouse-first";
/** Правила закупа товара (vending_product): исключён / фикс-количество / блок без цены. */
export interface ProductRule { excluded?: boolean; fixedQty?: number | null; pack?: number }
export interface PurchaseOptions {
  round?: boolean; includeNoSales?: boolean; maxCapacity?: number;
  /** Политика раздачи (R-P5a-1). По умолчанию purchase-first. */
  allocation?: AllocationPolicy;
  /** Правила по канону имени; товар без записи — обычный. */
  rules?: Map<string, ProductRule>;
}
export interface PurchaseItem {
  /* существующие поля без изменений: product, perMachine, need, stock, covered, buy, surplus, pack, order, extra, price, costExact, costRounded, noPrice, noSales */
  /** В автоматы из закупа (новая упаковка). */ fromPurchase: number;
  /** В автоматы со склада. */ fromStock: number;
  /** Не заполнится. */ unfilled: number;
  /** Излишек закупки → на склад: order − fromPurchase. */ toStock: number;
  /** Склад после: stock − fromStock + toStock. */ stockAfter: number;
  /** Правило «убрано из закупки». */ excluded: boolean;
  /** Фикс-количество, если задано. */ fixedQty: number | null;
}
export interface PurchaseSummary {
  /* существующие: items, excludedNoSales, noPrice, totalNeed, totalCovered, totalBuy, totalOrder, costExact, costRounded, overpay, costByPriceFull */
  /** «Убрано из закупки» правилом товара — в деньги не входит, в раздачу входит. */ excludedByRule: PurchaseItem[];
  allocation: AllocationPolicy;
  totalFromPurchase: number; totalFromStock: number; totalUnfilled: number; totalToStock: number;
}
```
Семантика (спека §4.1): для `excluded` — `buy = 0, order = 0, fromPurchase = 0, fromStock = min(stock, need)`; для `fixedQty` при `shortage > 0` — `buy = shortage, order = fixedQty` (без округления), `extra = max(0, order − buy)`; purchase-first: `fromPurchase = min(need, order)`, `fromStock = min(stock, need − fromPurchase)`; warehouse-first: `fromStock = min(stock, need)`, `fromPurchase = min(order, need − fromStock)`; всегда `unfilled = need − fromPurchase − fromStock`, `toStock = order − fromPurchase`, `stockAfter = stock − fromStock + toStock`. Позиции `noSales` вне итогов: `fromPurchase = 0`, `fromStock = min(stock, need)`, `toStock = 0` (не покупаем, но что есть на складе — загрузим); их `order`/`buy` остаются как раньше. Итоги `totalFrom*`/`totalUnfilled`/`totalToStock` — по `items` + `excludedByRule` + `excludedNoSales` (это штуки, не деньги). `pack` берётся `prices.get(p)?.pack ?? rules.get(p)?.pack ?? 1`.

- [ ] **Step 1: Написать падающие тесты** (в конец `vending-calc.test.ts`):

```ts
describe("Вендинг: политика раздачи и правила товара (П5a, донор vending-ops)", () => {
  const prices = new Map<string, PriceEntry>([
    ["Fanta", { price: 5167, pack: 12 }],
    ["Snickers", { price: 7000, pack: 10 }],
    ["Qurt", { price: 6800, pack: 10 }],
    ["Montella", { price: 2090, pack: 12 }],
  ]);
  const row = (product: string, need: number, stock: number, sold7 = 5): PurchaseRow => ({
    product, perMachine: { olma: need }, need, stock, sold7,
  });

  it("purchase-first (по умолчанию): новая упаковка идёт в автоматы первой, склад не трогается", () => {
    const s = computePurchase([row("Fanta", 20, 5)], prices);
    const i = s.items[0]!;
    assert.equal(s.allocation, "purchase-first");
    assert.equal(i.buy, 15);
    assert.equal(i.order, 24);
    assert.equal(i.fromPurchase, 20);
    assert.equal(i.fromStock, 0);
    assert.equal(i.toStock, 4);
    assert.equal(i.stockAfter, 9);
    assert.equal(i.unfilled, 0);
    // прежние поля не меняются (Приложение Г)
    assert.equal(i.covered, 5);
    assert.equal(i.surplus, 0);
    assert.equal(i.extra, 9);
  });

  it("warehouse-first (совместимость): склад закрывает потребность первым", () => {
    const s = computePurchase([row("Fanta", 20, 5)], prices, { allocation: "warehouse-first" });
    const i = s.items[0]!;
    assert.equal(i.fromStock, 5);
    assert.equal(i.fromPurchase, 15);
    assert.equal(i.toStock, 9);
    assert.equal(i.stockAfter, 9);
  });

  it("фикс-количество: при дефиците покупаем ровно фикс, без округления; излишек на склад", () => {
    const rules = new Map([["Snickers", { fixedQty: 48 }]]);
    const s = computePurchase([row("Snickers", 10, 0)], prices, { rules });
    const i = s.items[0]!;
    assert.equal(i.fixedQty, 48);
    assert.equal(i.buy, 10);
    assert.equal(i.order, 48);
    assert.equal(i.fromPurchase, 10);
    assert.equal(i.toStock, 38);
    assert.equal(i.stockAfter, 38);
    assert.equal(i.costRounded, 48 * 7000);
  });

  it("фикс меньше дефицита: остаток честно «пусто», extra не уходит в минус", () => {
    const rules = new Map([["Snickers", { fixedQty: 5 }]]);
    const s = computePurchase([row("Snickers", 12, 2)], prices, { rules });
    const i = s.items[0]!;
    assert.equal(i.order, 5);
    assert.equal(i.fromPurchase, 5);
    assert.equal(i.fromStock, 2);
    assert.equal(i.unfilled, 5);
    assert.equal(i.extra, 0);
  });

  it("фикс не срабатывает без дефицита (склад закрывает)", () => {
    const rules = new Map([["Snickers", { fixedQty: 48 }]]);
    const s = computePurchase([row("Snickers", 10, 15)], prices, { rules });
    assert.equal(s.items[0]!.order, 0);
    assert.equal(s.items[0]!.fromStock, 10);
  });

  it("исключён из закупки: не покупаем, грузим со склада что есть, остальное пусто; вне денег", () => {
    const rules = new Map([["Qurt", { excluded: true }]]);
    const s = computePurchase([row("Qurt", 8, 5)], prices, { rules });
    assert.equal(s.items.length, 0);
    assert.equal(s.excludedByRule.length, 1);
    const i = s.excludedByRule[0]!;
    assert.equal(i.excluded, true);
    assert.equal(i.order, 0);
    assert.equal(i.fromStock, 5);
    assert.equal(i.unfilled, 3);
    assert.equal(s.costRounded, 0);
    assert.equal(s.totalFromStock, 5);
    assert.equal(s.totalUnfilled, 3);
  });

  it("нет продаж: не покупаем, но склад грузим; штуки в итогах раздачи, денег нет", () => {
    const s = computePurchase([row("Montella", 6, 4, 0)], prices);
    const i = s.excludedNoSales[0]!;
    assert.equal(i.fromPurchase, 0);
    assert.equal(i.fromStock, 4);
    assert.equal(i.unfilled, 2);
    assert.equal(s.totalFromStock, 4);
    assert.equal(s.totalBuy, 0);
  });

  it("блок без цены берётся из правил; цена — нет (noPrice)", () => {
    const rules = new Map([["TUC", { pack: 5 }]]);
    const s = computePurchase([row("TUC", 7, 0)], prices, { rules });
    const i = s.items[0]!;
    assert.equal(i.pack, 5);
    assert.equal(i.order, 10);
    assert.equal(i.noPrice, true);
    assert.equal(i.fromPurchase, 7);
  });

  it("инварианты: fromPurchase + fromStock + unfilled = need; stockAfter ≥ 0", () => {
    const rules = new Map([["Qurt", { excluded: true }], ["Snickers", { fixedQty: 3 }]]);
    const s = computePurchase(
      [row("Fanta", 20, 5), row("Snickers", 12, 2), row("Qurt", 8, 5), row("Montella", 6, 4, 0)],
      prices,
      { rules },
    );
    for (const i of [...s.items, ...s.excludedByRule, ...s.excludedNoSales]) {
      assert.equal(i.fromPurchase + i.fromStock + i.unfilled, i.need, i.product);
      assert.ok(i.stockAfter >= 0, i.product);
    }
    assert.equal(s.totalFromPurchase + s.totalFromStock + s.totalUnfilled, 46);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter @mydon/shared build && pnpm --filter @mydon/shared test 2>&1 | tail -30`
Expected: FAIL — `allocation`/`fromPurchase` undefined, `excludedByRule` undefined.

- [ ] **Step 3: Реализовать** в `vending-calc.ts`:

```ts
export type AllocationPolicy = "purchase-first" | "warehouse-first";

/** Правила закупа товара (vending_product): исключён / фикс-количество / блок без цены (П5a). */
export interface ProductRule {
  excluded?: boolean;
  fixedQty?: number | null;
  pack?: number;
}
```
В `PurchaseOptions` добавить `allocation?: AllocationPolicy; rules?: Map<string, ProductRule>;`. В `PurchaseItem` — 7 новых полей (JSDoc как в Interfaces). В `PurchaseSummary` — `excludedByRule`, `allocation`, четыре `total*`. В теле `computePurchase`:

```ts
  const allocation = opts.allocation ?? "purchase-first";
  const rules = opts.rules ?? new Map<string, ProductRule>();
  const excludedByRule: PurchaseItem[] = [];
  let totalFromPurchase = 0, totalFromStock = 0, totalUnfilled = 0, totalToStock = 0;

  for (const row of input) {
    const need = row.need ?? Object.values(row.perMachine).reduce((a, b) => a + b, 0);
    if (need <= 0) continue;

    const price = prices.get(row.product);
    const rule = rules.get(row.product);
    const excluded = rule?.excluded === true;
    const fixedQty = typeof rule?.fixedQty === "number" && rule.fixedQty > 0 ? rule.fixedQty : null;
    const stock = row.stock;
    const covered = Math.min(stock, need);
    const surplus = Math.max(0, stock - need);
    const pack = price?.pack ?? rule?.pack ?? 1;
    const unit = price?.price ?? 0;
    const noSales = row.sold7 <= 0;

    // Сколько купить: исключённые — ничего; фикс — ровно фикс; иначе дефицит с округлением.
    const shortage = Math.max(0, need - stock);
    const buy = excluded ? 0 : shortage;
    const order = excluded || buy === 0 ? 0 : fixedQty !== null ? fixedQty : !round ? buy : Math.ceil(buy / pack) * pack;

    // Раздача (R-P5a-1): «нет продаж» и «исключён» не покупают, но склад грузят.
    const purchasable = !excluded && (includeNoSales || !noSales);
    const orderForLoad = purchasable ? order : 0;
    let fromPurchase: number;
    let fromStock: number;
    if (allocation === "purchase-first") {
      fromPurchase = Math.min(need, orderForLoad);
      fromStock = Math.min(stock, need - fromPurchase);
    } else {
      fromStock = Math.min(stock, need);
      fromPurchase = Math.min(orderForLoad, need - fromStock);
    }
    const unfilled = need - fromPurchase - fromStock;
    const toStock = orderForLoad - fromPurchase;
    const stockAfter = stock - fromStock + toStock;

    const item: PurchaseItem = {
      product: row.product, perMachine: row.perMachine, need, stock, covered, buy, surplus, pack, order,
      extra: Math.max(0, order - buy), price: unit, costExact: buy * unit, costRounded: order * unit,
      noPrice: price === undefined, noSales,
      fromPurchase, fromStock, unfilled, toStock, stockAfter, excluded, fixedQty,
    };

    totalFromPurchase += fromPurchase; totalFromStock += fromStock; totalUnfilled += unfilled; totalToStock += toStock;
    if (item.noPrice) noPrice.push(row.product);
    if (excluded) { excludedByRule.push(item); continue; }
    if (!item.noPrice) costByPriceFull += need * unit;
    if (item.noSales && !includeNoSales) { excludedNoSales.push(item); continue; }
    totalNeed += need; totalCovered += covered; totalBuy += buy; totalOrder += order;
    if (!item.noPrice) { costExact += item.costExact; costRounded += item.costRounded; }
    items.push(item);
  }
  return { items, excludedNoSales, excludedByRule, noPrice, allocation, totalNeed, totalCovered, totalBuy, totalOrder,
    costExact, costRounded, overpay: costRounded - costExact, costByPriceFull,
    totalFromPurchase, totalFromStock, totalUnfilled, totalToStock };
```
Проверь по контрольному примеру: `extra` раньше был `order − buy` — при `fixedQty === null` это неотрицательно всегда, значит `Math.max(0, …)` старые числа не меняет. `noPrice` у исключённых по-прежнему попадает в список `noPrice` (владелец видит).

- [ ] **Step 4: Прогнать тесты shared**

Run: `pnpm --filter @mydon/shared build && pnpm --filter @mydon/shared test 2>&1 | tail -15`
Expected: PASS, включая старый блок «воспроизводит Приложение Г до единицы».

- [ ] **Step 5: Коммит**

```bash
git add packages/shared/src/vending-calc.ts packages/shared/src/vending-calc.test.ts
git commit -m "feat(shared): политика раздачи purchase-first и правила товара в computePurchase (П5a)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Ядро — раздача по маршруту и по слотам (`vending-plan.ts`)

**Files:**
- Create: `packages/shared/src/vending-plan.ts`
- Test: `packages/shared/src/vending-plan.test.ts`
- Modify: `packages/shared/src/index.ts` (после строки `export * from "./vending-calc";` добавить `export * from "./vending-plan";`)

**Interfaces:**
- Consumes: `PurchaseItem` (Task 1), `Slot`, `slotValid`, `slotDeficit`, `hasProduct` из `vending-calc.ts` (если `hasProduct` не экспортирован — экспортировать).
- Produces:
```ts
/** Порядок слотов: числовые coilId по возрастанию, потом строковые. */
export function coilOrder(a: string, b: string): number;
/** Порядок обхода: серийники из настройки первыми (в их порядке), остальные — по имени. */
export function routeOrderFrom(setting: string, machines: { serial: string; name: string }[]): string[];
export interface ProductAllocation { need: number; fromPurchase: number; fromStock: number; unfilled: number }
export interface MachineAllocation {
  serial: string;
  byProduct: Record<string, ProductAllocation>;
  need: number; fromPurchase: number; fromStock: number; unfilled: number;
}
/** Раздача позиций по автоматам в порядке маршрута: закуп — первому автомату первым, потом склад. */
export function allocateByRoute(items: PurchaseItem[], route: string[]): MachineAllocation[];
export interface SlotPlanRow {
  coilId: string; product: string; quantity: number; capacity: number;
  need: number; fromPurchase: number; fromStock: number; unfilled: number;
}
/** Раздача по слотам одного автомата: меньший coilId первым; сначала закуп, потом склад, остаток — пусто. */
export function allocateBySlots(slots: Slot[], alloc: MachineAllocation, maxCapacity?: number): SlotPlanRow[];
```

- [ ] **Step 1: Тесты** `vending-plan.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PurchaseItem, Slot } from "./vending-calc";
import { allocateByRoute, allocateBySlots, coilOrder, routeOrderFrom } from "./vending-plan";

const item = (o: Partial<PurchaseItem> & { product: string; perMachine: Record<string, number> }): PurchaseItem => ({
  need: Object.values(o.perMachine).reduce((a, b) => a + b, 0),
  stock: 0, covered: 0, buy: 0, surplus: 0, pack: 1, order: 0, extra: 0, price: 0, costExact: 0, costRounded: 0,
  noPrice: false, noSales: false, fromPurchase: 0, fromStock: 0, unfilled: 0, toStock: 0, stockAfter: 0,
  excluded: false, fixedQty: null, ...o,
});

describe("План закупа: порядок слотов и маршрут", () => {
  it("coilOrder: 2 < 10 < 'A'", () => {
    assert.deepEqual(["10", "A", "2"].sort(coilOrder), ["2", "10", "A"]);
  });
  it("routeOrderFrom: серийники настройки первыми, остальные по имени; мусор игнорируется", () => {
    const ms = [{ serial: "2508160359", name: "American Hospital" }, { serial: "2508160376", name: "Olma" }, { serial: "1", name: "Zeta" }];
    assert.deepEqual(routeOrderFrom("2508160376, 9999", ms), ["2508160376", "2508160359", "1"]);
    assert.deepEqual(routeOrderFrom("", ms), ["2508160359", "2508160376", "1"]);
  });
});

describe("План закупа: раздача по автоматам", () => {
  it("первый автомат маршрута получает закуп первым, второй — остаток и склад", () => {
    const fanta = item({ product: "Fanta", perMachine: { olma: 8, ah: 4 }, fromPurchase: 8, fromStock: 3, unfilled: 1 });
    const [olma, ah] = allocateByRoute([fanta], ["olma", "ah"]);
    assert.deepEqual(olma!.byProduct.Fanta, { need: 8, fromPurchase: 8, fromStock: 0, unfilled: 0 });
    assert.deepEqual(ah!.byProduct.Fanta, { need: 4, fromPurchase: 0, fromStock: 3, unfilled: 1 });
    assert.equal(olma!.fromPurchase, 8);
    assert.equal(ah!.unfilled, 1);
  });
  it("автомат без потребности по товару не получает строки", () => {
    const x = item({ product: "X", perMachine: { olma: 2 }, fromPurchase: 2 });
    const [olma, ah] = allocateByRoute([x], ["olma", "ah"]);
    assert.equal(olma!.byProduct.X!.fromPurchase, 2);
    assert.equal(ah!.byProduct.X, undefined);
    assert.equal(ah!.need, 0);
  });
});

describe("План закупа: раздача по слотам", () => {
  const slots: Slot[] = [
    { coilId: "12", product: "Fanta", capacity: 11, quantity: 4 },
    { coilId: "3", product: "Fanta", capacity: 5, quantity: 2 },
    { coilId: "7", product: "TUC", capacity: 5, quantity: 5 },
    { coilId: "9", product: null, capacity: 5, quantity: 0 },
  ];
  it("меньший coilId первым: закуп → склад → пусто; слоты без дефицита и без товара пропущены", () => {
    const alloc = { serial: "olma", byProduct: { Fanta: { need: 10, fromPurchase: 4, fromStock: 3, unfilled: 3 } }, need: 10, fromPurchase: 4, fromStock: 3, unfilled: 3 };
    const rows = allocateBySlots(slots, alloc);
    assert.deepEqual(rows.map((r) => r.coilId), ["3", "12"]);
    assert.deepEqual(rows[0], { coilId: "3", product: "Fanta", quantity: 2, capacity: 5, need: 3, fromPurchase: 3, fromStock: 0, unfilled: 0 });
    assert.deepEqual(rows[1], { coilId: "12", product: "Fanta", quantity: 4, capacity: 11, need: 7, fromPurchase: 1, fromStock: 3, unfilled: 3 });
  });
  it("сумма по слотам равна раздаче автомата", () => {
    const alloc = { serial: "olma", byProduct: { Fanta: { need: 10, fromPurchase: 10, fromStock: 0, unfilled: 0 } }, need: 10, fromPurchase: 10, fromStock: 0, unfilled: 0 };
    const rows = allocateBySlots(slots, alloc);
    assert.equal(rows.reduce((a, r) => a + r.fromPurchase, 0), 10);
  });
});
```

- [ ] **Step 2: Убедиться, что падает** — `pnpm --filter @mydon/shared build 2>&1 | tail -5` (ошибка компиляции: модуля нет).

- [ ] **Step 3: Реализовать** `vending-plan.ts`:

```ts
import { MAX_CAPACITY, slotDeficit, slotValid, type PurchaseItem, type Slot } from "./vending-calc";

/**
 * Раздача закупочного плана по автоматам и слотам (П5a, донор vending-ops
 * build_plan.py:214-262). Чистые функции: те же входы → те же числа.
 */

export function coilOrder(a: string, b: string): number {
  const na = Number(a), nb = Number(b);
  const an = Number.isFinite(na) && a.trim() !== "", bn = Number.isFinite(nb) && b.trim() !== "";
  if (an && bn) return na - nb;
  if (an) return -1;
  if (bn) return 1;
  return a.localeCompare(b, "ru");
}

export function routeOrderFrom(setting: string, machines: { serial: string; name: string }[]): string[] {
  const known = new Set(machines.map((m) => m.serial));
  const first = setting.split(",").map((s) => s.trim()).filter((s) => s !== "" && known.has(s));
  const seen = new Set(first);
  const rest = machines.filter((m) => !seen.has(m.serial)).sort((a, b) => a.name.localeCompare(b.name, "ru")).map((m) => m.serial);
  return [...first, ...rest];
}

export interface ProductAllocation { need: number; fromPurchase: number; fromStock: number; unfilled: number }
export interface MachineAllocation {
  serial: string;
  byProduct: Record<string, ProductAllocation>;
  need: number; fromPurchase: number; fromStock: number; unfilled: number;
}

export function allocateByRoute(items: PurchaseItem[], route: string[]): MachineAllocation[] {
  const out = new Map<string, MachineAllocation>(route.map((serial) => [serial, { serial, byProduct: {}, need: 0, fromPurchase: 0, fromStock: 0, unfilled: 0 }]));
  for (const i of items) {
    let restPurchase = i.fromPurchase, restStock = i.fromStock;
    for (const serial of route) {
      const need = i.perMachine[serial] ?? 0;
      if (need <= 0) continue;
      const fromPurchase = Math.min(need, restPurchase); restPurchase -= fromPurchase;
      const fromStock = Math.min(need - fromPurchase, restStock); restStock -= fromStock;
      const unfilled = need - fromPurchase - fromStock;
      const m = out.get(serial)!;
      m.byProduct[i.product] = { need, fromPurchase, fromStock, unfilled };
      m.need += need; m.fromPurchase += fromPurchase; m.fromStock += fromStock; m.unfilled += unfilled;
    }
  }
  return [...out.values()];
}

export interface SlotPlanRow {
  coilId: string; product: string; quantity: number; capacity: number;
  need: number; fromPurchase: number; fromStock: number; unfilled: number;
}

export function allocateBySlots(slots: Slot[], alloc: MachineAllocation, maxCapacity = MAX_CAPACITY): SlotPlanRow[] {
  const left = new Map<string, { p: number; s: number }>();
  for (const [product, a] of Object.entries(alloc.byProduct)) left.set(product, { p: a.fromPurchase, s: a.fromStock });
  const rows: SlotPlanRow[] = [];
  const ordered = [...slots].sort((a, b) => coilOrder(a.coilId, b.coilId));
  for (const s of ordered) {
    if (!s.product || !slotValid(s, maxCapacity)) continue;
    const need = slotDeficit(s);
    if (need <= 0) continue;
    const product = s.product.trim();
    const l = left.get(product) ?? { p: 0, s: 0 };
    const fromPurchase = Math.min(need, l.p); l.p -= fromPurchase;
    const fromStock = Math.min(need - fromPurchase, l.s); l.s -= fromStock;
    left.set(product, l);
    rows.push({ coilId: s.coilId, product, quantity: Math.min(s.quantity, s.capacity), capacity: s.capacity, need, fromPurchase, fromStock, unfilled: need - fromPurchase - fromStock });
  }
  return rows;
}
```
Если `slotDeficit` в `vending-calc.ts` не экспортирован под этим именем — используй экспортированный (`grep -n "export function slotDeficit" packages/shared/src/vending-calc.ts`). Слоты в `allocateBySlots` приходят уже с каноническими именами (Core резолвит алиасы до вызова — см. Task 4).

- [ ] **Step 4: Прогнать** `pnpm --filter @mydon/shared build && pnpm --filter @mydon/shared test 2>&1 | tail -10` → PASS.

- [ ] **Step 5: Коммит**

```bash
git add packages/shared/src/vending-plan.ts packages/shared/src/vending-plan.test.ts packages/shared/src/index.ts
git commit -m "feat(shared): раздача закупа по маршруту автоматов и по слотам (П5a)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Данные — миграция 0066 и правила владельца в сиде

**Files:**
- Modify: `packages/db/src/schema.ts:1371-1383` (`vendingProduct`)
- Create: `packages/db/drizzle/0066_purchase_rules.sql`, `packages/db/drizzle/meta/0066_snapshot.json` (генерируется)
- Modify: `packages/db/drizzle/meta/_journal.json`
- Modify: `packages/db/src/seed-vending.ts` (константа `VENDING_PURCHASE_RULES`, функция `seedVendingRules`, вызов в `main()`)
- Test: `packages/db/src/seed-vending.test.ts` (новый; проверить, есть ли уже — `ls packages/db/src/*.test.ts`)

**Interfaces:**
- Produces: колонки `vendingProduct.excludedFromPurchase: boolean (default false)`, `vendingProduct.fixedPurchaseQty: integer | null`; 
```ts
export interface PurchaseRuleItem { product: string; excludedFromPurchase?: boolean; fixedPurchaseQty?: number; packSize?: number }
export const VENDING_PURCHASE_RULES: PurchaseRuleItem[];
export async function seedVendingRules(db): Promise<{ applied: number; unknown: string[] }>;
```

- [ ] **Step 1: Дрейф до правок** — `pnpm --filter @mydon/db db:generate 2>&1 | tail -3` → «No schema changes». Иначе остановись и доложи.

- [ ] **Step 2: Схема** — в `vendingProduct` после `packSize`:

```ts
  /** «Убрано из закупки» (П5a): дефицит закрываем только складом, не покупаем. Правило владельца 24.08.2026. */
  excludedFromPurchase: boolean("excluded_from_purchase").default(false).notNull(),
  /** Фикс-количество закупа при дефиците, без округления до блока (СуперКонтик 50, Snickers 48). NULL — обычное округление. */
  fixedPurchaseQty: integer("fixed_purchase_qty"),
```

- [ ] **Step 3: Миграция** — `pnpm --filter @mydon/db db:generate`, переименовать `packages/db/drizzle/00XX_<случайное>.sql` → `0066_purchase_rules.sql`, в `_journal.json` последнюю запись: `"idx": 66, "when": 1787579676510, "tag": "0066_purchase_rules"`. Содержимое SQL привести к виду:

```sql
-- П5a: правила закупа товара как данные (решение владельца 24.08.2026, донор vending-ops).
-- Идемпотентно; дефолты безопасны для живых строк; бэкфилл — сидом seed-vending.js (overlay).
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "excluded_from_purchase" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "vending_product" ADD COLUMN IF NOT EXISTS "fixed_purchase_qty" integer;--> statement-breakpoint
ALTER TABLE "vending_product" DROP CONSTRAINT IF EXISTS "vending_product_fixed_purchase_qty_check";--> statement-breakpoint
ALTER TABLE "vending_product" ADD CONSTRAINT "vending_product_fixed_purchase_qty_check" CHECK ("fixed_purchase_qty" IS NULL OR "fixed_purchase_qty" > 0);
```
Снапшот `meta/0066_snapshot.json` оставить как сгенерирован. Повторный `db:generate` → «No schema changes».

- [ ] **Step 4: Прогнать миграцию дважды на временной БД**

```bash
docker run -d --name mydon-migtest-pg -e POSTGRES_PASSWORD=migtest -e POSTGRES_DB=mydon_migtest -p 55432:5432 postgres:17
sleep 5; pnpm --filter @mydon/db build
DATABASE_URL=postgresql://postgres:migtest@127.0.0.1:55432/mydon_migtest node packages/db/dist/migrate.js
DATABASE_URL=postgresql://postgres:migtest@127.0.0.1:55432/mydon_migtest node packages/db/dist/migrate.js   # второй — no-op, exit 0
docker rm -f mydon-migtest-pg
```

- [ ] **Step 5: Тест сида** `packages/db/src/seed-vending.test.ts` (node:test, чистые проверки данных — без БД):

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { VENDING_ALIASES, VENDING_PRICELIST, VENDING_PURCHASE_RULES } from "./seed-vending";

describe("Сид вендинга: правила закупа владельца (П5a)", () => {
  const names = new Set(VENDING_PRICELIST.map((p) => p.name));
  it("каждое правило ссылается на товар прайса", () => {
    for (const r of VENDING_PURCHASE_RULES) assert.ok(names.has(r.product), r.product);
  });
  it("11 исключений, 2 фикс-количества, блоки 6/5 у энергетиков и чипсов (procurement-rules.json 24.08.2026)", () => {
    assert.equal(VENDING_PURCHASE_RULES.filter((r) => r.excludedFromPurchase).length, 11);
    assert.deepEqual(
      VENDING_PURCHASE_RULES.filter((r) => r.fixedPurchaseQty).map((r) => [r.product, r.fixedPurchaseQty]),
      [["СуперКонтик Шоколадный вкус 100gr", 50], ["Snickers 50gr", 48]],
    );
    const pack = (n: string) => VENDING_PURCHASE_RULES.find((r) => r.product === n)?.packSize;
    assert.equal(pack("Red Bull CAN 0,25"), 6);
    assert.equal(pack("Lays Рифлёные Сметана и лук 70gr"), 5);
  });
  it("каждый алиас ссылается на товар прайса", () => {
    for (const a of VENDING_ALIASES) assert.ok(names.has(a.product), a.alias);
  });
});
```
Проверь `packages/db/package.json` — есть ли скрипт `test` и как собираются тесты (`find dist -name '*.test.js'`); если тестов в пакете нет вовсе — добавь скрипт по образцу `packages/shared/package.json`.

- [ ] **Step 6: Правила в сиде** — в `seed-vending.ts` после `VENDING_ALIASES`:

```ts
/** Правило закупа товара — перенос procurement-rules.json владельца (24.08.2026). */
export interface PurchaseRuleItem {
  product: string;
  excludedFromPurchase?: boolean;
  fixedPurchaseQty?: number;
  packSize?: number;
}

/**
 * Правила закупа владельца (vending-ops, 24.08.2026): что не покупать, фикс-количества,
 * блоки, отличные от правила 12/10. Цены здесь НЕ трогаем — они правятся командой «цена».
 */
export const VENDING_PURCHASE_RULES: PurchaseRuleItem[] = [
  // ── Убрано из закупки (11) ──
  { product: "Ermak Asl Qurt 7шт 30gr", excludedFromPurchase: true },
  { product: "Twix 50gr", excludedFromPurchase: true },
  { product: "Strobar 40gr", excludedFromPurchase: true },
  { product: "Ermak Арахис с солью 50gr", excludedFromPurchase: true },
  { product: "M and Ms Шоколадный 40gr", excludedFromPurchase: true },
  { product: "Barni Шоколадный 30gr", excludedFromPurchase: true },
  { product: "Nesquick Choco 200ml", excludedFromPurchase: true, packSize: 5 },
  { product: "Velona Венские вафли с шоколадным вкусом", excludedFromPurchase: true },
  { product: "Kinder Bueno Chocolate 43gr", excludedFromPurchase: true },
  { product: "Lays Рифлёные Сметана и лук 70gr", excludedFromPurchase: true, packSize: 5 },
  { product: "Flint Kabob 100gr", excludedFromPurchase: true, packSize: 5 },
  // ── Фикс-количества ──
  { product: "СуперКонтик Шоколадный вкус 100gr", fixedPurchaseQty: 50 },
  { product: "Snickers 50gr", fixedPurchaseQty: 48 },
  // ── Блоки, отличные от 12/10 ──
  { product: "Red Bull CAN 0,25", packSize: 6 },
  { product: "Flash Up Energy CAN 0,45", packSize: 6 },
  { product: "Plus 18 CAN 0,45", packSize: 6 },
  { product: "Ozbegim Tea Mango Moychechak 450ml", packSize: 6 },
  { product: "TUC Crackers Sour cream and Onion", packSize: 5 },
  { product: "Cheers Сметана и зелень 70gr", packSize: 5 },
];

/**
 * Наложить правила закупа на существующие строки `vending_product`. Идемпотентно:
 * задаёт ровно те поля, что перечислены в правиле; товар не найден — в `unknown`.
 */
export async function seedVendingRules(db: ReturnType<typeof createDb>): Promise<{ applied: number; unknown: string[] }> {
  const products = await db.select({ id: vendingProduct.id, name: vendingProduct.name }).from(vendingProduct);
  const idByName = new Map(products.map((p) => [p.name, p.id]));
  const unknown: string[] = [];
  let applied = 0;
  for (const r of VENDING_PURCHASE_RULES) {
    const id = idByName.get(r.product);
    if (!id) { unknown.push(r.product); continue; }
    await db.update(vendingProduct).set({
      ...(r.excludedFromPurchase !== undefined ? { excludedFromPurchase: r.excludedFromPurchase } : {}),
      ...(r.fixedPurchaseQty !== undefined ? { fixedPurchaseQty: r.fixedPurchaseQty } : {}),
      ...(r.packSize !== undefined ? { packSize: r.packSize } : {}),
      updatedAt: new Date(),
    }).where(eq(vendingProduct.id, id));
    applied += 1;
  }
  return { applied, unknown };
}
```
В `main()` после алиасов:
```ts
  const rules = await seedVendingRules(db);
  console.log(`Правила закупа: наложено ${rules.applied}` + (rules.unknown.length ? `, не найдено: ${rules.unknown.join(", ")}` : "") + ".");
```
Также добавь в `VENDING_ALIASES` точные Ourvend-имена слотов прода, которых в сиде нет (блок «Ourvend-имена слотов (планограммы прода 24.08.2026)»): `{ alias: "Sprite 250ml", product: "Sprite 250ml" }` не нужен (совпадает); проверь по списку прод-агента: все 33 имени донора найдены в `machine_slot` точно, а в прайсе сида отсутствуют записи для `Kitkat 40gr`? — есть. Единственный кандидат: `"Cheers Сметана и зелень 70gr"` — есть. Добавлять алиасы только там, где имя слота ≠ имя прайса и алиаса ещё нет (сверка — Task 4 warnings `unknown_product` покажет остаток на проде).

- [ ] **Step 7: Прогнать** `pnpm --filter @mydon/db build && pnpm --filter @mydon/db test` (страж `schema.test.ts` + новый тест) → PASS.

- [ ] **Step 8: Коммит**

```bash
git add packages/db
git commit -m "feat(db): правила закупа товара — колонки 0066 и overlay правил владельца в сиде (П5a)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Core — `GET /vending/plan`, правила товара, фильтр автоматов, разбивка в заявке

**Files:**
- Modify: `apps/core/src/system/config-spec.ts` (в `CONFIG_SPECS` перед `GR_COMMISSION_METHOD`), `apps/core/src/system/config-spec.test.ts` (если в нём считаются ключи — обновить ожидание)
- Modify: `apps/core/src/vending/vending.service.ts` (`loadProductIndex` :665, `purchase()` :855, `submitPurchase` :893, новые `plan()`, `products()`, `setProductRules()`, `inServiceSerials()`, `routeSetting()`)
- Modify: `apps/core/src/vending/vending.controller.ts` (DTO `SetProductRulesDto`, роуты)
- Modify: `tools/smoke-core.mjs` (`ЧТЕНИЕ`: `/vending/plan`, `/vending/products`; `ЗАПИСЬ`: `/vending/product-rules`)
- Test: `apps/core/src/vending/vending.service.test.ts` (новые `describe`)

**Interfaces:**
- Consumes: Task 1 (`computePurchase` c `rules`/`allocation`), Task 2 (`allocateByRoute`, `allocateBySlots`, `routeOrderFrom`), Task 3 (колонки), `machineCard`, `systemConfig`, `entity` из `@mydon/db`, `resolveEffective`/`specFor` из `../system/config-spec`.
- Produces:
```ts
export interface PlanMachine {
  serial: string; name: string; routeIndex: number;
  need: number; fromPurchase: number; fromStock: number; unfilled: number;
  slots: SlotPlanRow[];
}
export interface PlanWarning { code: "stock_stale" | "machine_skipped" | "no_price" | "unknown_product"; message: string }
export interface PurchasePlan {
  generatedAt: string;                       // ISO
  stock: { asOf: string | null; totalBefore: number; use: number; back: number; totalAfter: number; stale: boolean };
  summary: PurchaseSummary;                  // из computePurchase (аддитивно расширен)
  machines: PlanMachine[];
  warnings: PlanWarning[];
}
export interface VendingProductRow { id: string; name: string; category: "drink"|"snack"|"other"; purchasePrice: number | null; packSize: number; isActive: boolean; excludedFromPurchase: boolean; fixedPurchaseQty: number | null }
export interface SetRulesResult { ok: boolean; reason?: "not_found"; product?: string; before?: Partial<VendingProductRow>; after?: Partial<VendingProductRow> }
// Роуты: GET /vending/plan → PurchasePlan; GET /vending/products → VendingProductRow[]; POST /vending/product-rules { product; packSize?; excludedFromPurchase?; fixedPurchaseQty? (0 = снять); actor? } → SetRulesResult
```
`STOCK_STALE_DAYS = 3` — константа сервиса с JSDoc (спека §6).

- [ ] **Step 1: Ключ маршрута** в `config-spec.ts`:

```ts
  // ── Вендинг: порядок обхода автоматов при загрузке (П5a, R-P5a-3) ──
  {
    key: "VENDING_ROUTE_ORDER",
    label: "Вендинг: маршрут загрузки (серийники через запятую)",
    kind: "text",
    placeholder: "2508160376,2508160359",
    help: "Первый автомат маршрута получает закуп первым. Пусто — по имени автомата.",
    validate: (v) => (/^\s*\d{6,}(\s*,\s*\d{6,})*\s*$/.test(v) ? null : "серийники (без «c») через запятую, например 2508160376,2508160359"),
  },
```
Прогнать `pnpm --filter core build && pnpm --filter core test 2>&1 | grep -i "config" | tail -5` — если `config-spec.test.ts` ждёт точное число ключей, поправить.

- [ ] **Step 2: Тесты сервиса** (в `vending.service.test.ts`, стаб по образцу `readDb`/`priceDb` того же файла):

```ts
describe("Вендинг Core: план закупа (П5a)", () => {
  type Card = { entityId: string; status: string };
  type Ent = { id: string; name: string; externalRef: string | null; type: string };
  /** Стаб: слоты, склад, товары, карточки автоматов, настройки — по ссылке на таблицу. */
  function planDb(o: { slots: Row[]; stock?: { productName: string; quantity: number; countedAt: Date }[]; products?: ProdRow[]; aliases?: AliasRow[]; cards?: Card[]; entities?: Ent[]; config?: { key: string; value: string }[]; sales?: SaleRow[] }) {
    return {
      select: () => ({
        from: (t: unknown) => {
          const rows =
            t === vendingAlias ? o.aliases ?? [] : t === vendingProduct ? o.products ?? [] : t === vendingStock ? o.stock ?? []
            : t === machineCard ? o.cards ?? [] : t === entity ? o.entities ?? [] : t === systemConfig ? o.config ?? []
            : t === productSale ? o.sales ?? [] : o.slots;
          const p = Promise.resolve(rows);
          return { where: async () => rows, then: p.then.bind(p) };
        },
      }),
    } as never;
  }
  const slots: Row[] = [
    { machineSerial: "2508160376", coilId: "1", productName: "Fanta", capacity: 5, quantity: 1 },
    { machineSerial: "2508160359", coilId: "1", productName: "Fanta", capacity: 5, quantity: 3 },
    { machineSerial: "2508160355", coilId: "1", productName: "Fanta", capacity: 5, quantity: 0 }, // SKLAD 5S — warehouse
  ];
  const entities: Ent[] = [
    { id: "m-olma", name: "Olma", externalRef: "c2508160376", type: "machine" },
    { id: "m-ah", name: "American Hospital", externalRef: "c2508160359", type: "machine" },
    { id: "m-sk", name: "SKLAD 5S", externalRef: "c2508160355", type: "machine" },
  ];
  const cards: Card[] = [{ entityId: "m-olma", status: "in_service" }, { entityId: "m-ah", status: "in_service" }, { entityId: "m-sk", status: "warehouse" }];
  const products: ProdRow[] = [{ id: "p1", name: "Fanta", purchasePrice: "5167", packSize: 12, excludedFromPurchase: false, fixedPurchaseQty: null } as ProdRow];

  it("автомат не в строю пропущен и виден в warnings; маршрут из настройки; раздача по слотам", async () => {
    const db = planDb({ slots, entities, cards, products, stock: [{ productName: "Fanta", quantity: 2, countedAt: new Date() }], config: [{ key: "VENDING_ROUTE_ORDER", value: "2508160359,2508160376" }] });
    const plan = await new VendingService(db).plan();
    assert.deepEqual(plan.machines.map((m) => m.serial), ["2508160359", "2508160376"]);
    assert.equal(plan.machines[0]!.name, "American Hospital");
    assert.ok(plan.warnings.some((w) => w.code === "machine_skipped" && w.message.includes("SKLAD 5S")));
    // need: AH 2, Olma 4 = 6; stock 2; order 12 → fromPurchase 6, склад не трогаем
    assert.equal(plan.summary.totalFromPurchase, 6);
    assert.equal(plan.summary.totalFromStock, 0);
    assert.equal(plan.machines[0]!.slots[0]!.fromPurchase, 2);
    assert.equal(plan.stock.totalBefore, 2);
    assert.equal(plan.stock.totalAfter, 2 + 6);
    assert.equal(plan.stock.stale, false);
  });

  it("склад старше 3 дней → warning stock_stale и stock.stale=true", async () => {
    const old = new Date(Date.now() - 4 * 86_400_000);
    const db = planDb({ slots, entities, cards, products, stock: [{ productName: "Fanta", quantity: 2, countedAt: old }] });
    const plan = await new VendingService(db).plan();
    assert.equal(plan.stock.stale, true);
    assert.ok(plan.warnings.some((w) => w.code === "stock_stale"));
  });

  it("без настройки маршрут — по имени автомата", async () => {
    const db = planDb({ slots, entities, cards, products });
    const plan = await new VendingService(db).plan();
    assert.deepEqual(plan.machines.map((m) => m.name), ["American Hospital", "Olma"]);
  });

  it("исключённый товар уходит в excludedByRule, фикс — в order", async () => {
    const prods: ProdRow[] = [
      { id: "p1", name: "Fanta", purchasePrice: "5167", packSize: 12, excludedFromPurchase: true, fixedPurchaseQty: null } as ProdRow,
    ];
    const db = planDb({ slots, entities, cards, products: prods });
    const plan = await new VendingService(db).plan();
    assert.equal(plan.summary.items.length, 0);
    assert.equal(plan.summary.excludedByRule[0]!.product, "Fanta");
  });
});

describe("Вендинг Core: правила товара (П5a)", () => {
  it("меняет блок/исключение/фикс в транзакции с событием и аудитом; 0 снимает фикс", async () => {
    const { db, updates, events, audits } = priceDb({ id: "p1", name: "TUC", purchasePrice: null, packSize: 10, excludedFromPurchase: false, fixedPurchaseQty: 5 } as never);
    const res = await new VendingService(db).setProductRules("TUC", { packSize: 5, excludedFromPurchase: true, fixedPurchaseQty: 0 }, "owner");
    assert.equal(res.ok, true);
    assert.deepEqual(updates[0], { packSize: 5, excludedFromPurchase: true, fixedPurchaseQty: null, updatedAt: updates[0]!.updatedAt });
    assert.equal(events[0]!.type, "vending.product_rules_changed");
    assert.equal(audits[0]!.action, "vending.product.set_rules");
  });
  it("товар не найден → not_found", async () => {
    const { db } = priceDb(null);
    const res = await new VendingService(db).setProductRules("Нет такого", { packSize: 5 });
    assert.equal(res.ok, false);
    assert.equal(res.reason, "not_found");
  });
});

describe("Вендинг Core: заявка хранит разбивку по автоматам (П5a)", () => {
  // Тот же стаб, что в describe «отправка закупа на утверждение (§5.7)» выше: purchaseDb + очередь согласований.
  const t = new Date("2026-08-02T00:00:00Z");
  const slots: Row[] = [
    { machineSerial: "AH", coilId: "1", productName: "Montella", capacity: 6, quantity: 2 },
    { machineSerial: "OL", coilId: "1", productName: "Montella", capacity: 6, quantity: 3 },
  ];
  const sales: SaleRow[] = [{ machineSerial: "AH", productName: "Montella", quantity: 14, capturedAt: t }];
  const products: ProdRow[] = [{ name: "Montella", purchasePrice: "5000.00", packSize: 12 }];
  it("positions содержат perMachine/fromPurchase/fromStock/unfilled", async () => {
    const requests: { payload?: Record<string, unknown> }[] = [];
    const svc = { request: async (input: { payload?: Record<string, unknown> }) => { requests.push(input); return { id: "ap-1" }; } };
    const vending = new VendingService(purchaseDb(slots, sales, products), svc as never);
    await vending.submitPurchase("owner");
    const po = (requests[0]!.payload as { purchaseOrder: { positions: Record<string, unknown>[] } }).purchaseOrder;
    const pos = po.positions[0]!;
    assert.deepEqual(pos.perMachine, { AH: 4, OL: 3 });
    assert.equal(pos.fromPurchase, 7); // need 7, склад 0, order 12 → в автоматы 7
    assert.equal(pos.fromStock, 0);
    assert.equal(pos.unfilled, 0);
    assert.deepEqual(Object.keys(pos).sort(), ["buy", "costRounded", "fromPurchase", "fromStock", "noPrice", "order", "pack", "perMachine", "price", "product", "unfilled"]);
  });
});
```
⚠️ Существующие стабы этого файла (`readDb`, `forecastDb`, `purchaseDb`, `priceDb`) отдают строки слотов для ЛЮБОЙ неизвестной таблицы. `purchase()` теперь читает ещё `entity` и `machineCard` — добавь в каждый стаб ветки `t === entity ? [] : t === machineCard ? [] : t === systemConfig ? [] : …` (импорт `machineCard`, `systemConfig` из `@mydon/db`), иначе строки слотов притворятся карточками. Сервис устроен так, что автомат без карточки считается в строю — старые тесты с пустыми `entity`/`machineCard` проходят без изменений.

`priceDb` в тесте цены выбирает строку `productRow` через `.where().limit()` — `setProductRules` должен читать товар тем же путём (`select … where lower(name) = canon limit 1`), тогда стаб переиспользуется. Расширь тип `ProdRow` тестового файла полями `excludedFromPurchase?: boolean; fixedPurchaseQty?: number | null`.

- [ ] **Step 3: Убедиться, что падает** — `pnpm --filter core build 2>&1 | tail -5` (нет `plan`/`setProductRules`).

- [ ] **Step 4: Реализовать в `vending.service.ts`**

Импорты: добавить `machineCard, systemConfig` в импорт из `@mydon/db`; `allocateByRoute, allocateBySlots, routeOrderFrom, type MachineAllocation, type ProductRule, type SlotPlanRow` из `@mydon/shared`; `import { resolveEffective, specFor } from "../system/config-spec";`.

`loadProductIndex` — в `select` добавить `excludedFromPurchase: vendingProduct.excludedFromPurchase, fixedPurchaseQty: vendingProduct.fixedPurchaseQty, category: vendingProduct.category`, вернуть дополнительно `rulesByName: Map<string, ProductRule>` (`{ excluded: p.excludedFromPurchase, fixedQty: p.fixedPurchaseQty, pack: p.packSize }` для каждого товара).

```ts
/** Склад считается устаревшим для плана, если инвентаризация старше стольких дней (спека §6). */
export const STOCK_STALE_DAYS = 3;

/**
 * Автоматы, о которых ТОЧНО известно, что они не в строю (machine_card.status ≠ in_service),
 * и имена по серийнику. Автомат без карточки/без записи в реестре считается в строю
 * (DEFAULT_MACHINE_STATUS): молчаливое исключение опаснее лишней строки (R-P5a-4).
 * Серийник — канон без «c» (normalizeMachineSerial), как у слотов Ourvend.
 */
private async machineRegistry(): Promise<{ notInService: Map<string, { name: string; status: string }>; nameBySerial: Map<string, string> }> {
  const [ents, cards] = await Promise.all([
    this.db.select({ id: entity.id, name: entity.name, externalRef: entity.externalRef }).from(entity).where(eq(entity.type, "machine")),
    this.db.select({ entityId: machineCard.entityId, status: machineCard.status }).from(machineCard),
  ]);
  const statusById = new Map(cards.map((c) => [c.entityId, c.status]));
  const notInService = new Map<string, { name: string; status: string }>();
  const nameBySerial = new Map<string, string>();
  for (const e of ents) {
    if (!e.externalRef) continue;
    const serial = normalizeMachineSerial(e.externalRef);
    if (!nameBySerial.has(serial)) nameBySerial.set(serial, e.name);
    const status = statusById.get(e.id) ?? "in_service";
    if (status !== "in_service") notInService.set(serial, { name: e.name, status });
  }
  return { notInService, nameBySerial };
}

/** Настройка маршрута: база важнее env, env важнее дефолта (тот же резолвер, что у панели настроек). */
private async routeSetting(): Promise<string> {
  const spec = specFor("VENDING_ROUTE_ORDER");
  if (!spec) return "";
  const rows = await this.db.select().from(systemConfig);
  const map: Record<string, string> = {};
  for (const r of rows) map[r.key] = r.value;
  return resolveEffective(spec, map, process.env).value;
}
```
Внутри `purchase()`: после `okSerials` убрать серийники из `notInService` (сравнивать через `normalizeMachineSerial(serial)`), `skipped` = те из них, у кого были слоты; вызывать `computePurchase(rows, prices, { rules: rulesByName })`. Вынести общую часть в `private async purchaseContext()` → `{ summary, ok: MachineSlots[], nameBySerial, skipped: { serial; name; status }[], stockRows, unknownProducts }`, где `unknownProducts` — канон-имена слотов с дефицитом, которых нет в `vending_product` (по `nameById`). `purchase()` = `(await this.purchaseContext()).summary`.

```ts
async plan(): Promise<PurchasePlan> {
  const ctx = await this.purchaseContext();
  const s = ctx.summary;
  const machines = ctx.ok.map((m) => ({ serial: m.machineId, name: ctx.nameBySerial.get(m.machineId) ?? m.machineId }));
  const route = routeOrderFrom(await this.routeSetting(), machines);
  const allItems = [...s.items, ...s.excludedByRule, ...s.excludedNoSales];
  const byMachine = allocateByRoute(allItems, route);
  const slotsBySerial = new Map(ctx.ok.map((m) => [m.machineId, m.slots]));
  const planMachines: PlanMachine[] = byMachine.map((a, i) => ({
    serial: a.serial, name: ctx.nameBySerial.get(a.serial) ?? a.serial, routeIndex: i + 1,
    need: a.need, fromPurchase: a.fromPurchase, fromStock: a.fromStock, unfilled: a.unfilled,
    slots: allocateBySlots(slotsBySerial.get(a.serial) ?? [], a),
  }));
  const asOf = ctx.stockRows.reduce<Date | null>((acc, r) => (!acc || r.countedAt > acc ? r.countedAt : acc), null);
  const stale = asOf === null || Date.now() - asOf.getTime() > STOCK_STALE_DAYS * 86_400_000;
  const totalBefore = ctx.stockRows.reduce((a, r) => a + r.quantity, 0);
  const warnings: PlanWarning[] = [];
  if (stale) warnings.push({ code: "stock_stale", message: asOf ? `Склад инвентаризирован ${asOf.toLocaleDateString("ru-RU", { timeZone: TZ })} — обнови: «склад …»` : "Склад не инвентаризирован — план считает склад пустым" });
  for (const m of ctx.skipped) warnings.push({ code: "machine_skipped", message: `${m.name} (${m.serial}) не в строю: ${m.status}` });
  if (s.noPrice.length) warnings.push({ code: "no_price", message: `Без цены — вне бюджета: ${s.noPrice.join(", ")}` });
  if (ctx.unknownProducts.length) warnings.push({ code: "unknown_product", message: `Нет в прайсе вендинга (нужна карточка или алиас): ${ctx.unknownProducts.join(", ")}` });
  return {
    generatedAt: new Date().toISOString(),
    stock: { asOf: asOf?.toISOString() ?? null, totalBefore, use: s.totalFromStock, back: s.totalToStock, totalAfter: totalBefore - s.totalFromStock + s.totalToStock, stale },
    summary: s, machines: planMachines, warnings,
  };
}
```
`stockByProduct()` сейчас читает `vendingStock` — расширь до `stockRows()` (имя, qty, countedAt) и переиспользуй. `countedAt` в схеме `vending_stock` — проверь имя колонки (`schema.ts:1498-1508`).

`products()`:
```ts
async products(): Promise<VendingProductRow[]> {
  const rows = await this.db.select().from(vendingProduct);
  return rows.map((p) => ({ id: p.id, name: p.name, category: p.category, purchasePrice: p.purchasePrice === null ? null : Number(p.purchasePrice), packSize: p.packSize, isActive: p.isActive, excludedFromPurchase: p.excludedFromPurchase, fixedPurchaseQty: p.fixedPurchaseQty }))
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
}
```
`setProductRules(rawProduct, patch: { packSize?: number; excludedFromPurchase?: boolean; fixedPurchaseQty?: number }, actor = "owner")` — по образцу `setProductPrice` (:1226-1275): резолв алиаса → `select … limit 1` → транзакция `update` (`fixedPurchaseQty: patch.fixedPurchaseQty === 0 ? null : patch.fixedPurchaseQty`, `updatedAt: new Date()`) + `event { source: "owner", type: "vending.product_rules_changed", payload: { product, before, after, actor } }` + `auditLog { actorKind: "human", actorRef: actor, action: "vending.product.set_rules", target: row.id, before, after }`. Пустой patch (ни одного поля) → `{ ok: false, reason: "not_found" }` не подходит — верни `{ ok: true, product, before, after }` без записи? Нет: DTO гарантирует хотя бы одно поле (см. Step 5), сервис при пустом patch бросает `BadRequestException("нечего менять")`.

`submitPurchase` — позиции: добавить `perMachine: i.perMachine, fromPurchase: i.fromPurchase, fromStock: i.fromStock, unfilled: i.unfilled`.

- [ ] **Step 5: Контроллер** — DTO и роуты:

```ts
export class SetProductRulesDto {
  @IsString() @IsNotEmpty() @MaxLength(255)
  product!: string;

  @IsOptional() @IsInt() @Min(1) @Max(1000)
  packSize?: number;

  @IsOptional() @IsIn([true, false])
  excludedFromPurchase?: boolean;

  /** 0 — снять фикс-количество. */
  @IsOptional() @IsInt() @Min(0) @Max(100_000)
  fixedPurchaseQty?: number;

  @IsOptional() @IsString() @MaxLength(128)
  actor?: string;
}
```
Роуты рядом с `product-price`:
```ts
  /** План закупа: раздача по маршруту и слотам (П5a). */
  @Get("plan")
  plan() { return this.vending.plan(); }

  /** Прайс вендинга с правилами закупа — для редактора панели. */
  @Get("products")
  products() { return this.vending.products(); }

  /** Правила закупа товара: блок / исключён / фикс-количество (П5a). */
  @Post("product-rules")
  setProductRules(@Body() dto: SetProductRulesDto) {
    const { product, actor, ...patch } = dto;
    if (patch.packSize === undefined && patch.excludedFromPurchase === undefined && patch.fixedPurchaseQty === undefined) {
      throw new BadRequestException("нечего менять: укажи packSize, excludedFromPurchase или fixedPurchaseQty");
    }
    return this.vending.setProductRules(product, patch, actor);
  }
```
(`BadRequestException` — импорт из `@nestjs/common`.)

- [ ] **Step 6: smoke-core** — в `ЧТЕНИЕ` добавить `"/vending/plan"`, `"/vending/products"`; в `ЗАПИСЬ` — шаг `{ имя: "правила товара (не найден → not_found)", path: "/vending/product-rules", body: { product: "Smoke Нет Такого", packSize: 5 }, проверить: (о) => { if (о.ok !== false) throw new Error("ожидали not_found"); } }` (изучи форму существующих шагов и как обрабатывается ответ 200 с `ok:false`).

- [ ] **Step 7: Прогнать** `pnpm --filter core build && pnpm --filter core test 2>&1 | tail -15` → PASS (все старые + новые). `pnpm -s typecheck` по репо.

- [ ] **Step 8: Коммит**

```bash
git add apps/core tools/smoke-core.mjs
git commit -m "feat(core): план закупа GET /vending/plan, правила товара, фильтр автоматов в строю, разбивка в заявке (П5a)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Бот — «план закупа», команды правил товара, строка брифинга

**Files:**
- Modify: `apps/bot/src/core-client.ts` (типы `VendingPlan`, `VendingProductRules`, методы `vendingPlan()`, `setVendingProductRules()`; в `VendingPurchaseItem` добавить `fromPurchase, fromStock, unfilled, toStock, stockAfter, excluded, fixedQty`; в `VendingPurchase` — `excludedByRule, totalFromPurchase, totalFromStock, totalUnfilled, totalToStock`)
- Create: `apps/bot/src/purchase-plan.ts` (+ `purchase-plan.test.ts`), `apps/bot/src/product-rules.ts` (+ `product-rules.test.ts`)
- Modify: `apps/bot/src/purchase-brief.ts:17-50` (`formatPurchaseBrief` — строка раздачи), `apps/bot/src/handler.ts` (`Reply.more`, ветки, HELP), `apps/bot/src/index.ts` (отправка `reply.more`), `apps/bot/src/briefing.ts:99-146` (`BriefingPurchase.fromStock?`), тесты рядом
- Test: `apps/bot/src/purchase-brief.test.ts`, `apps/bot/src/briefing.test.ts` (найти существующий файл тестов брифинга: `ls apps/bot/src/*brief*.test.ts`)

**Interfaces:**
- Consumes: Task 4 (`GET /vending/plan` → `PurchasePlan`, `POST /vending/product-rules`).
- Produces:
```ts
// purchase-plan.ts
export function isPlanCommand(text: string): boolean;                 // «план закупа», «план закупки», «маршрут закупа», «план загрузки»
export function formatPurchasePlan(p: VendingPlan): string[];         // ≥2 сообщений, каждое ≤ 3500 символов
export const TG_BUDGET = 3500;
// product-rules.ts
export type RuleCommand =
  | { kind: "exclude"; product: string }          // «не закупать <товар>»
  | { kind: "include"; product: string }          // «закупать <товар>»
  | { kind: "fixed"; product: string; qty: number } // «фикс <товар> <N>»; «фикс <товар> нет» → qty 0
  | { kind: "pack"; product: string; qty: number }; // «блок <товар> <N>»
export function isRuleCommand(text: string): boolean;
export function parseRuleCommand(text: string): RuleCommand | null;
export function formatRuleResult(cmd: RuleCommand, res: SetRulesResult): string;
export const RULE_COMMAND_HINT: string;
// handler.ts
export interface Reply { text: string; more?: string[]; keyboard?; document? }
```

- [ ] **Step 1: Тесты** `purchase-plan.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { VendingPlan } from "./core-client";
import { TG_BUDGET, formatPurchasePlan, isPlanCommand } from "./purchase-plan";

/** ru-RU ставит U+202F/U+00A0 в тысячах — сравниваем по обычному пробелу. */
const norm = (s: string): string => s.replace(/[\u00a0\u202f]/g, " ");

const plan: VendingPlan = {
  generatedAt: "2026-08-25T04:00:00.000Z",
  stock: { asOf: "2026-08-20T15:00:00.000Z", totalBefore: 134, use: 3, back: 4, totalAfter: 135, stale: true },
  summary: {
    items: [{ product: "Fanta", need: 12, stock: 3, buy: 9, pack: 12, order: 12, price: 5167, costRounded: 62004, noPrice: false, noSales: false, fromPurchase: 12, fromStock: 0, unfilled: 0, toStock: 0, stockAfter: 3, excluded: false, fixedQty: null, perMachine: { "2508160376": 8, "2508160359": 4 } }],
    excludedNoSales: [], excludedByRule: [{ product: "Qurt", need: 5, stock: 3, buy: 0, pack: 10, order: 0, price: 6800, costRounded: 0, noPrice: false, noSales: false, fromPurchase: 0, fromStock: 3, unfilled: 2, toStock: 0, stockAfter: 0, excluded: true, fixedQty: null, perMachine: { "2508160376": 5 } }],
    noPrice: [], totalBuy: 9, totalOrder: 12, costExact: 46503, costRounded: 62004, overpay: 15501,
    totalFromPurchase: 12, totalFromStock: 3, totalUnfilled: 2, totalToStock: 0, allocation: "purchase-first",
  },
  machines: [
    { serial: "2508160376", name: "Olma", routeIndex: 1, need: 13, fromPurchase: 8, fromStock: 3, unfilled: 2, slots: [{ coilId: "3", product: "Fanta", quantity: 1, capacity: 5, need: 4, fromPurchase: 4, fromStock: 0, unfilled: 0 }, { coilId: "5", product: "Qurt", quantity: 0, capacity: 5, need: 5, fromPurchase: 0, fromStock: 3, unfilled: 2 }] },
    { serial: "2508160359", name: "American Hospital", routeIndex: 2, need: 4, fromPurchase: 4, fromStock: 0, unfilled: 0, slots: [{ coilId: "12", product: "Fanta", quantity: 7, capacity: 11, need: 4, fromPurchase: 4, fromStock: 0, unfilled: 0 }] },
  ],
  warnings: [{ code: "stock_stale", message: "Склад инвентаризирован 20.08.2026 — обнови: «склад …»" }],
};

describe("Бот: команда «план закупа»", () => {
  it("ловит формулировки владельца и не ловит «что заказать»", () => {
    for (const t of ["план закупа", "План закупки", "маршрут закупа", "план загрузки"]) assert.equal(isPlanCommand(t), true, t);
    for (const t of ["что заказать", "закуп", "оформить закуп"]) assert.equal(isPlanCommand(t), false, t);
  });
  it("сводка: итоги, маршрут по автоматам, склад до/после, предупреждение о давности", () => {
    const [head] = formatPurchasePlan(plan).map(norm);
    assert.match(head!, /Загрузить 15 из 17/);
    assert.match(head!, /купить 12 .*62 004/);
    assert.match(head!, /1\. Olma — загрузить 11 \(закуп 8 · склад 3\) · пусто 2/);
    assert.match(head!, /2\. American Hospital — загрузить 4/);
    assert.match(head!, /Склад: 134 → 135/);
    assert.match(head!, /⚠️ .*20\.08\.2026/);
  });
  it("купить / со склада / убрано / слоты по автоматам — отдельные сообщения", () => {
    const parts = formatPurchasePlan(plan).map(norm);
    assert.ok(parts.some((p) => /🛒 Купить/.test(p) && /Fanta — 12 \(в автоматы 12, на склад 0\) · 62 004 сум/.test(p)));
    assert.ok(parts.some((p) => /📦 Со склада/.test(p) && /Qurt — 3/.test(p)));
    assert.ok(parts.some((p) => /🚫 Убрано из закупки/.test(p) && /Qurt — со склада 3, пусто 2/.test(p)));
    assert.ok(parts.some((p) => /🎰 Olma/.test(p) && /слот 5 Qurt: 0\/5 \+5 → склад 3 · пусто 2/.test(p)));
  });
  it("каждое сообщение укладывается в бюджет Telegram", () => {
    const big = { ...plan, machines: plan.machines.map((m) => ({ ...m, slots: Array.from({ length: 200 }, (_, i) => ({ ...m.slots[0]!, coilId: String(i) })) })) };
    for (const p of formatPurchasePlan(big)) assert.ok(p.length <= TG_BUDGET, String(p.length));
  });
  it("нечего грузить — одно сообщение", () => {
    const empty = { ...plan, summary: { ...plan.summary, items: [], excludedByRule: [], totalFromPurchase: 0, totalFromStock: 0, totalUnfilled: 0 }, machines: [] };
    assert.equal(formatPurchasePlan(empty).length, 1);
  });
});
```
`product-rules.test.ts`:
```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatRuleResult, isRuleCommand, parseRuleCommand } from "./product-rules";

describe("Бот: команды правил закупа товара (П5a)", () => {
  it("разбирает четыре формы", () => {
    assert.deepEqual(parseRuleCommand("не закупать Twix"), { kind: "exclude", product: "Twix" });
    assert.deepEqual(parseRuleCommand("Закупать twix"), { kind: "include", product: "twix" });
    assert.deepEqual(parseRuleCommand("фикс Snickers 48"), { kind: "fixed", product: "Snickers", qty: 48 });
    assert.deepEqual(parseRuleCommand("фикс Snickers нет"), { kind: "fixed", product: "Snickers", qty: 0 });
    assert.deepEqual(parseRuleCommand("блок Red Bull 6"), { kind: "pack", product: "Red Bull", qty: 6 });
  });
  it("число — один токен: «блок Cola 330 12» → товар «Cola 330», блок 12", () => {
    assert.deepEqual(parseRuleCommand("блок Cola 330 12"), { kind: "pack", product: "Cola 330", qty: 12 });
  });
  it("потолки и мусор → null; «закупать» без товара → null", () => {
    assert.equal(parseRuleCommand("блок TUC 5000"), null);
    assert.equal(parseRuleCommand("фикс TUC 0"), null);
    assert.equal(parseRuleCommand("закупать"), null);
  });
  it("isRuleCommand не ловит «что закупать» и «закуп»", () => {
    assert.equal(isRuleCommand("что закупать"), false);
    assert.equal(isRuleCommand("закуп"), false);
    assert.equal(isRuleCommand("не закупать Lays"), true);
  });
  it("форматирует успех и «не найден»", () => {
    assert.match(formatRuleResult({ kind: "exclude", product: "Twix" }, { ok: true, product: "Twix 50gr" }), /«Twix 50gr» убран из закупки/);
    assert.match(formatRuleResult({ kind: "pack", product: "X" }, { ok: false, reason: "not_found", product: "X" }), /не найден/);
  });
});
```

- [ ] **Step 2: Убедиться, что падает** — `pnpm --filter bot build 2>&1 | tail -5`.

- [ ] **Step 3: Реализовать**

`core-client.ts`: интерфейсы `VendingPlanSlot`, `VendingPlanMachine`, `VendingPlan` (зеркало `PurchasePlan` из Task 4), `SetRulesResult`; методы:
```ts
  vendingPlan(): Promise<VendingPlan> { return this.request<VendingPlan>("/vending/plan"); }
  setVendingProductRules(product: string, patch: { packSize?: number; excludedFromPurchase?: boolean; fixedPurchaseQty?: number }): Promise<SetRulesResult> {
    return this.request("/vending/product-rules", { method: "POST", body: JSON.stringify({ product, ...patch, actor: "owner" }) });
  }
```
`purchase-plan.ts`:
```ts
import { TZ } from "@mydon/shared";
import type { VendingPlan, VendingPlanMachine } from "./core-client";

/** Telegram обрезает на 4096 — держимся заметно ниже (как owner-actions.ts). */
export const TG_BUDGET = 3500;
const RU = (n: number): string => Math.round(n).toLocaleString("ru-RU");
const day = (iso: string): string => new Date(iso).toLocaleDateString("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" });

/** «план закупа» / «план закупки» / «маршрут закупа» / «план загрузки» — без \b (кириллица). */
export function isPlanCommand(text: string): boolean {
  return /^(план|маршрут)\s+(закуп|загруз)/i.test(text.trim());
}

/** Режет список строк на сообщения ≤ TG_BUDGET, каждое с заголовком (+ «(продолжение)»). */
function chunk(title: string, lines: string[]): string[] {
  const out: string[] = [];
  let cur: string[] = [title, ""];
  let len = title.length + 1;
  for (const l of lines) {
    if (len + l.length + 1 > TG_BUDGET) { out.push(cur.join("\n")); cur = [`${title} (продолжение)`, ""]; len = cur[0]!.length + 1; }
    cur.push(l); len += l.length + 1;
  }
  out.push(cur.join("\n"));
  return out;
}

function machineLine(m: VendingPlanMachine): string {
  const load = m.fromPurchase + m.fromStock;
  return `${m.routeIndex}. ${m.name} — загрузить ${RU(load)} (закуп ${RU(m.fromPurchase)} · склад ${RU(m.fromStock)})${m.unfilled > 0 ? ` · пусто ${RU(m.unfilled)}` : ""}`;
}

export function formatPurchasePlan(p: VendingPlan): string[] {
  const s = p.summary;
  const need = s.totalFromPurchase + s.totalFromStock + s.totalUnfilled;
  const load = s.totalFromPurchase + s.totalFromStock;
  const head: string[] = [`📋 План закупа — ${day(p.generatedAt)}`, ""];
  if (need === 0) return [`📋 План закупа: грузить нечего — дефицита у автоматов в расчёте нет.`];
  const money = s.costRounded > 0 ? ` на ${RU(s.costRounded)} сум` : "";
  head.push(`Загрузить ${RU(load)} из ${RU(need)} нужных · со склада ${RU(s.totalFromStock)} · купить ${RU(s.totalOrder)} ед (${s.items.length} поз.)${money}${s.totalUnfilled > 0 ? ` · пусто ${RU(s.totalUnfilled)}` : ""}`);
  head.push("", "Маршрут:");
  for (const m of p.machines) head.push(machineLine(m));
  head.push("", `Склад: ${RU(p.stock.totalBefore)} → ${RU(p.stock.totalAfter)} (взять ${RU(p.stock.use)}, вернуть ${RU(p.stock.back)})${p.stock.asOf ? ` · инвентаризация ${day(p.stock.asOf)}` : ""}`);
  for (const w of p.warnings) head.push(`⚠️ ${w.message}`);
  const parts: string[] = [head.join("\n")];

  if (s.items.length > 0) {
    const rows = [...s.items].sort((a, b) => b.costRounded - a.costRounded).map((i) => `• ${i.product} — ${RU(i.order)} (в автоматы ${RU(i.fromPurchase)}, на склад ${RU(i.toStock)}) · ${i.noPrice ? "нет цены" : `${RU(i.costRounded)} сум`}`);
    if (s.noPrice.length) rows.push("", `⚠️ Без цены — на разбор: ${s.noPrice.join(", ")}`);
    parts.push(...chunk(`🛒 Купить — ${RU(s.totalOrder)} ед${money}`, rows));
  }
  const fromStock = [...s.items, ...s.excludedByRule, ...s.excludedNoSales].filter((i) => i.fromStock > 0);
  if (fromStock.length > 0) {
    const rows = fromStock.map((i) => `• ${i.product} — ${RU(i.fromStock)} (${p.machines.filter((m) => (m.slots.some((sl) => sl.product === i.product && sl.fromStock > 0))).map((m) => `${m.name} ${RU(m.slots.filter((sl) => sl.product === i.product).reduce((a, sl) => a + sl.fromStock, 0))}`).join(", ")}) · останется ${RU(i.stockAfter)}`);
    parts.push(...chunk(`📦 Со склада собрать — ${RU(s.totalFromStock)} ед`, rows));
  }
  if (s.excludedByRule.length > 0) {
    parts.push(...chunk("🚫 Убрано из закупки — только склад", s.excludedByRule.map((i) => `• ${i.product} — со склада ${RU(i.fromStock)}, пусто ${RU(i.unfilled)}`)));
  }
  for (const m of p.machines) {
    const rows = m.slots.map((sl) => {
      const src = [sl.fromPurchase > 0 ? `закуп ${RU(sl.fromPurchase)}` : "", sl.fromStock > 0 ? `склад ${RU(sl.fromStock)}` : "", sl.unfilled > 0 ? `пусто ${RU(sl.unfilled)}` : ""].filter(Boolean).join(" · ");
      return `слот ${sl.coilId} ${sl.product}: ${sl.quantity}/${sl.capacity} +${sl.need} → ${src}`;
    });
    if (rows.length > 0) parts.push(...chunk(`🎰 ${m.name} — загрузить ${RU(m.fromPurchase + m.fromStock)}${m.unfilled > 0 ? ` · пусто ${RU(m.unfilled)}` : ""}`, rows));
  }
  return parts;
}
```
(Формулировки должны совпадать с регексами тестов: «Загрузить 15 из 17», «купить 12 ед (1 поз.) на 62 004 сум», «1. Olma — загрузить 11 (закуп 8 · склад 3) · пусто 2», «Склад: 134 → 135», «Fanta — 12 (в автоматы 12, на склад 0) · 62 004 сум», «Qurt — со склада 3, пусто 2», «слот 5 Qurt: 0/5 +5 → склад 3 · пусто 2».)

`product-rules.ts`:
```ts
import type { SetRulesResult } from "./core-client";

export type RuleCommand =
  | { kind: "exclude"; product: string }
  | { kind: "include"; product: string }
  | { kind: "fixed"; product: string; qty: number }
  | { kind: "pack"; product: string; qty: number };

export const RULE_COMMAND_HINT =
  "Правила закупа: «не закупать <товар>», «закупать <товар>», «фикс <товар> <N>» (или «нет»), «блок <товар> <N>».";

/** Префиксы команд правил (без \b — не работает после кириллицы). «что закупать» не ловим. */
export function isRuleCommand(text: string): boolean {
  return /^(не\s+закупать|закупать|фикс|блок)(\s|:|$)/i.test(text.trim());
}

const NUM = /^(.+?)[\s:—=-]+(\d+(?:[\s  ]\d{3})*)\s*(?:шт\.?)?\s*[.!]?$/i;

export function parseRuleCommand(text: string): RuleCommand | null {
  const t = text.trim();
  let m = /^не\s+закупать\s*:?\s*(.+)$/i.exec(t);
  if (m) return { kind: "exclude", product: clean(m[1]!) };
  m = /^закупать\s*:?\s*(.+)$/i.exec(t);
  if (m) return { kind: "include", product: clean(m[1]!) };
  m = /^(фикс|блок)\s*:?\s*(.+)$/i.exec(t);
  if (!m) return null;
  const kind = m[1]!.toLowerCase() === "фикс" ? "fixed" : "pack";
  const rest = m[2]!.trim();
  if (kind === "fixed") {
    const off = /^(.+?)[\s:—=-]+(нет|снять|0)\s*[.!]?$/i.exec(rest);
    if (off) return { kind, product: clean(off[1]!), qty: 0 };
  }
  const n = NUM.exec(rest);
  if (!n) return null;
  const qty = Number(n[2]!.replace(/[\s  ]+/g, ""));
  const max = kind === "pack" ? 1000 : 100_000;
  if (!Number.isInteger(qty) || qty <= 0 || qty > max) return null;
  return { kind, product: clean(n[1]!), qty };
}

function clean(s: string): string { return s.trim().replace(/[«»"']/g, "").replace(/[,;:—-]+$/, "").trim(); }

export function formatRuleResult(cmd: RuleCommand, res: SetRulesResult): string {
  if (!res.ok) return `Товар «${res.product ?? cmd.product}» не найден в прайсе вендинга. Имя должно совпадать с карточкой или алиасом.`;
  const name = res.product ?? cmd.product;
  const what =
    cmd.kind === "exclude" ? `«${name}» убран из закупки — грузим только со склада.` :
    cmd.kind === "include" ? `«${name}» снова закупается.` :
    cmd.kind === "fixed" ? (cmd.qty === 0 ? `Фикс-количество «${name}» снято — обычное округление до блока.` : `«${name}»: при дефиците покупаем ровно ${cmd.qty}.`) :
    `Блок «${name}»: ${cmd.qty} шт.`;
  return `${what}\n\n«план закупа» — пересчитать.`;
}
```
`handler.ts`: `Reply` + `more?: string[]`; импорт новых модулей; ветки — ПЕРЕД `isPriceCommand`: 
```ts
  if (isRuleCommand(text)) {
    const cmd = parseRuleCommand(text);
    if (cmd === null) return { text: RULE_COMMAND_HINT };
    try {
      const patch = cmd.kind === "exclude" ? { excludedFromPurchase: true } : cmd.kind === "include" ? { excludedFromPurchase: false } : cmd.kind === "fixed" ? { fixedPurchaseQty: cmd.qty } : { packSize: cmd.qty };
      const res = await deps.core.setVendingProductRules(cmd.product, patch);
      return { text: formatRuleResult(cmd, res) };
    } catch (err) { console.error("Ошибка правки правил закупа:", err); return { text: "Не удалось записать правило в MYDON Core. Попробуй ещё раз чуть позже." }; }
  }
  if (isPlanCommand(text)) {
    try { const [first, ...more] = formatPurchasePlan(await deps.core.vendingPlan()); return { text: first!, more }; }
    catch (err) { console.error("Ошибка плана закупа:", err); return { text: "Не удалось получить план закупа из MYDON Core. Попробуй ещё раз чуть позже." }; }
  }
```
HELP — строки после «что заказать»: `"• «план закупа» — маршрут, что купить, что взять со склада, слоты по автоматам"`, `"• «не закупать Twix» / «закупать Twix» / «фикс Snickers 48» / «блок Red Bull 6» — правила закупа товара"`.
`index.ts`: в каждом месте `await tg.sendMessage(chatId, reply.text, …)` (строки ~239, 242, 309, 760) сразу после — `for (const part of reply.more ?? []) await tg.sendMessage(chatId, part);`.
`purchase-brief.ts` `formatPurchaseBrief`: после строки «Купить … ед» добавить `if (p.totalFromStock > 0 || p.totalUnfilled > 0) lines.push(`В автоматы: из закупа ${RU(p.totalFromPurchase)} · со склада ${RU(p.totalFromStock)}${p.totalUnfilled > 0 ? ` · пусто ${RU(p.totalUnfilled)}` : ""} — «план закупа»`);` (поля опциональны в типе? — нет, Core теперь всегда отдаёт; в тестах `formatPurchaseBrief` фикстура `item()`/объект `VendingPurchase` должна получить новые поля — обнови хелперы тестов).
`briefing.ts`: `BriefingPurchase { positions; costRounded; fromStock?: number }`, строка: `` `🛒 К закупу: ${purchase.positions} поз.${tail}${purchase.fromStock ? ` · со склада ${purchase.fromStock}` : ""} — «оформить закуп».` ``; в `index.ts`/`handler.ts` где строится `BriefingPurchase` из `purchase` — добавить `fromStock: purchase.totalFromStock`.

- [ ] **Step 4: Прогнать** `pnpm --filter bot build && pnpm --filter bot test 2>&1 | tail -15` → PASS.

- [ ] **Step 5: Коммит**

```bash
git add apps/bot
git commit -m "feat(bot): «план закупа» по маршруту и слотам, команды правил товара, строка раздачи в брифинге (П5a)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Панель — лист «План закупа» с кнопкой «Оформить закуп»

**Files:**
- Modify: `apps/cc/src/lib/core.ts` (типы `VendingPlan*`, поля `VendingPurchaseItem`/`VendingPurchase` как в Task 5; геттеры `vendingPlan: () => get<VendingPlan>("/vending/plan")`, `vendingProducts: () => get<VendingProductRow[]>("/vending/products")`, мутации `submitVendingPurchase: (createdBy: string) => send<…>("/vending/purchase/submit", "POST", { createdBy })`, `setVendingProductRules: (input) => send<SetRulesResult>("/vending/product-rules", "POST", input)`)
- Create: `apps/cc/src/app/vending/actions.ts` (`"use server"`: `submitVendingPurchase(domain: string)`, `saveVendingProductRules(domain: string, form: FormData)`)
- Create: `apps/cc/src/components/purchase-plan-view.tsx` (async `PurchasePlanView` + sync `PurchasePlanTables({ plan })`), `apps/cc/src/components/purchase-plan-submit.tsx` (client-кнопка)
- Test: `apps/cc/src/components/purchase-plan-view.test.tsx`
- Modify: `apps/cc/src/lib/domain-nav.ts` (группа `reports`: после `{ label: "Приход", type: "purchase" }` → `{ label: "План закупа", type: "buy_plan" }`; в `TABLE_BACKED_LEAVES` → `"buy_plan"`), `apps/cc/src/app/domain/[domain]/page.tsx` (импорт + `{group && leaf?.type === "buy_plan" && <PurchasePlanView domain={domain} />}` рядом с `machine_stock`)

**Interfaces:**
- Consumes: Task 4 API.
- Produces: `PurchasePlanTables({ plan, domain })` — презентационный компонент (тестируется без Core); `SubmitPurchaseButton({ domain })` — форма по конвенции #208.

- [ ] **Step 1: Тест** `purchase-plan-view.test.tsx` (vitest; фикстура `plan` — та же, что в Task 5, тип `VendingPlan` из `../lib/core`):

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { VendingPlan } from "../lib/core";
import { PurchasePlanTables } from "./purchase-plan-view";
import { SubmitPurchaseButton } from "./purchase-plan-submit";

const mocks = vi.hoisted(() => ({ submitVendingPurchase: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../app/vending/actions", () => ({ submitVendingPurchase: mocks.submitVendingPurchase, saveVendingProductRules: vi.fn() }));

const plan: VendingPlan = {
  generatedAt: "2026-08-25T04:00:00.000Z",
  stock: { asOf: "2026-08-20T15:00:00.000Z", totalBefore: 134, use: 3, back: 4, totalAfter: 135, stale: true },
  summary: {
    items: [{ product: "Fanta", need: 12, stock: 3, buy: 9, pack: 12, order: 12, price: 5167, costRounded: 62004, noPrice: false, noSales: false, fromPurchase: 12, fromStock: 0, unfilled: 0, toStock: 0, stockAfter: 3, excluded: false, fixedQty: null, perMachine: { "2508160376": 8, "2508160359": 4 } }],
    excludedNoSales: [],
    excludedByRule: [{ product: "Qurt", need: 5, stock: 3, buy: 0, pack: 10, order: 0, price: 6800, costRounded: 0, noPrice: false, noSales: false, fromPurchase: 0, fromStock: 3, unfilled: 2, toStock: 0, stockAfter: 0, excluded: true, fixedQty: null, perMachine: { "2508160376": 5 } }],
    noPrice: [], totalBuy: 9, totalOrder: 12, costExact: 46503, costRounded: 62004, overpay: 15501,
    totalFromPurchase: 12, totalFromStock: 3, totalUnfilled: 2, totalToStock: 0, allocation: "purchase-first",
  },
  machines: [
    { serial: "2508160376", name: "Olma", routeIndex: 1, need: 13, fromPurchase: 8, fromStock: 3, unfilled: 2, slots: [{ coilId: "3", product: "Fanta", quantity: 1, capacity: 5, need: 4, fromPurchase: 4, fromStock: 0, unfilled: 0 }, { coilId: "5", product: "Qurt", quantity: 0, capacity: 5, need: 5, fromPurchase: 0, fromStock: 3, unfilled: 2 }] },
    { serial: "2508160359", name: "American Hospital", routeIndex: 2, need: 4, fromPurchase: 4, fromStock: 0, unfilled: 0, slots: [{ coilId: "12", product: "Fanta", quantity: 7, capacity: 11, need: 4, fromPurchase: 4, fromStock: 0, unfilled: 0 }] },
  ],
  warnings: [{ code: "stock_stale", message: "Склад инвентаризирован 20.08.2026 — обнови: «склад …»" }],
} as VendingPlan;

describe("лист «План закупа»", () => {
  it("показывает итоги, маршрут, таблицы купить/склад/убрано и слоты по автоматам", () => {
    render(<PurchasePlanTables plan={plan} domain="vendhub" />);
    expect(screen.getByText(/Загрузить 15 из 17/)).toBeVisible();
    expect(screen.getByText("Olma")).toBeVisible();
    expect(screen.getByText(/Убрано из закупки/)).toBeVisible();
    expect(screen.getByText(/Склад на 20\.08\.2026/)).toBeVisible();
    expect(screen.getByText(/обнови/)).toBeVisible();
  });
  it("кнопка «Оформить закуп» показывает ошибку Core на месте и не падает", async () => {
    mocks.submitVendingPurchase.mockResolvedValue({ ok: false, message: "Core недоступен" });
    render(<SubmitPurchaseButton domain="vendhub" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Оформить закуп" }));
    expect(await screen.findByText("Core недоступен")).toBeVisible();
  });
  it("успех — подтверждение с числом позиций и refresh", async () => {
    mocks.submitVendingPurchase.mockResolvedValue({ ok: true, message: "Заявка отправлена: 3 поз." });
    render(<SubmitPurchaseButton domain="vendhub" />);
    await userEvent.setup().click(screen.getByRole("button", { name: "Оформить закуп" }));
    expect(await screen.findByText(/3 поз\./)).toBeVisible();
    expect(mocks.refresh).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Убедиться, что падает** — `pnpm --filter cc test -- purchase-plan 2>&1 | tail -5`.

- [ ] **Step 3: Реализовать**

`actions.ts`:
```ts
"use server";
import { revalidatePath } from "next/cache";
import { core, CoreUnavailable } from "../../lib/core";

export interface ActionResult { ok: boolean; message?: string }

/** Кнопка «Оформить закуп» на листе «План закупа»: та же заявка T2, что и из бота. */
export async function submitVendingPurchase(domain: string): Promise<ActionResult> {
  try {
    const res = await core.submitVendingPurchase("panel");
    if (!res.submitted) return { ok: false, message: res.reason ?? "Закупать нечего" };
    revalidatePath(`/domain/${domain}`);
    return { ok: true, message: `Заявка отправлена: ${res.positions} поз. — реши в «Согласованиях».` };
  } catch (err) {
    return { ok: false, message: err instanceof CoreUnavailable ? err.detail : err instanceof Error ? err.message : "Не получилось" };
  }
}

/** Правила закупа товара (лист «Правила закупа»): блок / исключён / фикс. */
export async function saveVendingProductRules(domain: string, form: FormData): Promise<ActionResult> {
  const product = String(form.get("product") ?? "").trim();
  const packRaw = String(form.get("packSize") ?? "").trim();
  const fixedRaw = String(form.get("fixedPurchaseQty") ?? "").trim();
  const excluded = form.get("excludedFromPurchase") === "on";
  const packSize = packRaw === "" ? undefined : Number(packRaw);
  const fixedPurchaseQty = fixedRaw === "" ? 0 : Number(fixedRaw);
  if (packSize !== undefined && (!Number.isInteger(packSize) || packSize < 1 || packSize > 1000)) return { ok: false, message: "Блок — целое число 1…1000" };
  if (!Number.isInteger(fixedPurchaseQty) || fixedPurchaseQty < 0 || fixedPurchaseQty > 100_000) return { ok: false, message: "Фикс — целое число (пусто = снять)" };
  try {
    const res = await core.setVendingProductRules({ product, ...(packSize !== undefined ? { packSize } : {}), excludedFromPurchase: excluded, fixedPurchaseQty, actor: "panel" });
    if (!res.ok) return { ok: false, message: `Товар «${product}» не найден` };
    revalidatePath(`/domain/${domain}`);
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof CoreUnavailable ? err.detail : err instanceof Error ? err.message : "Не получилось" };
  }
}
```
`purchase-plan-submit.tsx` (client, конвенция #208 — форма без полей, кнопка):
```tsx
"use client";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { submitVendingPurchase } from "../app/vending/actions";

export function SubmitPurchaseButton({ domain }: { domain: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  return (
    <form className="form-actions" onSubmit={(e) => { e.preventDefault(); start(async () => {
      const res = await submitVendingPurchase(domain);
      if (res.ok) { setError(null); setDone(res.message ?? "Отправлено"); router.refresh(); } else { setDone(null); setError(res.message ?? "Не получилось"); }
    }); }}>
      <button type="submit" className="btn primary" disabled={pending}>{pending ? "…" : "Оформить закуп"}</button>
      {error && <span className="err-text">{error}</span>}
      {done && <span className="muted">{done}</span>}
    </form>
  );
}
```
`purchase-plan-view.tsx`: `export async function PurchasePlanView({ domain })` — `try { plan = await core.vendingPlan() } catch { return <div className="empty"><b>План недоступен</b>Core не ответил — обнови страницу.</div> }` → `<PurchasePlanTables plan={plan} domain={domain} />`. `PurchasePlanTables` (sync): шапка `<p className="lead">Загрузить <b>N</b> из M нужных · со склада N · купить N ед (K поз.) на S сум · пусто N</p>`; бейдж `Склад на dd.mm.yyyy` + `⚠️ … обнови` при `stale` (текст из `warnings`); секция «Маршрут» — таблица `Шаг | Автомат | Загрузить | Закуп | Склад | Пусто`; `<SubmitPurchaseButton domain={domain} />` под таблицей «Купить» (`Товар | Нужно | Склад | Купить | В автоматы | На склад | Сумма`, плюс чипы «фикс N», «нет цены»); «Убрано из закупки» (`Товар | Нужно | Со склада | Пусто`); «Собрать со склада» (`Товар | Сейчас | по автоматам | Взять | После`); по автомату — `<details className="sect" open>` «Слоты — {name}» (`Слот | Товар | Было | Нужно | План | Источник`). Классы — как в `vending-panel.tsx` (`section-title`, `rows`, `row`, `pill`, `muted`, `page-head`); таблицы — `<table className="table">` если такой класс есть в `globals.css` (проверь `grep -n "\.table" apps/cc/src/app/globals.css`), иначе `rows/row`.

`domain-nav.ts` и `page.tsx` — как в Files. В `page.tsx` вид рендерится внутри `group && leaf?.type === "buy_plan"`; проверь, что серверный компонент асинхронный принимается там же, где `<MachineStockView />`.

- [ ] **Step 4: Прогнать** `pnpm --filter cc test 2>&1 | tail -8 && pnpm --filter cc lint && pnpm --filter cc build 2>&1 | tail -5` → PASS/OK.

- [ ] **Step 5: Коммит**

```bash
git add apps/cc
git commit -m "feat(cc): лист «План закупа» — маршрут, купить/склад/убрано, слоты, кнопка «Оформить закуп» (П5a)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Панель — лист «Правила закупа» (редактор `vending_product`)

**Files:**
- Create: `apps/cc/src/components/product-rules-panel.tsx` (client), `apps/cc/src/components/product-rules-view.tsx` (async server: `core.vendingProducts()` → `<ProductRulesPanel domain products />`)
- Test: `apps/cc/src/components/product-rules-panel.test.tsx`
- Modify: `apps/cc/src/lib/domain-nav.ts` (группа `settings`: после листа товаров/`product` — `{ label: "Правила закупа", type: "purchase_rules" }`; `TABLE_BACKED_LEAVES` → `"purchase_rules"`), `apps/cc/src/app/domain/[domain]/page.tsx` (диспетч `purchase_rules`)

**Interfaces:**
- Consumes: `core.vendingProducts()`, `saveVendingProductRules(domain, form)` (Task 6), `VendingProductRow`.
- Produces: `ProductRulesPanel({ domain, products })`.

- [ ] **Step 1: Тест** `product-rules-panel.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VendingProductRow } from "../lib/core";
import { ProductRulesPanel } from "./product-rules-panel";

const mocks = vi.hoisted(() => ({ saveVendingProductRules: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("../app/vending/actions", () => ({ saveVendingProductRules: mocks.saveVendingProductRules, submitVendingPurchase: vi.fn() }));

const rows: VendingProductRow[] = [
  { id: "p1", name: "Snickers 50gr", category: "snack", purchasePrice: 7000, packSize: 10, isActive: true, excludedFromPurchase: false, fixedPurchaseQty: 48 },
  { id: "p2", name: "Twix 50gr", category: "snack", purchasePrice: 7000, packSize: 10, isActive: true, excludedFromPurchase: true, fixedPurchaseQty: null },
];

describe("лист «Правила закупа»", () => {
  beforeEach(() => vi.resetAllMocks());
  it("показывает товары с правилами", () => {
    render(<ProductRulesPanel domain="vendhub" products={rows} />);
    expect(screen.getByText("Snickers 50gr")).toBeVisible();
    expect(screen.getByText("Twix 50gr")).toBeVisible();
  });
  it("сохраняет введённый блок при отказе Core и показывает ошибку", async () => {
    mocks.saveVendingProductRules.mockResolvedValue({ ok: false, message: "Core недоступен" });
    const user = userEvent.setup();
    render(<ProductRulesPanel domain="vendhub" products={rows} />);
    await user.click(screen.getByRole("button", { name: "Править Snickers 50gr" }));
    const pack = screen.getByLabelText("Блок, шт");
    await user.clear(pack); await user.type(pack, "12");
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Core недоступен")).toBeVisible();
    expect(pack).toHaveValue("12");
    const form = mocks.saveVendingProductRules.mock.calls[0]?.[1] as FormData;
    expect(form.get("product")).toBe("Snickers 50gr");
    expect(form.get("packSize")).toBe("12");
  });
  it("успех — refresh и форма закрывается", async () => {
    mocks.saveVendingProductRules.mockResolvedValue({ ok: true });
    const user = userEvent.setup();
    render(<ProductRulesPanel domain="vendhub" products={rows} />);
    await user.click(screen.getByRole("button", { name: "Править Twix 50gr" }));
    await user.click(screen.getByRole("button", { name: "Сохранить" }));
    await vi.waitFor(() => expect(mocks.refresh).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Убедиться, что падает.**

- [ ] **Step 3: Реализовать** `product-rules-panel.tsx` по эталону `customs-rates.tsx`: список строк (`rows/row`: имя, категория, цена или «нет цены», «блок N», чип «исключён», чип «фикс N»), кнопка `aria-label`/текст `Править {name}` открывает форму строки (`useState<string | null>` — id редактируемого):

```tsx
function RuleForm({ domain, row, onDone }: { domain: string; row: VendingProductRow; onDone: () => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <form className="form card" style={{ marginTop: 10 }} onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); start(async () => {
      const res = await saveVendingProductRules(domain, form);
      if (res.ok) { setError(null); onDone(); router.refresh(); } else setError(res.message ?? "Не получилось");
    }); }}>
      <input type="hidden" name="product" value={row.name} />
      <label><span>Блок, шт</span><input name="packSize" inputMode="numeric" defaultValue={row.packSize} /></label>
      <label><span>Фикс-количество при дефиците (пусто — снять)</span><input name="fixedPurchaseQty" inputMode="numeric" defaultValue={row.fixedPurchaseQty ?? ""} /></label>
      <label className="check"><input type="checkbox" name="excludedFromPurchase" defaultChecked={row.excludedFromPurchase} /><span>Убрать из закупки (грузить только со склада)</span></label>
      <div className="form-actions">
        <button type="submit" className="btn primary" disabled={pending}>{pending ? "…" : "Сохранить"}</button>
        <button type="button" className="btn" onClick={onDone}>Отмена</button>
        {error && <span className="err-text">{error}</span>}
      </div>
    </form>
  );
}
```
Подпись `<label><span>Блок, шт</span>` должна давать `getByLabelText("Блок, шт")` (как в customs-rates). Цена — только чтение с подсказкой «цена правится в боте: «цена <товар> <сум>»».

- [ ] **Step 4: Прогнать** `pnpm --filter cc test 2>&1 | tail -8 && pnpm --filter cc lint && pnpm --filter cc build 2>&1 | tail -3`.

- [ ] **Step 5: Коммит**

```bash
git add apps/cc
git commit -m "feat(cc): лист «Правила закупа» — блок, исключение, фикс-количество товара вендинга (П5a)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Документы, env, полный прогон

**Files:**
- Modify: `docs/PLAN_STOCK_ABSORPTION.md` (§П5: галочка ✅ у «что купить … бюджетом» → «✅ П5a (без поставщика/бюджет-лимита)», абзац «**Решения волны П5a (2026-08-25).** Реализовано: …; Осознанно НЕ реализовано: горизонт склада N дней (донор 2), поставщик/лучшая цена, dead_stock, price_changes, маржа — П5b; PNG-картинки; нечёткие алиасы.»)
- Modify: `.env.example` (блок вендинга: `# Маршрут загрузки автоматов для плана закупа (П5a): серийники через запятую; правится и из панели настроек (база важнее env).` `VENDING_ROUTE_ORDER=`)
- Modify: `deploy/docker-compose.yml` (+ `docker-compose.standby.yml`, если есть): проброс `VENDING_ROUTE_ORDER: ${VENDING_ROUTE_ORDER:-}` в `mydon-core` (по образцу соседних переменных)
- Modify: `tools/smoke-panel.mjs` — если он перечисляет листы/страницы, добавить `?tab=reports:buy_plan` и `?tab=settings:purchase_rules` с ключевыми словами «План закупа»/«Правила закупа» (изучи формат).

- [ ] **Step 1: Правки docs/env/compose/smoke-panel.**
- [ ] **Step 2: Полный прогон как CI:** `pnpm -s lint && pnpm -s typecheck && pnpm -s build && pnpm -s test 2>&1 | tail -20` → всё зелёное. Если поднят локальный Postgres — `DATABASE_URL=… SERVICE_TOKEN=smoke-token node tools/smoke-core.mjs`.
- [ ] **Step 3: Коммит**

```bash
git add docs/PLAN_STOCK_ABSORPTION.md .env.example deploy tools/smoke-panel.mjs
git commit -m "docs(p5a): решения волны П5a в плане поглощения, VENDING_ROUTE_ORDER в env/compose, листы в smoke-panel

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Выкатка (после адверсариал-ревью, вне задач)
1. `git push -u origin feat/p5a-procurement-plan` → `gh pr create` → CI зелёный → merge.
2. Вахта: `/health` → commit = merge-sha (7 знаков!), `.last-ok-sha`.
3. На проде один раз (R-P5a-5): `cd /opt/mydon-app && docker compose -f deploy/docker-compose.yml run --rm mydon-core node packages/db/dist/seed-vending.js` — лог: «Прайс вендинга: занесено 48», «Алиасы…», «Правила закупа: наложено 19». Затем `curl -s 127.0.0.1:3001/vending/products | jq length` → 48; `curl -s 127.0.0.1:3001/vending/plan | jq '.warnings, .summary.totalFromPurchase, .machines[].name'`.
4. Бот: «план закупа» → ≥ 4 сообщений; «блок TUC 5» → ответ; CC: `reports:buy_plan`, `settings:purchase_rules`.
5. Владельцу: «склад …» (переинвентаризация), `VENDING_ROUTE_ORDER` в настройках, 7 цен «на разбор» из лога сида.
