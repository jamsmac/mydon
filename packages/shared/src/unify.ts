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

/** Ключ заказа для сопоставления: пустой сводить не с чем. */
function keyOf(row: ReconRow): string {
  return normalizeSourceKey(row.key);
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
): UnifiedJournal {
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
  };
}
