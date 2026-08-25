import { TZ } from "@mydon/shared";

/** Дата и время по-ташкентски: панель и бот должны показывать одно и то же. */
export function when(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    timeZone: TZ,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Сумма с разделителями разрядов. Валюта проекта — сум. */
export function money(amount: string | number, currency = "UZS"): string {
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return String(amount);
  return `${n.toLocaleString("ru-RU")} ${currency === "UZS" ? "сум" : currency}`;
}

/**
 * Сумма по валютам: складывать разные валюты в одно число нельзя (UZS и USD —
 * не одна цифра). Группируем по валюте и показываем каждую отдельно
 * («1 500 000 сум · 2 000 USD»). Пустой список — «0 сум».
 */
export function moneyByCurrency(rows: readonly { amount: string | number; currency: string }[]): string {
  const byCur = new Map<string, number>();
  for (const r of rows) {
    const n = typeof r.amount === "string" ? Number(r.amount) : r.amount;
    if (!Number.isFinite(n)) continue;
    byCur.set(r.currency, (byCur.get(r.currency) ?? 0) + n);
  }
  if (byCur.size === 0) return money(0);
  // Сначала сум (основная валюта), потом прочие по алфавиту — порядок стабилен.
  return [...byCur.entries()]
    .sort((a, b) => (a[0] === "UZS" ? -1 : b[0] === "UZS" ? 1 : a[0].localeCompare(b[0])))
    .map(([currency, amount]) => money(amount, currency))
    .join(" · ");
}

/** Есть ли ненулевая сумма хоть в одной валюте — для подсветки плитки. */
export function hasMoney(rows: readonly { amount: string | number }[]): boolean {
  return rows.some((r) => {
    const n = typeof r.amount === "string" ? Number(r.amount) : r.amount;
    return Number.isFinite(n) && n !== 0;
  });
}

/**
 * Число с разделителями разрядов и БЕЗ неразрывного пробела.
 *
 * `toLocaleString("ru-RU")` разделяет тройки разрядов U+00A0, и скопированная
 * из панели сумма молча не находится ни поиском по странице, ни в боте (тот же
 * баг чинит `formatAmount` в apps/core/src/rules/rules.ts и `n` в
 * shrinkage-view.tsx). Листы отчётов П5b показывают числа, которые владелец
 * копирует и сверяет, поэтому пробел здесь обычный.
 */
export function count(v: number): string {
  return v.toLocaleString("ru-RU").replace(/\u00a0/g, " ");
}

/** Сумма («12 300 сум») тем же правилом, что `count`: без U+00A0. */
export function amount(v: number): string {
  return money(v).replace(/\u00a0/g, " ");
}

/**
 * Процент с одним знаком: «27,6 %». `null` — «—», а не «0 %»: у процента с
 * нулевой базой нет значения, и ноль читался бы как посчитанный результат.
 * Минус — типографский (U+2212), как в остальных числах панели.
 */
export function percent(v: number | null): string {
  return v === null ? "—" : `${v.toFixed(1).replace("-", "\u2212").replace(".", ",")} %`;
}

/** Голые сутки `YYYY-MM-DD` → «25.08.2026»: отчёт живёт неделями, год не лишний. */
export function day(iso: string): string {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}.${m}.${y}` : iso;
}

/** Месяц `YYYY-MM` → «08.2026». */
export function month(iso: string): string {
  const [y, m] = iso.split("-");
  return y && m ? `${m}.${y}` : iso;
}

/** Слово в правильном числе: 1 автомат, 2 автомата, 5 автоматов. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
