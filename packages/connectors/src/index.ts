/**
 * @mydon/connectors — коннекторы к внешним системам.
 * Статусы по фронту Ф5: реально работают только cbu.uz и Telegram;
 * платёжки — ручная выгрузка; VHM24 и Zadarma — планируются (API/доступы не подключены).
 */

export type ConnectorStatus = "live" | "manual" | "planned";

export interface ConnectorMeta {
  readonly name: string;
  readonly status: ConnectorStatus;
  readonly note: string;
}

/** Строка курса валют от cbu.uz. */
export interface CbuRate {
  Ccy: string; // код валюты: USD, EUR, RUB…
  Rate: string; // курс к суму
  Date: string; // дата курса
}

/** Курс валют ЦБ РУз — открытый JSON API, ключ не нужен. Работает (Ф5). */
export const cbu = {
  name: "cbu.uz",
  status: "live" as const,
  note: "Открытый API курсов валют, опрос по cron.",
  async fetchRates(
    url: string = process.env.CBU_API_URL ?? "https://cbu.uz/uz/arkhiv-kursov-valyut/json/",
  ): Promise<CbuRate[]> {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`cbu.uz: HTTP ${res.status}`);
    return (await res.json()) as CbuRate[];
  },
} satisfies ConnectorMeta & Record<string, unknown>;

/** VendHub / VHM24 — отдельный движок, подключается по REST API. Не связан (Ф5). */
export const vhm24 = {
  name: "VHM24",
  status: "planned" as const,
  note: "REST API существует, связать. Нужны VHM24_API_URL/VHM24_API_KEY.",
  async fetchMachines(): Promise<never> {
    throw new Error("VHM24 connector не реализован (см. Ф5): заполните VHM24_API_URL/VHM24_API_KEY.");
  },
} satisfies ConnectorMeta & Record<string, unknown>;

/** Платёжки (Payme/Click/Uzum/Multikassa) — прямого API нет, ручная выгрузка отчёта (Ф5). */
export const payments = {
  name: "payments",
  status: "manual" as const,
  note: "Прямого API нет. Данные попадают через ручную выгрузку отчёта VendHub.",
} satisfies ConnectorMeta;

/** Телефония Zadarma — записи звонков → транскрипция. Планируется (Ф5). */
export const zadarma = {
  name: "Zadarma",
  status: "planned" as const,
  note: "Записи звонков грузятся вручную; транскрипция локальная. API не подключён.",
} satisfies ConnectorMeta;

/** Реестр коннекторов. */
export const connectors = { cbu, vhm24, payments, zadarma };

// Notion: отчёты агентов туда, куда владелец и так смотрит.
export * from "./notion";

// Cowork: агент и память Claude Desktop — читаются файлами с Мака владельца.
export * from "./cowork";
