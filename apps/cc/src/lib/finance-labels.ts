/** Подписи финансового контура — по-русски, в одном месте (сервер и клиент). */

export const CATEGORY_LABELS: Record<string, string> = {
  sale: "продажа техники",
  service: "сервис и запчасти",
  supplier: "оплата поставщику",
  logistics: "логистика",
  customs: "таможня",
  certification: "сертификация",
  tax: "налоги",
  rent: "аренда",
  other: "прочее",
};

export const categoryLabel = (c: string | null): string | null =>
  c === null ? null : (CATEGORY_LABELS[c] ?? c);

export const methodLabel = (m: string | null): string | null =>
  m === "bank" ? "перечисление" : m === "cash" ? "наличные" : m;

export const flowStatusLabel = (s: string): string =>
  s === "planned" ? "ожидает" : s === "actual" ? "оплачено" : s === "cancelled" ? "отменено" : s;
