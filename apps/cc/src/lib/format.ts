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

/** Слово в правильном числе: 1 автомат, 2 автомата, 5 автоматов. */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
