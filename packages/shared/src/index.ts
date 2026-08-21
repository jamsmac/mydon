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
export * from "./unify";
export * from "./xlsx";
export * from "./combine";
export * from "./recipe";
export * from "./ingredient-price";
// Разбор реестра закупок владельца в нормализованные записи (срез D, задача 1).
export * from "./purchase-register";
export * from "./batch-import";
export * from "./stock";
export * from "./planogram";
export * from "./menu";
export * from "./vending-calc";
export * from "./coffee-calc";
export * from "./coffee-order";
export * from "./contractor-name";
export * from "./cash-estimate";
export * from "./service-feed";
export * from "./consumption";
export * from "./intake-sync";
export * from "./numguard";
export * from "./geo";

/** Обслуживание оборудования: узлы, виды работ, симптомы, расчёт сроков. */
export * from "./maintenance";
export * from "./maintenance-due";
export * from "./catalog-kinds";

/** Вид места: точка продаж / склад / мастерская. */
export * from "./place-kinds";
export * from "./place-name";
export * from "./entity-name";

/** Состояние автомата: в эксплуатации / склад / ремонт. */
export * from "./machine-status";
export * from "./maintenance-norms";

/** Серийник автомата: две формы написания сводятся к одному ключу. */
export * from "./machine-serial";

/** Роли сотрудников, права и приглашения в бота. */
export * from "./roles";
export * from "./invite";
// GLOBERENT: словарь реестра и расчётные движки (перенос PROMACH).
export * from "./globerent/registry";
export * from "./globerent/contract-calc";
export * from "./globerent/calc";
export * from "./globerent/unit-status";
export * from "./globerent/commission";
export * from "./globerent/import-lifecycle";
export * from "./globerent/unit-cogs";
export * from "./globerent/preorder-status";

/** Кто совершил действие: вид актора выводится из ссылки, а не задаётся руками. */
export * from "./actor";

/** Партии сырья: расход по FEFO и срок годности (перенос из mydon_1, срез C). */
export * from "./fefo";
export * from "./expiry";

/** Касса и инкассация: номиналы сума и сверка набора купюр (срез K, задача 1). */
export * from "./denominations";
