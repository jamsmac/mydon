import { COMMON_PART_KINDS, PART_KINDS, PART_LABELS, PART_LOCATION_LABELS, type PartKind } from "@mydon/shared";
import type { CoreClient, PartCountLineRow, PartCountSummaryRow, PersonRow } from "./core-client";
import type { Conversations } from "./conversation";
import { newRunId } from "./staff-refill";
import type { StaffReply } from "./staff";

/**
 * Мастер «🗂 Инвентаризация узлов» (pc:) — спека vendhub-parts, R-PU-7, У4.
 *
 * Место (склад / мойка / сушка / ремонт) → цикл по одному узлу: вид → номер
 * с наклейки (или нет) → серийник (или нет) → СНАЧАЛА ЗАПИСЬ, ПОТОМ ФОТО
 * (или причина пропуска) → следующий. «Закончить» отдаёт сводку; применяет
 * сессию владелец в панели — не сотрудник со склада. Черновик живёт в Core:
 * оборвалась связь — «Инвентаризация узлов» продолжает ту же сессию.
 */

export interface PartCountDeps {
  core: CoreClient;
  conversations: Conversations;
}

export const PART_COUNT_FLOW = "part-count";

const LOCATIONS = ["warehouse", "washing", "drying", "repair"] as const;
type CountLocation = (typeof LOCATIONS)[number];

/** Что считают на складе чаще всего — первыми; остальное за «ещё». */
const COUNT_COMMON_KINDS: readonly PartKind[] = ["mixer", "hopper", "grinder", "brewer", "water_filter", ...COMMON_PART_KINDS.filter((k) => !["mixer", "grinder", "brewer", "water_filter"].includes(k))];

export type PartCountCallback =
  | { kind: "location"; location: CountLocation }
  | { kind: "part"; part: PartKind }
  | { kind: "moreParts" }
  | { kind: "backToKind" }
  | { kind: "noNumber" }
  | { kind: "noSerial" }
  | { kind: "noPhoto" }
  | { kind: "removeLine" }
  | { kind: "finish" }
  | { kind: "cancel" };

export function parsePartCountCallback(data: string): PartCountCallback | null {
  const simple: Record<string, PartCountCallback> = {
    "pc:more": { kind: "moreParts" },
    "pc:k0": { kind: "backToKind" },
    "pc:n0": { kind: "noNumber" },
    "pc:s0": { kind: "noSerial" },
    "pc:p0": { kind: "noPhoto" },
    "pc:rm": { kind: "removeLine" },
    "pc:f": { kind: "finish" },
    "pc:x": { kind: "cancel" },
  };
  if (simple[data]) return simple[data];
  const loc = /^pc:l:([a-z]{4,12})$/.exec(data);
  if (loc && (LOCATIONS as readonly string[]).includes(loc[1])) return { kind: "location", location: loc[1] as CountLocation };
  const part = /^pc:k:([a-z_]{3,20})$/.exec(data);
  if (part && (PART_KINDS as readonly string[]).includes(part[1])) return { kind: "part", part: part[1] as PartKind };
  return null;
}

/** «инвентаризация узлов», «посчитать узлы» — раньше складской «инвентар…» в меню, иначе перехватит склад. */
export function isPartCountTrigger(text: string): boolean {
  return /^(инвентаризац\S*\s+узл|пересч\S*\s+узл|посчита\S*\s+узл|узлы\s+на\s+склад)/i.test(text.trim());
}

function kindKeyboard(all: boolean): NonNullable<StaffReply["keyboard"]> {
  const list = all ? PART_KINDS : COUNT_COMMON_KINDS;
  const rows: { text: string; callback_data: string }[][] = [];
  list.forEach((k, i) => {
    if (i % 2 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: PART_LABELS[k], callback_data: `pc:k:${k}` });
  });
  if (!all) rows.push([{ text: "⋯ Другой узел", callback_data: "pc:more" }]);
  rows.push([{ text: "🏁 Закончить", callback_data: "pc:f" }]);
  return { inline_keyboard: rows };
}

function numberKeyboard(): NonNullable<StaffReply["keyboard"]> {
  return {
    inline_keyboard: [[{ text: "Номера нет", callback_data: "pc:n0" }], [{ text: "↩️ Другой узел", callback_data: "pc:k0" }]],
  };
}

function serialKeyboard(): NonNullable<StaffReply["keyboard"]> {
  return {
    inline_keyboard: [[{ text: "Нет / не читается", callback_data: "pc:s0" }], [{ text: "↩️ Другой узел", callback_data: "pc:k0" }]],
  };
}

function photoKeyboard(required: boolean): NonNullable<StaffReply["keyboard"]> {
  return {
    inline_keyboard: [
      [{ text: required ? "Без фото (с причиной)" : "Без фото", callback_data: "pc:p0" }],
      [{ text: "🗑 Убрать эту строку", callback_data: "pc:rm" }],
    ],
  };
}

function locLabel(location: string): string {
  return (PART_LOCATION_LABELS[location as CountLocation] ?? location).toLowerCase();
}

function header(conv: { data: Record<string, unknown> }): string {
  return `🗂 ${locLabel(String(conv.data.location ?? ""))} · введено ${Number(conv.data.count ?? 0)}`;
}

function askKind(conv: { data: Record<string, unknown> }, prefix = ""): StaffReply {
  return { text: `${prefix}${header(conv)}\nКакой узел в руках?`, keyboard: kindKeyboard(false) };
}

export async function startPartCount(chatId: number, _person: PersonRow, deps: PartCountDeps): Promise<StaffReply> {
  deps.conversations.start(chatId, PART_COUNT_FLOW, "location", { runId: newRunId(), count: 0 });
  const rows = LOCATIONS.map((l) => [{ text: PART_LOCATION_LABELS[l], callback_data: `pc:l:${l}` }]);
  rows.push([{ text: "✖️ Отмена", callback_data: "pc:x" }]);
  return { text: "🗂 Инвентаризация узлов. Где считаем?", keyboard: { inline_keyboard: rows } };
}

export function partCountStepHint(step: string): string {
  switch (step) {
    case "location":
      return "Выбери место кнопкой: склад, мойка, сушка или ремонт.";
    case "kind":
      return "Выбери вид узла кнопкой или «Закончить».";
    case "number":
      return "Напиши номер с наклейки (например M-017) или нажми «Номера нет».";
    case "serial":
      return "Напиши серийник с шильдика или нажми «Нет».";
    case "photo":
      return "Пришли фото узла или нажми «Без фото».";
    case "reason":
      return "Напиши, почему без фото — одной строкой.";
    default:
      return "Продолжай по кнопкам.";
  }
}

function lineText(res: { line: PartCountLineRow; status: "found" | "new" }): string {
  if (res.status === "new") return `🆕 ${res.line.label} — в реестре нет, карточка заведётся при применении.`;
  const where = res.line.registeredAt;
  if (!where) return `✅ ${res.line.label} — найден.`;
  const here = ["warehouse", "washing", "drying", "repair", "unknown"].includes(where) ? null : where;
  return here
    ? `✅ ${res.line.label} — найден, но числился на «${here}». При применении переедет сюда.`
    : `✅ ${res.line.label} — найден${where === "unknown" ? " (место было неизвестно)" : ""}.`;
}

/** Записать строку в Core (до фото) и перейти к шагу фото. */
async function recordLine(chatId: number, person: PersonRow, deps: PartCountDeps): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== PART_COUNT_FLOW) return { text: "Инвентаризация прервалась. Начни заново кнопкой «🗂 Инвентаризация узлов»." };
  const sessionId = String(conv.data.sessionId ?? "");
  const partKind = String(conv.data.partKind ?? "");
  const n = Number(conv.data.count ?? 0) + 1;
  const inventoryNo = typeof conv.data.inventoryNo === "string" ? conv.data.inventoryNo : undefined;
  const serialNumber = typeof conv.data.serial === "string" ? conv.data.serial : undefined;
  try {
    const res = await deps.core.partCountAddLine(sessionId, {
      partKind,
      ...(inventoryNo ? { inventoryNo } : {}),
      ...(serialNumber ? { serialNumber } : {}),
      clientKey: `pc:${String(conv.data.runId ?? "")}:${n}`,
      actorRef: `person:${person.id}`,
    });
    const required = conv.data.photoRequired !== false;
    deps.conversations.advance(chatId, "photo", { lineId: res.line.id, count: n, inventoryNo: null, serial: null, photos: 0 });
    return {
      text: `${lineText(res)}\n\n📷 Сфотографируй узел${required ? " — фото обязательно" : ", если есть чем"}.`,
      keyboard: photoKeyboard(required),
    };
  } catch (e) {
    deps.conversations.advance(chatId, "number", { inventoryNo: null, serial: null });
    return {
      text: `Не принял: ${e instanceof Error ? e.message : "ошибка"}.\nНапиши номер ещё раз или нажми «Номера нет».`,
      keyboard: numberKeyboard(),
    };
  }
}

/** Текст сотрудника: номер, серийник, причина пропуска фото. */
export async function handlePartCountText(chatId: number, text: string, person: PersonRow, deps: PartCountDeps): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== PART_COUNT_FLOW) return { text: partCountStepHint("") };
  const value = text.trim().slice(0, 128);
  if (conv.step === "number") {
    deps.conversations.advance(chatId, "serial", { inventoryNo: value.slice(0, 32) });
    return { text: `Номер ${value.slice(0, 32)}. Серийник с шильдика?`, keyboard: serialKeyboard() };
  }
  if (conv.step === "serial") {
    deps.conversations.advance(chatId, "serial", { serial: value });
    return recordLine(chatId, person, deps);
  }
  if (conv.step === "reason") {
    const lineId = String(conv.data.lineId ?? "");
    try {
      await deps.core.partCountSkipPhoto(lineId, value);
    } catch (e) {
      return { text: `Причину не сохранил: ${e instanceof Error ? e.message : "ошибка"}. Напиши ещё раз.` };
    }
    deps.conversations.advance(chatId, "kind", { lineId: null });
    return askKind(deps.conversations.get(chatId)!, "Записал без фото — узел попадёт в очередь «без фото».\n\n");
  }
  return { text: partCountStepHint(conv.step) };
}

/** Фото узла на шаге «photo». null — шаг сейчас не активен. */
export async function handlePartCountPhoto(
  chatId: number,
  file: { bytes: Buffer; mime: string | null },
  person: PersonRow,
  deps: PartCountDeps,
): Promise<StaffReply | null> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== PART_COUNT_FLOW || conv.step !== "photo") return null;
  const lineId = String(conv.data.lineId ?? "");
  const count = Number(conv.data.photos ?? 0) + 1;
  try {
    await deps.core.uploadPhoto({
      ownerType: "part_count_line",
      ownerId: lineId,
      bytes: file.bytes,
      mime: file.mime,
      filename: `count-${count}.${file.mime === "image/png" ? "png" : "jpg"}`,
      createdBy: `person:${person.id}`,
      stage: "count",
    });
  } catch (e) {
    return { text: `Фото не сохранилось: ${e instanceof Error ? e.message : "ошибка"}. Пришли ещё раз или «Без фото».`, keyboard: photoKeyboard(conv.data.photoRequired !== false) };
  }
  deps.conversations.advance(chatId, "kind", { lineId: null, photos: 0 });
  return askKind(deps.conversations.get(chatId)!, `📷 Фото есть.\n\n`);
}

function summaryText(s: PartCountSummaryRow): string {
  const lines = [
    `🏁 Инвентаризация: ${locLabel(s.session.location)}.`,
    `Введено ${s.lines.length}: найдено ${s.found}, новых ${s.fresh}${s.moved ? `, числились не здесь ${s.moved}` : ""}.`,
  ];
  if (s.missing.length > 0) {
    lines.push(`Не найдено ${s.missing.length}: ${s.missing.slice(0, 8).map((u) => u.inventoryNo ?? u.label).join(", ")}${s.missing.length > 8 ? "…" : ""}.`);
  } else {
    lines.push("Не найденных нет — всё, что числилось, на месте.");
  }
  const noPhoto = s.lines.filter((l) => l.photoCount === 0).length;
  if (noPhoto > 0) lines.push(`Без фото: ${noPhoto}.`);
  lines.push("Владелец применит сессию в панели (/parts/count) — тогда новые узлы получат карточки, а не найденные уйдут в «неизвестно где».");
  return lines.join("\n");
}

export async function handlePartCountCallback(
  chatId: number,
  cb: PartCountCallback,
  person: PersonRow,
  deps: PartCountDeps,
): Promise<{ answer: string; message?: StaffReply }> {
  const conv = deps.conversations.get(chatId);
  if (cb.kind === "cancel") {
    if (conv !== null && conv.flow !== PART_COUNT_FLOW) {
      return { answer: "Кнопка устарела", message: { text: "Эта кнопка от прошлого шага — она уже не действует." } };
    }
    deps.conversations.clear(chatId);
    return { answer: "Отменено", message: { text: "Ок. Введённое не пропало — сессия ждёт в Core, «Инвентаризация узлов» продолжит её." } };
  }
  if (conv?.flow !== PART_COUNT_FLOW) {
    return { answer: "Кнопка устарела", message: { text: "Инвентаризация прервалась. Начни заново кнопкой «🗂 Инвентаризация узлов»." } };
  }

  if (cb.kind === "location") {
    let started: Awaited<ReturnType<CoreClient["partCountStart"]>>;
    try {
      started = await deps.core.partCountStart({ location: cb.location, personId: person.id, actorRef: `person:${person.id}` });
    } catch (e) {
      deps.conversations.clear(chatId);
      return { answer: "Не вышло", message: { text: `Не смог открыть сессию: ${e instanceof Error ? e.message : "ошибка"}.` } };
    }
    deps.conversations.advance(chatId, "kind", {
      sessionId: started.session.id,
      location: cb.location,
      photoRequired: started.photoRequired,
    });
    const intro = started.resumed
      ? `Продолжаем начатую сессию (${locLabel(cb.location)}). По учёту здесь ${started.expected} узлов.\n\n`
      : `Открыл сессию: ${locLabel(cb.location)}. По учёту здесь ${started.expected} узлов — сверим по одному.\n\n`;
    return { answer: PART_LOCATION_LABELS[cb.location], message: askKind(deps.conversations.get(chatId)!, intro) };
  }

  if (cb.kind === "moreParts") {
    return { answer: "Все узлы", message: { text: "Какой узел?", keyboard: kindKeyboard(true) } };
  }
  if (cb.kind === "part") {
    deps.conversations.advance(chatId, "number", { partKind: cb.part, inventoryNo: null, serial: null });
    return { answer: PART_LABELS[cb.part], message: { text: `${PART_LABELS[cb.part]}. Номер с наклейки?`, keyboard: numberKeyboard() } };
  }
  if (cb.kind === "backToKind") {
    deps.conversations.advance(chatId, "kind", { inventoryNo: null, serial: null });
    return { answer: "Другой узел", message: askKind(deps.conversations.get(chatId)!) };
  }
  if (cb.kind === "noNumber") {
    if (conv.step !== "number") return { answer: "Не тот шаг" };
    deps.conversations.advance(chatId, "serial", { inventoryNo: null });
    return { answer: "Без номера", message: { text: "Серийник с шильдика? По нему Core попробует узнать узел.", keyboard: serialKeyboard() } };
  }
  if (cb.kind === "noSerial") {
    if (conv.step !== "serial") return { answer: "Не тот шаг" };
    deps.conversations.advance(chatId, "serial", { serial: null });
    return { answer: "Без серийника", message: await recordLine(chatId, person, deps) };
  }
  if (cb.kind === "noPhoto") {
    if (conv.step !== "photo") return { answer: "Не тот шаг" };
    if (conv.data.photoRequired !== false) {
      deps.conversations.advance(chatId, "reason", {});
      return { answer: "Причина", message: { text: "Почему без фото? Напиши одной строкой — узел попадёт в очередь «без фото»." } };
    }
    deps.conversations.advance(chatId, "kind", { lineId: null });
    return { answer: "Без фото", message: askKind(deps.conversations.get(chatId)!) };
  }
  if (cb.kind === "removeLine") {
    if (conv.step !== "photo" && conv.step !== "reason") return { answer: "Не тот шаг" };
    const lineId = String(conv.data.lineId ?? "");
    try {
      await deps.core.partCountRemoveLine(lineId, `person:${person.id}`);
    } catch (e) {
      return { answer: "Не вышло", message: { text: `Строку не убрал: ${e instanceof Error ? e.message : "ошибка"}.` } };
    }
    deps.conversations.advance(chatId, "kind", { lineId: null, count: Math.max(0, Number(conv.data.count ?? 1) - 1) });
    return { answer: "Убрал", message: askKind(deps.conversations.get(chatId)!, "Строку убрал.\n\n") };
  }
  // finish
  const sessionId = String(conv.data.sessionId ?? "");
  if (!sessionId) {
    deps.conversations.clear(chatId);
    return { answer: "Закончил", message: { text: "Сессия не открывалась — нечего заканчивать." } };
  }
  let summary: PartCountSummaryRow;
  try {
    summary = await deps.core.partCountFinish(sessionId, `person:${person.id}`);
  } catch (e) {
    return { answer: "Не вышло", message: { text: `Не смог закрыть сессию: ${e instanceof Error ? e.message : "ошибка"}. Попробуй ещё раз.` } };
  }
  deps.conversations.clear(chatId);
  return { answer: "Готово", message: { text: summaryText(summary) } };
}
