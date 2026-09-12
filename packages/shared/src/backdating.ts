import { TASHKENT_OFFSET_MS, tashkentDay, tashkentInstant } from "./tashkent-time";

/**
 * Два времени у операции и ввод задним числом (волна 5, R-H-1…R-H-7, R-H-12).
 *
 * ЗАЧЕМ. Событие и запись о нём почти никогда не совпадают: техник заливает
 * бункер утром, в панель это попадает вечером. Пока у операции одна дата —
 * дата записи, — всё, что считается по времени (расход между заливками,
 * усушка по дням, сроки ТО), считается по неверной шкале.
 *
 * ЧТО ЗДЕСЬ. Чистые правила, общие для всех операций: разбор введённого
 * времени, запрет будущего, граница «задним числом» и подпись разрыва. Записью
 * и одобрением занимается Core; форма берёт отсюда же, чтобы отказ приходил
 * сразу, а не после круга к серверу.
 */

/** Точность — до минуты (R-H-2): две заливки одного бункера в день различимы порядком. */
export function truncateToMinute(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 60_000) * 60_000);
}

/**
 * Значение для поля формы (`datetime-local`) — ташкентские настенные часы.
 * Не `toISOString().slice(0,16)`: это часы UTC, и форма открывалась бы на пять
 * часов раньше — ровно та ловушка, на которой погорел донор VendCash.
 */
export function tashkentLocalInput(at: Date): string {
  return new Date(truncateToMinute(at).getTime() + TASHKENT_OFFSET_MS).toISOString().slice(0, 16);
}

/**
 * Разбор введённого «когда произошло». Строка без зоны читается ташкентскими
 * часами (`tashkentInstant`), будущее отвергается (R-H-4) — проверка живёт
 * здесь и вызывается И формой, И сервером: сервер потому, что форму можно
 * обойти, форма — чтобы отказ был виден сразу.
 *
 * `toleranceMs` — запас на расхождение часов клиента и сервера: минута вперёд
 * не считается будущим, иначе «сейчас» у человека с чуть спешащими часами
 * отвергалось бы как событие, которого не было.
 */
export function parseOccurred(
  raw: string,
  now: Date,
  toleranceMs = 60_000,
): { at: Date } | { problem: string } {
  const at = tashkentInstant(raw);
  if (!at) return { problem: "Не понял дату и время события — ожидается «2026-09-11 09:40»" };
  if (at.getTime() > now.getTime() + toleranceMs) {
    return { problem: "Событие в будущем записать нельзя — проверьте дату и время" };
  }
  return { at: truncateToMinute(at) };
}

/**
 * Запись задним числом (R-H-12): дата события раньше СЕГОДНЯШНЕЙ по Ташкенту.
 * Сегодняшнее событие с уточнённым временем («залил в 9:40, записал в 14:00»)
 * задним числом не считается — иначе очередь владельца забьётся обычной
 * работой смены, и одобрение перестанет что-либо значить.
 */
export function isBackdated(occurredAt: Date, recordedAt: Date): boolean {
  return tashkentDay(occurredAt) < tashkentDay(recordedAt);
}

/** На сколько ташкентских суток запись отстала от события. */
export function backdateDays(occurredAt: Date, recordedAt: Date): number {
  const day = (d: Date) => Date.parse(`${tashkentDay(d)}T00:00:00.000Z`);
  return Math.max(0, Math.round((day(recordedAt) - day(occurredAt)) / 86_400_000));
}

/**
 * Подпись разрыва для владельца (R-H-5): он вправе знать, что вчерашние цифры
 * приехали сегодня. Не задним числом — `null`, подписывать нечего.
 */
export function backdateLabel(occurredAt: Date, recordedAt: Date): string | null {
  const days = backdateDays(occurredAt, recordedAt);
  if (days === 0) return null;
  if (days === 1) return "задним числом: за вчера";
  return `задним числом: за ${tashkentDay(occurredAt)} (${days} дн. назад)`;
}
