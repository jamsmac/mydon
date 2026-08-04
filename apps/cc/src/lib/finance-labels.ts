/** Подписи финансового контура — по-русски, в одном месте (сервер и клиент). */
import { MONEY_CATEGORY_LABELS } from "@mydon/shared";

/** Единый словарь категорий денег живёт в packages/shared (решение сверки переноса). */
export const CATEGORY_LABELS: Record<string, string> = MONEY_CATEGORY_LABELS;

export const categoryLabel = (c: string | null): string | null =>
  c === null ? null : (CATEGORY_LABELS[c] ?? c);

export const methodLabel = (m: string | null): string | null =>
  m === "bank" ? "перечисление" : m === "cash" ? "наличные" : m;

export const flowStatusLabel = (s: string): string =>
  s === "planned" ? "ожидает" : s === "actual" ? "оплачено" : s === "cancelled" ? "отменено" : s;
