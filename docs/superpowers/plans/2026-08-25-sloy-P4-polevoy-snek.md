# П4 «Полевой снек-контур» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Заливки снек-автоматов становятся фактом системы (детектор по снимкам + мастер в боте по плану), усушка автомата считается по дням без заливок с денежным порогом, `machine_stock`-синк получает паритет для гашения.

**Architecture:** Чистые расчёты в `@mydon/shared` (`vending-field.ts`); Core: новый `RefillEventsService` (детектор по `slot_snapshot`) и `ShrinkageService` (по дням), события через `event` + `rules.ts`; агент `ourvend-sync` вызывает детектор после сбора слотов и честно ставит `partial`; бот — мастер `rf:*` поверх существующих заготовок `staff-refill.ts` и `RefillService`; панель — лист «Усушка».

**Tech Stack:** TypeScript strict, NestJS + class-validator, Drizzle/Postgres (миграция 0067), Next.js (конвенция форм #208 — здесь форм нет, только чтение), Telegram-бот (Conversations, numpad, machine-picker), `node:test` по dist / vitest (cc).

**Spec:** `docs/superpowers/specs/2026-08-25-p4-field-snack-design.md` (рулинги R-P4-1…6)

## Global Constraints
- Ветка `feat/p4-field-snack` (worktree `~/Developer/mydon-p4`); push только в свою ветку; коммиты Conventional + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- TZ `Asia/Tashkent` (`TZ` из `@mydon/shared`) для суточных границ; русский в UI/тестах/доках, английский в коде и именах событий/полей; без `any`.
- Ответы API аддитивны; существующие тесты (core 830, bot 504, cc 68, shared 627, db 45) остаются зелёными.
- Мутация = транзакция + `event` + `audit_log` где есть человек; новые события без правила в `rules.ts` до бота не доходят — правило обязательно там, где нужна доставка.
- Тесты по dist: `pnpm --filter @mydon/shared build && pnpm --filter @mydon/db build` перед core/bot/agents; `pnpm --filter cc test`.
- Никаких изменений на проде из задач плана; «мёртвый автомат» (R-P4-4, уточнено при реализации — см. «Addendum после реализации» в спеке и Task 3 ниже): слотов с товаром ≥ 10, и НИ ОДНА их ёмкость не валидна (вне диапазона) — не «все слоты полны» (это старое правило ловило свежезаправленный автомат ложно).
- Цена — `vending_product.purchase_price` (канон); `avg_cost` не заводить (R-P4-3).

---

## Карта файлов
| Файл | Роль |
|---|---|
| `packages/shared/src/vending-field.ts` (+test), `index.ts` | `deadMachine`, `detectRefills`, `matchRefill`, `shrinkageByDay`, типы |
| `packages/db/src/schema.ts`, `drizzle/0067_refill_events.sql`, `meta/_journal.json`, `meta/0067_snapshot.json` | таблица `vending_refill_event` |
| `apps/core/src/system/config-spec.ts` (+test) | `SHRINK_ALERT_UZS`, `REFILL_DETECT_MIN_UNITS` |
| `apps/core/src/vending/refill-events.service.ts` (+test), `vending.controller.ts`, `vending.module.ts` | детектор, `POST /vending/refill-events/detect`, `GET /vending/refill-events` |
| `apps/core/src/vending/shrinkage.service.ts` (+test), `vending.controller.ts` | `GET /vending/shrinkage`, событие `vending.shrinkage_alert`, эмиттер `machine.low_stock` |
| `apps/core/src/vending/refill.service.ts` (+test), `vending.service.ts` (+test), `apps/core/src/rules/rules.ts` (+test) | `vending.refill_recorded`, бэкфилл `product_id`, фильтр мёртвых, правила |
| `apps/core/src/ourvend/ourvend-parity.service.ts` (+test), `ourvend.controller.ts` | паритет остатков |
| `apps/agents/src/ourvend-sync.ts` (+test), `core-client.ts` | вызов детектора, статус `partial` |
| `apps/bot/src/staff-refill.ts` (+test), `staff.ts`, `field-work.ts`, `menu.ts` (+test), `core-client.ts`, `shrinkage-brief.ts` (новый, +test), `handler.ts`, `briefing.ts`, `index.ts` | мастер, команда «усушка», брифинг |
| `apps/cc/src/lib/core.ts`, `components/shrinkage-view.tsx` (+test), `vending-panel.tsx`, `supply-views.tsx`, `lib/domain-nav.ts`, `app/domain/[domain]/page.tsx` | лист «Усушка», секция, подпись частоты |
| `docs/PLAN_STOCK_ABSORPTION.md`, `docs/WAREHOUSE_SPEC.md` (§1.3 ссылка на R-P4-1), `.env.example`, `tools/smoke-core.mjs`, `tools/smoke-panel.mjs` | docs/smoke |

---

### Task 1: Ядро — детектор заливок, мёртвые автоматы, усушка по дням (`vending-field.ts`)

**Files:** Create `packages/shared/src/vending-field.ts`, `packages/shared/src/vending-field.test.ts`; Modify `packages/shared/src/index.ts` (после `export * from "./vending-plan";` → `export * from "./vending-field";`).

**Interfaces (produces):**
```ts
export interface SnapshotSlot { coilId: string; product: string | null; capacity: number; quantity: number }
export interface MachineSnapshot { serial: string; capturedAt: Date; slots: SnapshotSlot[] }
/** R-P4-4 (уточнено при реализации, см. addendum в спеке): слотов с товаром ≥ DEAD_MIN_SLOTS, И НИ ОДНА их ёмкость не валидна → данных нет, автомат мёртв. НЕ «все слоты полны» — то правило ложно ловило свежезаправленный живой автомат. */
export const DEAD_MIN_SLOTS = 10;
export function deadMachine(slots: SnapshotSlot[], maxCapacity = MAX_CAPACITY): boolean;
export interface RefillEvent {
  serial: string; windowFrom: Date; windowTo: Date; units: number;
  slots: { coilId: string; product: string; before: number; after: number; delta: number }[];
}
/** Пары соседних снимков одного автомата; событие, если Σ положительных дельт валидных слотов ≥ minUnits. Мёртвый автомат (по любому из двух снимков) — пропуск. */
export function detectRefills(snapshots: MachineSnapshot[], minUnits: number, maxCapacity = MAX_CAPACITY): RefillEvent[];
export interface HumanRefill { id: string; serial: string; performedAt: Date; qty: number }
/** Ближайшая по времени человеческая запись того же автомата в [windowFrom − pad, windowTo + pad]. */
export function matchRefill(event: RefillEvent, refills: HumanRefill[], padMs = 3 * 3_600_000): HumanRefill | null;
export interface ShrinkDayInput {
  date: string;                 // YYYY-MM-DD (Ташкент)
  startSlots: SnapshotSlot[];   // ближайший снимок к началу суток
  endSlots: SnapshotSlot[];     // ближайший снимок к концу суток
  sales: Map<string, number>;   // продажи за день по товару (канон)
  refillUnits: number;          // Σ units событий детектора за день (0 = день считается)
}
export interface ShrinkItem { product: string; lossUnits: number; lossValue: number; surplusUnits: number; daysCounted: number; noPrice: boolean; alert: boolean }
export interface ShrinkSummary { items: ShrinkItem[]; lossValue: number; daysCounted: number; daysSkipped: number; threshold: number }
/** По дням без заливок: expected = startQty − sales; loss = expected − endQty (>0 недостача, <0 излишек — не зачитывается). Порог по позиции за период. */
export function shrinkageByDay(days: ShrinkDayInput[], prices: Map<string, number>, threshold: number, maxCapacity = MAX_CAPACITY): ShrinkSummary;
```
Семантика: количества по товару = Σ `min(quantity, capacity)` по валидным слотам с этим товаром; товар считается в дне, если есть и в start, и в end (иначе день по товару пропускается). Уточнено при реализации (R-FW-1, addendum в спеке): формула — неттинг ВНУТРИ товара ЗА ПЕРИОД, не по дням. `net = Σ(start − end − sales)` по всем посчитанным дням; `lossUnits = max(0, net)`, `surplusUnits = max(0, −net)`, `lossValue = lossUnits × price` (нет цены → `noPrice`, в деньги 0); `alert = lossValue ≥ threshold`. Между товарами ничего не гасится (R-P4-3 в этой части не менялся). Причина: прод кладёт продажи OurVend в `sale.dt` со сдвигом ±1 день от снимков — посуточная формула `Σ max(loss,0)` считала одну и ту же продажу то недостачей, то излишком у соседних дней вместо взаимного гашения.

- [ ] **Step 1: Тесты** (`vending-field.test.ts`, node:test):
```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEAD_MIN_SLOTS, deadMachine, detectRefills, matchRefill, shrinkageByDay, type MachineSnapshot, type SnapshotSlot } from "./vending-field";

const slot = (coilId: string, product: string | null, quantity: number, capacity = 5): SnapshotSlot => ({ coilId, product, quantity, capacity });
const at = (iso: string) => new Date(iso);

describe("Полевой контур: мёртвый автомат (R-P4-4)", () => {
  it("все слоты полны до 199 при ≥10 слотах — мёртв", () => {
    const slots = Array.from({ length: 12 }, (_, i) => slot(String(i + 1), "X", 199, 199));
    assert.equal(deadMachine(slots, 200), true);
  });
  it("живой автомат: хотя бы один слот не полон", () => {
    const slots = [...Array.from({ length: 11 }, (_, i) => slot(String(i + 1), "X", 5)), slot("12", "Y", 3)];
    assert.equal(deadMachine(slots), false);
  });
  it("меньше 10 слотов с товаром — не мёртв, даже если все полны", () => {
    assert.equal(deadMachine(Array.from({ length: DEAD_MIN_SLOTS - 1 }, (_, i) => slot(String(i), "X", 5))), false);
  });
});

describe("Полевой контур: детектор заливок по снимкам", () => {
  const snaps: MachineSnapshot[] = [
    { serial: "376", capturedAt: at("2026-08-18T07:00:00Z"), slots: [slot("1", "Montella", 1), slot("2", "Fanta", 0), slot("3", "TUC", 4)] },
    { serial: "376", capturedAt: at("2026-08-18T10:00:00Z"), slots: [slot("1", "Montella", 5), slot("2", "Fanta", 5), slot("3", "TUC", 3)] },
    { serial: "376", capturedAt: at("2026-08-18T13:00:00Z"), slots: [slot("1", "Montella", 4), slot("2", "Fanta", 5), slot("3", "TUC", 3)] },
  ];
  it("окно с Σ+ ≥ порога даёт событие; продажи (отрицательные дельты) не учитываются; следующее окно без прихода — нет", () => {
    const ev = detectRefills(snaps, 5);
    assert.equal(ev.length, 1);
    assert.equal(ev[0]!.units, 9);
    assert.deepEqual(ev[0]!.slots.map((s) => [s.coilId, s.delta]), [["1", 4], ["2", 5]]);
    assert.equal(ev[0]!.windowFrom.toISOString(), "2026-08-18T07:00:00.000Z");
    assert.equal(ev[0]!.windowTo.toISOString(), "2026-08-18T10:00:00.000Z");
  });
  it("ниже порога — событий нет", () => { assert.equal(detectRefills(snaps, 10).length, 0); });
  it("мёртвый автомат пропускается; разные автоматы не смешиваются", () => {
    const dead = Array.from({ length: 12 }, (_, i) => slot(String(i), "X", 199, 199));
    const mixed: MachineSnapshot[] = [
      { serial: "360", capturedAt: at("2026-08-18T07:00:00Z"), slots: dead },
      { serial: "360", capturedAt: at("2026-08-18T10:00:00Z"), slots: dead },
      ...snaps,
    ];
    assert.equal(detectRefills(mixed, 5, 200).map((e) => e.serial).join(), "376");
  });
  it("слот без товара или с capacity вне 0..MAX не участвует", () => {
    const s: MachineSnapshot[] = [
      { serial: "1", capturedAt: at("2026-08-18T07:00:00Z"), slots: [slot("1", null, 0), slot("2", "A", 0, 500)] },
      { serial: "1", capturedAt: at("2026-08-18T10:00:00Z"), slots: [slot("1", null, 9), slot("2", "A", 9, 500)] },
    ];
    assert.equal(detectRefills(s, 1).length, 0);
  });
});

describe("Полевой контур: сопоставление с записью оператора", () => {
  const ev = detectRefills([
    { serial: "376", capturedAt: at("2026-08-18T07:00:00Z"), slots: [slot("1", "A", 0)] },
    { serial: "376", capturedAt: at("2026-08-18T10:00:00Z"), slots: [slot("1", "A", 5)] },
  ], 1)[0]!;
  it("берёт ближайшую запись того же автомата в окне ±3ч", () => {
    const m = matchRefill(ev, [
      { id: "far", serial: "376", performedAt: at("2026-08-18T14:30:00Z"), qty: 5 },
      { id: "near", serial: "376", performedAt: at("2026-08-18T09:30:00Z"), qty: 5 },
      { id: "other", serial: "359", performedAt: at("2026-08-18T09:00:00Z"), qty: 5 },
    ]);
    assert.equal(m?.id, "near");
  });
  it("нет записи в окне → null", () => {
    assert.equal(matchRefill(ev, [{ id: "x", serial: "376", performedAt: at("2026-08-19T09:30:00Z"), qty: 5 }]), null);
  });
});

describe("Полевой контур: усушка по дням без заливок (R-P4-3)", () => {
  const prices = new Map([["Kinder", 11000], ["Qurt", 6800]]);
  it("день без заливки: expected = start − sales; недостача в штуках и сумах", () => {
    const s = shrinkageByDay([{
      date: "2026-08-19",
      startSlots: [slot("1", "Kinder", 10, 11), slot("2", "Qurt", 8, 11)],
      endSlots: [slot("1", "Kinder", 6, 11), slot("2", "Qurt", 8, 11)],
      sales: new Map([["Kinder", 2]]),
      refillUnits: 0,
    }], prices, 30000);
    const k = s.items.find((i) => i.product === "Kinder")!;
    assert.equal(k.lossUnits, 2);            // 10 − 2 = 8 ожидали, 6 факт
    assert.equal(k.lossValue, 22000);
    assert.equal(k.alert, false);
    assert.equal(s.daysCounted, 1);
    assert.equal(s.daysSkipped, 0);
  });
  it("день с заливкой пропускается целиком", () => {
    const s = shrinkageByDay([{ date: "2026-08-18", startSlots: [slot("1", "Kinder", 1, 11)], endSlots: [slot("1", "Kinder", 11, 11)], sales: new Map(), refillUnits: 96 }], prices, 30000);
    assert.equal(s.daysSkipped, 1);
    assert.equal(s.items.length, 0);
  });
  it("излишек показывается, но в деньги не входит; порог по позиции за период", () => {
    const day = (date: string, start: number, end: number) => ({ date, startSlots: [slot("1", "Kinder", start, 11)], endSlots: [slot("1", "Kinder", end, 11)], sales: new Map<string, number>(), refillUnits: 0 });
    const s = shrinkageByDay([day("2026-08-19", 10, 8), day("2026-08-20", 8, 9), day("2026-08-21", 9, 8)], prices, 30000);
    const k = s.items[0]!;
    assert.equal(k.lossUnits, 3);
    assert.equal(k.surplusUnits, 1);
    assert.equal(k.lossValue, 33000);
    assert.equal(k.alert, true);
    assert.equal(s.lossValue, 33000);
  });
  it("товар без цены — noPrice, деньги 0; товар не в обоих снимках — день по нему пропущен", () => {
    const s = shrinkageByDay([{ date: "2026-08-19", startSlots: [slot("1", "TUC", 5), slot("2", "Kinder", 3)], endSlots: [slot("1", "TUC", 3)], sales: new Map(), refillUnits: 0 }], prices, 30000);
    assert.deepEqual(s.items.map((i) => [i.product, i.lossUnits, i.noPrice]), [["TUC", 2, true]]);
  });
});
```
- [ ] **Step 2:** `pnpm --filter @mydon/shared build` → ошибка «модуля нет».
- [ ] **Step 3: Реализация** `vending-field.ts` (импорт `MAX_CAPACITY`, `slotValid`, `hasProduct` из `./vending-calc`):
```ts
import { MAX_CAPACITY, hasProduct, slotValid } from "./vending-calc";
/* типы из Interfaces */
export const DEAD_MIN_SLOTS = 10;
const usable = (s: SnapshotSlot, max: number) => hasProduct(s) && slotValid(s, max);
export function deadMachine(slots: SnapshotSlot[], maxCapacity = MAX_CAPACITY): boolean {
  const live = slots.filter((s) => usable(s, maxCapacity));
  return live.length >= DEAD_MIN_SLOTS && live.every((s) => s.quantity >= s.capacity);
}
const qtyByProduct = (slots: SnapshotSlot[], max: number): Map<string, number> => {
  const m = new Map<string, number>();
  for (const s of slots) if (usable(s, max)) m.set(s.product!.trim(), (m.get(s.product!.trim()) ?? 0) + Math.min(s.quantity, s.capacity));
  return m;
};
export function detectRefills(snapshots: MachineSnapshot[], minUnits: number, maxCapacity = MAX_CAPACITY): RefillEvent[] {
  const bySerial = new Map<string, MachineSnapshot[]>();
  for (const s of snapshots) bySerial.set(s.serial, [...(bySerial.get(s.serial) ?? []), s]);
  const out: RefillEvent[] = [];
  for (const [serial, list] of bySerial) {
    const sorted = [...list].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!, cur = sorted[i]!;
      if (deadMachine(prev.slots, maxCapacity) || deadMachine(cur.slots, maxCapacity)) continue;
      const before = new Map(prev.slots.filter((s) => usable(s, maxCapacity)).map((s) => [s.coilId, s]));
      const slots: RefillEvent["slots"] = [];
      for (const s of cur.slots) {
        if (!usable(s, maxCapacity)) continue;
        const b = before.get(s.coilId);
        if (!b || b.product?.trim() !== s.product?.trim()) continue;
        const delta = Math.min(s.quantity, s.capacity) - Math.min(b.quantity, b.capacity);
        if (delta > 0) slots.push({ coilId: s.coilId, product: s.product!.trim(), before: Math.min(b.quantity, b.capacity), after: Math.min(s.quantity, s.capacity), delta });
      }
      const units = slots.reduce((a, x) => a + x.delta, 0);
      if (units >= minUnits) out.push({ serial, windowFrom: prev.capturedAt, windowTo: cur.capturedAt, units, slots });
    }
  }
  return out;
}
export function matchRefill(event: RefillEvent, refills: HumanRefill[], padMs = 3 * 3_600_000): HumanRefill | null {
  const lo = event.windowFrom.getTime() - padMs, hi = event.windowTo.getTime() + padMs, mid = (event.windowFrom.getTime() + event.windowTo.getTime()) / 2;
  const c = refills.filter((r) => r.serial === event.serial && r.performedAt.getTime() >= lo && r.performedAt.getTime() <= hi);
  c.sort((a, b) => Math.abs(a.performedAt.getTime() - mid) - Math.abs(b.performedAt.getTime() - mid));
  return c[0] ?? null;
}
export function shrinkageByDay(days: ShrinkDayInput[], prices: Map<string, number>, threshold: number, maxCapacity = MAX_CAPACITY): ShrinkSummary {
  const acc = new Map<string, ShrinkItem>();
  let daysCounted = 0, daysSkipped = 0;
  for (const d of days) {
    if (d.refillUnits > 0) { daysSkipped++; continue; }
    daysCounted++;
    const start = qtyByProduct(d.startSlots, maxCapacity), end = qtyByProduct(d.endSlots, maxCapacity);
    for (const [product, s] of start) {
      const e = end.get(product); if (e === undefined) continue;
      const expected = s - (d.sales.get(product) ?? 0);
      const loss = expected - e;
      const price = prices.get(product);
      const it = acc.get(product) ?? { product, lossUnits: 0, lossValue: 0, surplusUnits: 0, daysCounted: 0, noPrice: price === undefined, alert: false };
      it.daysCounted++;
      if (loss > 0) { it.lossUnits += loss; it.lossValue += price === undefined ? 0 : loss * price; } else if (loss < 0) it.surplusUnits += -loss;
      acc.set(product, it);
    }
  }
  const items = [...acc.values()].filter((i) => i.lossUnits > 0 || i.surplusUnits > 0).map((i) => ({ ...i, alert: i.lossValue >= threshold })).sort((a, b) => b.lossValue - a.lossValue);
  return { items, lossValue: items.reduce((a, i) => a + i.lossValue, 0), daysCounted, daysSkipped, threshold };
}
```
- [ ] **Step 4:** `pnpm --filter @mydon/shared build && pnpm --filter @mydon/shared test` → PASS.
- [ ] **Step 5:** `git add packages/shared/src/vending-field.ts packages/shared/src/vending-field.test.ts packages/shared/src/index.ts && git commit -m "feat(shared): детектор заливок по снимкам, мёртвые автоматы, усушка по дням (П4)"`

---

### Task 2: Данные — миграция 0067 `vending_refill_event` + ключи настроек

**Files:** Modify `packages/db/src/schema.ts` (после `vendingRefill`), `packages/db/drizzle/meta/_journal.json`; Create `packages/db/drizzle/0067_refill_events.sql`, `meta/0067_snapshot.json` (db:generate); Modify `apps/core/src/system/config-spec.ts` (+test).

**Interfaces (produces):**
```ts
export const vendingRefillEvent = pgTable("vending_refill_event", {
  id: id(), machineSerial: text("machine_serial").notNull(), machineId: uuid("machine_id").references(() => entity.id),
  windowFrom: timestamp("window_from", { withTimezone: true }).notNull(), windowTo: timestamp("window_to", { withTimezone: true }).notNull(),
  units: integer("units").notNull(), slots: jsonb("slots").$type<{ coilId: string; product: string; before: number; after: number; delta: number }[]>().notNull(),
  matchedRefillId: uuid("matched_refill_id").references(() => vendingRefill.id), createdAt: createdAt(),
}, (t) => [uniqueIndex("vending_refill_event_serial_to").on(t.machineSerial, t.windowTo), index("vending_refill_event_to_idx").on(t.windowTo)]);
```
Config-spec: `{ key: "SHRINK_ALERT_UZS", label: "Вендинг: порог усушки автомата, сум (по позиции за период)", kind: "number", fallback: "30000", help: "Донор mydon-stock: 30 000 сум", validate: nonNegNumber }`, `{ key: "REFILL_DETECT_MIN_UNITS", label: "Вендинг: порог детектора заливки, шт за окно", kind: "number", fallback: "10", validate: nonNegNumber }`.

- [ ] Step 1: `pnpm --filter @mydon/db db:generate` → «No schema changes». Step 2: схема (JSDoc: «событие детектора по снимкам; unique(serial, window_to) — идемпотентность прогона»), **добавить таблицу в `export const schema = {…}`** (страж `schema.test.ts`). Step 3: `db:generate` → переименовать в `0067_refill_events.sql`, tag в журнале (idx 67, when предыдущий+1), SQL привести к `CREATE TABLE IF NOT EXISTS` + индексы `IF NOT EXISTS`, шапка-комментарий. Step 4: config-spec + тест валидатора (число ≥ 0; отрицательное отвергается). Step 5: `pnpm --filter @mydon/db build && pnpm --filter @mydon/db test`; `pnpm --filter core build && pnpm --filter core test` (config-spec). Step 6: commit `feat(db,core): события заливок по снимкам (0067) и пороги усушки/детектора в настройках (П4)`.

---

### Task 3: Core — `RefillEventsService`: детектор по `slot_snapshot`, бэкфилл `product_id`, мёртвые автоматы

**Files:** Create `apps/core/src/vending/refill-events.service.ts` (+test); Modify `vending.controller.ts` (роуты), `vending.module.ts` (провайдер), `vending.service.ts` (бэкфилл `product_id` в `ingestSlots`/`ingestStock`; `okSerials()` исключает `deadMachine`), `vending.service.test.ts`.

**Interfaces:**
```ts
// POST /vending/refill-events/detect  body { days?: 1..30 (default 2) }  → { machines: number; events: number; matched: number; skipped: { serial: string; reason: "dead"|"uncalibrated"|"no_slots" }[] }
// GET  /vending/refill-events?days=14 → { serial, name, windowFrom, windowTo, units, slots, matchedRefillId }[]
export class RefillEventsService { detect(days = 2): Promise<DetectResult>; list(days = 14): Promise<RefillEventRow[]> }
```
Алгоритм `detect`: читать `slot_snapshot` за `days` (по `captured_at`), сгруппировать по `(machine_serial, captured_at)` → `MachineSnapshot[]` (имена слотов резолвить через алиасы `loadProductIndex` до канона, как `resolveSlots`); `minUnits` = `REFILL_DETECT_MIN_UNITS` через `resolveEffective`; `detectRefills` → upsert `onConflictDoNothing` по `(serial, window_to)`; для новых событий `matchRefill` с `vending_refill` того же автомата ±3ч → `matched_refill_id`; `machine_id` через `machineIdBySerial`. Уточнено при реализации (R-FW-9, addendum в спеке): `vending.refill_detected` НЕ эмитится в момент детекта — техник дописывает позицию в боте уже после прогона детектора, и запись «без записи» становилась необратимым враньём после ack брифинга. Событие эмитится отдельным проходом в конце `detect()` по событиям без `matched_refill_id`, у которых `window_to < now − MATCH_PAD_MS` (~3 ч) и которых ещё нет в ленте (дедуп по `payload.eventId`/`(serial, windowTo)`); с записью — `recorded:true` по-прежнему сразу. Возврат счётчиков.
Бэкфилл: в `ingestSlots` upsert `productId` из индекса (по канону); в `ingestStock` — `productId` строки склада. Мёртвые: `okSerials()` дополнительно `!deadMachine(slots)`; в `plan()` warnings добавить `machine_skipped` с причиной «ёмкости слотов вне диапазона (заглушка источника)» для мёртвых (R-P4-4 уточнён — см. Global Constraints и addendum в спеке; на текущем проде эта ветка не срабатывает вовсе, склад-заглушки без имени товара уходят в `no_slots`/`uncalibrated` — R-FW-3).
Тесты (стабы как в `vending.service.test.ts`): детект даёт событие и второй прогон — 0 новых (конфликт); мёртвый автомат в `skipped` (`reason: "dead"`); matched по записи ±3ч; `ingestSlots` пишет `productId` для известного имени; `plan()` пропускает мёртвый автомат.
Smoke-core: `POST /vending/refill-events/detect` (после сценария приёма слотов) и `GET /vending/refill-events`.
Commit: `feat(core): детектор заливок по снимкам слотов, бэкфилл product_id, фильтр мёртвых автоматов (П4)`.

---

### Task 4: Core — усушка, события и правила, паритет остатков

**Files:** Create `apps/core/src/vending/shrinkage.service.ts` (+test); Modify `vending.controller.ts` (`GET /vending/shrinkage`), `vending.module.ts`, `refill.service.ts` (+test: `event vending.refill_recorded` в той же транзакции), `apps/core/src/rules/rules.ts` (+test), `apps/core/src/ourvend/ourvend-parity.service.ts` (+test), `ourvend.controller.ts`.

**Interfaces:**
```ts
// GET /vending/shrinkage?days=14 → { from, to, threshold, machines: [{ serial, name, summary: ShrinkSummary, refillDays: [{ date, detectedUnits, recordedUnits }] }], warnings: { code: "snapshots_stale"|"no_sales_day"|"machine_dead"|"sales_unknown_product"|"machine_error"; message }[] }
// POST /vending/shrinkage/alerts  (ручной триггер, без тела, ServiceTokenGuard — тот же метод, что дёргает крон 08:35) → { alerts: number; lowStock: number }
export class ShrinkageService { report(days = 14): Promise<ShrinkReport>; alertDaily(): Promise<{ alerts: number; lowStock: number }> }
```
`report`: для каждого автомата в строю и не мёртвого: дни по Ташкенту за период; `startSlots`/`endSlots` = ближайшие снимки к 00:00 и 24:00 дня (из `slot_snapshot`; если ближайший дальше 6 ч — день пропущен с warning `snapshots_stale`); `sales` = `sale` за `dt` по канону (алиасы); `refillUnits` = Σ `vending_refill_event.units` с `window_to` в дне; `prices` из `vending_product` через `loadProductIndex`; `shrinkageByDay` с `SHRINK_ALERT_UZS`. `refillDays` = дни с событиями: `detectedUnits` и `recordedUnits` (Σ `vending_refill.qty` за день).
`alertDaily` (крон `croner` `35 8 * * *` Asia/Tashkent, `onModuleInit`/`onApplicationShutdown` + `cron-shutdown.test.ts`): отчёт за 7 дней; по каждой позиции с `alert` — `event { type:"vending.shrinkage_alert", payload:{serial, name, product, lossUnits, lossValue, days} }` с дедупом по `(serial, product, day)` (проверка существующего события за сегодня). Эмиттер `machine.low_stock`: там же — по `machine_slot` товар с Σ quantity ≤ 1 при Σ capacity ≥ 5 → `event { type:"machine.low_stock", payload:{machine: name, product, left} }`, дедуп по дню.
`rules.ts`: `{ id:"vending.shrinkage_alert", eventType:"vending.shrinkage_alert", urgency:"briefing", format: (p) => `📉 Усушка ${p.name}: ${p.product} −${p.lossUnits} шт ≈ ${p.lossValue} сум за ${p.days} дн.` }`, `{ id:"vending.refill_detected", eventType:"vending.refill_detected", urgency:"briefing", when: (p) => p.recorded === false, format: (p) => `🍫 Заливка без записи: ${p.name} +${p.units} шт ${время} — оформи в боте «Заполнил автомат»` }` — сверить сигнатуры с существующими правилами и стражем `rules.test.ts` (уникальные id).
`RefillService.create`: в транзакции после вставки — `event { source: personId ? "human":"system", type:"vending.refill_recorded", payload:{serial, product, qty, personId} }` (правило не нужно — лента читает таблицу).
Паритет остатков: `OurvendParityService.parity(days)` дополнительно `stock: { days, checked, ok, note?, mismatches[{dt, serial, product, own, stock}] }` — сравнение `ourvend_stock_snapshot` ↔ `machine_stock` по `(dt, serial, product)` за `days` (только автоматы, у которых есть обе стороны, склад/не-в-строю исключены явно тем же реестром `notInService`/`skipReasonOf`, а не только пересечением множеств); вердикт `ok` = обе части (продажи и остатки) без расхождений; `daily()` пишет в сводку обе. Уточнено при реализации (R-FW-2, addendum в спеке): `checked = 0` (снимков `ourvend_stock_snapshot` за период нет — сравнивать не по чему) ⇒ `stock.ok = false` с `note: "снимков остатков OurVend за период нет — сверять не по чему"`, а НЕ зелёный «ok» по умолчанию — иначе гейт «7 зелёных дней» (§П4 `PLAN_STOCK_ABSORPTION.md`) засчитывал бы дни, когда сверки не было вовсе. Тесты со стабами.
Commit: `feat(core): усушка автомата по дням, алерты и низкий остаток через правила, паритет остатков (П4)`.

---

### Task 5: Агент — детектор после сбора слотов, честный статус `partial`

**Files:** Modify `apps/agents/src/ourvend-sync.ts` (+test), `apps/agents/src/core-client.ts`.
Шаги: (1) `AgentsCoreClient.detectRefillEvents(days=1)` → `POST /vending/refill-events/detect`; (2) в `runOurvendSync` после успешного `ingestVendingSlots` — вызвать детектор (ошибка детектора не роняет синк: лог + поле `detect: "failed"` в результате); (3) если слоты записаны, а продажи упали — `status: "partial"` с `machinesOk` от слотов и `error` про продажи (сейчас `:169` даёт `failed`/`machinesOk 0`); тест на оба поведения (стаб клиента, где `ingestVendingSales` бросает `AbortError`). `.env.example`: комментарий к `OURVEND_SYNC_CRON` — «после слотов запускается детектор заливок».
Commit: `fix(agents): синк ставит partial при падении продаж и запускает детектор заливок после слотов (П4)`.

---

### Task 6: Бот — мастер «Заполнил автомат» по плану, команда «усушка», брифинг

**Files:** Modify `apps/bot/src/staff-refill.ts` (+test), `staff.ts`, `field-work.ts` (FIELD_FLOWS/onObjectPicked для `refill`), `menu.ts` (`ready: true`) + `menu.test.ts`, `core-client.ts` (`vendingPlan` уже есть; добавить `vendingShrinkage(days)`, `vendingStock()` если нужен «на складе N»); Create `apps/bot/src/shrinkage-brief.ts` (+test); Modify `handler.ts` (команда «усушка» до parseIntent, HELP), `briefing.ts`/`index.ts` (строка усушки из событий правил).
Расхождение с исходным планом (обнаружено при реализации): `urgency:"briefing"` события НЕ доставлялись владельцу вовсе — поллер срочных ходит с `immediate=1`, а утренний брифинг `/rules/pending` не читал никогда, так что `vending.shrinkage_alert`/`vending.refill_detected` копились в Core без доставки. Добавлена проводка: `formatBriefingNotes` (блок «Разобраться сегодня», дедуп, лимит длины, бюджет символов) + чтение `briefingNotifications()` в утреннем брифинге + `ackNotifications` только по показанным ключам после успешной отправки.

**Мастер (шаги, callback `rf:*`, один слот беседы):**
1. Вход: `case "mrefill"` в `startMenuItem` → `startMachineRefill(chatId, person, deps)`: `pickObject` (machine-picker, flow `refill`; `FIELD_FLOWS` + `onObjectPicked` case `refill`).
2. После выбора автомата: `entityId → serial` (по `entity.externalRef` через `deps.core` — добавить `machineSerial(entityId)` в core-client, если нет: `GET /entities/:id` → `externalRef` → `normalizeMachineSerial`), загрузить `vendingPlan()` и взять `machines.find(serial)`; чек-лист «По плану в {name}: • Montella — 6 · • Fanta — 5 …» (товары с `fromPurchase+fromStock>0`, Σ по слотам) + кнопки `✅ Загрузил по плану` / `✏️ Иначе` / `✖️ Отмена`. Если плана по автомату нет → сразу список товаров автомата (`machineProducts`) как в заготовке.
3. `✅ Загрузил по плану` → для каждого товара `recordItem` с `qty` из плана (`clientKey rf:<runId>:<index>`), итог `summaryText`, `afterItemKeyboard` (`➕ Ещё товар` / `✅ Готово`).
4. `✏️ Иначе` → `productKeyboard(товары плана + автомата)` → товар → нумпад (`numpad.ts`, prefix `rf`) с подсказкой «по плану N» → `recordItem` → `afterItemKeyboard`.
5. `rf:other` → список всех товаров автомата (`machineProducts`), поиск текстом по прайсу (`GET /vending/products` имена, `normalizeProductName` подстрока) — до 20.
6. `rf:done` → итог + `conversations.clear`; `rf:cancel` → `cancelText` (записанное не стирается).
Барьеры: «кнопка устарела» для `rf:*` вне беседы; «прошлое не дописано» — по существующему шаблону `staff.ts:303-354`. Тесты: сценарий по плану (2 позиции → 2 `createRefill` с ключами `rf:<run>:0/1`), правка через нумпад, «другой товар», отмена, сбой Core не двигает индекс, `menu.test.ts` — пункт видим и `ready`.
**Команда владельца «усушка»** (`isShrinkageQuery`: `/^усушк|^потер[ия]\s*(в\s*)?автомат/i`): `formatShrinkage(report)` — по автомату: «📉 Olma за 14 дн (дней посчитано 9, с заливкой 5): Kinder Bueno −9 шт ≈ 99 000 сум ⚠️ · Qurt −6 ≈ 40 800 ⚠️ · … Итого ≈ 164 600 сум» + «Заливки по снимкам: 18.08 +96 (записано 0), 21.08 +87 (записано 0)» + предупреждения; ≤ 3500 символов (`chunk` из `purchase-plan.ts` — вынести в общий helper `tg-chunk.ts`? — нет, переиспользовать экспортом). HELP строка.
Commit: `feat(bot): мастер «Заполнил автомат» по плану закупа, команда «усушка» (П4)`.

---

### Task 7: Панель — лист «Усушка», секция на «Снек», подпись частоты остатков

**Files:** Modify `apps/cc/src/lib/core.ts` (типы `VendingShrinkage*`, геттер `vendingShrinkage(days)`, `vendingRefillEvents(days)`), `lib/domain-nav.ts` (`reports` → `{ label: "Усушка", type: "shrinkage" }` + `TABLE_BACKED_LEAVES` + исключение из generic ListShell в `page.tsx`), `app/domain/[domain]/page.tsx` (диспетч), Create `components/shrinkage-view.tsx` (+test: `ShrinkageTables({report})` презентационный + async `ShrinkageView`), Modify `components/vending-panel.tsx` (секция «Усушка за 14 дней» — топ-5 позиций с alert + ссылка на лист), `components/supply-views.tsx:~105` (подпись «обновляется каждые 10 минут» → по источнику: `supplySummary().source === "own" ? "раз в сутки (свой снапшот)" : "каждые 10 минут (зеркало склада)"` — если источник в ответе нет, добавить в `GET /supply/summary` поле `source`).
Тесты vitest: рендер таблиц (позиции, alert-пилюля, дни заливок с «записано 0»), пустое состояние, Core down.
Commit: `feat(cc): лист «Усушка» и секция на вкладке «Снек»; подпись частоты остатков по источнику (П4)`.

---

### Task 8: Docs, smoke, полный прогон

**Files:** `docs/PLAN_STOCK_ABSORPTION.md` (§П4: ✅ мастер, ✅ усушка, «инвентаризация задним числом — НЕ делаем (R-P4-1)», «перемещения — НЕ делаем (R-P4-5)», связь №1 — «паритет остатков добавлен, флип после 7 зелёных дней»), `docs/WAREHOUSE_SPEC.md` §1.3 — ссылка на R-P4-1 и на детектор, §4.4 «сверка» — «реализовано детектором + усушкой (П4)», `docs/FIELD_OPS_SPEC.md` — строка про мастер `rf:` (готов), `.env.example`, `tools/smoke-core.mjs` (`GET /vending/shrinkage`, `GET /vending/refill-events`, `POST /vending/refill-events/detect`), `tools/smoke-panel.mjs` (`reports:shrinkage`).
Полный прогон: `pnpm -s lint && pnpm -s typecheck && pnpm -s build && pnpm -s test`; smoke-core на scratch-БД (createdb → migrate → seed.js → seed-vending.js → smoke → dropdb).
Commit: `docs(p4): решения волны П4 в плане поглощения и спеках, smoke-пути`.

---

## Выкатка (после адверсариал-ревью)
1. PR → CI → мерж → автодеплой (миграция 0067).
2. Прод read-only: `POST /vending/refill-events/detect {days: 14}` один раз (бэкфилл истории событий) → `GET /vending/refill-events?days=14` ≈ 6 событий / 430 ед.; `GET /vending/shrinkage?days=14` — Olma: Kinder ≈ 99 000, Qurt ≈ 40 800 с alert; warnings без `snapshots_stale`.
3. Бот (владелец): «усушка»; сотрудник: «📦 Заполнил автомат» → план → «Загрузил по плану» (на тестовом автомате? — нет: только показать чек-лист и отменить).
4. Владельцу: пороги в «Система» при желании; наблюдать 7 зелёных дней паритета продаж+остатков → флип `OURVEND_ACCOUNTING_SOURCE=own`.
