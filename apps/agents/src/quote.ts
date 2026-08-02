/**
 * Денежная математика КП (перенос computeQuoteTotals из mydon-agent-os).
 *
 * Правило безопасности: итоги и НДС считает КОД, а не модель. Модель (когда
 * появится) отдаёт только позиции и цены ИЗ ПРАЙСА; всё арифметическое —
 * детерминированно и целочисленно, без «тихого» округления.
 *
 * Цены в прайсе — с НДС (12%), в целых сумах. НДС выделяем из суммы. USD — в
 * центах, чтобы не терять копейки на дроблении.
 */

export interface QuoteItem {
  /** Цена с НДС, целое число сум. */
  priceUzs: number;
  /** Количество, целое ≥ 0. */
  qty: number;
}

export interface QuoteTotals {
  /** Итог с НДС, целые сумы. */
  uzs: number;
  /** Сумма НДС (12%), целые сумы. */
  vatUzs: number;
  /** Итог в USD (из центов). */
  usd: number;
  /** Итог в центах USD — для точности. */
  usdCents: number;
}

/**
 * Считает итоги по позициям и курсу USD/UZS. Отрицательные qty обнуляются,
 * дробные цены/количества округляются на входе (в прайсе их быть не должно —
 * это подстраховка, а не разрешение на дробь).
 */
export function computeQuoteTotals(items: readonly QuoteItem[], usdUzs: number): QuoteTotals {
  let grossUzs = 0;
  for (const it of items) {
    grossUzs += Math.round(it.priceUzs) * Math.max(0, Math.round(it.qty));
  }
  const netUzs = Math.round(grossUzs / 1.12); // цены с НДС → выделяем НДС из суммы
  const vatUzs = grossUzs - netUzs;
  const usdCents = usdUzs > 0 ? Math.round((grossUzs * 100) / usdUzs) : 0;
  return { uzs: grossUzs, vatUzs, usd: usdCents / 100, usdCents };
}

/**
 * Проверяет позиции перед расчётом (без zod — правила простые). Возвращает
 * список проблем; пусто = позиции годны. Цена/количество должны быть целыми
 * неотрицательными: дробь в прайсе — сигнал ошибки, а не повод округлить молча.
 */
export function validateQuoteItems(items: readonly QuoteItem[]): string[] {
  const problems: string[] = [];
  if (items.length === 0) problems.push("нет позиций");
  items.forEach((it, i) => {
    if (!Number.isInteger(it.priceUzs) || it.priceUzs < 0) {
      problems.push(`позиция ${i + 1}: цена должна быть целым числом сум ≥ 0`);
    }
    if (!Number.isInteger(it.qty) || it.qty < 0) {
      problems.push(`позиция ${i + 1}: количество должно быть целым ≥ 0`);
    }
  });
  return problems;
}
