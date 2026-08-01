/**
 * Объединённый журнал «Все продажи»: несколько поштучных источников — одна лента.
 *
 * gjvending и OurVend — РАЗНЫЕ производители и РАЗНЫЕ автоматы. Их продажи не
 * пересекаются, поэтому это не сверка (где ищут двойников), а сложение: вместе
 * два флота дают полную картину продаж. Каждый заказ помечен источником и лежит
 * один раз — задваивать нечего, машины не общие.
 *
 * Почему это живёт у нас. OurVend в кабинет vendinghub пока НЕ интегрирован, а
 * gjvending и OurVend — разные системы без общего свода. Значит единственное
 * место, где виден весь оборот сразу, — этот журнал. Свод считается здесь, в
 * одном разборе, чтобы оболочка и Core не разошлись.
 *
 * Правило слоя цело: значения не переписываются. Приведение суммы к числу
 * законно только ради счёта итога — само сырьё остаётся строкой.
 */

/** Один заказ источника, уже вынутый по ролям колонок. */
export interface RawOrder {
  externalId: string;
  ts: string;
  machine: string;
  product: string;
  /** Сумма как в источнике — строкой. */
  amount: string;
  payment: string;
  status: string;
  /** Тип заказа (у gjvending); по нему отсеиваются тестовые отгрузки. */
  kind: string;
}

/** Входной флот: код и название источника плюс его заказы. */
export interface Fleet {
  source: string;
  title: string;
  /** Загружен ли источник (был ли снимок). false — покажем честно «нет данных». */
  loaded: boolean;
  orders: RawOrder[];
}

/** Заказ объединённой ленты: та же строка плюс метка источника. */
export interface CombinedOrder {
  source: string;
  title: string;
  externalId: string;
  ts: string;
  machine: string;
  product: string;
  amount: string;
  /** Сумма числом; null — сумма нечитаема и в оборот не идёт. */
  amountNum: number | null;
  payment: string;
  status: string;
}

/** Итог по одному разрезу (источник, способ оплаты, месяц). */
export interface Bucket {
  key: string;
  orders: number;
  revenue: number;
}

/** Свод по источнику — с пометкой, загружен ли он вообще. */
export interface SourceBucket extends Bucket {
  source: string;
  loaded: boolean;
}

/** Результат объединения. */
export interface CombinedSales {
  /** Итог по всем продажам обоих флотов. */
  totalOrders: number;
  totalRevenue: number;
  /** Разрезы. */
  bySource: SourceBucket[];
  byPayment: Bucket[];
  byMonth: Bucket[];
  /** Заказов с нечитаемой суммой — не вошли в оборот, но названы. */
  unreadable: number;
  page: number;
  size: number;
  /** Заказов всего (для листания). */
  count: number;
  /** Страница ленты, по времени убыванием. */
  orders: CombinedOrder[];
}

/** Сумма из строки источника. null — не число, выдумывать нельзя. */
function toNum(v: string): number | null {
  const s = v.replace(/[\s\u00A0\u202F]/g, "").replace(",", ".");
  if (s.length === 0 || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Тестовая отгрузка — не продажа: у gjvending это `Order type = testShipment`. */
function isTest(o: RawOrder): boolean {
  return o.kind.trim().toLowerCase() === "testshipment";
}

/** Прибавить заказ к разрезу по ключу. */
function add(map: Map<string, Bucket>, key: string, revenue: number): void {
  const b = map.get(key);
  if (b) {
    b.orders += 1;
    b.revenue += revenue;
  } else {
    map.set(key, { key, orders: 1, revenue });
  }
}

/**
 * Свести флоты в один журнал.
 *
 * Порядок ленты — время убыванием: свежая продажа сверху. Заказ без времени не
 * теряется, но уходит в конец: место в порядке ему определить нечем. Свод
 * считается по ВСЕМ продажам, страница нарезается уже после сортировки.
 */
export function combineSales(fleets: readonly Fleet[], page: number, size: number): CombinedSales {
  const orders: CombinedOrder[] = [];
  const bySourceMap = new Map<string, SourceBucket>();
  const byPayment = new Map<string, Bucket>();
  const byMonth = new Map<string, Bucket>();
  let totalOrders = 0;
  let totalRevenue = 0;
  let unreadable = 0;

  for (const f of fleets) {
    // Источник в своде показываем всегда — даже пустой или не загруженный:
    // «OurVend: нет данных» это факт, а не повод его спрятать.
    const sb: SourceBucket = bySourceMap.get(f.source) ?? {
      key: f.source,
      source: f.source,
      loaded: f.loaded,
      orders: 0,
      revenue: 0,
    };
    bySourceMap.set(f.source, sb);

    for (const o of f.orders) {
      if (isTest(o)) continue;
      const amountNum = toNum(o.amount);
      const revenue = amountNum ?? 0;
      if (o.amount.trim().length > 0 && amountNum === null) unreadable += 1;

      totalOrders += 1;
      totalRevenue += revenue;
      sb.orders += 1;
      sb.revenue += revenue;
      add(byPayment, o.payment.trim() || "—", revenue);
      const month = o.ts.slice(0, 7);
      if (month.length === 7) add(byMonth, month, revenue);

      orders.push({
        source: f.source,
        title: f.title,
        externalId: o.externalId,
        ts: o.ts,
        machine: o.machine,
        product: o.product,
        amount: o.amount,
        amountNum,
        payment: o.payment,
        status: o.status,
      });
    }
  }

  // Свежая продажа сверху; без времени — в конец (пустая строка меньше любой даты).
  orders.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));

  const p = Math.max(1, page);
  const s = Math.max(1, size);
  const pageOrders = orders.slice((p - 1) * s, (p - 1) * s + s);

  const bySource = [...bySourceMap.values()].sort((a, b) => b.revenue - a.revenue);
  const paymentList = [...byPayment.values()].sort((a, b) => b.revenue - a.revenue);
  const monthList = [...byMonth.values()].sort((a, b) => (a.key < b.key ? 1 : -1));

  return {
    totalOrders,
    totalRevenue,
    bySource,
    byPayment: paymentList,
    byMonth: monthList,
    unreadable,
    page: p,
    size: s,
    count: orders.length,
    orders: pageOrders,
  };
}
