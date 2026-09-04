import { PART_KINDS, type PartKind } from "./maintenance";

/**
 * Состав автомата — шаблон узлов по виду автомата (спека vendhub-parts, R-PU-3).
 *
 * Слово владельца 04.09.2026: в кофейном аппарате 4 миксера, 1 гриндер,
 * 1 варка и ВСЕГДА 8 бункеров; фильтр воды — по нормативу «замена 45 дней».
 * Шаблон правится в панели (настройка PARTS_TEMPLATE_COFFEE, JSON), и любая
 * правка только ДОВОДИТ недостающие узлы — заведённые не удаляет.
 */
export interface PartsTemplateEntry {
  kind: PartKind;
  count: number;
}

export const DEFAULT_COFFEE_PARTS_TEMPLATE: readonly PartsTemplateEntry[] = [
  { kind: "mixer", count: 4 },
  { kind: "grinder", count: 1 },
  { kind: "brewer", count: 1 },
  { kind: "hopper", count: 8 },
  { kind: "water_filter", count: 1 },
];

/** Разбор JSON настройки; неверный формат → null (вызывающий берёт дефолт и пишет в лог). */
export function parsePartsTemplate(raw: string | null | undefined): PartsTemplateEntry[] | null {
  if (!raw || raw.trim() === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) return null;
  const out: PartsTemplateEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const kind = (item as { kind?: unknown }).kind;
    const count = (item as { count?: unknown }).count;
    if (typeof kind !== "string" || !(PART_KINDS as readonly string[]).includes(kind)) return null;
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || count > 32) return null;
    if (out.some((o) => o.kind === kind)) return null;
    out.push({ kind: kind as PartKind, count });
  }
  return out;
}

/** Проверка значения настройки для панели: null — ок, строка — текст ошибки. */
export function validatePartsTemplate(raw: string): string | null {
  if (raw.trim() === "") return null;
  return parsePartsTemplate(raw)
    ? null
    : 'нужен JSON вида [{"kind":"mixer","count":4},…]; kind — вид узла из справочника, count — 0…32, без повторов';
}

export interface PartSlotKey {
  kind: PartKind;
  slot: number | null;
}

/**
 * Каких узлов не хватает автомату по шаблону.
 *
 * Идемпотентно по (вид, слот): узел вида с count > 1 живёт в слотах 1…count,
 * единичный — без слота. Существующий узел без слота у многослотового вида
 * (история до нумерации слотов) занимает «одно место», но не конкретный слот:
 * недостающих = count − сколько есть, а слоты выдаются те, что не заняты.
 */
export function planMissingParts(
  template: readonly PartsTemplateEntry[],
  existing: readonly PartSlotKey[],
): PartSlotKey[] {
  const missing: PartSlotKey[] = [];
  for (const entry of template) {
    if (entry.count <= 0) continue;
    const have = existing.filter((e) => e.kind === entry.kind);
    if (entry.count === 1) {
      if (have.length === 0) missing.push({ kind: entry.kind, slot: null });
      continue;
    }
    const need = entry.count - have.length;
    if (need <= 0) continue;
    const takenSlots = new Set(have.map((e) => e.slot).filter((s): s is number => s !== null));
    let added = 0;
    for (let slot = 1; slot <= entry.count && added < need; slot++) {
      if (takenSlots.has(slot)) continue;
      missing.push({ kind: entry.kind, slot });
      added += 1;
    }
  }
  return missing;
}

/** Сколько узлов даёт шаблон целиком (для приёмки: очередь после заведения = N × автоматов). */
export function templateSize(template: readonly PartsTemplateEntry[]): number {
  return template.reduce((n, e) => n + Math.max(0, e.count), 0);
}
