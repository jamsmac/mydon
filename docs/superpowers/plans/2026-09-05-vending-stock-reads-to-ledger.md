# Чтения остатков товаров → складской леджер — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** В режиме `VENDING_STOCK_SOURCE=ledger` все пять читателей остатков товаров (список остатков, расчёт закупа, мёртвый сток, ответ заливки, сверка) идут через одну дверь `goodsStock()`, а сверка перестаёт быть ложно-зелёной на пустой таблице. В режиме `table` — ни одна цифра не меняется.

**Architecture:** Чистые функции сборки (`assembleGoodsStock`, `parityRows`) отделены от SQL-обёрток (`ledgerQtyMany`, `lastCountedByProduct`, `goodsStock`, `vendingParity`) и тестируются на заглушке; SQL — на настоящем Postgres в CI (`tools/pglite-checks/check-parts-u6.mjs`). Читатели получают ветку `ledger`, которая зовёт `VendingLedgerService.goodsStock()`; таблица `vending_stock` в этом режиме не читается.

**Tech Stack:** TypeScript strict · NestJS · Drizzle (`sql` шаблоны) · node:test (core) · vitest (cc) · pglite/postgres:17 (сценарии) · Turborepo + pnpm.

**Spec:** `docs/superpowers/specs/2026-09-05-vending-stock-reads-to-ledger-design.md`

## Global Constraints

- TypeScript strict, без `any`; `exactOptionalPropertyTypes` — необязательные поля добавлять через spread `...(x ? { k: x } : {})`.
- Русский язык в UI и сообщениях, английский в коде; имена переменных кириллицей допустимы там, где файл уже так пишет.
- Часовой пояс Asia/Tashkent; даты `vending_stock_count.dt` — голые ташкентские сутки (`date`), сравнивать как строки `YYYY-MM-DD`.
- **Миграций, новых таблиц, колонок и настроек — нет** (R-GS-8). Существующий ключ `VENDING_STOCK_SOURCE`, значения `table | ledger`.
- **R-GS-4:** в режиме `table` поведение всех читателей — строка в строку прежнее; существующие тесты не правятся, только добавляются.
- Ветка `feat/goods-stock-reads-to-ledger` → PR → merge (в `main` напрямую нельзя). Коммиты — Conventional Commits, на русском, как в репо.
- Гейт перед PR: `pnpm build && pnpm test && pnpm lint && pnpm typecheck`, затем сценарии на SQL в ОБОИХ движках:
  `CHECKS_DATABASE_URL=postgres://mydon:mydon@127.0.0.1:55432/mydon node tools/pglite-checks/check-parts-u6.mjs` и
  `NODE_PATH=~/pgtest/node_modules node tools/pglite-checks/check-parts-u6.mjs` (сборка `pnpm --filter @mydon/db build && pnpm --filter @mydon/core build` перед ними).
- Прод этим срезом НЕ переключается: флип `ledger` — владельцем после недели нулевой сверки.

---

## Файловая структура

| Файл | Ответственность |
|---|---|
| `apps/core/src/stock/goods-stock.ts` (новый) | Чистая логика: типы `GoodsStockRow/GoodsStock`, `assembleGoodsStock()`, статусы сверки `parityRows()`/`parityStatus()`. Без импортов БД. |
| `apps/core/src/stock/goods-stock.test.ts` (новый) | node:test на чистую логику. |
| `apps/core/src/stock/vending-ledger.ts` | SQL-обёртки: `ledgerQtyMany`, `lastCountedByProduct`, `goodsStock`; `vendingParity` через `parityRows`; методы сервиса. |
| `apps/core/src/vending/vending.service.ts` | `stockLevels`, `stockRows`, план: `unknownStock`, предупреждение, сторож давности. |
| `apps/core/src/vending/analytics.service.ts` | мёртвый сток — ветка `ledger` + предупреждение. |
| `apps/core/src/vending/refill.service.ts` | остаток в ветке повтора — через леджер. |
| `apps/core/src/system/config-spec.ts` | текст `help` настройки. |
| `apps/cc/src/lib/core.ts`, `apps/cc/src/app/stock/goods/page.tsx` | тип и статусы сверки, счётчик в шапке. |
| `tools/pglite-checks/check-parts-u6.mjs` | сценарии на настоящем SQL. |
| `tools/smoke-core.mjs` | оба маршрута в режиме `ledger`. |
| `docs/superpowers/specs/2026-09-04-vendhub-parts-inventory-design.md` §12, `docs/OWNER_NEXT_STEPS_parts.md` | как сделано. |

---

### Task 1: Чистая логика — `assembleGoodsStock()` и статусы сверки

**Files:**
- Create: `apps/core/src/stock/goods-stock.ts`
- Test: `apps/core/src/stock/goods-stock.test.ts`

**Interfaces:**
- Consumes: `normalizeProductName` из `@mydon/shared` (уже есть, используется в `vending.service.ts`).
- Produces (их используют Task 2–4):

```ts
export interface GoodsStockRow {
  productName: string;
  productId: string;
  cardId: string | null;
  quantity: number | null;   // null — неизвестно (нет карточки или склада), R-GS-3
  countedAt: Date | null;    // R-GS-6
  isActive: boolean;
}
export interface GoodsStock {
  warehouseId: string | null;
  rows: GoodsStockRow[];     // отсортированы по имени (ru)
  asOf: Date | null;         // max(countedAt) по строкам
}
export interface GoodsStockInput {
  warehouseId: string | null;
  products: { id: string; name: string; entityId: string | null; isActive: boolean }[];
  qtyByCard: Map<string, number>;          // cardId → остаток леджера
  countedById: Map<string, Date>;          // productId → последний пересчёт
  countedByName: Map<string, Date>;        // normalizeProductName(имя) → последний пересчёт (фолбэк)
  includeInactive?: boolean;               // по умолчанию false (R-GS-2)
}
export function assembleGoodsStock(input: GoodsStockInput): GoodsStock;

export type VendingParityStatus = "ok" | "mismatch" | "no_row" | "no_card" | "inactive_with_stock" | "no_warehouse";
export interface VendingParityRow {
  productName: string;
  productId: string | null;
  cardId: string | null;
  table: number | null;      // null — строки в таблице нет
  ledger: number | null;     // null — карточки/склада нет
  diff: number | null;
  status: VendingParityStatus;
  isMismatch: boolean;       // считается расхождением по §6 спеки
}
export interface TableStockRow { productName: string; productId: string | null; quantity: number }
export function parityRows(goods: GoodsStock, table: TableStockRow[], canon: (raw: string) => string): VendingParityRow[];
```

- [ ] **Step 1: Написать падающие тесты**

`apps/core/src/stock/goods-stock.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assembleGoodsStock, parityRows, type GoodsStock } from "./goods-stock";

const W = "wh-1";
const d = (s: string) => new Date(`${s}T06:00:00+05:00`);
const products = [
  { id: "p-snickers", name: "Snickers 50gr", entityId: "c-snickers", isActive: true },
  { id: "p-bounty", name: "Bounty Coconut 55gr", entityId: "c-bounty", isActive: true },
  { id: "p-nocard", name: "Pulpy", entityId: null, isActive: true },
  { id: "p-old", name: "Strobar 40gr", entityId: "c-old", isActive: false },
];

describe("Остатки товаров — одна дверь (R-GS-1…6)", () => {
  it("список — активные позиции прайса, остаток из леджера, ноль у позиции без движений (R-GS-2)", () => {
    const g = assembleGoodsStock({
      warehouseId: W, products,
      qtyByCard: new Map([["c-snickers", 40]]),
      countedById: new Map([["p-snickers", d("2026-09-01")]]),
      countedByName: new Map(),
    });
    assert.deepEqual(g.rows.map((r) => [r.productName, r.quantity]), [["Bounty Coconut 55gr", 0], ["Pulpy", null], ["Snickers 50gr", 40]]);
    assert.equal(g.rows.some((r) => r.productName === "Strobar 40gr"), false, "неактивный не показывается");
    assert.equal(g.warehouseId, W);
  });

  it("позиция без карточки — quantity null, а не 0 (R-GS-3)", () => {
    const g = assembleGoodsStock({ warehouseId: W, products, qtyByCard: new Map(), countedById: new Map(), countedByName: new Map() });
    assert.equal(g.rows.find((r) => r.productId === "p-nocard")?.quantity, null);
    assert.equal(g.rows.find((r) => r.productId === "p-snickers")?.quantity, 0);
  });

  it("без центрального склада все остатки неизвестны и warehouseId null (R-GS-3)", () => {
    const g = assembleGoodsStock({ warehouseId: null, products, qtyByCard: new Map([["c-snickers", 40]]), countedById: new Map(), countedByName: new Map() });
    assert.ok(g.rows.every((r) => r.quantity === null));
    assert.equal(g.warehouseId, null);
  });

  it("дата — по id, фолбэк по нормализованному имени; asOf — самая поздняя; никто не считал — null (R-GS-6)", () => {
    const g = assembleGoodsStock({
      warehouseId: W, products, qtyByCard: new Map(),
      countedById: new Map([["p-snickers", d("2026-08-20")]]),
      countedByName: new Map([["bounty coconut 55gr", d("2026-09-01")]]),
    });
    assert.equal(g.rows.find((r) => r.productId === "p-snickers")?.countedAt?.toISOString(), d("2026-08-20").toISOString());
    assert.equal(g.rows.find((r) => r.productId === "p-bounty")?.countedAt?.toISOString(), d("2026-09-01").toISOString());
    assert.equal(g.rows.find((r) => r.productId === "p-nocard")?.countedAt, null);
    assert.equal(g.asOf?.toISOString(), d("2026-09-01").toISOString());
    const пусто = assembleGoodsStock({ warehouseId: W, products, qtyByCard: new Map(), countedById: new Map(), countedByName: new Map() });
    assert.equal(пусто.asOf, null);
  });

  it("includeInactive отдаёт и неактивные (для сверки)", () => {
    const g = assembleGoodsStock({ warehouseId: W, products, qtyByCard: new Map([["c-old", 3]]), countedById: new Map(), countedByName: new Map(), includeInactive: true });
    assert.deepEqual(g.rows.find((r) => r.productId === "p-old"), { productName: "Strobar 40gr", productId: "p-old", cardId: "c-old", quantity: 3, countedAt: null, isActive: false });
  });
});

describe("Сверка по объединению прайса и таблицы (R-GS-5)", () => {
  const goods = (over: Partial<GoodsStock> = {}): GoodsStock => ({
    warehouseId: W,
    asOf: null,
    rows: [
      { productName: "Snickers 50gr", productId: "p-snickers", cardId: "c-snickers", quantity: 40, countedAt: null, isActive: true },
      { productName: "Bounty Coconut 55gr", productId: "p-bounty", cardId: "c-bounty", quantity: 0, countedAt: null, isActive: true },
      { productName: "Pulpy", productId: "p-nocard", cardId: null, quantity: null, countedAt: null, isActive: true },
      { productName: "Strobar 40gr", productId: "p-old", cardId: "c-old", quantity: 3, countedAt: null, isActive: false },
    ],
    ...over,
  });
  const canon = (raw: string) => raw;

  it("таблица = леджер → ok; расхождение → mismatch с diff = таблица − леджер", () => {
    const rows = parityRows(goods(), [{ productName: "Snickers 50gr", productId: "p-snickers", quantity: 35 }, { productName: "Bounty Coconut 55gr", productId: "p-bounty", quantity: 0 }], canon);
    const sn = rows.find((r) => r.productId === "p-snickers")!;
    assert.equal(sn.status, "mismatch"); assert.equal(sn.diff, -5); assert.equal(sn.isMismatch, true);
    assert.equal(rows.find((r) => r.productId === "p-bounty")?.status, "ok");
  });

  it("пустая таблица: все позиции no_row, расхождение — только у тех, где леджер ≠ 0", () => {
    const rows = parityRows(goods(), [], canon);
    const noRow = rows.filter((r) => r.status === "no_row");
    assert.equal(noRow.length, 3, "Snickers, Bounty и неактивный Strobar с остатком; Pulpy без карточки — no_card");
    assert.equal(rows.filter((r) => r.isMismatch).length, 2, "Snickers 40 и Strobar 3");
    assert.equal(rows.find((r) => r.productId === "p-bounty")?.isMismatch, false, "новый товар с нулём — не расхождение");
  });

  it("строка таблицы без карточки прайса — no_card, ledger null", () => {
    const rows = parityRows(goods(), [{ productName: "Неизвестный", productId: null, quantity: 7 }], canon);
    const x = rows.find((r) => r.productName === "Неизвестный")!;
    assert.equal(x.status, "no_card"); assert.equal(x.ledger, null); assert.equal(x.table, 7); assert.equal(x.isMismatch, false);
  });

  it("строка таблицы без product_id сопоставляется по канону имени", () => {
    const rows = parityRows(goods(), [{ productName: "snickers 50GR", productId: null, quantity: 40 }], (raw) => (raw.toLowerCase().startsWith("snickers") ? "Snickers 50gr" : raw));
    assert.equal(rows.find((r) => r.productId === "p-snickers")?.status, "ok");
  });

  it("неактивная позиция: с остатком — inactive_with_stock и расхождение; без остатка и без строки — не показывается", () => {
    const rows = parityRows(goods(), [{ productName: "Strobar 40gr", productId: "p-old", quantity: 3 }], canon);
    assert.equal(rows.find((r) => r.productId === "p-old")?.status, "inactive_with_stock");
    const g0 = goods({ rows: goods().rows.map((r) => (r.productId === "p-old" ? { ...r, quantity: 0 } : r)) });
    assert.equal(parityRows(g0, [], canon).some((r) => r.productId === "p-old"), false);
  });

  it("без склада — no_warehouse у позиций с карточкой, ничего не считается расхождением", () => {
    const rows = parityRows(goods({ warehouseId: null, rows: goods().rows.map((r) => ({ ...r, quantity: null })) }), [{ productName: "Snickers 50gr", productId: "p-snickers", quantity: 40 }], canon);
    assert.equal(rows.find((r) => r.productId === "p-snickers")?.status, "no_warehouse");
    assert.equal(rows.some((r) => r.isMismatch), false);
  });
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `pnpm --filter @mydon/core test -- --test-name-pattern="одна дверь|объединению" 2>&1 | tail -5`
Expected: FAIL — `Cannot find module './goods-stock'`.

- [ ] **Step 3: Реализация**

`apps/core/src/stock/goods-stock.ts`:

```ts
import { normalizeProductName } from "@mydon/shared";

/**
 * Остатки товаров — ОДНА ДВЕРЬ (R-GS-1, спека 2026-09-05).
 *
 * Здесь только сборка и правила: список позиций — прайс (R-GS-2), «неизвестно»
 * ≠ ноль (R-GS-3), дата — из истории пересчётов (R-GS-6). SQL живёт рядом, в
 * `vending-ledger.ts`, и проверяется на настоящем Postgres в CI; правила —
 * здесь, на заглушке, потому что их можно и нужно читать без базы.
 */
export interface GoodsStockRow {
  productName: string;
  productId: string;
  cardId: string | null;
  /** Остаток по леджеру; null — неизвестно: нет карточки склада или не выбран центральный склад. */
  quantity: number | null;
  /** Последний пересчёт из истории (`vending_stock_count`), null — ни разу не считали. */
  countedAt: Date | null;
  isActive: boolean;
}

export interface GoodsStock {
  warehouseId: string | null;
  rows: GoodsStockRow[];
  asOf: Date | null;
}

export interface GoodsStockInput {
  warehouseId: string | null;
  products: { id: string; name: string; entityId: string | null; isActive: boolean }[];
  qtyByCard: Map<string, number>;
  countedById: Map<string, Date>;
  countedByName: Map<string, Date>;
  includeInactive?: boolean;
}

export function assembleGoodsStock(input: GoodsStockInput): GoodsStock {
  const rows: GoodsStockRow[] = [];
  for (const p of input.products) {
    if (!p.isActive && !input.includeInactive) continue;
    // Ноль — «карточка есть, склад выбран, движений нет». Без карточки или без
    // склада остаток НЕИЗВЕСТЕН, и закуп не имеет права вычитать ноль.
    const quantity = input.warehouseId && p.entityId ? (input.qtyByCard.get(p.entityId) ?? 0) : null;
    const countedAt = input.countedById.get(p.id) ?? input.countedByName.get(normalizeProductName(p.name)) ?? null;
    rows.push({ productName: p.name, productId: p.id, cardId: p.entityId, quantity, countedAt, isActive: p.isActive });
  }
  rows.sort((a, b) => a.productName.localeCompare(b.productName, "ru"));
  const asOf = rows.reduce<Date | null>((acc, r) => (r.countedAt && (!acc || r.countedAt > acc) ? r.countedAt : acc), null);
  return { warehouseId: input.warehouseId, rows, asOf };
}

export type VendingParityStatus = "ok" | "mismatch" | "no_row" | "no_card" | "inactive_with_stock" | "no_warehouse";

export interface VendingParityRow {
  productName: string;
  productId: string | null;
  cardId: string | null;
  table: number | null;
  ledger: number | null;
  diff: number | null;
  status: VendingParityStatus;
  isMismatch: boolean;
}

export interface TableStockRow {
  productName: string;
  productId: string | null;
  quantity: number;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Сверка по ОБЪЕДИНЕНИЮ прайса и строк таблицы (R-GS-5).
 *
 * Строка таблицы ищет свою позицию по `product_id`, без него — по канону
 * имени (тот же `resolveProduct`, что везде; R-G-1). Позиция без строки —
 * `no_row`: это факт о таблице, он виден всегда; расхождением считается только
 * когда в леджере не ноль. Пустая таблица при непустом леджере поэтому не может
 * дать «расхождений 0» — гейт катовера снова что-то проверяет.
 */
export function parityRows(goods: GoodsStock, table: TableStockRow[], canon: (raw: string) => string): VendingParityRow[] {
  const byId = new Map(goods.rows.map((r) => [r.productId, r]));
  const byNorm = new Map(goods.rows.map((r) => [normalizeProductName(r.productName), r]));
  const tableByProduct = new Map<string, TableStockRow>();
  const orphans: TableStockRow[] = [];
  for (const t of table) {
    const p = (t.productId && byId.get(t.productId)) || byNorm.get(normalizeProductName(canon(t.productName)));
    if (p && !tableByProduct.has(p.productId)) tableByProduct.set(p.productId, t);
    else orphans.push(t);
  }
  const out: VendingParityRow[] = [];
  for (const p of goods.rows) {
    const t = tableByProduct.get(p.productId) ?? null;
    const ledger = p.quantity;
    // Неактивная позиция без остатка и без строки — не тема сверки (R-GS-2).
    if (!p.isActive && !t && !(ledger !== null && ledger !== 0)) continue;
    let status: VendingParityStatus;
    let diff: number | null = null;
    if (goods.warehouseId === null && p.cardId !== null) status = "no_warehouse";
    else if (p.cardId === null) status = "no_card";
    else if (t === null) status = "no_row";
    else if (!p.isActive && ledger !== null && ledger !== 0) status = "inactive_with_stock";
    else {
      diff = ledger === null ? null : round3(t.quantity - ledger);
      status = diff === 0 ? "ok" : "mismatch";
    }
    const isMismatch = status === "mismatch" || status === "inactive_with_stock" || (status === "no_row" && ledger !== null && ledger !== 0);
    out.push({ productName: p.productName, productId: p.productId, cardId: p.cardId, table: t?.quantity ?? null, ledger, diff, status, isMismatch });
  }
  for (const o of orphans) {
    out.push({ productName: o.productName, productId: o.productId, cardId: null, table: o.quantity, ledger: null, diff: null, status: "no_card", isMismatch: false });
  }
  return out.sort((a, b) => a.productName.localeCompare(b.productName, "ru"));
}
```

- [ ] **Step 4: Тесты зелёные**

Run: `pnpm --filter @mydon/core test -- --test-name-pattern="одна дверь|объединению" 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`, pass ≥ 11.

- [ ] **Step 5: Коммит**

```bash
git add apps/core/src/stock/goods-stock.ts apps/core/src/stock/goods-stock.test.ts
git commit -m "feat(core): остатки товаров — одна дверь и статусы сверки по объединению прайса и таблицы (чистая логика, R-GS-1…6)"
```

---

### Task 2: SQL-обёртки в `vending-ledger.ts` и новая сверка

**Files:**
- Modify: `apps/core/src/stock/vending-ledger.ts` (импорты :1–5; `ledgerQty` :65–92; `VendingParityRow`/`vendingParity` :154–187; класс `VendingLedgerService` :268+)
- Test: `tools/pglite-checks/check-parts-u6.mjs` (сценарии на SQL — Task 5 их дописывает; здесь только компиляция и прежние сценарии)

**Interfaces:**
- Consumes: `assembleGoodsStock`, `parityRows`, типы из Task 1; `normalizeProductName`, `productIndex`, `resolveCatalogName` из `@mydon/shared` (как в `vending.service.ts:1453`); `vendingAlias`, `vendingStockCount` из `@mydon/db`.
- Produces:

```ts
export async function ledgerQtyMany(tx: Writer, warehouseId: string, cardIds: readonly string[]): Promise<Map<string, number>>;
export async function lastCountedByProduct(tx: Writer): Promise<{ byId: Map<string, Date>; byName: Map<string, Date> }>;
export async function goodsStock(tx: Writer, opts?: { includeInactive?: boolean }): Promise<GoodsStock>;
export interface VendingParityReport { warehouseId: string | null; rows: VendingParityRow[]; mismatched: number; unlinked: number; missingRows: number; products: number }
export async function vendingParity(db: Writer): Promise<VendingParityReport>;
// VendingLedgerService: goodsStock(tx?: Writer, opts?) → GoodsStock; parity() → VendingParityReport
```

- [ ] **Step 1: Импорты и групповой остаток**

В начале файла заменить импорт из `@mydon/db` и добавить shared:

```ts
import { auditLog, entity, stockMovement, vendingAlias, vendingProduct, vendingStock, vendingStockCount } from "@mydon/db";
import { normalizeProductName, productIndex, resolveCatalogName } from "@mydon/shared";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { assembleGoodsStock, parityRows, type GoodsStock, type VendingParityRow } from "./goods-stock";
export type { GoodsStock, GoodsStockRow, VendingParityRow, VendingParityStatus } from "./goods-stock";
```

Сразу после `ledgerQty` (после строки `return Number(row?.q ?? 0);` и `}`) добавить:

```ts
/**
 * Остатки по МНОГИМ карточкам одним запросом (R-GS-7): план закупа зовёт
 * выдачу на каждую сводку, и 52 запроса по одной карточке — это 52 обращения
 * к базе там, где хватает одного `group by`. Арифметика та же, что у `ledgerQty`.
 */
export async function ledgerQtyMany(tx: Writer, warehouseId: string, cardIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (cardIds.length === 0) return out;
  const rows = await tx
    .select({
      cardId: stockMovement.ingredientId,
      q: sql<string>`coalesce(sum(case
        when ${stockMovement.kind} in ('intake','return') then ${stockMovement.qty}
        when ${stockMovement.kind} = 'consumption' then -${stockMovement.qty}
        when ${stockMovement.kind} = 'adjustment' then ${stockMovement.qty}
        when ${stockMovement.kind} = 'transfer' and ${stockMovement.warehouseId} = ${warehouseId} then -${stockMovement.qty}
        when ${stockMovement.kind} = 'transfer' and ${stockMovement.counterpartyId} = ${warehouseId} then ${stockMovement.qty}
        else 0 end), 0)`,
    })
    .from(stockMovement)
    .where(
      and(
        inArray(stockMovement.ingredientId, [...cardIds]),
        sql`(${stockMovement.warehouseId} = ${warehouseId} or ${stockMovement.counterpartyId} = ${warehouseId})`,
      ),
    )
    .groupBy(stockMovement.ingredientId);
  for (const r of rows) if (r.cardId) out.set(r.cardId, Number(r.q ?? 0));
  return out;
}

/**
 * Последний пересчёт по товару — из истории `vending_stock_count` (R-GS-6):
 * без сторно и без отменённых сторно строк (то же условие «видимой строки», что у
 * `GET /vending/stock-counts`). По `product_id`, и отдельно по имени — для строк
 * истории до бэкфилла П4, у которых `product_id` пуст.
 */
export async function lastCountedByProduct(tx: Writer): Promise<{ byId: Map<string, Date>; byName: Map<string, Date> }> {
  const видимая = and(
    ne(vendingStockCount.source, "storno"),
    sql`not exists (select 1 from ${vendingStockCount} s2 where s2.source = 'storno' and s2.reverses_id = ${vendingStockCount.id})`,
  );
  const rows = await tx
    .select({
      productId: vendingStockCount.productId,
      productName: vendingStockCount.productName,
      last: sql<string>`max(${vendingStockCount.dt})`,
    })
    .from(vendingStockCount)
    .where(видимая)
    .groupBy(vendingStockCount.productId, vendingStockCount.productName);
  const byId = new Map<string, Date>();
  const byName = new Map<string, Date>();
  const later = (m: Map<string, Date>, k: string, d: Date) => {
    const prev = m.get(k);
    if (!prev || d > prev) m.set(k, d);
  };
  for (const r of rows) {
    // `dt` — ташкентские сутки. Берём ПОЛДЕНЬ этих суток по Ташкенту (07:00Z):
    // полночь +05:00 — это 19:00Z предыдущего дня, и `toISOString().slice(0, 10)`
    // у панели и смоука показывал бы «вчера». Для сторожа давности (дни) разницы нет.
    const d = new Date(`${String(r.last).slice(0, 10)}T12:00:00+05:00`);
    if (r.productId) later(byId, r.productId, d);
    later(byName, normalizeProductName(r.productName), d);
  }
  return { byId, byName };
}

/**
 * Одна дверь к остаткам товаров (R-GS-1): список — прайс, остаток — леджер по
 * центральному складу, дата — история пересчётов. Три запроса на выдачу.
 */
export async function goodsStock(tx: Writer, opts: { includeInactive?: boolean } = {}): Promise<GoodsStock> {
  const warehouseId = await centralWarehouseId(tx);
  const products = await tx
    .select({ id: vendingProduct.id, name: vendingProduct.name, entityId: vendingProduct.entityId, isActive: vendingProduct.isActive })
    .from(vendingProduct);
  const cardIds = products.map((p) => p.entityId).filter((x): x is string => x !== null);
  const [qtyByCard, counted] = await Promise.all([
    warehouseId ? ledgerQtyMany(tx, warehouseId, cardIds) : Promise.resolve(new Map<string, number>()),
    lastCountedByProduct(tx),
  ]);
  return assembleGoodsStock({
    warehouseId,
    products,
    qtyByCard,
    countedById: counted.byId,
    countedByName: counted.byName,
    ...(opts.includeInactive ? { includeInactive: true } : {}),
  });
}
```

- [ ] **Step 2: Сверка через `parityRows`**

Заменить блок от `export interface VendingParityRow {` (:154) до конца функции `vendingParity` (:187) на:

```ts
export interface VendingParityReport {
  warehouseId: string | null;
  rows: VendingParityRow[];
  /** Расхождений по правилу §6 спеки: mismatch, inactive_with_stock, no_row с ненулевым леджером. */
  mismatched: number;
  /** Строк без карточки реестра (как раньше). */
  unlinked: number;
  /** Позиций прайса без строки в таблице — факт о таблице, виден всегда. */
  missingRows: number;
  /** Позиций прайса в сверке. */
  products: number;
}

/**
 * Сверка проекции с леджером по ОБЪЕДИНЕНИЮ прайса и таблицы (R-GS-5): пустая
 * таблица при непустом леджере даёт расхождения, а не «0 из 0».
 */
export async function vendingParity(db: Writer): Promise<VendingParityReport> {
  const [goods, table, products, aliases] = await Promise.all([
    goodsStock(db, { includeInactive: true }),
    db.select({ productName: vendingStock.productName, productId: vendingStock.productId, quantity: vendingStock.quantity }).from(vendingStock),
    db.select({ id: vendingProduct.id, name: vendingProduct.name }).from(vendingProduct),
    db.select({ productId: vendingAlias.productId, alias: vendingAlias.alias }).from(vendingAlias),
  ]);
  // Канон имени — тот же индекс, что у закупа и импорта (R-G-1): строка таблицы
  // без product_id должна найти свою позицию тем же правилом, что и везде.
  const index = productIndex(products, aliases);
  const canon = (raw: string) => {
    const r = resolveCatalogName(index, raw);
    return r.kind === "hit" ? r.canon : r.kind === "conflict" ? r.byName : raw;
  };
  const rows = parityRows(goods, table, canon);
  return {
    warehouseId: goods.warehouseId,
    rows,
    mismatched: rows.filter((r) => r.isMismatch).length,
    unlinked: rows.filter((r) => r.status === "no_card").length,
    missingRows: rows.filter((r) => r.status === "no_row").length,
    products: rows.filter((r) => r.productId !== null).length,
  };
}
```

Проверить, что `productIndex` принимает `{ id, name }[]` и `{ productId, alias }[]` — сигнатура в `packages/shared/src/stock-history.ts:396` (`ProductRow`/`AliasRow`); если `ProductRow` требует больше полей, передать их из `vendingProduct` (как `loadProductIndex` в `vending.service.ts:1333–1348`).

- [ ] **Step 3: Методы сервиса**

В `VendingLedgerService` после `centralWarehouseId(tx)` добавить:

```ts
  /** Одна дверь к остаткам товаров (R-GS-1). Внутри транзакции — передавать её `tx`. */
  goodsStock(tx: Writer = this.db, opts: { includeInactive?: boolean } = {}) {
    return goodsStock(tx, opts);
  }
```

`parity()` остаётся, тип возврата теперь `VendingParityReport`.

- [ ] **Step 4: Сборка и прежние сценарии**

Run: `pnpm --filter @mydon/db build && pnpm --filter @mydon/core build 2>&1 | grep -E "error TS" ; echo BUILD_DONE`
Expected: без `error TS`.

Run: `CHECKS_DATABASE_URL=postgres://mydon:mydon@127.0.0.1:55432/mydon node tools/pglite-checks/check-parts-u6.mjs 2>&1 | tail -2`
(контейнер: `docker run -d --name mydon-checks-pg -e POSTGRES_USER=mydon -e POSTGRES_PASSWORD=mydon -e POSTGRES_DB=mydon -p 55432:5432 postgres:17`, если не поднят)
Expected: `У6 (postgres): … ✔` — прежние проверки `parity.mismatched === 0/1` и `rows.map([name, table, ledger])` проходят: у обеих позиций есть строки, статусы `ok`/`mismatch`.

- [ ] **Step 5: Коммит**

```bash
git add apps/core/src/stock/vending-ledger.ts
git commit -m "feat(core): goodsStock() — остаток по леджеру групповым запросом, дата из истории пересчётов; сверка по объединению прайса и таблицы (R-GS-5, R-GS-7)"
```

---

### Task 3: Читатели 1–2 — `stockLevels()`, `stockRows()`, план закупа

**Files:**
- Modify: `apps/core/src/vending/vending.service.ts` — `StockLevelRow` :274–280; `StockRow` :612–616; `PurchaseContext` :~623 (`stockRows`, `unmatchedStock`); `stockLevels()` :1766–1786; `stockRows()` :1891–1894; сопоставление :2026–2050; сторож давности :2145–2170; предупреждения :2171–2190; выдача :2276–2292
- Test: `apps/core/src/vending/vending.service.test.ts`

**Interfaces:**
- Consumes: `VendingLedgerService.goodsStock()`, `GoodsStock` (Task 2).
- Produces: `StockLevelRow { product; productId; quantity: number | null; countedAt: string | null }`; `StockRow { product; quantity: number | null; countedAt: Date | null }`; `PurchaseContext.unknownStock: StockRow[]`; выдача плана `stock.unknown: number`; предупреждение `code: "stock_unknown_card"`.

- [ ] **Step 1: Падающие тесты**

В `apps/core/src/vending/vending.service.test.ts` добавить в конец файла (стаб `readDb` и тип `ProdRow` уже есть в файле):

```ts
describe("Остатки товаров в режиме ledger — одна дверь (R-GS-1, R-GS-4)", () => {
  const goods = {
    warehouseId: "wh-1",
    asOf: new Date("2026-09-01T01:00:00Z"),
    rows: [
      { productName: "Bounty", productId: "p-b", cardId: "c-b", quantity: 0, countedAt: null, isActive: true },
      { productName: "Pulpy", productId: "p-p", cardId: null, quantity: null, countedAt: null, isActive: true },
      { productName: "Snickers", productId: "p-s", cardId: "c-s", quantity: 40, countedAt: new Date("2026-09-01T01:00:00Z"), isActive: true },
    ],
  };
  const ledger = (source: "table" | "ledger") => ({ source: async () => source, goodsStock: async () => goods }) as never;

  it("stockLevels(): в ledger — все активные позиции прайса, включая ноль и «неизвестно»", async () => {
    const svc = new VendingService(readDb([]), undefined, ledger("ledger"));
    const rows = await svc.stockLevels();
    assert.deepEqual(rows.map((r) => [r.product, r.quantity, r.countedAt]), [
      ["Bounty", 0, null],
      ["Pulpy", null, null],
      ["Snickers", 40, "2026-09-01T01:00:00.000Z"],
    ]);
  });

  it("stockLevels(): в table — таблица, как раньше, одна дверь не вызывается", async () => {
    const stub = { ...goods, rows: [] };
    let called = 0;
    const l = { source: async () => "table", goodsStock: async () => { called += 1; return stub; } } as never;
    const svc = new VendingService(readDb([{ productName: "Snickers", quantity: 5, countedAt: new Date("2026-08-20T00:00:00Z") } as never]), undefined, l);
    const rows = await svc.stockLevels();
    assert.equal(called, 0);
    assert.deepEqual(rows.map((r) => [r.product, r.quantity]), [["Snickers", 5]]);
  });
});
```

Для плана — тест на «неизвестно не вычитается и даёт предупреждение». Стаб закупа `purchaseDb(...)` определён в этом же файле (~:150); прочитать его сигнатуру и порядок аргументов (слоты, продажи, алиасы, прайс, склад, …) и собрать по образцу ближайшего теста `purchase()` с одним автоматом и одним товаром «Snickers» в слоте с потребностью > 0. Ожидания:

```ts
  it("план в ledger: quantity null не вычитается и даёт предупреждение stock_unknown_card; asOf — из одной двери", async () => {
    // slots/sales/products — по образцу теста «закуп вычитает остаток склада» выше по файлу;
    // склад в стабе пустой: в ledger план читает одну дверь, а не таблицу.
    const svc = new VendingService(purchaseDb(slots, sales, [], products, []), undefined, ledger("ledger"));
    const plan = await svc.purchase();
    const snickers = plan.summary.items.find((i) => i.product === "Snickers")!;
    assert.equal(snickers.stock, 40, "остаток из леджера вычтен");
    const pulpy = [...plan.summary.items, ...plan.summary.excludedNoSales, ...plan.summary.excludedByRule].find((i) => i.product === "Pulpy");
    assert.equal(pulpy?.stock ?? 0, 0, "неизвестный остаток в расчёт не входит");
    assert.equal(plan.stock.unknown, 1);
    assert.ok(plan.warnings.some((w) => w.code === "stock_unknown_card" && /Pulpy/.test(w.message)));
    assert.equal(plan.stock.asOf, "2026-09-01T01:00:00.000Z");
  });
```

(Если `purchase()` в этом файле зовётся иначе — `purchasePlan()`/`plan()` — взять имя из соседнего теста; `plan.stock.asOf` и `plan.warnings` — поля выдачи `:2276–2292`.)

- [ ] **Step 2: Убедиться, что падают**

Run: `pnpm --filter @mydon/core test -- --test-name-pattern="одна дверь" 2>&1 | grep -E "^not ok|# fail"`
Expected: падения — `goodsStock is not a function`/`quantity` не совпадает.

- [ ] **Step 3: Типы и `stockLevels()`**

`StockLevelRow` (:274):

```ts
export interface StockLevelRow {
  product: string;
  /** Карточка прайса, если имя строки известно справочнику (бэкфилл П4). */
  productId: string | null;
  /** null — остаток неизвестен: нет карточки склада или не выбран центральный склад (только в режиме ledger, R-GS-3). */
  quantity: number | null;
  /** null — ни разу не считали (только в режиме ledger). */
  countedAt: string | null;
}
```

`stockLevels()` (:1766–1786) — заменить целиком:

```ts
  async stockLevels(): Promise<StockLevelRow[]> {
    // Режим ledger — ОДНА ДВЕРЬ (R-GS-1): список позиций — прайс, а не строки
    // таблицы; иначе товар без строки не существовал бы для панели.
    if (this.ledger && (await this.stockSource()) === "ledger") {
      const goods = await this.ledger.goodsStock(this.db);
      return goods.rows.map((r) => ({
        product: r.productName,
        productId: r.productId,
        quantity: r.quantity,
        countedAt: r.countedAt?.toISOString() ?? null,
      }));
    }
    const rows = await this.db.select().from(vendingStock);
    return rows
      // `productId` в ответе — не украшение: связь строки склада с карточкой
      // прайса иначе не видна ниоткуда, и её потерю (бэкфилл П4) нечем поймать
      // ни панели, ни дымовому прогону.
      .map((r) => ({ product: r.productName, productId: r.productId, quantity: r.quantity, countedAt: r.countedAt.toISOString() }))
      .sort((a, b) => a.product.localeCompare(b.product, "ru"));
  }
```

- [ ] **Step 4: `StockRow`, `stockRows()`, контекст плана**

`StockRow` (:612):

```ts
/** Остаток склада строкой: имя, штуки (null — неизвестно, R-GS-3) и когда считали (null — ни разу). */
interface StockRow {
  product: string;
  quantity: number | null;
  countedAt: Date | null;
}
```

В `PurchaseContext` рядом с `unmatchedStock` добавить:

```ts
  /** Позиции прайса с неизвестным остатком (нет карточки склада / склад не выбран): в расчёт не вошли, R-GS-3. */
  unknownStock: StockRow[];
```

`stockRows()` (:1891):

```ts
  private async stockRows(): Promise<StockRow[]> {
    if (this.ledger && (await this.stockSource()) === "ledger") {
      const goods = await this.ledger.goodsStock(this.db);
      return goods.rows.map((r) => ({ product: r.productName, quantity: r.quantity, countedAt: r.countedAt }));
    }
    const rows = await this.db.select().from(vendingStock);
    return rows.map((r) => ({ product: r.productName, quantity: r.quantity, countedAt: r.countedAt }));
  }
```

Сопоставление (:2026): перед циклом `for (const r of allStockRows)` добавить `const unknownStock: StockRow[] = [];`, а в цикле первой строкой:

```ts
      if (r.quantity === null) { unknownStock.push(r); continue; }
```

`stockByProduct` считать только по числам (`r.quantity` там уже `number` после `continue`, но тип остаётся `number | null`):

```ts
    for (const r of stockRows) stockByProduct.set(r.product, (stockByProduct.get(r.product) ?? 0) + (r.quantity ?? 0));
```

В `return { summary, ok, …, unmatchedStock, … }` (:2086) добавить `unknownStock,`.

- [ ] **Step 5: Сторож давности и предупреждения (:2145–2190)**

```ts
    // `asOf` — «когда последний раз считали хоть что-то» (для показа).
    const asOf = ctx.stockRows.reduce<Date | null>((acc, r) => (r.countedAt && (!acc || r.countedAt > acc) ? r.countedAt : acc), null);
    …
    const usedRows = ctx.stockRows.filter((r) => usedProducts.has(r.product));
    // «Неизвестно» (null) — не залежалось и не пусто: такие строки сторож не смотрит (R-GS-3).
    const watched = (usedRows.length > 0 ? usedRows : ctx.stockRows.filter((r) => (r.quantity ?? 0) > 0)).filter((r) => r.countedAt !== null);
    const staleRows = watched
      .filter((r) => r.countedAt !== null && Date.now() - r.countedAt.getTime() > STOCK_STALE_DAYS * 86_400_000)
      .sort((a, b) => (a.countedAt?.getTime() ?? 0) - (b.countedAt?.getTime() ?? 0));
    const stale = asOf === null || staleRows.length > 0;
    const totalBefore = ctx.stockRows.reduce((a, r) => a + (r.quantity ?? 0), 0);
```

После блока `if (ctx.unmatchedStock.length) { … }` добавить:

```ts
    if (ctx.unknownStock.length) {
      // Остаток неизвестен — не ноль: план не вычитает его и говорит об этом,
      // иначе владелец купил бы «весь дефицит» по товару, который просто без карточки.
      warnings.push({
        code: "stock_unknown_card",
        message:
          `Без карточки склада: ${ctx.unknownStock.length} поз. — остаток не вычтен (${ctx.unknownStock.map((r) => r.product).slice(0, 5).join(", ")}` +
          `${ctx.unknownStock.length > 5 ? ` и ещё ${ctx.unknownStock.length - 5}` : ""}). Заведи карточки: панель /stock/goods → «Карточки для товаров»`,
      });
    }
```

В `unmatchedStock`-предупреждении заменить `r.quantity` на `(r.quantity ?? 0)` в сумме `шт`. В выдаче (:2279) `unmatched: ctx.unmatchedStock.reduce((a, r) => a + (r.quantity ?? 0), 0)` и добавить `unknown: ctx.unknownStock.length,` рядом. Если `PlanWarning.code` — строковый union (проверить объявление `PlanWarning` через grep `code: "stock_stale"` и его тип), добавить в него `"stock_unknown_card"`.

- [ ] **Step 6: Тесты зелёные, старые не тронуты**

Run: `pnpm --filter @mydon/core test 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`, pass = прежние 1769 + новые.

- [ ] **Step 7: Коммит**

```bash
git add apps/core/src/vending/vending.service.ts apps/core/src/vending/vending.service.test.ts
git commit -m "feat(core): список остатков и план закупа в режиме ledger идут через одну дверь; «неизвестно» не вычитается и предупреждает (R-GS-2/3/4)"
```

---

### Task 4: Читатели 3–4 — мёртвый сток и ответ заливки

**Files:**
- Modify: `apps/core/src/vending/analytics.service.ts` — конструктор (найти `constructor(` и текущие инъекции), `мёртвыйСток` :287–300, место после сборки `warehouse` :345, предупреждения отчёта (найти `warnings.push` в этом методе или `warnings: []` в возврате)
- Modify: `apps/core/src/vending/refill.service.ts` :100–111 (ветка повтора)
- Test: `apps/core/src/vending/analytics.service.test.ts`, `apps/core/src/vending/refill.service.test.ts`

**Interfaces:**
- Consumes: `VendingLedgerService.goodsStock()`, `.source()`, `.qty()`, `.cardIdOf()`, `.centralWarehouseId()`.
- Produces: мёртвый сток в `ledger` — склад из одной двери, предупреждение `code: "stock_unknown_card"` при `null`-позициях; повтор заливки в `ledger` — `stockLeft` по леджеру.

- [ ] **Step 1: Падающие тесты**

`refill.service.test.ts` — в конец файла (стаб `stubDb` и `vendingStub`/`vending` — из файла):

```ts
describe("Повтор заливки в режиме ledger — остаток по леджеру, а не по таблице (R-GS-4)", () => {
  it("повтор по clientKey отдаёт остаток леджера и не читает vending_stock", async () => {
    // В очереди select — только сама заливка. Если бы повтор читал таблицу, следующий select
    // отдал бы [] и stockLeft стал бы null; 37 доказывает, что остаток пришёл из леджера.
    const selects: Record<string, unknown>[][] = [[{ id: "r1", clientKey: "rf-1" }]];
    const db = stubDb({ refillInsert: [], selects, inserted: [] });
    const ledger = {
      source: async () => "ledger",
      centralWarehouseId: async () => "wh-1",
      cardIdOf: async () => "c-s",
      qty: async () => 37,
      movement: async () => ({ ok: true }),
    } as never;
    const res = await new RefillService(db, vending, ledger).create({ machineSerial: "M1", productName: "Snickers", qty: 3, clientKey: "rf-1" });
    assert.equal(res.duplicate, true);
    assert.equal(res.stockLeft, 37);
  });
});
```

(`vending` — стаб `VendingService` из соседних тестов, который резолвит `productId` для «Snickers»; посмотреть, как он объявлен в этом файле, и переиспользовать.)

`analytics.service.test.ts` — по образцу существующего теста мёртвого стока (найти `deadStock(`), добавить:

```ts
  it("мёртвый сток в ledger: склад — из одной двери, позиции с null не в отчёте, но в предупреждении", async () => {
    const goods = {
      warehouseId: "wh-1", asOf: null,
      rows: [
        { productName: "Snickers", productId: "p-s", cardId: "c-s", quantity: 11, countedAt: null, isActive: true },
        { productName: "Pulpy", productId: "p-p", cardId: null, quantity: null, countedAt: null, isActive: true },
      ],
    };
    const ledger = { source: async () => "ledger", goodsStock: async () => goods } as never;
    const svc = new AnalyticsService(deadStockDb(/* те же аргументы, что в соседнем тесте, но склад ПУСТОЙ */), /* остальные зависимости как в соседнем тесте */, ledger);
    const r = await svc.deadStock(30, new Date("2026-09-05T06:00:00+05:00"));
    assert.ok(r.warehouse.some((w) => w.product === "Snickers" && w.qty === 11));
    assert.equal(r.warehouse.some((w) => w.product === "Pulpy"), false);
    assert.ok(r.warnings.some((w) => w.code === "stock_unknown_card"));
  });
```

Позиция `ledger` в конструкторе `AnalyticsService` — последний параметр, `@Optional()`; порядок остальных — из текущего `constructor(`.

- [ ] **Step 2: Убедиться, что падают**

Run: `pnpm --filter @mydon/core test -- --test-name-pattern="ledger" 2>&1 | grep -E "^not ok|# fail"`
Expected: падения.

- [ ] **Step 3: Заливка — ветка повтора (`refill.service.ts:100–111`)**

Заменить:

```ts
        const [stock] = await tx
          .select({ quantity: vendingStock.quantity })
          .from(vendingStock)
          .where(eq(vendingStock.productName, productName))
          .limit(1);
        return { refill: existing, stockLeft: stock?.quantity ?? null, duplicate: true };
```

на:

```ts
        // Остаток — тем же источником, что и у свежей заливки: в режиме ledger
        // таблица не читается (R-GS-4), без карточки — «неизвестно».
        let stockLeft: number | null = null;
        if (this.ledger && (await this.ledger.source(tx)) === "ledger") {
          const [warehouseId, cardId] = await Promise.all([this.ledger.centralWarehouseId(tx), productId ? this.ledger.cardIdOf(tx, productId) : Promise.resolve(null)]);
          stockLeft = warehouseId && cardId ? await this.ledger.qty(tx, warehouseId, cardId) : null;
        } else {
          const [stock] = await tx
            .select({ quantity: vendingStock.quantity })
            .from(vendingStock)
            .where(eq(vendingStock.productName, productName))
            .limit(1);
          stockLeft = stock?.quantity ?? null;
        }
        return { refill: existing, stockLeft, duplicate: true };
```

`productId` — та же переменная, что использует свежая ветка (:181, `this.ledger.cardIdOf(tx, productId)`); она объявлена выше в методе.

- [ ] **Step 4: Мёртвый сток (`analytics.service.ts`)**

Конструктор: добавить последним параметром `@Optional() @Inject(VendingLedgerService) private readonly ledger?: VendingLedgerService,` (импорты `Optional, Inject` из `@nestjs/common`, `VendingLedgerService` из `../stock/vending-ledger` — по образцу `vending.service.ts:79, :667`).

В `мёртвыйСток` ПЕРЕД `Promise.all` вынести склад отдельным блоком, а из `Promise.all` первый элемент (запрос к `vendingStock`) убрать вместе с `склад` в деструктуризации:

```ts
    // Склад — одной дверью в режиме ledger (R-GS-1); таблица — в table, как раньше.
    let склад: { productName: string; quantity: number }[];
    let неизвестно = 0;
    if (this.ledger && (await this.ledger.source()) === "ledger") {
      const g = await this.ledger.goodsStock(this.db);
      склад = g.rows.flatMap((r) => (r.quantity !== null && r.quantity > 0 ? [{ productName: r.productName, quantity: r.quantity }] : []));
      неизвестно = g.rows.filter((r) => r.quantity === null).length;
    } else {
      склад = await this.db
        .select({ productName: vendingStock.productName, quantity: vendingStock.quantity })
        .from(vendingStock)
        .where(gt(vendingStock.quantity, 0));
    }
    const [остатки, продажи, заливки, накладные, { cost }] = await Promise.all([
      // …остальные четыре запроса как были, без первого
    ]);
``` В конце метода, где собираются `warnings` отчёта (найти существующий `warnings.push({ code:` в этом методе или место сборки `warnings: [...]` в возврате), добавить:

```ts
    if (неизвестно > 0) {
      warnings.push({ code: "stock_unknown_card", message: `Без карточки склада: ${неизвестно} поз. — в отчёте по складу их нет` });
    }
```

Тип `AnalyticsWarning` — проверить, что `code` принимает строку/union; при union добавить `"stock_unknown_card"`.

- [ ] **Step 5: Тесты зелёные**

Run: `pnpm --filter @mydon/core test 2>&1 | grep -E "^# (pass|fail)"`
Expected: `# fail 0`.

- [ ] **Step 6: Коммит**

```bash
git add apps/core/src/vending/analytics.service.ts apps/core/src/vending/analytics.service.test.ts apps/core/src/vending/refill.service.ts apps/core/src/vending/refill.service.test.ts
git commit -m "feat(core): мёртвый сток и повтор заливки в режиме ledger читают одну дверь, таблица не читается (R-GS-1, R-GS-4)"
```

---

### Task 5: Панель `/stock/goods`, текст настройки, тип сверки

**Files:**
- Modify: `apps/cc/src/lib/core.ts` :2274–2279 (`VendingParity`)
- Modify: `apps/cc/src/app/stock/goods/page.tsx` (шапка :34–35, пустое состояние :50–54, таблица :57–90)
- Modify: `apps/core/src/system/config-spec.ts` :208–211 (`help`)
- Test: `apps/cc/src/app/stock/goods/page.test.tsx` (новый, vitest — по образцу любого `apps/cc/src/app/**/page.test.tsx`; если страничных тестов в репо нет — `apps/cc/src/components/parity-status.test.tsx` на вынесенный компонент строки)

**Interfaces:**
- Consumes: `VendingParityReport` (Task 2) как JSON.
- Produces: компонент `ParityStatusPill({ status, diff })` в `apps/cc/src/components/parity-status.tsx`.

- [ ] **Step 1: Тип в панели**

```ts
export type VendingParityStatus = "ok" | "mismatch" | "no_row" | "no_card" | "inactive_with_stock" | "no_warehouse";
export interface VendingParity {
  warehouseId: string | null;
  rows: {
    productName: string;
    productId: string | null;
    cardId: string | null;
    table: number | null;
    ledger: number | null;
    diff: number | null;
    status: VendingParityStatus;
    isMismatch: boolean;
  }[];
  mismatched: number;
  unlinked: number;
  missingRows: number;
  products: number;
}
```

- [ ] **Step 2: Падающий тест компонента**

`apps/cc/src/components/parity-status.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ParityStatusPill } from "./parity-status";

describe("Статус сверки словами (R-GS-5)", () => {
  it("каждому статусу — своё слово, расхождение — с числом", () => {
    const { rerender } = render(<ParityStatusPill status="ok" diff={0} />);
    expect(screen.getByText("сходится")).toBeTruthy();
    rerender(<ParityStatusPill status="mismatch" diff={-5} />);
    expect(screen.getByText("-5")).toBeTruthy();
    rerender(<ParityStatusPill status="no_row" diff={null} />);
    expect(screen.getByText("нет строки в таблице")).toBeTruthy();
    rerender(<ParityStatusPill status="no_card" diff={null} />);
    expect(screen.getByText("нет карточки")).toBeTruthy();
    rerender(<ParityStatusPill status="inactive_with_stock" diff={null} />);
    expect(screen.getByText("неактивен, но есть остаток")).toBeTruthy();
    rerender(<ParityStatusPill status="no_warehouse" diff={null} />);
    expect(screen.getByText("склад не выбран")).toBeTruthy();
  });
});
```

- [ ] **Step 3: Компонент и страница**

`apps/cc/src/components/parity-status.tsx`:

```tsx
import type { VendingParityStatus } from "../lib/core";

const СЛОВА: Record<Exclude<VendingParityStatus, "ok" | "mismatch">, string> = {
  no_row: "нет строки в таблице",
  no_card: "нет карточки",
  inactive_with_stock: "неактивен, но есть остаток",
  no_warehouse: "склад не выбран",
};

/** Статус строки сверки словами: пустота в таблице — тоже статус, а не «сходится». */
export function ParityStatusPill({ status, diff }: { status: VendingParityStatus; diff: number | null }) {
  if (status === "ok") return <span className="pill ok">сходится</span>;
  if (status === "mismatch") return <span className="pill bad">{diff !== null && diff > 0 ? `+${diff}` : String(diff)}</span>;
  const тревожно = status === "inactive_with_stock" || status === "no_row";
  return <span className={`pill ${тревожно ? "bad" : "act"}`}>{СЛОВА[status]}</span>;
}
```

`page.tsx`: шапка (:35) →

```tsx
          Позиций прайса: {parity.products} · без строки в таблице: {parity.missingRows} · расхождений: {parity.mismatched} · без карточки реестра: {parity.unlinked}.
```

Пустое состояние (:50): условие `parity.rows.length === 0` оставить (при пустой таблице строки теперь есть — по позициям прайса), текст сменить на «Позиций прайса нет — заведи товары в прайсе вендинга». В таблице: `<td className="mono">{r.table ?? "—"}</td>`, столбец «разница» → `<ParityStatusPill status={r.status} diff={r.diff} />`. Подсказка внизу: добавить предложение «Строка «нет строки в таблице» с ненулевым леджером — расхождение: таблицу восстанавливает пересчёт из бота или импорт».

`config-spec.ts` `help` для `VENDING_STOCK_SOURCE`:

```ts
    help:
      "table — строка vending_stock, как раньше (леджер пишется параллельно, двойная запись). " +
      "ledger — список позиций из прайса, остаток по движениям леджера на центральном складе, дата — из истории пересчётов (катовер У6). " +
      "Переключать, когда сверка /stock/vending-parity держится нулевой неделю И позиций «без строки» с ненулевым леджером нет.",
```

- [ ] **Step 4: Тесты и сборка панели**

Run: `pnpm --filter @mydon/cc test 2>&1 | grep -E "parity-status|Tests "` → `✓ … parity-status.test.tsx`, все зелёные.
Run: `pnpm --filter @mydon/cc typecheck 2>&1 | grep -E "error TS"; echo TC_DONE` → без ошибок.

- [ ] **Step 5: Коммит**

```bash
git add apps/cc/src/lib/core.ts apps/cc/src/app/stock/goods/page.tsx apps/cc/src/components/parity-status.tsx apps/cc/src/components/parity-status.test.tsx apps/core/src/system/config-spec.ts
git commit -m "feat(cc,core): сверка товаров — статусы словами, счётчик «без строки», критерий катовера в подсказке настройки (R-GS-5)"
```

---

### Task 6: Сценарии на настоящем SQL и дымовой прогон

**Files:**
- Modify: `tools/pglite-checks/check-parts-u6.mjs` (после строки `assert.equal(r3.stockLeft, 40, …)`, перед `console.log`)
- Modify: `tools/smoke-core.mjs` (рядом с существующим сценарием `/vending/stock`, ~:903–930)

**Interfaces:**
- Consumes: всё из Task 1–4 через `apps/core/dist/**`.

- [ ] **Step 1: Сценарии У6 (spec §9, пункты 2–5)**

Добавить перед `console.log(\`У6 (${ENGINE}) …\`)`:

```js
  // ── Срез 05.09: чтения — через одну дверь (R-GS-1…7) ─────────────────────
  // (а) Все активные позиции прайса, включая ноль и «неизвестно»: Pulpy без карточки → null
  await run(`insert into vending_product (name, purchase_price) values ('Pulpy', 5000)`);
  const levels = await vending.stockLevels();
  assert.deepEqual(levels.map((r) => [r.product, r.quantity]), [["Bounty", 20], ["Pulpy", null], ["Snickers", 40]], "ledger: список — прайс, без карточки — null, не 0");
  assert.equal(levels.find((r) => r.product === "Snickers").countedAt.slice(0, 10), "2026-09-01", "дата — из истории пересчётов");
  // (б) Повтор заливки по clientKey — остаток леджера, таблица не при чём
  const r4 = await refill.create({ machineSerial: "M1", productName: "Snickers", qty: 2, clientKey: "rf-2" });
  assert.equal(r4.duplicate, true); assert.equal(r4.stockLeft, 40);
  // (в) Пустая таблица при заполненном леджере → сверка НЕ зелёная
  await run(`delete from vending_stock`);
  parity = await ledger.parity();
  assert.equal(parity.missingRows, 2, "Snickers и Bounty без строки; Pulpy без карточки — это no_card, не no_row");
  assert.equal(parity.mismatched, 2, "Snickers 40 и Bounty 20 в леджере — расхождения; Pulpy без карточки — нет");
  assert.equal(parity.products, 3, "все три позиции прайса в сверке");
  assert.equal(parity.rows.find((r) => r.productName === "Snickers").status, "no_row");
  assert.equal(parity.rows.find((r) => r.productName === "Pulpy").status, "no_card");
  // (г) В режиме ledger список остатков и план не зависят от таблицы
  assert.equal((await vending.stockLevels()).find((r) => r.product === "Snickers").quantity, 40, "таблица пуста, остаток из леджера");
  // (д) Режим table — прежние числа: таблица пуста → пусто
  await run(`update system_config set value = 'table' where key = 'VENDING_STOCK_SOURCE'`);
  assert.deepEqual(await vending.stockLevels(), [], "table: читается таблица, она пуста");
  await run(`update system_config set value = 'ledger' where key = 'VENDING_STOCK_SOURCE'`);
```

Если в сценарии нет метода расчёта плана на пустых слотах, п. (г) ограничивается `stockLevels()` — план покрыт юнит-тестом Task 3.

- [ ] **Step 2: Прогнать в обоих движках**

Run:
```bash
pnpm --filter @mydon/db build && pnpm --filter @mydon/core build
CHECKS_DATABASE_URL=postgres://mydon:mydon@127.0.0.1:55432/mydon node tools/pglite-checks/check-parts-u6.mjs
NODE_PATH=~/pgtest/node_modules node tools/pglite-checks/check-parts-u6.mjs
```
Expected: обе строки `У6 (…) … ✔`. Разницу драйверов помнить: счётчики в `run()` брать через `::int`.

- [ ] **Step 3: Дым**

В `tools/smoke-core.mjs` рядом со сценарием `/vending/stock` (:903–930) добавить сценарий: выставить `VENDING_STOCK_SOURCE=ledger` через `PUT /system/config` (как это делают соседние сценарии с настройками — найти `"/system/config"` в файле и повторить их способ с owner-токеном смоука), затем `GET /vending/stock` → массив, у каждой строки есть `product` и поле `quantity` (число или `null`); `GET /stock/vending-parity` → есть `missingRows`, `products`, у строк есть `status`; вернуть настройку в `table`. Печатать `ok  сценарий: остатки товаров в ledger — одна дверь и сверка по прайсу`.

Run (локально нужен scratch-Postgres со словом smoke в имени или `SMOKE_SCRATCH=1`): `SMOKE_SCRATCH=1 DATABASE_URL=postgres://mydon:mydon@127.0.0.1:55432/mydon node tools/smoke-core.mjs 2>&1 | grep -E "одна дверь|Всё прошло|FAIL"`
Expected: строка сценария `ok` и «Всё прошло».

- [ ] **Step 4: Коммит**

```bash
git add tools/pglite-checks/check-parts-u6.mjs tools/smoke-core.mjs
git commit -m "test(tools): сценарии У6 на SQL — одна дверь, пустая таблица не зелёная, повтор заливки по леджеру; дым в режиме ledger"
```

---

### Task 7: Документы, гейт, PR

**Files:**
- Modify: `docs/superpowers/specs/2026-09-04-vendhub-parts-inventory-design.md` §12 (абзац «Товары (§5.7)»)
- Modify: `docs/OWNER_NEXT_STEPS_parts.md` §7 и §8
- Create: `memory/session-log/2026-09-05-goods-stock-reads.md` (handoff, по образцу `memory/session-log/2026-09-04-agentic-os-arms.md`)

- [ ] **Step 1: Спека У1–У6 §12** — в абзац про товары добавить:

```
  Срез 05.09 (`2026-09-05-vending-stock-reads-to-ledger-design.md`): в режиме `ledger` все читатели идут через
  одну дверь `goodsStock()` — список позиций из прайса, остаток по леджеру групповым запросом, дата из истории
  пересчётов; `vending_stock` в этом режиме не читается. Сверка — по объединению прайса и таблицы со статусами
  (`no_row` с ненулевым леджером — расхождение): пустая таблица больше не даёт «0 из 0». Тень (запись) осталась.
```

- [ ] **Step 2: Чек-лист владельца** — §7 последний пункт дополнить: «Критерий: расхождений 0 и позиций «без строки» с ненулевым леджером нет (панель `/stock/goods`, шапка)». §8 первый пункт переформулировать: «Убрать теневую запись `vending_stock` (четыре писателя) и затем таблицу — после недели жизни на `ledger`; чтения с таблицы сняты срезом 05.09».

- [ ] **Step 3: Handoff** — файл с: что сделано (одна дверь, статусы сверки), что НЕ сделано (тень, таблица, флип), как проверить на проде после мержа (`GET /stock/vending-parity` при `table`: `missingRows = 28`, `mismatched = 0`; `GET /vending/stock` при `table` — прежние 24 строки), откат (настройка `table`).

- [ ] **Step 4: Полный гейт**

```bash
pnpm build && pnpm test && pnpm lint && pnpm typecheck
CHECKS_DATABASE_URL=postgres://mydon:mydon@127.0.0.1:55432/mydon bash -c 'for c in check-0084 check-parts-u1 check-parts-u2 check-parts-u3 check-parts-u4 check-parts-u5 check-parts-u6; do node tools/pglite-checks/$c.mjs >/dev/null 2>&1 && echo "ok $c" || echo "FAIL $c"; done'
```
Expected: все exit 0, семь `ok`.

- [ ] **Step 5: Коммит документов, пуш, PR, CI**

```bash
git add docs memory/session-log
git commit -m "docs: как сделано — чтения остатков товаров через одну дверь; критерий катовера с «без строки»"
git push -u origin feat/goods-stock-reads-to-ledger
gh pr create --base main --head feat/goods-stock-reads-to-ledger --title "feat: чтения остатков товаров — с vending_stock на складской леджер (одна дверь, честная сверка)" --body-file <тело: что/почему/проверка по спеке §9, без флипа прода>
gh workflow run ci.yml --ref feat/goods-stock-reads-to-ledger
```

Мерж — после зелёного CI (шаг «Scenarios on real SQL (parts U1-U6)» обязателен), squash, как #264–#267. После деплоя: `GET /stock/vending-parity` на проде → `missingRows = 28`, `mismatched = 0`, `products = 52`; настройку НЕ трогать.
