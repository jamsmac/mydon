import { PART_LABELS, type PartKind } from "@mydon/shared";
import type { CoreClient, PartUnitRow, PersonRow } from "./core-client";
import type { Conversations } from "./conversation";
import { newRunId } from "./staff-refill";
import type { StaffReply } from "./staff";

/**
 * Мастер «🚿 Помыл узлы» (pw:) — узлы, снятые с автоматов на мойку базы
 * (спека vendhub-parts, R-PU-8, У3).
 *
 * Два списка на одном экране: «на мойке» — нажал «помыл», узел уходит на
 * сушку (или сразу на склад, если сушки в настройках нет); «на сушке» —
 * нажал «на склад», узел снова среди запасных. Ничего не вводится текстом.
 * Это НЕ «🧼 Мойка бункера»: та — про бункер на точке (позиция 1..8), эта —
 * про снятую деталь с инвентарным номером.
 */

export interface PartWashDeps {
  core: CoreClient;
  conversations: Conversations;
}

export const PART_WASH_FLOW = "part-wash";

export type PartWashCallback =
  | { kind: "washed"; unitId: string }
  | { kind: "washedAll" }
  | { kind: "stored"; unitId: string }
  | { kind: "storedAll" }
  | { kind: "refresh" }
  | { kind: "done" };

export function parsePartWashCallback(data: string): PartWashCallback | null {
  if (data === "pw:x") return { kind: "done" };
  if (data === "pw:all") return { kind: "washedAll" };
  if (data === "pw:stall") return { kind: "storedAll" };
  if (data === "pw:r") return { kind: "refresh" };
  const m = /^pw:(ok|st):([0-9a-f-]{36})$/.exec(data);
  if (!m) return null;
  return m[1] === "ok" ? { kind: "washed", unitId: m[2] } : { kind: "stored", unitId: m[2] };
}

/** «помыл узлы», «с мойки», «сушка» — с якорем; одиночное «помыл» остаётся за мойкой бункера. */
export function isPartWashTrigger(text: string): boolean {
  return /^(помыл узл|помыты узл|узлы с мойки|с мойки|сушк|высохл|на склад с сушки)/i.test(text.trim());
}

function kindOf(u: PartUnitRow): string {
  return PART_LABELS[u.partKind as PartKind] ?? u.partKind;
}

function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}.${m}` : iso;
}

function unitText(u: PartUnitRow): string {
  return `${u.inventoryNo ?? "без номера"} · ${kindOf(u)}${u.where?.since ? ` · с ${dayLabel(u.where.since)}` : ""}`;
}

async function loadLists(deps: PartWashDeps): Promise<{ washing: PartUnitRow[]; drying: PartUnitRow[] }> {
  const [washing, drying] = await Promise.all([deps.core.partsAt("washing"), deps.core.partsAt("drying")]);
  return { washing, drying };
}

/** Экран мастера: оба списка и кнопки. Пусто — честное «нечего отмечать». */
function screen(lists: { washing: PartUnitRow[]; drying: PartUnitRow[] }, prefix = ""): StaffReply {
  const lines: string[] = [];
  const rows: { text: string; callback_data: string }[][] = [];
  if (lists.washing.length > 0) {
    lines.push(`🚿 На мойке: ${lists.washing.length}`);
    for (const u of lists.washing.slice(0, 10)) rows.push([{ text: `✅ Помыл ${unitText(u)}`, callback_data: `pw:ok:${u.id}` }]);
    if (lists.washing.length > 1) rows.push([{ text: `✅ Помыл все (${lists.washing.length})`, callback_data: "pw:all" }]);
  }
  if (lists.drying.length > 0) {
    lines.push(`💨 На сушке: ${lists.drying.length}`);
    for (const u of lists.drying.slice(0, 10)) rows.push([{ text: `📦 На склад ${unitText(u)}`, callback_data: `pw:st:${u.id}` }]);
    if (lists.drying.length > 1) rows.push([{ text: `📦 На склад все (${lists.drying.length})`, callback_data: "pw:stall" }]);
  }
  if (lines.length === 0) {
    return { text: `${prefix}На мойке и сушке пусто — отмечать нечего. Снятые узлы попадают сюда через «🔧 Замена детали» → «куда увёз: мойка».` };
  }
  rows.push([{ text: "✖️ Закончить", callback_data: "pw:x" }]);
  const hint = lists.washing.length > 0 ? "\nНажми «Помыл» у узла — он уйдёт на сушку или на склад." : "";
  return { text: `${prefix}${lines.join("\n")}${hint}`, keyboard: { inline_keyboard: rows } };
}

export async function startPartWash(chatId: number, person: PersonRow, deps: PartWashDeps): Promise<StaffReply> {
  let lists: { washing: PartUnitRow[]; drying: PartUnitRow[] };
  try {
    lists = await loadLists(deps);
  } catch (e) {
    return { text: `Не смог прочитать мойку: ${e instanceof Error ? e.message : "ошибка"}.` };
  }
  if (lists.washing.length === 0 && lists.drying.length === 0) return screen(lists);
  deps.conversations.start(chatId, PART_WASH_FLOW, "pick", { runId: newRunId(), personId: person.id });
  return screen(lists);
}

export function partWashStepHint(): string {
  return "Жми кнопки под списком: «Помыл» или «На склад». Текстом тут ничего не нужно.";
}

/** Один узел: помыт (→ сушка/склад по настройке Core) или убран на склад с сушки. */
async function moveOne(
  cb: { kind: "washed" | "stored"; unitId: string },
  person: PersonRow,
  runId: string,
  deps: PartWashDeps,
): Promise<{ ok: boolean; text: string }> {
  const clientKey = `pw:${runId}:${cb.kind === "washed" ? "w" : "s"}:${cb.unitId}`;
  try {
    const res =
      cb.kind === "washed"
        ? await deps.core.partWashed(cb.unitId, { personId: person.id, clientKey, actorRef: `person:${person.id}` })
        : await deps.core.partMove(cb.unitId, { to: "warehouse", personId: person.id, clientKey, actorRef: `person:${person.id}` });
    const where = res.unit.where?.location;
    const to = where === "drying" ? "на сушке" : where === "warehouse" ? "на складе" : (where ?? "перемещён");
    return { ok: true, text: `✅ ${res.unit.inventoryNo ?? kindOf(res.unit)} — ${to}` };
  } catch (e) {
    return { ok: false, text: `⚠️ ${cb.unitId.slice(0, 8)}: ${e instanceof Error ? e.message : "ошибка"}` };
  }
}

export async function handlePartWashCallback(
  chatId: number,
  cb: PartWashCallback,
  person: PersonRow,
  deps: PartWashDeps,
): Promise<{ answer: string; message?: StaffReply }> {
  const conv = deps.conversations.get(chatId);
  if (cb.kind === "done") {
    if (conv?.flow === PART_WASH_FLOW) deps.conversations.clear(chatId);
    return { answer: "Закончил", message: { text: "Ок. Что осталось на мойке — дождётся следующего раза." } };
  }
  if (conv?.flow !== PART_WASH_FLOW) {
    return { answer: "Кнопка устарела", message: { text: "Мастер мойки прервался. Начни заново кнопкой «🚿 Помыл узлы»." } };
  }
  const runId = String(conv.data.runId ?? "");

  let lists: { washing: PartUnitRow[]; drying: PartUnitRow[] };
  try {
    lists = await loadLists(deps);
  } catch (e) {
    return { answer: "Не вышло", message: { text: `Не смог прочитать мойку: ${e instanceof Error ? e.message : "ошибка"}.` } };
  }
  if (cb.kind === "refresh") return { answer: "Обновил", message: screen(lists) };

  const results: string[] = [];
  if (cb.kind === "washed" || cb.kind === "stored") {
    const pool = cb.kind === "washed" ? lists.washing : lists.drying;
    if (!pool.some((u) => u.id === cb.unitId)) {
      return { answer: "Уже не там", message: screen(lists, "Этот узел уже не в списке — кто-то отметил раньше.\n\n") };
    }
    results.push((await moveOne(cb, person, runId, deps)).text);
  } else {
    const pool = cb.kind === "washedAll" ? lists.washing : lists.drying;
    for (const u of pool) results.push((await moveOne({ kind: cb.kind === "washedAll" ? "washed" : "stored", unitId: u.id }, person, runId, deps)).text);
  }

  let after: { washing: PartUnitRow[]; drying: PartUnitRow[] };
  try {
    after = await loadLists(deps);
  } catch {
    after = { washing: [], drying: [] };
  }
  const summary = `${results.join("\n")}\n\n`;
  if (after.washing.length === 0 && after.drying.length === 0) {
    deps.conversations.clear(chatId);
    return { answer: "Готово", message: { text: `${summary}Мойка и сушка пусты — всё на складе. 👍` } };
  }
  return { answer: results.length === 1 ? results[0].slice(0, 60) : `Отмечено: ${results.length}`, message: screen(after, summary) };
}
