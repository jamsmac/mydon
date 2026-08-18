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

/** Полный отчёт по людям: время и суть каждого действия, длинное — свёрнуто. */
export function formatActions(rows: ActionRow[], periodLabel: string): string {
  if (rows.length === 0) {
    return `За ${periodLabel === "сегодня" ? "сегодня" : periodLabel} действий сотрудников не записано.`;
  }
  const byPerson = new Map<string, ActionRow[]>();
  for (const r of rows) byPerson.set(r.personName, [...(byPerson.get(r.personName) ?? []), r]);

  const lines: string[] = [`📊 Действия сотрудников (${periodLabel}): ${rows.length}`];
  // Самые деятельные — первыми: владелец читает сверху.
  const people = [...byPerson.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [name, acts] of people) {
    lines.push("", `👤 ${name} — ${acts.length}:`);
    // В ленте новое сверху; в отчёте человека — хронологически, как шёл день.
    const chrono = [...acts].reverse();
    const shown = chrono.slice(0, 12);
    for (const a of shown) lines.push(`  ${timeOf(a.ts)} ${a.label}`);
    if (chrono.length > shown.length) lines.push(`  … ещё ${chrono.length - shown.length}`);
  }
  return lines.join("\n");
}

/** Однострочная сводка для брифинга: «Вчера: Имя — N, Имя — M». */
export function summarizeActions(rows: ActionRow[]): string | null {
  if (rows.length === 0) return null;
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.personName, (counts.get(r.personName) ?? 0) + 1);
  const parts = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name} — ${n}`);
  return `👥 Вчера сделано: ${parts.join(", ")}. Подробно: «итоги вчера».`;
}

/** Обработка запроса владельца. */
export async function handleActionsQuery(text: string, core: CoreClient): Promise<StaffReply> {
  const period = actionsPeriod(text);
  const rows = await core.actions(period.from, period.to);
  return { text: formatActions(rows, period.label) };
}
