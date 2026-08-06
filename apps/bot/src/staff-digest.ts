import { dueLabel } from "@mydon/shared";
import type { PersonRow, TaskRow } from "./core-client";

/**
 * Утренний дайджест сотрудника, 07:00.
 *
 * Раньше владельческого брифинга (07:30) намеренно: владелец должен видеть
 * картину, зная, что люди её уже получили, а не одновременно с ними.
 *
 * Дайджест — ЕДИНСТВЕННЫЙ канал доставки свободных задач. `sendReminders`
 * ходит по `ownerRef`, а у свободной задачи его нет, и до сотрудника она
 * доходит только здесь.
 *
 * Группировка по объекту, а не по виду работ: техник ездит по точкам.
 * «Три дела на Kaffit-04» — это один заезд, а тот же список вперемешку —
 * три, и человек это увидит только на месте.
 */

/** Сколько своих задач показываем. Дальше — в разделе «Мои задачи». */
const MAX_MINE = 10;
/** Сколько свободных. Больше пяти в утреннем сообщении — уже биржа труда. */
const MAX_FREE = 5;

export interface DigestInput {
  person: PersonRow;
  /** Задачи на этом человеке. */
  mine: TaskRow[];
  /** Свободные задачи — общий пул. */
  free: TaskRow[];
  /** Имена объектов по id — чтобы группировать по точкам, а не по uuid. */
  objectNames?: Map<string, string>;
  /** Сколько уже сделано сегодня. */
  doneToday?: number;
}

export interface Digest {
  text: string;
  /** Кнопки: открыть свою задачу, взять свободную. */
  keyboard?: { inline_keyboard: { text: string; callback_data: string }[][] };
}

function prio(t: TaskRow): string {
  return t.priority === "urgent" ? "🔴" : t.priority === "high" ? "🟡" : "🟢";
}

/** Ключ группировки: объект, а при его отсутствии — «без объекта». */
function groupKey(t: TaskRow, names?: Map<string, string>): string {
  if (!t.entityId) return "Без объекта";
  return names?.get(t.entityId) ?? "Объект";
}

function block(tasks: TaskRow[], names: Map<string, string> | undefined, offset: number): string[] {
  const byObject = new Map<string, TaskRow[]>();
  for (const t of tasks) {
    const key = groupKey(t, names);
    byObject.set(key, [...(byObject.get(key) ?? []), t]);
  }
  const lines: string[] = [];
  let n = offset;
  for (const [object, list] of byObject) {
    for (const t of list) {
      n += 1;
      lines.push(`${n} ${prio(t)} ${object}`);
      lines.push(`   ${t.title} · ${dueLabel(t.due)}`);
    }
  }
  return lines;
}

/**
 * Собрать дайджест. Возвращает null, если слать нечего: пустое утреннее
 * сообщение «у тебя ноль задач» каждый день приучает его не читать.
 */
export function buildDigest(input: DigestInput): Digest | null {
  const mine = input.mine.slice(0, MAX_MINE);
  const free = input.free.slice(0, MAX_FREE);
  if (mine.length === 0 && free.length === 0) return null;

  const head = [`🌅 Доброе утро, ${input.person.name}!`, ""];
  const rows: { text: string; callback_data: string }[][] = [];
  const parts: string[] = [];

  if (mine.length > 0) {
    parts.push(`На сегодня ${input.mine.length} ${plural(input.mine.length)}:`, "");
    parts.push(...block(mine, input.objectNames, 0));
    mine.forEach((t, i) => {
      rows.push([{ text: `${i + 1} · ${t.title}`.slice(0, 40), callback_data: `t:${t.id}:open` }]);
    });
    if (input.doneToday !== undefined) {
      parts.push("", `Сделано сегодня: ${input.doneToday} из ${input.mine.length}`);
    }
  }

  if (free.length > 0) {
    parts.push("", "🆓 Свободные — кто возьмёт:", "");
    parts.push(...block(free, input.objectNames, mine.length));
    free.forEach((t, i) => {
      rows.push([
        {
          text: `✋ Взять ${mine.length + i + 1} · ${t.title}`.slice(0, 40),
          callback_data: `t:${t.id}:claim`,
        },
      ]);
    });
    if (input.free.length > free.length) {
      parts.push("", `…и ещё ${input.free.length - free.length} свободных.`);
    }
  }

  return {
    text: [...head, ...parts].join("\n"),
    ...(rows.length > 0 ? { keyboard: { inline_keyboard: rows } } : {}),
  };
}

function plural(n: number): string {
  const last = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  if (!teen && last === 1) return "дело";
  if (!teen && last >= 2 && last <= 4) return "дела";
  return "дел";
}

/**
 * Ключ идемпотентности рассылки.
 *
 * Без него перезапуск бота в 07:00:30 слал бы дайджест второй раз, а третий
 * перезапуск — третий. Ключ занимается в Core атомарно, поэтому переживает
 * и перезапуск, и параллельный процесс.
 */
export function digestKey(dayKey: string, personId: string): string {
  return `staff-digest:${dayKey}:${personId}`;
}
