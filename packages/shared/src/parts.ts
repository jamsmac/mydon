import { PART_KINDS, type PartKind } from "./maintenance";

/**
 * Инвентарные номера узлов (спека 2026-09-04-vendhub-parts-inventory, R-PU-2).
 *
 * Номер — наклейка на детали. Серия задаётся видом узла: `M-001` миксер,
 * `G-001` гриндер, `B-001` варочная группа, `F-001` фильтр воды; бункер —
 * `H-<набор>-<позиция>`, потому что физический контейнер и так живёт в
 * матрице тары «набор × позиция» (coffee_container_tare), а два номера у
 * одной детали — это два номера, которые разойдутся. Система присваивает
 * номер при заведении (слово владельца 04.09.2026), сотрудник наклеивает и
 * подтверждает — или исправляет на тот, что уже есть на детали.
 */
export const INVENTORY_SERIES: Record<PartKind, string> = {
  mixer: "M",
  grinder: "G",
  brewer: "B",
  hopper: "H",
  water_filter: "F",
  boiler: "BL",
  pump: "P",
  bill_acceptor: "BA",
  coin_acceptor: "CA",
  cooling_unit: "CU",
  compressor: "CP",
  payment_terminal: "PT",
  display: "D",
  mainboard: "MB",
  motor: "MT",
  valve: "V",
  sensor: "S",
  lock: "L",
  spiral: "SP",
  elevator: "E",
  other: "X",
};

/** Ширина числа в серии: `M-001`…`M-999`, дальше — `M-1000`. */
const SERIES_WIDTH = 3;

/**
 * Нормализация номера для сравнения и хранения: без пробелов, в верхнем
 * регистре. Пустая строка → null. Тот же вид, что у уникального индекса
 * `part_unit_inventory_no_key` (upper + удаление пробелов), чтобы «m-001» и
 * «M-001 » не стали двумя наклейками.
 */
export function normalizeInventoryNo(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.replace(/\s+/g, "").toUpperCase();
  return value.length > 0 ? value : null;
}

/** Допустимый вид номера: латиница/цифры/дефис, 2–32 символа, начинается с буквы или цифры. */
export const INVENTORY_NO_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,31}$/;

export function isValidInventoryNo(raw: string): boolean {
  const norm = normalizeInventoryNo(raw);
  return norm !== null && INVENTORY_NO_PATTERN.test(norm);
}

/** Номер по серии вида: `M-017`. Для бункера с известным набором — `H-27-3`. */
export function formatInventoryNo(
  kind: PartKind,
  n: number,
  hopper?: { setNumber: number; position: number },
): string {
  if (kind === "hopper" && hopper) return `H-${hopper.setNumber}-${hopper.position}`;
  return `${INVENTORY_SERIES[kind]}-${String(n).padStart(SERIES_WIDTH, "0")}`;
}

/** Порядковый номер в серии вида, если номер серийный (`M-017` → 17); иначе null. */
export function seriesNumberOf(kind: PartKind, inventoryNo: string): number | null {
  const norm = normalizeInventoryNo(inventoryNo);
  if (!norm) return null;
  const prefix = INVENTORY_SERIES[kind];
  const match = new RegExp(`^${prefix}-(\\d{1,6})$`).exec(norm);
  return match ? Number(match[1]) : null;
}

/**
 * Следующий свободный номер серии: максимум занятых + 1 (дыры не
 * переиспользуем — снятая наклейка могла остаться на списанной детали).
 * Бункерная серия `H-<набор>-<позиция>` сюда не попадает: у неё номер задаёт
 * набор, а не счётчик.
 */
export function suggestInventoryNo(kind: PartKind, taken: readonly string[]): string {
  let max = 0;
  for (const t of taken) {
    const n = seriesNumberOf(kind, t);
    if (n !== null && n > max) max = n;
  }
  return formatInventoryNo(kind, max + 1);
}

/** Что мешает узлу считаться учтённым — для очереди «Наклеить номер» и бейджей. */
export type PartAttention = "no_number" | "label_pending" | "unknown_location" | "no_tare" | "no_photo";

export const PART_ATTENTION_LABELS: Record<PartAttention, string> = {
  no_number: "без номера",
  label_pending: "наклеить номер",
  unknown_location: "местонахождение неизвестно",
  no_tare: "без тары",
  no_photo: "без фото",
};

export function partAttentionLabel(a: string): string {
  return PART_ATTENTION_LABELS[a as PartAttention] ?? a;
}

/** Виды узлов, у которых номер — серийный счётчик (все, кроме бункера с набором). */
export function isCounterSeries(kind: PartKind): boolean {
  return PART_KINDS.includes(kind) && kind !== "hopper";
}
