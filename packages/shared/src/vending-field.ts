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
 * Порог «мёртвого» автомата (R-P4-4): сколько слотов с товаром должно быть,
 * чтобы судить об источнике целиком. Пара сбитых ёмкостей на живом автомате —
 * это калибровка, а не заглушка источника.
 */
export const DEAD_MIN_SLOTS = 10;

const usable = (s: SnapshotSlot, max: number): boolean => hasProduct(s) && slotValid(s, max);

/**
 * Мёртвый автомат (R-P4-4): в слотах есть товар (их ≥ DEAD_MIN_SLOTS), но НИ
 * ОДНА ёмкость не попадает в диапазон — источник отдаёт мусор вместо данных.
 *
 * НА СЕГОДНЯШНЕМ ПРОДЕ ЭТА ВЕТКА НЕ СРАБАТЫВАЕТ НИ РАЗУ (замер 25.08 по всей
 * истории `slot_snapshot`, 35 652 строки). Склад-заглушки SKLAD 5S/6S отдают
 * `capacity = quantity = 199`, но с ПУСТЫМ именем товара: `hasProduct` их не
 * считает, и автомат отсеивается раньше как `no_slots`. SKLAD 4S держит 43
 * имени и 7 валидных ёмкостей из 43 — это `uncalibrated`. Правило остаётся
 * защитным: оно ждёт источник, который отдаст ТОВАР с ёмкостью вне диапазона.
 *
 * Полный ЖИВОЙ автомат мёртвым НЕ считается. Прежнее правило («все валидные
 * слоты полны») давало ложное срабатывание ровно на том, ради чего затевался
 * весь срез: только что заправленный автомат на 43 пружины стоит 5/5 по всем
 * слотам и на несколько часов выпадал бы из плана, продаж и прогноза — с
 * предупреждением «нет данных», которое в этом случае враньё.
 */
export function deadMachine(slots: SnapshotSlot[], maxCapacity = MAX_CAPACITY): boolean {
  const withProduct = slots.filter(hasProduct);
  return withProduct.length >= DEAD_MIN_SLOTS && withProduct.every((s) => !slotValid(s, maxCapacity));
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
 * Проверка явная, хотя `usable` и так отсекает слоты заглушки: намерение «по
 * этому автомату данных нет» должно быть видно в коде, а не выводиться
 * читателем из фильтра ёмкостей.
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
      // `units > 0` — не тавтология к порогу: порог берётся из настроек, и
      // `REFILL_DETECT_MIN_UNITS = 0` («ловить любой приход») иначе назвал бы
      // заливкой КАЖДУЮ пару снимков, включая те, где не приехало ничего.
      if (units > 0 && units >= minUnits) out.push({ serial, windowFrom: prev.capturedAt, windowTo: cur.capturedAt, units, slots });
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

/**
 * Позиция отчёта об усушке. `lossUnits`/`surplusUnits` — НЕТТО за период по
 * этому товару (R-FW-1): одновременно ненулевыми они не бывают, потому что
 * дневные знаки внутри товара гасятся до итога.
 */
export interface ShrinkItem {
  product: string;
  /** Чистая недостача за период, шт (≥ 0). */
  lossUnits: number;
  /** `lossUnits × price`; 0, если цены нет. */
  lossValue: number;
  /** Чистый излишек за период, шт (≥ 0) — в деньги не входит. */
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
 * Усушка автомата по дням БЕЗ заливок (R-P4-3), НЕТТИНГОМ ВНУТРИ ТОВАРА ЗА
 * ПЕРИОД (R-FW-1).
 *
 * В дни заливки приход и продажи гасятся внутри 3-часового окна, и сходимость
 * искажается — поэтому день с `refillUnits > 0` исключается целиком (не только
 * по позиции). За каждый посчитанный день по товару берётся
 * `net_день = startQty − sales − endQty`, и по товару за ПЕРИОД копится
 * `net = Σ net_день`: `lossUnits = max(0, net)`, `surplusUnits = max(0, −net)`,
 * `lossValue = lossUnits × price`.
 *
 * ПОЧЕМУ ДНЕВНЫЕ ЗНАКИ ГАСЯТСЯ ВНУТРИ ТОВАРА. Продажи Ourvend ложатся в
 * `sale.dt` со сдвигом ±1 сутки относительно снимков: у одного товара идут
 * подряд день −3 и день +3. Посуточная сумма показывала это как 29 970 сум
 * недостачи при нулевом фактическом расхождении — прод-замер 25.08 дал
 * Σ недостача 30 ед. против Σ излишка 37 ед., то есть убыли нет вовсе, а
 * верхние строки отчёта стояли в 0,1 % от порога алерта.
 *
 * МЕЖДУ ТОВАРАМИ НИЧЕГО НЕ ГАСИТСЯ (R-P4-3 в силе): излишек по одной позиции
 * не закрывает недостачу по другой — это разные товары и разные деньги, а не
 * сдвиг даты у одного и того же расхода.
 *
 * Товар считается в дне, только если он есть и в start, и в end (иначе один
 * снимок не про этот слот, а не «весь товар пропал»). Порог — по позиции за
 * весь период, не по дню.
 */
export function shrinkageByDay(
  days: ShrinkDayInput[],
  prices: Map<string, number>,
  threshold: number,
  maxCapacity = MAX_CAPACITY,
): ShrinkSummary {
  /** По товару за период: чистое расхождение (+ недостача, − излишек) и сколько дней его считали. */
  const acc = new Map<string, { net: number; daysCounted: number; noPrice: boolean }>();
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
      const item = acc.get(product) ?? { net: 0, daysCounted: 0, noPrice: prices.get(product) === undefined };
      item.net += expected - endQty;
      item.daysCounted++;
      acc.set(product, item);
    }
  }

  const items: ShrinkItem[] = [...acc.entries()]
    .map(([product, a]) => {
      const lossUnits = Math.max(0, a.net);
      const price = prices.get(product);
      const lossValue = price === undefined ? 0 : lossUnits * price;
      return {
        product,
        lossUnits,
        lossValue,
        surplusUnits: Math.max(0, -a.net),
        daysCounted: a.daysCounted,
        noPrice: a.noPrice,
        // `lossUnits > 0` — на случай порога 0 («алерт на любую потерю»):
        // без него нулевая сумма позиции с ОДНИМ ЛИШЬ ИЗЛИШКОМ прошла бы как
        // «потеря на 0 сум».
        alert: lossUnits > 0 && lossValue >= threshold,
      };
    })
    .filter((i) => i.lossUnits > 0 || i.surplusUnits > 0)
    .sort((a, b) => b.lossValue - a.lossValue);

  return { items, lossValue: items.reduce((a, i) => a + i.lossValue, 0), daysCounted, daysSkipped, threshold };
}
