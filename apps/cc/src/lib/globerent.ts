import type { Entity } from "./core";
import { plural } from "./format";

/**
 * Чтение атрибутов записей GLOBERENT.
 *
 * Сбор со страниц свободный (ingest-site кладёт факты как назвала модель),
 * а карта переноса легаси фиксировала английские ключи (client, amount,
 * endDate — его же читает брифинг Core). Поэтому каждое поле ищется по списку
 * ключей-кандидатов: сначала канонический, затем русские варианты.
 */
function at(e: Entity, keys: readonly string[]): string | null {
  const a = e.attrs ?? {};
  for (const k of keys) {
    const v = a[k];
    if (v === undefined || v === null || v === "") continue;
    return String(v);
  }
  return null;
}

/** Дата окончания договора — тот же ключ endDate, что считает Core в брифинге. */
export const contractEnd = (e: Entity): string | null =>
  at(e, ["endDate", "end_date", "окончание", "срок окончания", "срок"]);

export const contractClient = (e: Entity): string | null =>
  at(e, ["client", "клиент", "контрагент", "counterparty"]);

export const docDate = (e: Entity): string | null => at(e, ["date", "дата"]);

export const contractorInn = (e: Entity): string | null =>
  e.externalRef ?? at(e, ["inn", "ИНН", "инн"]);

export const equipmentLine = (e: Entity): string | null =>
  at(e, ["line", "линейка", "модель", "model"]);

export const equipmentCapacity = (e: Entity): string | null =>
  at(e, ["capacity", "грузоподъёмность", "грузоподъемность"]);

/** Дата в формате ISO с точностью до дня — только такую можно сравнивать строками. */
export const ISO_DAY = /^\d{4}-\d{2}-\d{2}/;

/** «2026-05-25» → «25.05.2026». Не ISO — возвращаем как есть, не выдумывая дату. */
export function fmtDay(day: string): string {
  if (!ISO_DAY.test(day)) return day;
  return `${day.slice(8, 10)}.${day.slice(5, 7)}.${day.slice(0, 4)}`;
}

function utcOf(day: string): number | null {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  const d = Number(day.slice(8, 10));
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  return Date.UTC(y, m - 1, d);
}

/** Дней от a до b (обе — YYYY-MM-DD). null — дату не разобрать. */
export function daysBetween(a: string, b: string): number | null {
  const ta = utcOf(a.slice(0, 10));
  const tb = utcOf(b.slice(0, 10));
  if (ta === null || tb === null) return null;
  return Math.round((tb - ta) / 86_400_000);
}

/**
 * Сумма записи словами: «68 308 623 097 сум», «12 000 USD» или сырая строка,
 * если числом не читается. Валюту без явного указания НЕ дописываем: договоры
 * HELI бывают и в долларах, а молча приписать «сум» — соврать в цифре.
 */
export function amountLabel(e: Entity): string | null {
  const raw = at(e, ["amount", "сумма", "amount_novat", "сумма без НДС"]);
  if (raw === null) return null;
  const n = Number(raw.replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n)) return raw;
  const num = n.toLocaleString("ru-RU");
  const cur = at(e, ["currency", "валюта"]);
  if (cur === null) return num;
  return `${num} ${cur === "UZS" ? "сум" : cur}`;
}

/** Цена продажи техники — для колонки прайса парка HELI. */
export function salePriceLabel(e: Entity): string | null {
  const raw = at(e, ["sale_price", "цена продажи", "цена", "price"]);
  if (raw === null) return null;
  const n = Number(raw.replace(/\s/g, "").replace(",", "."));
  if (!Number.isFinite(n)) return raw;
  const num = n.toLocaleString("ru-RU");
  const cur = at(e, ["currency", "валюта"]);
  if (cur === null) return num;
  return `${num} ${cur === "UZS" ? "сум" : cur}`;
}

export interface ContractStats {
  total: number;
  /** Истекают в горизонте тревоги (сегодня…horizon), по близости срока. */
  dueSoon: Entity[];
  /** Действуют (окончание сегодня или позже), включая dueSoon. */
  active: number;
  expired: number;
  /** Дата есть, но не читается — те же договоры, что Core считает contractsBadDate. */
  badDate: number;
  noDate: number;
}

/**
 * Раскладка договоров по срокам. Сравнение дат — строками, как в брифинге Core:
 * несуществующая дата («2026-02-30») не должна ронять страницу направления.
 */
export function contractStats(contracts: Entity[], today: string, horizon: string): ContractStats {
  const dueSoon: Entity[] = [];
  let active = 0;
  let expired = 0;
  let badDate = 0;
  let noDate = 0;
  for (const e of contracts) {
    const end = contractEnd(e);
    if (end === null) {
      noDate += 1;
      continue;
    }
    if (!ISO_DAY.test(end)) {
      badDate += 1;
      continue;
    }
    const day = end.slice(0, 10);
    if (day < today) {
      expired += 1;
      continue;
    }
    active += 1;
    if (day < horizon) dueSoon.push(e);
  }
  dueSoon.sort((a, b) => (contractEnd(a) ?? "").localeCompare(contractEnd(b) ?? ""));
  return { total: contracts.length, dueSoon, active, expired, badDate, noDate };
}

/** Подпись срока договора для строки списка + признак «горит». */
export function endLabel(end: string | null, today: string): { text: string; hot: boolean } {
  if (end === null) return { text: "срок не указан", hot: false };
  if (!ISO_DAY.test(end)) return { text: `дата непонятна: ${end}`, hot: false };
  const day = end.slice(0, 10);
  if (day < today) return { text: `истёк ${fmtDay(day)}`, hot: false };
  const days = daysBetween(today, day);
  if (days === 0) return { text: "истекает сегодня", hot: true };
  if (days !== null && days <= 14)
    return { text: `осталось ${days} ${plural(days, "день", "дня", "дней")}`, hot: true };
  return { text: `до ${fmtDay(day)}`, hot: false };
}
