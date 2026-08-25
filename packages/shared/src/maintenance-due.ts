/**
 * Расчёт сроков обслуживания.
 *
 * Чистые функции без БД и без часов: срок — это арифметика по датам, и её
 * надо уметь проверить тестом на любой день, а не только на сегодняшний.
 * Сегодняшняя дата приходит параметром — так модуль не зависит ни от зоны
 * процесса, ни от `Date.now()`, и не тянет TZ из индекса пакета (это был бы
 * цикл импортов: index → maintenance-due → index). Соседний `calendar-day`
 * импортируется НАПРЯМУЮ, а не через индекс, по той же причине: это лист без
 * своих зависимостей, и цикла он не заводит.
 *
 * Главное правило: СТАТУС НЕ ХРАНИТСЯ. «Пора / просрочено» зависит от текущей
 * даты, и хранимое поле обязательно разъедется с реальностью в тот день, когда
 * крон не отработает. Хранится якорь `dueOn` — плановая дата следующей работы.
 */

import { dayNumber, isoOfDay } from "./calendar-day";

export type DueStatus = "ok" | "soon" | "due" | "overdue" | "unknown";

/** Норматив: как часто положено. Задан хотя бы один способ — иначе unknown. */
export interface Periodicity {
  everyDays?: number | null;
  everyMonths?: number | null;
  /** По счётчику: раз в N чашек/продаж. */
  everyCount?: number | null;
}

/**
 * Разница в КАЛЕНДАРНЫХ днях: to − from.
 *
 * Через номера дней, а не делением миллисекунд. Деление ошибается на
 * переходах и на датах, где между полуночами не ровно 24 часа, — и ошибается
 * молча, на единицу, что в графике выглядит как «просрочено на день».
 */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/** Прибавить дни к дате YYYY-MM-DD. */
export function addDays(iso: string, days: number): string {
  return isoOfDay(dayNumber(iso) + days);
}

/**
 * Прибавить месяцы календарно: 31 января + 1 месяц = 28/29 февраля, а не
 * 3 марта. Иначе годовой график каждый раз уползал бы на несколько дней.
 */
export function addMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Есть ли вообще норматив. Без него срок посчитать не из чего. */
export function hasPeriod(p: Periodicity): boolean {
  return Boolean(p.everyDays || p.everyMonths || p.everyCount);
}

/**
 * Сдвинуть якорь после выполненной работы.
 *
 * Не «дата выполнения + период», а «плановая дата + период»: иначе график
 * ползёт. Мойка раз в 30 дней, срок 1 марта, сделали 5-го — следующая должна
 * быть 31 марта, а не 4 апреля. Через год такой ошибки «ежемесячная» работа
 * делается десять раз вместо двенадцати.
 *
 * Если работу пропустили надолго, якорь двигается целыми периодами, пока не
 * окажется в будущем: иначе после трёхмесячного перерыва система тут же
 * потребовала бы три просроченных работы разом.
 */
export function advanceAnchor(dueOn: string, performedOn: string, p: Periodicity): string {
  if (!hasPeriod(p)) return dueOn;

  const step = (from: string): string =>
    p.everyMonths ? addMonths(from, p.everyMonths) : addDays(from, p.everyDays ?? 1);

  let next = step(dueOn);
  // Потолок на случай мусора в данных (период 0 не даст сойтись).
  for (let guard = 0; guard < 1000 && daysBetween(next, performedOn) >= 0; guard += 1) {
    const moved = step(next);
    if (moved === next) break;
    next = moved;
  }
  return next;
}

/** Первый срок для только что заведённого норматива. */
export function firstDue(from: string, p: Periodicity): string | null {
  if (p.everyMonths) return addMonths(from, p.everyMonths);
  if (p.everyDays) return addDays(from, p.everyDays);
  return null;
}

export interface DueInput extends Periodicity {
  /** Плановая дата следующей работы. null — норматив есть, а якоря нет. */
  dueOn?: string | null;
  /** Когда делали в последний раз. */
  lastDoneOn?: string | null;
  /** За сколько дней до срока считать работу «скорой». */
  taskLeadDays?: number;
  /** Текущее показание счётчика и показание на момент последней работы. */
  counterNow?: number | null;
  counterAtLastDone?: number | null;
}

export interface DueResult {
  status: DueStatus;
  /** Сколько дней осталось. Отрицательное — просрочено. null — срока нет. */
  daysLeft: number | null;
  /** Сколько единиц счётчика осталось до норматива. */
  countLeft: number | null;
  nextDueOn: string | null;
}

/** Значение по умолчанию: за сколько дней предупреждать. */
export const DEFAULT_LEAD_DAYS = 3;

/**
 * Статус норматива на заданный день.
 *
 * Считается на чтении. Два независимых основания — календарь и счётчик;
 * если заданы оба, побеждает то, что наступает раньше: фильтр воды меняют
 * либо через 90 дней, либо через 5000 чашек, смотря что случится первым.
 */
export function computeDue(input: DueInput, today: string): DueResult {
  const lead = input.taskLeadDays ?? DEFAULT_LEAD_DAYS;

  if (!hasPeriod(input)) {
    return { status: "unknown", daysLeft: null, countLeft: null, nextDueOn: null };
  }

  // Календарная часть.
  let daysLeft: number | null = null;
  let nextDueOn: string | null = input.dueOn ?? null;
  if (nextDueOn === null && (input.everyDays || input.everyMonths) && input.lastDoneOn) {
    nextDueOn = firstDue(input.lastDoneOn, input);
  }
  if (nextDueOn !== null) daysLeft = daysBetween(today, nextDueOn);

  // Счётчиковая часть.
  let countLeft: number | null = null;
  if (input.everyCount && input.counterNow != null) {
    const since = input.counterNow - (input.counterAtLastDone ?? 0);
    countLeft = input.everyCount - since;
  }

  // Норматив задан, но опереться не на что: ни якоря, ни показаний.
  if (daysLeft === null && countLeft === null) {
    return { status: "unknown", daysLeft: null, countLeft: null, nextDueOn };
  }

  const byDays = statusOf(daysLeft, lead);
  const byCount = countLeft === null ? null : statusOfCount(countLeft, input.everyCount ?? 0);
  const status = worst(byDays, byCount);

  return { status, daysLeft, countLeft, nextDueOn };
}

function statusOf(daysLeft: number | null, lead: number): DueStatus | null {
  if (daysLeft === null) return null;
  if (daysLeft < 0) return "overdue";
  // Срок сегодня — это ещё не просрочка: техник закроет вечером.
  if (daysLeft === 0) return "due";
  return daysLeft <= lead ? "soon" : "ok";
}

/**
 * По счётчику «скоро» — это последняя десятая часть норматива: раньше
 * предупреждать бессмысленно, позже уже поздно ехать.
 */
function statusOfCount(countLeft: number, every: number): DueStatus {
  if (countLeft <= 0) return "overdue";
  return countLeft <= Math.max(1, Math.round(every * 0.1)) ? "soon" : "ok";
}

const SEVERITY: Record<DueStatus, number> = { unknown: 0, ok: 1, soon: 2, due: 3, overdue: 4 };

/** Из двух оснований берём худшее: раньше наступивший срок и есть срок. */
function worst(a: DueStatus | null, b: DueStatus | null): DueStatus {
  if (a === null) return b ?? "unknown";
  if (b === null) return a;
  return SEVERITY[a] >= SEVERITY[b] ? a : b;
}

/** Значок статуса для списков в боте и панели — один на оба интерфейса. */
export const DUE_ICON: Record<DueStatus, string> = {
  overdue: "🔴",
  due: "🟠",
  soon: "🟡",
  ok: "🟢",
  unknown: "⚪",
};

export const DUE_LABEL: Record<DueStatus, string> = {
  overdue: "просрочено",
  due: "сегодня",
  soon: "скоро",
  ok: "в норме",
  unknown: "норматив не задан",
};

/** Человеческая подпись срока: «просрочено на 3 дн.», «через 5 дн.». */
export function dueText(r: DueResult): string {
  if (r.status === "unknown") return DUE_LABEL.unknown;
  if (r.daysLeft === null) {
    return r.countLeft !== null && r.countLeft <= 0 ? "пора по счётчику" : `осталось ${r.countLeft} по счётчику`;
  }
  if (r.daysLeft < 0) return `просрочено на ${Math.abs(r.daysLeft)} дн.`;
  if (r.daysLeft === 0) return "сегодня";
  if (r.daysLeft === 1) return "завтра";
  return `через ${r.daysLeft} дн.`;
}
