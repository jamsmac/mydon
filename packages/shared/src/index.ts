/**
 * @mydon/shared — общие типы, утилиты и константы MYDON.
 * Русский в UI, английский в коде.
 */

/** Часовой пояс проекта. Использовать везде, включая cron. */
export const TZ = "Asia/Tashkent" as const;

/** Валюта по умолчанию. */
export const DEFAULT_CURRENCY = "UZS" as const;

/** Направления (домены) MYDON. TRent убран по решению владельца 2026-07-28. */
export const DOMAINS = ["globerent", "vendhub", "personal", "mydon"] as const;
export type Domain = (typeof DOMAINS)[number];

/** Читаемые названия доменов (для UI). */
export const DOMAIN_LABELS: Record<Domain, string> = {
  globerent: "GLOBERENT",
  vendhub: "VendHub",
  personal: "Личный контур",
  mydon: "MYDON",
};

/**
 * Уровни автономии агентов (T0–T4).
 * T0 — только предложение, ничего не исполняет; T4 — полная автономия.
 * Текущий порог владельца: всё вручную (T0).
 */
export const AUTONOMY_TIERS = ["T0", "T1", "T2", "T3", "T4"] as const;
export type AutonomyTier = (typeof AUTONOMY_TIERS)[number];

/** Решение по запросу согласования. */
export type ApprovalDecision = "approved" | "rejected" | "clarify";

/** Срочность доставки уведомления. */
export type NotifyUrgency = "immediate" | "briefing" | "weekly";

/** Строка времени в часовом поясе проекта (для отображения). */
export function formatTashkent(date: Date = new Date()): string {
  return date.toLocaleString("ru-RU", { timeZone: TZ });
}

/** Тип-хелпер: сделать перечисленные поля обязательными. */
export type WithRequired<T, K extends keyof T> = T & Required<Pick<T, K>>;

// Логика задач: разбор сроков словами и группировка по срочности (панель + бот).
export * from "./tasks";

// Справочник источников VendHub: откуда берутся сырые выгрузки.
export * from "./sources";

// Разбор выгрузки, сохранённой файлом: владелец кладёт её сам, без разработчика.
export * from "./delimited";

// Кабинет VendHub office: отчёт приходит HTML-страницей, а не файлом.
export * from "./vendinghub";

// Построчная сверка двух источников по номеру операции.
export * from "./reconcile";
