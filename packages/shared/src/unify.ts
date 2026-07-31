/**
 * Объединённый журнал продаж: два источника — один список заказов.
 *
 * Сверка (reconcile.ts) отвечает на вопрос «где источники расходятся». Это её
 * продолжение и то, ради чего она была нужна: свести gjvending и vendinghub в
 * ОДИН журнал, где каждый заказ лежит РОВНО ОДИН РАЗ. Пока источники раздельны,
 * один и тот же заказ считается дважды — сложить их выручку значит задвоить её.
 * Объединение по номеру операции убирает задвоение: сколько уникальных заказов,
 * столько и продаж на деле.
 *
 * Что объединение НЕ делает — не выбирает победителя. Где источники согласны,
 * показано одно значение с пометкой «подтверждают оба». Где разошлись —
 * показаны ОБА, и заказ помечен спорным. Какое из двух верное, решает владелец,
 * а не объединение: правило слоя цело, мы сводим, но не судим.
 */

import { normalizeSourceKey } from "./sources";
import { valuesAgree, type CompareAs, type ReconField, type ReconRow } from "./reconcile";

/** Где встретился заказ: в обоих источниках, только в A или только в B. */
export type Presence = "both" | "onlyA" | "onlyB";

/** Одно поле объединённого заказа: значения обеих сторон и их согласие. */
export interface UnifiedField {
  role: string;
  label: string;
  compare: CompareAs;
  /** Значение источника A как в источнике; null — у A этого заказа/поля нет. */
  a: string | null;
  b: string | null;
  /** true — сошлись, false — разошлись, null — сравнивать не с чем (одна сторона). */
  agree: boolean | null;
}

/** Один заказ объединённого журнала. */
export interface UnifiedOrder {
  /** Номер операции как в источнике. */
  key: string;
  presence: Presence;
  /** Хоть одно поле разошлось — заказ спорный, значение выбирает владелец. */
  conflict: boolean;
  /** Номер задвоен внутри своего источника — факт источника, не ошибка сводки. */
  duplicated: boolean;
  fields: UnifiedField[];
}

/** Результат объединения: свод и страница заказов. */
export interface UnifiedJournal {
  totalA: number;
  totalB: number;
  /** Уникальных заказов после объединения — столько продаж без задвоения. */
  union: number;
  /** Подтверждены обоими источниками. */
  both: number;
  /** Только в A / только в B. */
  onlyA: number;
  onlyB: number;
  /** Из подтверждённых обоими — спорных (хоть одно поле разошлось). */
  conflicts: number;
  /** Задвоенных номеров (в любом из источников). */
  duplicated: number;
  page: number;
  size: number;
  /** Заказы текущей страницы. */
  orders: UnifiedOrder[];
}

/**
 * Дневная корзина союза: заказы, свёрнутые до «день + автомат + товар».
 *
 * Нужна ради OurVend. Он не отдаёт ни номера заказа, ни времени внутри дня —
 * только дневные итоги. Сверить его построчно нельзя, а по дню — можно, если
 * свернуть союз до того же зерна. Это НЕ добавка к выручке: OurVend показывает
 * те же продажи третьим взглядом, и сложить его с союзом значило бы задвоить.
 */
export interface DailyBucket {
  day: string;
  /** Написание источника (первое встреченное) — владельцу показываем его. */
  serial: string;
  product: string;
  orders: number;
  revenue: number;
  /** В корзине есть заказы со спорной суммой — дневная цифра предварительна. */
  hasConflict: boolean;
}

/** Дневная строка OurVend как есть из `sale`: вход для сверки. */
export interface OurVendBucket {
  day: string;
  serial: string;
  product: string;
  revenue: number;
  /** Штук по данным OurVend (qty). */
  orders: number;
  /** Как источник называет себя (sale.source). */
  source: string;
}

/** Пример дневной корзины — для показа расхождений и односторонних. */
export interface BucketSample {
  day: string;
  serial: string;
  product: string;
  revenue: number;
  orders: number;
}

/** Расхождение дневной выручки: союз против OurVend по одной корзине. */
export interface OurVendConflict {
  day: string;
  serial: string;
  product: string;
  unionOrders: number;
  unionRevenue: number;
  ourvendRevenue: number;
  /** Корзина союза содержит спорные суммы — сама цифра союза предварительна. */
  provisional: boolean;
}

/**
 * Дневная сверка союза с OurVend.
 *
 * Третий источник — дневной, поэтому и сверка дневная, и так и написано.
 * Ни выручку союза, ни его число заказов OurVend не меняет: это отдельная
 * дорожка «сходится ли третий взгляд», а не слагаемое.
 */
export interface OurVendRecon {
  /** Как OurVend называет себя. null — за диапазон союза данных нет. */
  source: string | null;
  /** Есть ли вообще строки OurVend за диапазон (иначе сверять не с чем). */
  synced: boolean;
  fromDay: string | null;
  toDay: string | null;
  /** Дневных корзин, сошедшихся у обоих (день + автомат + товар). */
  matched: number;
  /** Из сошедшихся — где дневная выручка совпала (округлённо). */
  agree: number;
  differ: number;
  /** Корзин только у союза / только у OurVend. */
  onlyUnion: number;
  onlyOurVend: number;
  /** Итог выручки по пересечению — обе стороны, для честной сводки. */
  unionRevenue: number;
  ourvendRevenue: number;
  conflicts: OurVendConflict[];
  onlyUnionSamples: BucketSample[];
  onlyOurVendSamples: BucketSample[];
}

/** Сколько примеров расхождений показываем: длинный хвост владельцу не нужен. */
const MAX_SAMPLES = 200;

/** Ключ заказа для сопоставления: пустой сводить не с чем. */
function keyOf(row: ReconRow): string {
  return normalizeSourceKey(row.key);
}

/** Число из значения источника (те же правила, что в reconcile). */
function toNum(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const s = v.replace(/[\s\u00A0\u202F]/g, "").replace(",", ".");
  if (s.length === 0 || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Значение поля заказа: сторона A, иначе B (A — панель, ближе к истоку). */
function fieldValue(order: UnifiedOrder, role: string): string | null {
  const f = order.fields.find((x) => x.role === role);
  if (!f) return null;
  return f.a ?? f.b;
}

/** Ключ дневной корзины: день + нормализованные автомат и товар. */
function dayKey(day: string, serial: string, product: string): string {
  return `${day}\u0000${normalizeSourceKey(serial)}\u0000${normalizeSourceKey(product)}`;
}

/**
 * Свернуть заказы союза до дневных корзин «день + автомат + товар».
 *
 * Тестовые отгрузки не в счёт — как и в вёдрах цен: это не продажа. Заказ без
 * дня (нет времени) поставить в дневную корзину нельзя, он выпадает из дневной
 * сверки, но из союза не исчезает.
 */
export function dailyBuckets(orders: readonly UnifiedOrder[]): DailyBucket[] {
  const map = new Map<string, DailyBucket>();
  for (const o of orders) {
    const kind = fieldValue(o, "kind");
    if (kind !== null && kind.trim().toLowerCase() === "testshipment") continue;
    const ts = fieldValue(o, "ts");
    if (ts === null) continue;
    const day = ts.slice(0, 10);
    if (day.length < 10) continue;
    const serial = fieldValue(o, "machine") ?? "";
    const product = fieldValue(o, "product") ?? "";
    if (serial.trim().length === 0 || product.trim().length === 0) continue;
    const amountField = o.fields.find((x) => x.role === "amount");
    const amount = amountField ? toNum(amountField.a ?? amountField.b) : null;
    const amountConflict = amountField ? amountField.agree === false : false;
    const key = dayKey(day, serial, product);
    const b = map.get(key);
    if (b) {
      b.orders += 1;
      b.revenue += amount ?? 0;
      b.hasConflict = b.hasConflict || amountConflict;
    } else {
      map.set(key, { day, serial, product, orders: 1, revenue: amount ?? 0, hasConflict: amountConflict });
    }
  }
  return [...map.values()];
}

/**
 * Сверить дневные корзины союза с дневными строками OurVend.
 *
 * Сравнение по выручке, округлённо: у OurVend нет заказов внутри дня, и штуки с
 * числом заказов союза сходятся не всегда, а деньги — величина, которую обе
 * стороны считают одинаково. Ни одно значение не объявлено верным: где выручка
 * разошлась, показаны обе.
 */
export function reconcileOurVend(
  union: readonly DailyBucket[],
  ourvend: readonly OurVendBucket[],
): OurVendRecon {
  const u = new Map<string, DailyBucket>();
  for (const b of union) u.set(dayKey(b.day, b.serial, b.product), b);

  const o = new Map<string, { day: string; serial: string; product: string; revenue: number; orders: number }>();
  let source: string | null = null;
  for (const b of ourvend) {
    if (source === null && b.source.length > 0) source = b.source;
    const k = dayKey(b.day, b.serial, b.product);
    const cur = o.get(k);
    if (cur) {
      cur.revenue += b.revenue;
      cur.orders += b.orders;
    } else {
      o.set(k, { day: b.day, serial: b.serial, product: b.product, revenue: b.revenue, orders: b.orders });
    }
  }

  let matched = 0;
  let agree = 0;
  let differ = 0;
  let onlyUnion = 0;
  let onlyOurVend = 0;
  let unionRevenue = 0;
  let ourvendRevenue = 0;
  const conflicts: OurVendConflict[] = [];
  const onlyUnionSamples: BucketSample[] = [];
  const onlyOurVendSamples: BucketSample[] = [];

  for (const [k, ub] of u) {
    const ob = o.get(k);
    if (!ob) {
      onlyUnion += 1;
      onlyUnionSamples.push({ day: ub.day, serial: ub.serial, product: ub.product, revenue: ub.revenue, orders: ub.orders });
      continue;
    }
    matched += 1;
    unionRevenue += ub.revenue;
    ourvendRevenue += ob.revenue;
    if (Math.round(ub.revenue) === Math.round(ob.revenue)) agree += 1;
    else {
      differ += 1;
      conflicts.push({
        day: ub.day,
        serial: ub.serial,
        product: ub.product,
        unionOrders: ub.orders,
        unionRevenue: ub.revenue,
        ourvendRevenue: ob.revenue,
        provisional: ub.hasConflict,
      });
    }
  }
  for (const [k, ob] of o) {
    if (u.has(k)) continue;
    onlyOurVend += 1;
    onlyOurVendSamples.push({ day: ob.day, serial: ob.serial, product: ob.product, revenue: ob.revenue, orders: ob.orders });
  }

  // Самые крупные расхождения — вперёд: мелочь в хвосте владельцу не нужна.
  conflicts.sort((a, b) => Math.abs(b.unionRevenue - b.ourvendRevenue) - Math.abs(a.unionRevenue - a.ourvendRevenue));
  onlyUnionSamples.sort((a, b) => b.revenue - a.revenue);
  onlyOurVendSamples.sort((a, b) => b.revenue - a.revenue);

  const days = union.map((b) => b.day).sort();
  return {
    source,
    synced: ourvend.length > 0,
    fromDay: days[0] ?? null,
    toDay: days[days.length - 1] ?? null,
    matched,
    agree,
    differ,
    onlyUnion,
    onlyOurVend,
    unionRevenue,
    ourvendRevenue,
    conflicts: conflicts.slice(0, MAX_SAMPLES),
    onlyUnionSamples: onlyUnionSamples.slice(0, MAX_SAMPLES),
    onlyOurVendSamples: onlyOurVendSamples.slice(0, MAX_SAMPLES),
  };
}

/** Первое вхождение каждого ключа + отметка задвоенных. */
function index(rows: readonly ReconRow[]): {
  first: Map<string, ReconRow>;
  dup: Set<string>;
} {
  const first = new Map<string, ReconRow>();
  const seen = new Map<string, number>();
  const dup = new Set<string>();
  for (const row of rows) {
    const k = keyOf(row);
    if (k.length === 0) continue;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n === 1) first.set(k, row);
    else dup.add(k);
  }
  return { first, dup };
}

/**
 * Порядок заказов: сначала то, что требует владельца.
 *
 * Спорные — выше всех: там надо выбрать значение. Затем односторонние: их
 * подтвердил лишь один источник. Согласованные — ниже, они и так в порядке.
 * Внутри группы — по номеру: числовой убыванием (свежие заказы — крупнее),
 * нечисловой по строке, чтобы порядок был устойчив для листания.
 */
function rank(o: UnifiedOrder): number {
  if (o.conflict) return 0;
  if (o.presence !== "both") return 1;
  return 2;
}

function byKeyDesc(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  const aNum = a.trim() !== "" && Number.isFinite(na);
  const bNum = b.trim() !== "" && Number.isFinite(nb);
  if (aNum && bNum) return nb - na;
  if (aNum) return -1;
  if (bNum) return 1;
  return b.localeCompare(a);
}

/** Собрать поля одного заказа из значений обеих сторон. */
function fieldsOf(
  fields: readonly ReconField[],
  rowA: ReconRow | undefined,
  rowB: ReconRow | undefined,
): { fields: UnifiedField[]; conflict: boolean } {
  const out: UnifiedField[] = [];
  let conflict = false;
  for (const f of fields) {
    const rawA = rowA?.values[f.role];
    const rawB = rowB?.values[f.role];
    const a = rawA !== undefined && rawA !== "" ? rawA : null;
    const b = rawB !== undefined && rawB !== "" ? rawB : null;
    // Поля, которого нет ни у одной стороны, в журнале не показываем: пустая
    // строка «—/—» ничего владельцу не сообщает.
    if (a === null && b === null) continue;
    let agree: boolean | null = null;
    if (a !== null && b !== null) {
      agree = valuesAgree(a, b, f.compare);
      if (!agree) conflict = true;
    }
    out.push({ role: f.role, label: f.label, compare: f.compare, a, b, agree });
  }
  return { fields: out, conflict };
}

/**
 * Объединить два источника в один журнал по номеру операции.
 *
 * Источник A задаёт порядок полей, но не истину: где значения расходятся,
 * показаны оба, и заказ помечен спорным. Страница нарезается уже после
 * упорядочивания, а свод (union, both, conflicts) считается по всему множеству.
 */
export function unify(
  a: readonly ReconRow[],
  b: readonly ReconRow[],
  fields: readonly ReconField[],
  page: number,
  size: number,
): UnifiedJournal & { daily: DailyBucket[] } {
  const ia = index(a);
  const ib = index(b);

  const keys = new Set<string>([...ia.first.keys(), ...ib.first.keys()]);
  const orders: UnifiedOrder[] = [];
  let both = 0;
  let onlyA = 0;
  let onlyB = 0;
  let conflicts = 0;
  let duplicated = 0;

  for (const k of keys) {
    const rowA = ia.first.get(k);
    const rowB = ib.first.get(k);
    const presence: Presence = rowA && rowB ? "both" : rowA ? "onlyA" : "onlyB";
    if (presence === "both") both += 1;
    else if (presence === "onlyA") onlyA += 1;
    else onlyB += 1;

    const dup = ia.dup.has(k) || ib.dup.has(k);
    if (dup) duplicated += 1;

    const built = fieldsOf(fields, rowA, rowB);
    if (built.conflict) conflicts += 1;

    // Номер владельцу показываем как в источнике — берём у той стороны, что есть.
    const shownKey = (rowA ?? rowB)!.key;
    orders.push({
      key: shownKey,
      presence,
      conflict: built.conflict,
      duplicated: dup,
      fields: built.fields,
    });
  }

  orders.sort((x, y) => rank(x) - rank(y) || byKeyDesc(x.key, y.key));

  // Дневные корзины считаются по ВСЕМ заказам союза, до нарезки на страницы:
  // OurVend сверяется с итогом за день, а не с тем, что попало на экран.
  const daily = dailyBuckets(orders);

  // Страницы считаются от единицы — как normalizeRowsQuery во всём сыром слое.
  const p = Math.max(1, page);
  const s = Math.max(1, size);
  const pageOrders = orders.slice((p - 1) * s, (p - 1) * s + s);

  return {
    totalA: a.length,
    totalB: b.length,
    union: keys.size,
    both,
    onlyA,
    onlyB,
    conflicts,
    duplicated,
    page,
    size,
    orders: pageOrders,
    daily,
  };
}
