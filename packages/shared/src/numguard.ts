/**
 * Строгий разбор чисел из чужих источников.
 *
 * `Number(x) || 0` — тихий враг финансов: пустая строка, «н/д» или мусор
 * превращаются в 0 и уходят в базу как настоящий ноль. Сумма продаж занижается,
 * и никто не знает. Здесь непарсимое — это `null`, а вызывающий решает: в
 * карантин, а не в упсерт.
 */
export function strictNumber(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    const s = v.trim();
    if (s.length === 0) return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
