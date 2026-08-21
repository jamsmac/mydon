/**
 * Номиналы сума в обороте вендинговых автоматов и сверка набора купюр
 * инкассации (касса → изъято оператором → пересчитано по купюрам → банк).
 */

/** Номиналы сума в обороте автоматов. Все 266 живых инкассаций кратны 1000. */
export const DENOMINATIONS = [200000, 100000, 50000, 20000, 10000, 5000, 2000, 1000] as const;

export type Denomination = (typeof DENOMINATIONS)[number];

/** Сколько купюр каждого номинала. Отсутствующий номинал = ноль купюр. */
export type DenominationCounts = Partial<Record<`${Denomination}`, number>>;

/** Сумма набора: количество купюр каждого номинала умножается на номинал. */
export function denominationsTotal(counts: DenominationCounts): number {
  return DENOMINATIONS.reduce((sum, denom) => sum + denom * (counts[`${denom}`] ?? 0), 0);
}

/**
 * Разбор набора купюр из формы: строки → числа, мусор отбрасывается,
 * отрицательные и дробные количества купюр — ошибка, незнакомый номинал —
 * тоже ошибка (в обороте автоматов только номиналы из DENOMINATIONS).
 */
export function parseDenominations(
  raw: Record<string, unknown>,
): { counts: DenominationCounts; total: number } | { error: string } {
  const counts: DenominationCounts = {};

  for (const [key, value] of Object.entries(raw)) {
    const denom = Number(key);
    if (!(DENOMINATIONS as readonly number[]).includes(denom)) {
      return { error: `Номинал ${key} сум не в обороте автоматов` };
    }
    const denomKey = String(denom) as `${Denomination}`;

    const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value);
    if (text.length === 0) continue; // пустое поле формы — ноль купюр, а не ошибка

    const count = Number(text);
    if (!Number.isFinite(count)) continue; // мусор отбрасывается, а не ошибка

    if (count < 0) {
      return { error: `Отрицательное количество купюр номиналом ${denomKey}: "${text}"` };
    }
    if (!Number.isInteger(count)) {
      return { error: `Дробное количество купюр номиналом ${denomKey}: "${text}"` };
    }

    counts[denomKey] = count;
  }

  return { counts, total: denominationsTotal(counts) };
}
