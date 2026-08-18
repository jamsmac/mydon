import { TZ } from "@mydon/shared";
import type { ActionRow, CoreClient } from "./core-client";
import type { StaffReply } from "./staff";

/**
 * «Итоги» — лента действий сотрудников для владельца.
 *
 * Ответ на прямой вопрос: «вижу ли я, что сделали операторы и кладовщики?»
 * До этого владелец видел только тревоги (просрочки, недоливы) и агрегаты;
 * сделанную работу по людям не показывал ни бот, ни брифинг.
 */

/** Фразы владельца: «итоги», «итоги вчера», «действия», «кто что сделал». */
export function isActionsQuery(text: string): boolean {
  return /^(итоги|действия|кто что сделал)/i.test(text.trim());
}

/** День по Ташкенту со сдвигом от сегодняшнего. */
function dayIso(shiftDays: number, now = new Date()): string {
  return new Date(now.getTime() - shiftDays * 86_400_000).toLocaleDateString("en-CA", { timeZone: TZ });
}

/** Период из фразы: «вчера» / «неделя»|«7 дней» / иначе — сегодня. */
export function actionsPeriod(text: string, now = new Date()): { from: string; to: string; label: string } {
  const t = text.toLowerCase();
  if (/вчера/.test(t)) return { from: dayIso(1, now), to: dayIso(1, now), label: "вчера" };
  if (/недел|7 дн/.test(t)) return { from: dayIso(6, now), to: dayIso(0, now), label: "за 7 дней" };
  return { from: dayIso(0, now), to: dayIso(0, now), label: "сегодня" };
}

const timeOf = (iso: string): string =>
  new Date(iso).toLocaleTimeString("ru-RU", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });

const dayOf = (iso: string): string =>
  new Date(iso).toLocaleDateString("ru-RU", { timeZone: TZ, day: "2-digit", month: "2-digit" });

/** Telegram обрезает сообщение на 4096 — держимся заметно ниже. */
const TG_BUDGET = 3500;

/** Полный отчёт по людям: время и суть каждого действия, длинное — свёрнуто. */
export function formatActions(rows: ActionRow[], periodLabel: string): string {
  if (rows.length === 0) {
    return `Действий сотрудников (${periodLabel}) не записано.`;
  }
  // Группировка по id, не по имени: тёзки — разные люди.
  const byPerson = new Map<string, ActionRow[]>();
  for (const r of rows) byPerson.set(r.personId, [...(byPerson.get(r.personId) ?? []), r]);
  const multiDay = new Set(rows.map((r) => dayOf(r.ts))).size > 1;
  const stamp = (a: ActionRow): string => (multiDay ? `${dayOf(a.ts)} ${timeOf(a.ts)}` : timeOf(a.ts));

  const lines: string[] = [`📊 Действия сотрудников (${periodLabel}): ${rows.length}`];
  // Самые деятельные — первыми: владелец читает сверху.
  const people = [...byPerson.values()].sort((a, b) => b.length - a.length);
  for (const acts of people) {
    lines.push("", `👤 ${acts[0].personName} — ${acts.length}:`);
    // Хронологически, как шёл день; при переполнении показываем СВЕЖИЙ хвост:
    // «что сделано под конец» полезнее давно прочитанного начала.
    const chrono = [...acts].reverse();
    const shown = chrono.slice(-12);
    if (chrono.length > shown.length) lines.push(`  … ${chrono.length - shown.length} раньше`);
    for (const a of shown) lines.push(`  ${stamp(a)} ${a.label}`);
  }

  // Бюджет Telegram: режем по границе строки, а не посреди слова, и честно
  // говорим, где полный список.
  let text = lines.join("\n");
  if (text.length > TG_BUDGET) {
    text = `${text.slice(0, TG_BUDGET).replace(/\n[^\n]*$/, "")}\n\n… показана часть — полный список в панели, раздел «Действия».`;
  }
  return text;
}

/** Однострочная сводка для брифинга: «Вчера: Имя — N, Имя — M». */
export function summarizeActions(rows: ActionRow[]): string | null {
  if (rows.length === 0) return null;
  // Считаем по id (тёзки — разные люди), показываем именем.
  const counts = new Map<string, { name: string; n: number }>();
  for (const r of rows) {
    const cur = counts.get(r.personId) ?? { name: r.personName, n: 0 };
    cur.n += 1;
    counts.set(r.personId, cur);
  }
  const parts = [...counts.values()]
    .sort((a, b) => b.n - a.n)
    .map((c) => `${c.name} — ${c.n}`);
  return `👥 Вчера сделано: ${parts.join(", ")}. Подробно: «итоги вчера».`;
}

/** Обработка запроса владельца. */
export async function handleActionsQuery(text: string, core: CoreClient): Promise<StaffReply> {
  const period = actionsPeriod(text);
  const rows = await core.actions(period.from, period.to);
  return { text: formatActions(rows, period.label) };
}
