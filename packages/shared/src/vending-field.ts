import { MAX_CAPACITY, hasProduct, slotValid } from "./vending-calc";

/**
 * Полевой снек-контур (П4): детектор заливок по снимкам слотов, мёртвые
 * автоматы, усушка по дням без заливок.
 *
 * Донор-факты (инвентаризация 25.08, прод read-only): заливок в
 * `vending_refill` — 0 строк за всю историю (люди забывают писать боту), но
 * снимки слотов идут каждые 3 ч без пропусков и детектор «Σ+ ≥ порога» ловит
 * приход чисто. Поэтому здесь заливка — это ФАКТ СНИМКА, а не запись
 * оператора; человеческая запись — только уточнение (см. `matchRefill`).
 *
 * Чистые детерминированные функции без инфраструктуры — как в `vending-calc`.
 */

export interface SnapshotSlot {
  coilId: string;
  product: string | null;
  capacity: number;
  quantity: number;
}

export interface MachineSnapshot {
  serial: string;
  capturedAt: Date;
  slots: SnapshotSlot[];
}

/**
 * Порог «мёртвого» автомата (R-P4-4): склад-заглушки (SKLAD 4S/5S/6S) отдают
 * `quantity = capacity = 199` по ВСЕМ слотам — данных с автомата нет, а не
 * «всё раскуплено». 10 слотов — чтобы маленький настоящий автомат с полной
 * загрузкой не попал под фильтр по случайности.
 */
export const DEAD_MIN_SLOTS = 10;

const usable = (s: SnapshotSlot, max: number): boolean => hasProduct(s) && slotValid(s, max);

/** Мёртвый автомат: валидных слотов с товаром ≥ DEAD_MIN_SLOTS и все они полны (quantity ≥ capacity). */
export function deadMachine(slots: SnapshotSlot[], maxCapacity = MAX_CAPACITY): boolean {
  const live = slots.filter((s) => usable(s, maxCapacity));
  return live.length >= DEAD_MIN_SLOTS && live.every((s) => s.quantity >= s.capacity);
}

export interface RefillEvent {
  serial: string;
  windowFrom: Date;
  windowTo: Date;
  units: number;
  slots: { coilId: string; product: string; before: number; after: number; delta: number }[];
}

/** Количество по товару = Σ min(quantity, capacity) по валидным слотам с этим товаром. */
const qtyByProduct = (slots: SnapshotSlot[], max: number): Map<string, number> => {
  const m = new Map<string, number>();
  for (const s of slots) {
    if (!usable(s, max)) continue;
    const name = s.product!.trim();
    m.set(name, (m.get(name) ?? 0) + Math.min(s.quantity, s.capacity));
  }
  return m;
};

/**
 * Детектор заливок по парам соседних снимков одного автомата (§ выше — донор
 * mydon-stock: окно 3 ч, Σ положительных дельт по валидным слотам ≥ порога).
 * Продажи (отрицательные дельты) НЕ учитываются в сумме — приход и расход
 * гасятся только внутри одного окна, если оба произошли между двумя
 * снимками (см. R-P4-3: усушку поэтому считаем по дням без заливок).
 * Мёртвый автомат (по любому из пары снимков) — окно пропускается целиком.
 */
export function detectRefills(snapshots: MachineSnapshot[], minUnits: number, maxCapacity = MAX_CAPACITY): RefillEvent[] {
  const bySerial = new Map<string, MachineSnapshot[]>();
  for (const s of snapshots) bySerial.set(s.serial, [...(bySerial.get(s.serial) ?? []), s]);

  const out: RefillEvent[] = [];
  for (const [serial, list] of bySerial) {
    const sorted = [...list].sort((a, b) => a.capturedAt.getTime() - b.capturedAt.getTime());
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]!;
      const cur = sorted[i]!;
      if (deadMachine(prev.slots, maxCapacity) || deadMachine(cur.slots, maxCapacity)) continue;

      const before = new Map(prev.slots.filter((s) => usable(s, maxCapacity)).map((s) => [s.coilId, s]));
      const slots: RefillEvent["slots"] = [];
      for (const s of cur.slots) {
        if (!usable(s, maxCapacity)) continue;
        const b = before.get(s.coilId);
        // Смена товара в слоте между снимками — не заливка того же товара,
        // дельта не считается (сравнение только «тот же coilId, тот же товар»).
        if (!b || b.product?.trim() !== s.product?.trim()) continue;
        const delta = Math.min(s.quantity, s.capacity) - Math.min(b.quantity, b.capacity);
        if (delta > 0) {
          slots.push({
            coilId: s.coilId,
            product: s.product!.trim(),
            before: Math.min(b.quantity, b.capacity),
            after: Math.min(s.quantity, s.capacity),
            delta,
          });
        }
      }
      const units = slots.reduce((a, x) => a + x.delta, 0);
      if (units >= minUnits) out.push({ serial, windowFrom: prev.capturedAt, windowTo: cur.capturedAt, units, slots });
    }
  }
  return out;
}

export interface HumanRefill {
  id: string;
  serial: string;
  performedAt: Date;
  qty: number;
}

/**
 * Сопоставление события детектора с человеческой записью (мастер «Заполнил
 * автомат» в боте): ближайшая по времени запись того же автомата в окне
 * [windowFrom − pad, windowTo + pad]. Запись — уточнение факта снимка, не
 * источник, поэтому детектор работает и без неё.
 */
export function matchRefill(event: RefillEvent, refills: HumanRefill[], padMs = 3 * 3_600_000): HumanRefill | null {
  const lo = event.windowFrom.getTime() - padMs;
  const hi = event.windowTo.getTime() + padMs;
  const mid = (event.windowFrom.getTime() + event.windowTo.getTime()) / 2;
  const candidates = refills.filter((r) => r.serial === event.serial && r.performedAt.getTime() >= lo && r.performedAt.getTime() <= hi);
  candidates.sort((a, b) => Math.abs(a.performedAt.getTime() - mid) - Math.abs(b.performedAt.getTime() - mid));
  return candidates[0] ?? null;
}

export interface ShrinkDayInput {
  /** YYYY-MM-DD (Ташкент). */
  date: string;
  /** Ближайший снимок к началу суток. */
  startSlots: SnapshotSlot[];
  /** Ближайший снимок к концу суток. */
  endSlots: SnapshotSlot[];
  /** Продажи за день по товару (канон). */
  sales: Map<string, number>;
  /** Σ units событий детектора за день (0 = день считается). */
  refillUnits: number;
}

export interface ShrinkItem {
  product: string;
  lossUnits: number;
  lossValue: number;
  surplusUnits: number;
  daysCounted: number;
  noPrice: boolean;
  alert: boolean;
}

export interface ShrinkSummary {
  items: ShrinkItem[];
  lossValue: number;
  daysCounted: number;
  daysSkipped: number;
  threshold: number;
}

/**
 * Усушка автомата по дням БЕЗ заливок (R-P4-3): в дни заливки приход и
 * продажи гасятся внутри 3-часового окна, и сходимость искажается — поэтому
 * день с `refillUnits > 0` исключается целиком (не только по позиции).
 * `expected = startQty − sales`; `loss = expected − endQty` (>0 недостача,
 * <0 излишек — в деньги не входит, но виден). Товар считается в дне, только
 * если он есть и в start, и в end (иначе один снимок не про этот слот, а
 * не «весь товар пропал»). Порог — по позиции за весь период, не по дню.
 */
export function shrinkageByDay(
  days: ShrinkDayInput[],
  prices: Map<string, number>,
  threshold: number,
  maxCapacity = MAX_CAPACITY,
): ShrinkSummary {
  const acc = new Map<string, ShrinkItem>();
  let daysCounted = 0;
  let daysSkipped = 0;

  for (const d of days) {
    if (d.refillUnits > 0) {
      daysSkipped++;
      continue;
    }
    daysCounted++;
    const start = qtyByProduct(d.startSlots, maxCapacity);
    const end = qtyByProduct(d.endSlots, maxCapacity);
    for (const [product, startQty] of start) {
      const endQty = end.get(product);
      if (endQty === undefined) continue;
      const expected = startQty - (d.sales.get(product) ?? 0);
      const loss = expected - endQty;
      const price = prices.get(product);
      const item =
        acc.get(product) ?? { product, lossUnits: 0, lossValue: 0, surplusUnits: 0, daysCounted: 0, noPrice: price === undefined, alert: false };
      item.daysCounted++;
      if (loss > 0) {
        item.lossUnits += loss;
        item.lossValue += price === undefined ? 0 : loss * price;
      } else if (loss < 0) {
        item.surplusUnits += -loss;
      }
      acc.set(product, item);
    }
  }

  const items = [...acc.values()]
    .filter((i) => i.lossUnits > 0 || i.surplusUnits > 0)
    .map((i) => ({ ...i, alert: i.lossValue >= threshold }))
    .sort((a, b) => b.lossValue - a.lossValue);

  return { items, lossValue: items.reduce((a, i) => a + i.lossValue, 0), daysCounted, daysSkipped, threshold };
}
