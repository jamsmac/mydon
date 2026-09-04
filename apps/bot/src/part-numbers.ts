import { PART_LABELS, PART_LOCATION_LABELS, partAttentionLabel, type PartKind, type PartLocation } from "@mydon/shared";
import type { CoreClient, PartUnitRow, PersonRow } from "./core-client";
import type { Conversations } from "./conversation";
import type { StaffReply } from "./staff";

/**
 * Мастер «🔢 Номера узлов» (pn:) — очередь «Наклеить номер» по одному узлу
 * (спека vendhub-parts, R-PU-2, R-PU-4).
 *
 * Номер узлу уже присвоила система; дело сотрудника — наклеить его на деталь
 * и нажать «Наклеил», либо вписать номер, который на детали уже есть.
 * «Пропустить» ничего не запоминает: следующему покажут снова — так и
 * задумано, очередь гаснет только сделанным.
 */

export interface PartNumberDeps {
  core: CoreClient;
  conversations: Conversations;
}

export const PART_NUMBER_FLOW = "part-number";

export type PartNumberCallback =
  | { kind: "ok"; unitId: string }
  | { kind: "edit"; unitId: string }
  | { kind: "skip"; unitId: string }
  | { kind: "assign"; unitId: string }
  | { kind: "done" };

export function parsePartNumberCallback(data: string): PartNumberCallback | null {
  if (data === "pn:x") return { kind: "done" };
  const m = /^pn:(ok|ed|sk|as):([0-9a-f-]{36})$/.exec(data);
  if (!m) return null;
  const map = { ok: "ok", ed: "edit", sk: "skip", as: "assign" } as const;
  return { kind: map[m[1] as keyof typeof map], unitId: m[2] };
}

/** «номера», «наклеить», «инвентарный» — с якорем, как у всех триггеров меню. */
export function isPartNumberTrigger(text: string): boolean {
  return /^(номер[аы]? узл|наклеи|наклей|инвентарн|проставить номер)/i.test(text.trim());
}

/** Только то, что касается номеров: без номера или наклейка не подтверждена. */
function numberingQueue(items: PartUnitRow[]): PartUnitRow[] {
  return items.filter((u) => u.attention.includes("no_number") || u.attention.includes("label_pending"));
}

function whereText(u: PartUnitRow): string {
  if (!u.where) return "местонахождение неизвестно";
  if (u.where.machineName) return `${u.where.machineName}${u.where.slot !== null ? `, слот ${u.where.slot}` : ""}`;
  return PART_LOCATION_LABELS[u.where.location as PartLocation] ?? u.where.location;
}

function card(u: PartUnitRow, pos: number, total: number): StaffReply {
  const kind = PART_LABELS[u.partKind as PartKind] ?? u.partKind;
  const lines = [`🔢 ${pos} из ${total}`, `🔧 ${kind}${u.inventoryNo ? ` — номер ${u.inventoryNo}` : " — номера нет"}`, `📍 ${whereText(u)}`];
  if (u.serialNumber) lines.push(`🆔 S/N ${u.serialNumber}`);
  const other = u.attention.filter((a) => a !== "no_number" && a !== "label_pending");
  if (other.length) lines.push(`⚠️ ${other.map(partAttentionLabel).join(", ")}`);
  lines.push(
    u.inventoryNo
      ? "Наклей этот номер на деталь и нажми «Наклеил». Если на детали уже есть свой номер — «Другой номер»."
      : "Номера ещё нет — нажми «Присвоить», система даст следующий по серии.",
  );
  const rows: { text: string; callback_data: string }[][] = [];
  if (u.inventoryNo) rows.push([{ text: `✅ Наклеил ${u.inventoryNo}`, callback_data: `pn:ok:${u.id}` }]);
  else rows.push([{ text: "🔢 Присвоить номер", callback_data: `pn:as:${u.id}` }]);
  rows.push([
    { text: "✏️ Другой номер", callback_data: `pn:ed:${u.id}` },
    { text: "⏭ Пропустить", callback_data: `pn:sk:${u.id}` },
  ]);
  rows.push([{ text: "✖️ Закончить", callback_data: "pn:x" }]);
  return { text: lines.join("\n"), keyboard: { inline_keyboard: rows } };
}

/** Показать текущий узел очереди или закрыть мастер, если очередь кончилась. */
async function showNext(chatId: number, deps: PartNumberDeps): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== PART_NUMBER_FLOW) return { text: "Мастер номеров прервался. Начни заново кнопкой «🔢 Номера узлов»." };
  const ids = (conv.data.ids ?? []) as string[];
  const skipped = (conv.data.skipped ?? []) as string[];
  const done = (conv.data.done ?? []) as string[];
  const remaining = ids.filter((id) => !skipped.includes(id) && !done.includes(id));
  if (remaining.length === 0) {
    deps.conversations.clear(chatId);
    const doneN = done.length;
    return {
      text:
        doneN > 0
          ? `Готово: номеров проставлено/подтверждено ${doneN}.${skipped.length ? ` Пропущено ${skipped.length} — они вернутся в следующий раз.` : ""}`
          : skipped.length
            ? `Все ${skipped.length} пропущены — вернутся в следующий раз.`
            : "Очередь пуста: все номера наклеены.",
    };
  }
  let unit: PartUnitRow;
  try {
    unit = await deps.core.partUnit(remaining[0]);
  } catch {
    deps.conversations.advance(chatId, "pick", { skipped: [...skipped, remaining[0]] });
    return showNext(chatId, deps);
  }
  deps.conversations.advance(chatId, "pick", { current: unit.id });
  return card(unit, ids.length - remaining.length + 1, ids.length);
}

export async function startPartNumbers(chatId: number, person: PersonRow, deps: PartNumberDeps): Promise<StaffReply> {
  let queue: { counts: Record<string, number>; items: PartUnitRow[] };
  try {
    queue = await deps.core.partsQueue();
  } catch (e) {
    return { text: `Не смог прочитать очередь узлов: ${e instanceof Error ? e.message : "ошибка"}.` };
  }
  const items = numberingQueue(queue.items);
  if (items.length === 0) {
    return { text: "Все узлы с номерами и наклейками — очередь пуста. 👍" };
  }
  deps.conversations.start(chatId, PART_NUMBER_FLOW, "pick", {
    ids: items.map((u) => u.id),
    skipped: [],
    done: [],
    personId: person.id,
  });
  const first = await showNext(chatId, deps);
  return { ...first, text: `Узлов ждут наклейки: ${items.length}. Идём по одному.\n\n${first.text}` };
}

export function partNumberStepHint(step: string): string {
  return step === "number" ? "Напиши номер с наклейки (например M-017 или H-27-3) или нажми «Отмена»." : "Жми кнопки под карточкой узла.";
}

/** Текст сотрудника на шаге «свой номер». */
export async function handlePartNumberText(chatId: number, text: string, person: PersonRow, deps: PartNumberDeps): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== PART_NUMBER_FLOW || conv.step !== "number") return { text: partNumberStepHint(conv?.step ?? "") };
  const unitId = String(conv.data.current ?? "");
  const value = text.trim().slice(0, 32);
  try {
    const u = await deps.core.partSetNumber(unitId, { inventoryNo: value, confirmLabel: true, actorRef: `person:${person.id}` });
    deps.conversations.advance(chatId, "pick", { done: [...((conv.data.done ?? []) as string[]), unitId] });
    const next = await showNext(chatId, deps);
    return { ...next, text: `✅ ${PART_LABELS[u.partKind as PartKind] ?? u.partKind} теперь ${u.inventoryNo}.\n\n${next.text}` };
  } catch (e) {
    deps.conversations.advance(chatId, "number", {});
    return {
      text: `Не принял номер: ${e instanceof Error ? e.message : "ошибка"}. Напиши другой или нажми «Отмена».`,
      keyboard: { inline_keyboard: [[{ text: "✖️ Отмена", callback_data: `pn:sk:${unitId}` }]] },
    };
  }
}

export async function handlePartNumberCallback(
  chatId: number,
  cb: PartNumberCallback,
  person: PersonRow,
  deps: PartNumberDeps,
): Promise<{ answer: string; message?: StaffReply }> {
  const conv = deps.conversations.get(chatId);
  if (cb.kind === "done") {
    if (conv?.flow === PART_NUMBER_FLOW) deps.conversations.clear(chatId);
    return { answer: "Закончил", message: { text: "Ок. Остальные узлы подождут — очередь никуда не денется." } };
  }
  if (conv?.flow !== PART_NUMBER_FLOW) {
    return { answer: "Кнопка устарела", message: { text: "Мастер номеров прервался. Начни заново кнопкой «🔢 Номера узлов»." } };
  }
  const done = (conv.data.done ?? []) as string[];
  const skipped = (conv.data.skipped ?? []) as string[];

  if (cb.kind === "skip") {
    deps.conversations.advance(chatId, "pick", { skipped: [...skipped, cb.unitId] });
    return { answer: "Пропущено", message: await showNext(chatId, deps) };
  }
  if (cb.kind === "edit") {
    deps.conversations.advance(chatId, "number", { current: cb.unitId });
    return {
      answer: "Свой номер",
      message: {
        text: "Напиши номер, который на детали (латиница, цифры, дефис — например M-017 или H-27-3).",
        keyboard: { inline_keyboard: [[{ text: "✖️ Отмена", callback_data: `pn:sk:${cb.unitId}` }]] },
      },
    };
  }
  // ok / assign — подтверждение наклейки или присвоение номера системой
  try {
    const u = await deps.core.partSetNumber(cb.unitId, {
      ...(cb.kind === "ok" ? { confirmLabel: true } : {}),
      actorRef: `person:${person.id}`,
    });
    if (cb.kind === "assign") {
      // Номер дан — деталь ещё без наклейки: показываем ту же карточку с «Наклеил».
      return { answer: `Номер ${u.inventoryNo}`, message: card(u, done.length + 1, ((conv.data.ids ?? []) as string[]).length) };
    }
    deps.conversations.advance(chatId, "pick", { done: [...done, cb.unitId] });
    const next = await showNext(chatId, deps);
    return { answer: `Наклеен ${u.inventoryNo}`, message: { ...next, text: `✅ ${u.inventoryNo} — наклейка подтверждена.\n\n${next.text}` } };
  } catch (e) {
    return { answer: "Не вышло", message: { text: `Не смог сохранить: ${e instanceof Error ? e.message : "ошибка"}. Попробуй ещё раз.` } };
  }
}
