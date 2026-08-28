/**
 * Явный разбор времени источника — часовой пояс Ташкента, а не пояс процесса.
 *
 * До этого модуля правильность держалась на переменной окружения `TZ`, а не
 * на коде: `new Date("2026-06-08 14:30:00")` без явной зоны читает строку
 * часами ПРОЦЕССА. Донор VendCash на этом уже погорел (их коммит `9e59220`):
 * время из Excel читалось как UTC, сверка суммировала чужие заказы, чинили
 * миграцией со сдвигом всех строк на −5 часов. Здесь зона зашита в код.
 */

const ГОЛАЯ_ДАТА = /^\d{4}-\d{2}-\d{2}$/;
/** Строка уже несёт зону: `Z` или смещение `±HH:MM`/`±HHMM` в конце. */
const С_ЗОНОЙ = /(?:Z|[+-]\d{2}:?\d{2})$/;
const ЗОНА = "+05:00";

function toDate(candidate: string): Date | null {
  const d = new Date(candidate);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Момент из строки источника. Строка с зоной (`Z`, `+05:00`) — как есть.
 * Без зоны — ташкентские настенные часы, а НЕ часы процесса: зона `+05:00`
 * дописывается явно, поэтому результат не зависит от `TZ` окружения.
 */
export function tashkentInstant(v: string): Date | null {
  const s = v.trim();
  if (!s) return null;
  if (ГОЛАЯ_ДАТА.test(s)) return toDate(`${s}T00:00:00.000${ЗОНА}`);
  if (С_ЗОНОЙ.test(s)) return toDate(s);
  // "YYYY-MM-DD HH:mm:ss" (пробел) и "YYYY-MM-DDTHH:mm:ss" (уже с T) —
  // обе формы источника сводятся к одному разделителю перед явной зоной.
  return toDate(`${s.replace(" ", "T")}${ЗОНА}`);
}

/** Голая дата → начало ташкентских суток. */
export function tashkentDayStart(v: string): Date | null {
  const m = v.trim().match(ГОЛАЯ_ДАТА);
  if (!m) return null;
  return toDate(`${m[0]}T00:00:00.000${ЗОНА}`);
}

/** Голая дата → конец ташкентских суток (последняя миллисекунда). */
export function tashkentDayEnd(v: string): Date | null {
  const m = v.trim().match(ГОЛАЯ_ДАТА);
  if (!m) return null;
  return toDate(`${m[0]}T23:59:59.999${ЗОНА}`);
}

/** Смещение Ташкента в миллисекундах: постоянное, перехода на летнее время нет. */
const СМЕЩЕНИЕ_МС = 5 * 3_600_000;

/**
 * Момент → ташкентские сутки `YYYY-MM-DD`.
 *
 * Живёт здесь, а не у потребителей: суточные отчёты вендинга заводили свою
 * копию смещения (`TZ_OFFSET_MS` в `shrinkage.service.ts`, убрана в R-FW-11),
 * и вторая константа зоны в коде — ровно та развилка, на которой донор
 * VendCash уехал на пять часов.
 * `toLocaleDateString` здесь не годится: он зависит от набора ICU в рантайме,
 * а формат нужен сортируемый и байт-в-байт как `date` в базе.
 */
export function tashkentDay(at: Date): string {
  return new Date(at.getTime() + СМЕЩЕНИЕ_МС).toISOString().slice(0, 10);
}

/** Момент → начало ЕГО ташкентских суток. */
export function tashkentDayStartOf(at: Date): Date {
  return tashkentDayStart(tashkentDay(at))!;
}

/**
 * Час ташкентских суток (0–23) для момента.
 *
 * Живёт здесь, а не у потребителя: вторая копия смещения зоны в коде — ровно
 * та развилка, на которой донор VendCash уехал на пять часов (R-FW-11).
 * `toLocaleString` не годится: он зависит от набора ICU в рантайме.
 */
export function tashkentHour(at: Date): number {
  return new Date(at.getTime() + СМЕЩЕНИЕ_МС).getUTCHours();
}
