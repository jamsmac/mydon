/**
 * Построчная сверка двух источников по ключу операции.
 *
 * gjvending и vendinghub показывают ОДНИ И ТЕ ЖЕ заказы: `Order number` панели
 * и `orderNo` кабинета — это один и тот же номер. Значит их можно сверить не
 * дневными итогами, как OurVend (у него нет времени внутри дня), а построчно:
 * каждый заказ против своего двойника.
 *
 * Зачем это нужно. Пока источники показываются раздельно, спорную цифру не с
 * чем сверить, кроме как глазами. Построчная сверка отвечает на конкретные
 * вопросы: где сумма разошлась, что есть у одного и нет у другого, не задвоил
 * ли кто заказ. Это прямой предшественник объединённого журнала: сводить
 * источники можно только после того, как видно, где они не сходятся.
 *
 * Правило слоя соблюдено: сверка НИЧЕГО не пишет и не правит. Она сравнивает и
 * докладывает. Что делать с расхождением — решает владелец.
 */

import { normalizeSourceKey } from "./sources";

/** Как сравнивать значение поля. */
export type CompareAs =
  /** Как число: «15000», «15000.00» и «15 000.00» — одно и то же. */
  | "number"
  /** Как ключ источника: регистр и пробелы не в счёт (название, серийник). */
  | "key"
  /** Точно, посимвольно: код оплаты (cash и cash0 — разное), номер заказа. */
  | "exact";

/** Поле, участвующее в сверке. */
export interface ReconField {
  /** Роль — как её знают оба источника (machine, product, amount…). */
  role: string;
  /** Как читать владельцу. */
  label: string;
  compare: CompareAs;
}

/** Одна операция источника: ключ и сравниваемые значения по ролям. */
export interface ReconRow {
  /** Значение externalId как в источнике — владельцу показываем его. */
  key: string;
  values: Record<string, string>;
}

/** Расхождение по одному полю одной операции. */
export interface FieldDiff {
  role: string;
  label: string;
  a: string;
  b: string;
}

/** Пара сошедшихся операций и их расхождения (пусто — сошлись полностью). */
export interface MatchedPair {
  key: string;
  diffs: FieldDiff[];
}

/** Итог сверки поля по всем сошедшимся операциям. */
export interface FieldSummary {
  role: string;
  label: string;
  /** Сошлось у обоих. */
  agree: number;
  /** Разошлось. */
  differ: number;
  /** Не с чем сравнить: поля нет у одного из источников в этой операции. */
  absent: number;
}

/** Операция, встретившаяся в источнике больше одного раза. */
export interface Duplicate {
  key: string;
  count: number;
}

/** Результат построчной сверки. */
export interface Reconciliation {
  totalA: number;
  totalB: number;
  /** Уникальных ключей, сошедшихся в обоих. */
  matched: number;
  /** Из сошедшихся — те, где хоть одно поле разошлось. */
  conflicts: MatchedPair[];
  /** Ключи, что есть только у A / только у B (с примерами). */
  onlyA: string[];
  onlyB: string[];
  onlyACount: number;
  onlyBCount: number;
  /** Задвоенные ключи внутри каждого источника — это факт, а не повод молча схлопнуть. */
  duplicatesA: Duplicate[];
  duplicatesB: Duplicate[];
  /** Свод по каждому полю. */
  fields: FieldSummary[];
}

/** Сколько расхождений и примеров показываем: длинный хвост владельцу не нужен. */
const MAX_SAMPLES = 200;

/** Равны ли два значения по правилу сравнения роли. */
export function valuesAgree(a: string, b: string, compare: CompareAs): boolean {
  switch (compare) {
    case "number": {
      const na = toNumber(a);
      const nb = toNumber(b);
      // Оба числа — сравниваем числами. Хоть одно не число — только точным
      // совпадением: приводить нечитаемое к нулю значило бы выдумать равенство.
      if (na !== null && nb !== null) return na === nb;
      return a.trim() === b.trim();
    }
    case "key":
      return normalizeSourceKey(a) === normalizeSourceKey(b);
    case "exact":
      return a.trim() === b.trim();
  }
}

/** Число из значения источника. null — не число, и выдумывать его нельзя. */
function toNumber(v: string): number | null {
  // Неразрывные пробелы записаны кодами: в исходнике не отличить от обычных.
  const s = v.replace(/[\s\u00A0\u202F]/g, "").replace(",", ".");
  if (s.length === 0 || !/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Ключ операции для сопоставления: пустой ключ сверять не с чем. */
function keyOf(row: ReconRow): string {
  return normalizeSourceKey(row.key);
}

/**
 * Сверить два источника построчно.
 *
 * Источник A — эталон порядка вопросов, но не истины: расхождение показывает
 * ОБА значения, не объявляя одно верным. Кто прав, решает владелец, а не сверка.
 */
export function reconcile(
  a: readonly ReconRow[],
  b: readonly ReconRow[],
  fields: readonly ReconField[],
): Reconciliation {
  const indexA = indexByKey(a);
  const indexB = indexByKey(b);

  const conflicts: MatchedPair[] = [];
  const onlyA: string[] = [];
  const onlyB: string[] = [];
  let onlyACount = 0;
  let onlyBCount = 0;
  let matched = 0;

  const summary = new Map<string, FieldSummary>();
  for (const f of fields) summary.set(f.role, { role: f.role, label: f.label, agree: 0, differ: 0, absent: 0 });

  for (const [key, rowsA] of indexA.map) {
    const rowsB = indexB.map.get(key);
    if (!rowsB) {
      onlyACount += 1;
      if (onlyA.length < MAX_SAMPLES) onlyA.push(rowsA[0].key);
      continue;
    }
    matched += 1;
    // Задвоенные ключи сверяем по первому вхождению каждой стороны: сам факт
    // задвоения показан отдельно (duplicatesA/B), сглаживать его сравнением
    // «первый с первым» нельзя, но и множить пары незачем — это одна операция.
    const rowA = rowsA[0];
    const rowB = rowsB[0];
    const diffs: FieldDiff[] = [];
    for (const f of fields) {
      const va = rowA.values[f.role];
      const vb = rowB.values[f.role];
      const s = summary.get(f.role)!;
      // Поле есть не у всякого источника: сверять «пусто против значения» как
      // расхождение неверно — это «не с чем сравнить», отдельное состояние.
      if (va === undefined || vb === undefined || (va === "" && vb === "")) {
        s.absent += 1;
        continue;
      }
      if (valuesAgree(va, vb, f.compare)) s.agree += 1;
      else {
        s.differ += 1;
        diffs.push({ role: f.role, label: f.label, a: va, b: vb });
      }
    }
    if (diffs.length > 0 && conflicts.length < MAX_SAMPLES) conflicts.push({ key: rowA.key, diffs });
  }

  for (const [key, rowsB] of indexB.map) {
    if (indexA.map.has(key)) continue;
    onlyBCount += 1;
    if (onlyB.length < MAX_SAMPLES) onlyB.push(rowsB[0].key);
  }

  return {
    totalA: a.length,
    totalB: b.length,
    matched,
    conflicts,
    onlyA,
    onlyB,
    onlyACount,
    onlyBCount,
    duplicatesA: indexA.duplicates,
    duplicatesB: indexB.duplicates,
    fields: [...summary.values()],
  };
}

/** Сгруппировать операции по ключу и заодно собрать задвоенные. */
function indexByKey(rows: readonly ReconRow[]): {
  map: Map<string, ReconRow[]>;
  duplicates: Duplicate[];
} {
  const map = new Map<string, ReconRow[]>();
  for (const row of rows) {
    const k = keyOf(row);
    if (k.length === 0) continue;
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  const duplicates: Duplicate[] = [];
  for (const [, list] of map) {
    if (list.length > 1 && duplicates.length < MAX_SAMPLES) {
      duplicates.push({ key: list[0].key, count: list.length });
    }
  }
  return { map, duplicates };
}
