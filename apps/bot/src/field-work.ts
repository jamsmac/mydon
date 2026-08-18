import {
  COMMON_PART_KINDS,
  INSPECTION_KIND,
  INSPECTION_LABELS,
  INSPECTION_TYPES,
  PART_KINDS,
  PART_LABELS,
  PART_SWAP_REASONS,
  SWAP_REASON_LABELS,
  SYMPTOM_LABELS,
  PROBLEM_SYMPTOMS,
  PROBLEM_URGENCIES,
  URGENCY_LABELS,
  URGENCY_PRIORITY,
  type InspectionType,
  type PartKind,
  type PartSwapReason,
  type ProblemSymptom,
  type ProblemUrgency,
} from "@mydon/shared";
import type { CoreClient, PersonRow } from "./core-client";
import type { Conversations } from "./conversation";
import { objectName, pickObject } from "./machine-picker";
import { newRunId } from "./staff-refill";
import type { StaffReply } from "./staff";

/**
 * Полевые мастера: замена узла, чистка, технический осмотр, поломка.
 *
 * Общий принцип всех четырёх: СНАЧАЛА ЗАПИСАТЬ, ПОТОМ ФОТО. Порядок
 * неочевидный, но единственно верный для полевой работы — на точке связь
 * рвётся, и если сначала просить снимок, то при обрыве теряется сам факт
 * работы, а не только картинка. Запись сохраняется на предпоследнем шаге,
 * фото предлагается уже к сохранённой записи и необязательно.
 *
 * Второй принцип: минимум ввода текстом. Всё, что можно выбрать кнопкой,
 * выбирается кнопкой; текстом вводятся только серийный номер и заметка,
 * и оба пропускаются одним нажатием.
 */

export interface FieldDeps {
  core: CoreClient;
  conversations: Conversations;
}

/**
 * Ключ идемпотентности мастера: повтор ТОГО ЖЕ нажатия несёт то же значение.
 *
 * Таймаут клиента при успехе на сервере + честный ретрай раньше давали вторую
 * замену/чистку/заявку (образец решения — refillClientKey у заливок).
 * В ключ входит и финальный выбор (`last`): если после сбоя человек нажал
 * ДРУГУЮ кнопку, это другое действие, а не повтор — дедупить его нельзя.
 */
function masterClientKey(
  prefix: string,
  data: Record<string, unknown>,
  last: string,
): { clientKey: string } | Record<string, never> {
  return typeof data.runId === "string" ? { clientKey: `${prefix}:${data.runId}:${last}` } : {};
}

/** Флоу мастеров — те же строки, что в Conversations.flow. */
export const FIELD_FLOWS = ["part-replace", "clean", "service-check", "problem"] as const;
export type FieldFlow = (typeof FIELD_FLOWS)[number];

// ── Замена узла (pt:) ───────────────────────────────────────────────────────

export type PartReplaceCallback =
  | { kind: "part"; part: PartKind }
  | { kind: "morePartsPage" }
  | { kind: "noSerial" }
  | { kind: "reason"; reason: PartSwapReason }
  | { kind: "cancel" };

export function parsePartReplaceCallback(data: string): PartReplaceCallback | null {
  if (data === "pt:more") return { kind: "morePartsPage" };
  if (data === "pt:s0") return { kind: "noSerial" };
  if (data === "pt:x") return { kind: "cancel" };
  const part = /^pt:u:([a-z_]{3,20})$/.exec(data);
  if (part && (PART_KINDS as readonly string[]).includes(part[1])) {
    return { kind: "part", part: part[1] as PartKind };
  }
  const reason = /^pt:r:([a-z]{4,10})$/.exec(data);
  if (reason && (PART_SWAP_REASONS as readonly string[]).includes(reason[1])) {
    return { kind: "reason", reason: reason[1] as PartSwapReason };
  }
  return null;
}

function partKeyboard(all: boolean): NonNullable<StaffReply["keyboard"]> {
  const list = all ? PART_KINDS : COMMON_PART_KINDS;
  const rows: { text: string; callback_data: string }[][] = [];
  list.forEach((k, i) => {
    if (i % 2 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: PART_LABELS[k], callback_data: `pt:u:${k}` });
  });
  // Показывать технику 21 кнопку значит заставить его листать там, где нужны
  // три. Редкие узлы — за «ещё».
  if (!all) rows.push([{ text: "⋯ Другой узел", callback_data: "pt:more" }]);
  rows.push([{ text: "✖️ Отмена", callback_data: "pt:x" }]);
  return { inline_keyboard: rows };
}

function reasonKeyboard(): NonNullable<StaffReply["keyboard"]> {
  const rows: { text: string; callback_data: string }[][] = [];
  PART_SWAP_REASONS.forEach((r, i) => {
    if (i % 2 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: SWAP_REASON_LABELS[r], callback_data: `pt:r:${r}` });
  });
  rows.push([{ text: "✖️ Отмена", callback_data: "pt:x" }]);
  return { inline_keyboard: rows };
}

export async function startPartReplace(chatId: number, person: PersonRow, deps: FieldDeps): Promise<StaffReply> {
  deps.conversations.start(chatId, "part-replace", "object", { runId: newRunId() });
  return pickObject(person, deps, "🔧 Замена детали. На каком автомате?");
}

export function partReplaceStepHint(step: string): string {
  switch (step) {
    case "object":
      return "Выбери автомат кнопкой.";
    case "part":
      return "Выбери узел кнопкой.";
    case "serial":
      return "Напиши серийный номер нового узла или жми «Не знаю».";
    case "reason":
      return "Выбери причину замены кнопкой.";
    default:
      return "Продолжай по кнопкам.";
  }
}

/** Шаг «серийник»: текст сотрудника. */
export function handlePartSerial(chatId: number, text: string, deps: FieldDeps): StaffReply {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "part-replace" || conv.step !== "serial") {
    return { text: "Замена прервалась. Начни заново кнопкой «🔧 Замена детали»." };
  }
  deps.conversations.advance(chatId, "reason", { newSerial: text.trim().slice(0, 64) });
  return { text: "Почему меняли?", keyboard: reasonKeyboard() };
}

export async function handlePartReplaceCallback(
  chatId: number,
  cb: PartReplaceCallback,
  person: PersonRow,
  deps: FieldDeps,
): Promise<{ answer: string; message?: StaffReply }> {
  if (cb.kind === "cancel") {
    // Барьер #149, распространённый на некофейные мастера: «Отмена» с чужого
    // устаревшего экрана не должна гасить текущее дело — слот беседы один,
    // а кнопки живут в чате вечно.
    const current = deps.conversations.get(chatId);
    if (current !== null && current.flow !== "part-replace") {
      return { answer: "Кнопка устарела", message: { text: "Эта кнопка от прошлого шага — она уже не действует." } };
    }
    deps.conversations.clear(chatId);
    return { answer: "Отменено", message: { text: "Замену отменил." } };
  }
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "part-replace") {
    return { answer: "Мастер истёк", message: { text: "Замена прервалась. Начни заново." } };
  }

  if (cb.kind === "morePartsPage") {
    return { answer: "Все узлы", message: { text: "Какой узел?", keyboard: partKeyboard(true) } };
  }

  if (cb.kind === "part") {
    deps.conversations.advance(chatId, "serial", { partKind: cb.part });
    return {
      answer: PART_LABELS[cb.part],
      message: {
        text: `${PART_LABELS[cb.part]}. Серийный номер нового узла?`,
        keyboard: {
          inline_keyboard: [
            [{ text: "Не знаю / нет номера", callback_data: "pt:s0" }],
            [{ text: "✖️ Отмена", callback_data: "pt:x" }],
          ],
        },
      },
    };
  }

  if (cb.kind === "noSerial") {
    deps.conversations.advance(chatId, "reason", { newSerial: null });
    return { answer: "Без номера", message: { text: "Почему меняли?", keyboard: reasonKeyboard() } };
  }

  // Причина — последний шаг: записываем.
  const entityId = String(conv.data.entityId ?? "");
  const partKind = String(conv.data.partKind ?? "");
  if (!entityId || !partKind) {
    deps.conversations.clear(chatId);
    return { answer: "Данные потерялись", message: { text: "Что-то потерялось — начни заново." } };
  }
  const newSerial = conv.data.newSerial as string | null | undefined;
  const name = String(conv.data.entityName ?? "автомат");

  const res = await deps.core.swapPart({
    machineId: entityId,
    partKind,
    ...(newSerial ? { newSerial } : {}),
    reason: cb.reason,
    personId: person.id,
    ...masterClientKey("pt", conv.data, cb.reason),
    createdBy: `person:${person.id}`,
  });

  const oldLine = res.removed?.serialNumber
    ? `\n🔁 Снят: ${res.removed.serialNumber}`
    : res.removed
      ? "\n🔁 Снят прежний узел (номер не был записан)"
      : "\n🆕 Первая установка — прежнего узла в реестре не было";

  return {
    answer: "Замена записана",
    message: {
      text:
        `✅ Записал замену.\n🏷 ${name}\n🔧 ${PART_LABELS[partKind as PartKind]}` +
        `${newSerial ? `\n🆔 Новый: ${newSerial}` : ""}${oldLine}\n` +
        `📋 Причина: ${SWAP_REASON_LABELS[cb.reason]}${photoHint()}`,
      keyboard: afterPhotoKeyboard(),
    },
    ...startAfterPhoto(chatId, "maintenance_log", res.log.id, "замене", deps),
  };
}

// ── Чистка автомата (cl:) ───────────────────────────────────────────────────

export type CleanCallback =
  | { kind: "target"; part: PartKind | "all" }
  | { kind: "sanitation" }
  | { kind: "cancel" };

export function parseCleanCallback(data: string): CleanCallback | null {
  if (data === "cl:x") return { kind: "cancel" };
  if (data === "cl:san") return { kind: "sanitation" };
  if (data === "cl:w:all") return { kind: "target", part: "all" };
  const m = /^cl:w:([a-z_]{3,20})$/.exec(data);
  if (m && (PART_KINDS as readonly string[]).includes(m[1])) {
    return { kind: "target", part: m[1] as PartKind };
  }
  return null;
}

/** Что чистят чаще всего. Полный список тут не нужен — чистят не всё. */
const CLEANABLE: readonly PartKind[] = ["mixer", "brewer", "hopper", "grinder", "cooling_unit", "water_filter"];

function cleanKeyboard(): NonNullable<StaffReply["keyboard"]> {
  const rows: { text: string; callback_data: string }[][] = [];
  CLEANABLE.forEach((k, i) => {
    if (i % 2 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: PART_LABELS[k], callback_data: `cl:w:${k}` });
  });
  rows.push([{ text: "🧽 Автомат целиком", callback_data: "cl:w:all" }]);
  rows.push([{ text: "🧴 Санобработка", callback_data: "cl:san" }]);
  rows.push([{ text: "✖️ Отмена", callback_data: "cl:x" }]);
  return { inline_keyboard: rows };
}

export async function startClean(chatId: number, person: PersonRow, deps: FieldDeps): Promise<StaffReply> {
  deps.conversations.start(chatId, "clean", "object", { runId: newRunId() });
  return pickObject(person, deps, "🧽 Чистка. На каком автомате?");
}

export async function handleCleanCallback(
  chatId: number,
  cb: CleanCallback,
  person: PersonRow,
  deps: FieldDeps,
): Promise<{ answer: string; message?: StaffReply }> {
  if (cb.kind === "cancel") {
    // Барьер #149, распространённый на некофейные мастера: «Отмена» с чужого
    // устаревшего экрана не должна гасить текущее дело — слот беседы один,
    // а кнопки живут в чате вечно.
    const current = deps.conversations.get(chatId);
    if (current !== null && current.flow !== "clean") {
      return { answer: "Кнопка устарела", message: { text: "Эта кнопка от прошлого шага — она уже не действует." } };
    }
    deps.conversations.clear(chatId);
    return { answer: "Отменено", message: { text: "Чистку отменил." } };
  }
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "clean") {
    return { answer: "Мастер истёк", message: { text: "Чистка прервалась. Начни заново." } };
  }
  const entityId = String(conv.data.entityId ?? "");
  if (!entityId) {
    deps.conversations.clear(chatId);
    return { answer: "Данные потерялись", message: { text: "Что-то потерялось — начни заново." } };
  }
  const name = String(conv.data.entityName ?? "автомат");

  const isSanitation = cb.kind === "sanitation";
  const partKind = !isSanitation && cb.part !== "all" ? cb.part : undefined;
  const log = await deps.core.createMaintenanceLog({
    entityId,
    kind: isSanitation ? "sanitation" : "cleaning",
    ...(partKind ? { partKind } : {}),
    personId: person.id,
    outcome: "done",
    ...masterClientKey("cl", conv.data, isSanitation ? "san" : (partKind ?? "all")),
    createdBy: `person:${person.id}`,
  });

  const what = isSanitation ? "Санобработка" : partKind ? PART_LABELS[partKind] : "Автомат целиком";
  return {
    answer: "Записал",
    message: { text: `✅ Записал чистку.\n🏷 ${name}\n🧽 ${what}${photoHint()}`, keyboard: afterPhotoKeyboard() },
    ...startAfterPhoto(chatId, "maintenance_log", log.id, "чистке", deps),
  };
}

// ── Технический осмотр (sv:) ────────────────────────────────────────────────

export type ServiceCheckCallback =
  | { kind: "type"; type: InspectionType }
  | { kind: "result"; outcome: "done" | "partial" | "failed" }
  | { kind: "cancel" };

export function parseServiceCheckCallback(data: string): ServiceCheckCallback | null {
  if (data === "sv:x") return { kind: "cancel" };
  const t = /^sv:t:(plan|elec|sani|metr)$/.exec(data);
  if (t) return { kind: "type", type: t[1] as InspectionType };
  const r = /^sv:r:(ok|note|fail)$/.exec(data);
  if (r) {
    const map = { ok: "done", note: "partial", fail: "failed" } as const;
    return { kind: "result", outcome: map[r[1] as "ok" | "note" | "fail"] };
  }
  return null;
}

function inspectionTypeKeyboard(): NonNullable<StaffReply["keyboard"]> {
  return {
    inline_keyboard: [
      ...INSPECTION_TYPES.map((t) => [{ text: INSPECTION_LABELS[t], callback_data: `sv:t:${t}` }]),
      [{ text: "✖️ Отмена", callback_data: "sv:x" }],
    ],
  };
}

function resultKeyboard(): NonNullable<StaffReply["keyboard"]> {
  return {
    inline_keyboard: [
      [{ text: "✅ Годен", callback_data: "sv:r:ok" }],
      [{ text: "⚠️ Есть замечания", callback_data: "sv:r:note" }],
      [{ text: "🔴 Не годен", callback_data: "sv:r:fail" }],
      [{ text: "✖️ Отмена", callback_data: "sv:x" }],
    ],
  };
}

export async function startServiceCheck(chatId: number, person: PersonRow, deps: FieldDeps): Promise<StaffReply> {
  deps.conversations.start(chatId, "service-check", "object", { runId: newRunId() });
  return pickObject(person, deps, "🛠 Технический осмотр. Какой автомат?");
}

export async function handleServiceCheckCallback(
  chatId: number,
  cb: ServiceCheckCallback,
  person: PersonRow,
  deps: FieldDeps,
): Promise<{ answer: string; message?: StaffReply }> {
  if (cb.kind === "cancel") {
    // Барьер #149, распространённый на некофейные мастера: «Отмена» с чужого
    // устаревшего экрана не должна гасить текущее дело — слот беседы один,
    // а кнопки живут в чате вечно.
    const current = deps.conversations.get(chatId);
    if (current !== null && current.flow !== "service-check") {
      return { answer: "Кнопка устарела", message: { text: "Эта кнопка от прошлого шага — она уже не действует." } };
    }
    deps.conversations.clear(chatId);
    return { answer: "Отменено", message: { text: "Осмотр отменил." } };
  }
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "service-check") {
    return { answer: "Мастер истёк", message: { text: "Осмотр прервался. Начни заново." } };
  }

  if (cb.kind === "type") {
    deps.conversations.advance(chatId, "result", { inspection: cb.type });
    return {
      answer: INSPECTION_LABELS[cb.type],
      message: { text: `${INSPECTION_LABELS[cb.type]}. Что по результату?`, keyboard: resultKeyboard() },
    };
  }

  const entityId = String(conv.data.entityId ?? "");
  const inspection = String(conv.data.inspection ?? "plan") as InspectionType;
  if (!entityId) {
    deps.conversations.clear(chatId);
    return { answer: "Данные потерялись", message: { text: "Что-то потерялось — начни заново." } };
  }
  const name = String(conv.data.entityName ?? "автомат");

  // Плановое ТО, электро- и санитарная проверка, поверка — разные обязанности
  // с разной периодичностью. В журнал они ложатся разными видами работ, иначе
  // сроки трёх обязанностей считались бы как одна.
  const log = await deps.core.createMaintenanceLog({
    entityId,
    kind: INSPECTION_KIND[inspection],
    personId: person.id,
    outcome: cb.outcome,
    note: INSPECTION_LABELS[inspection],
    ...masterClientKey("sv", conv.data, cb.outcome),
    createdBy: `person:${person.id}`,
  });

  const verdict = cb.outcome === "done" ? "✅ Годен" : cb.outcome === "partial" ? "⚠️ С замечаниями" : "🔴 Не годен";
  return {
    answer: "Записал",
    message: {
      text:
        `✅ Записал осмотр.\n🏷 ${name}\n🛠 ${INSPECTION_LABELS[inspection]}\n${verdict}` +
        (cb.outcome === "failed" ? "\n\nВладелец увидит это в брифинге." : "") +
        photoHint("фото акта"),
      keyboard: afterPhotoKeyboard(),
    },
    ...startAfterPhoto(chatId, "maintenance_log", log.id, "осмотру", deps),
  };
}

// ── Поломка (pr:) ───────────────────────────────────────────────────────────

export type ProblemCallback =
  | { kind: "symptom"; symptom: ProblemSymptom }
  | { kind: "urgency"; urgency: ProblemUrgency }
  | { kind: "repair"; entityId: string }
  | { kind: "cancel" };

export function parseProblemCallback(data: string): ProblemCallback | null {
  if (data === "pr:x") return { kind: "cancel" };
  const r = /^pr:rep:([0-9a-f-]{36})$/.exec(data);
  if (r) return { kind: "repair", entityId: r[1] };
  const s = /^pr:s:([a-z]{3,6})$/.exec(data);
  if (s && (PROBLEM_SYMPTOMS as readonly string[]).includes(s[1])) {
    return { kind: "symptom", symptom: s[1] as ProblemSymptom };
  }
  const u = /^pr:u:([123])$/.exec(data);
  if (u) return { kind: "urgency", urgency: u[1] as ProblemUrgency };
  return null;
}

function symptomKeyboard(): NonNullable<StaffReply["keyboard"]> {
  const rows: { text: string; callback_data: string }[][] = [];
  PROBLEM_SYMPTOMS.forEach((s, i) => {
    if (i % 2 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: SYMPTOM_LABELS[s], callback_data: `pr:s:${s}` });
  });
  rows.push([{ text: "✖️ Отмена", callback_data: "pr:x" }]);
  return { inline_keyboard: rows };
}

function urgencyKeyboard(): NonNullable<StaffReply["keyboard"]> {
  return {
    inline_keyboard: [
      ...PROBLEM_URGENCIES.map((u) => [{ text: URGENCY_LABELS[u], callback_data: `pr:u:${u}` }]),
      [{ text: "✖️ Отмена", callback_data: "pr:x" }],
    ],
  };
}

/**
 * Что предложить сразу после заявки о поломке.
 *
 * Перевод в ремонт — ПРЕДЛОЖЕНИЕ, а не следствие заявки. Отказ
 * купюроприёмника не значит, что автомат не работает: он продолжает
 * продавать за монеты, и снимать его с обслуживания было бы неверно.
 * Решает человек на точке — он единственный, кто видит автомат.
 *
 * Фото остаётся первой кнопкой: оно про уже созданную заявку, а состояние —
 * про автомат, и путать их местами значит подталкивать к более тяжёлому
 * действию.
 */
export function problemDoneKeyboard(entityId: string): NonNullable<StaffReply["keyboard"]> {
  // Подписи короткие: 44-символьное «✅ Готово (приложи фото поломки, если
  // можешь)» телефон обрезал до противоположного смысла, а «Автомат не
  // работает — в ремонт» (31) — до 24 знаков без потери сути. Инструкция про
  // фото — в тексте сообщения (photoHint).
  return {
    inline_keyboard: [
      [{ text: "✅ Готово", callback_data: "ph:ok" }],
      [{ text: "🔧 Не работает — в ремонт", callback_data: `pr:rep:${entityId}` }],
    ],
  };
}

export async function startProblem(chatId: number, person: PersonRow, deps: FieldDeps): Promise<StaffReply> {
  deps.conversations.start(chatId, "problem", "object", { runId: newRunId() });
  return pickObject(person, deps, "⚠️ Поломка. На каком автомате?");
}

export async function handleProblemCallback(
  chatId: number,
  cb: ProblemCallback,
  person: PersonRow,
  deps: FieldDeps,
): Promise<{ answer: string; message?: StaffReply }> {
  if (cb.kind === "cancel") {
    // Барьер #149, распространённый на некофейные мастера: «Отмена» с чужого
    // устаревшего экрана не должна гасить текущее дело — слот беседы один,
    // а кнопки живут в чате вечно.
    const current = deps.conversations.get(chatId);
    if (current !== null && current.flow !== "problem") {
      return { answer: "Кнопка устарела", message: { text: "Эта кнопка от прошлого шага — она уже не действует." } };
    }
    deps.conversations.clear(chatId);
    return { answer: "Отменено", message: { text: "Заявку отменил." } };
  }
  // Перевод в ремонт — ПОСЛЕ созданной заявки, когда мастер уже отработал и
  // разговор мог завершиться. Поэтому обрабатываем до проверки живого мастера:
  // иначе кнопка под готовым сообщением отвечала бы «начни заново».
  if (cb.kind === "repair") {
    try {
      await deps.core.setMachineStatus(
        cb.entityId,
        "repair",
        `person:${person.id}`,
        `Заявка о поломке от ${person.name}`,
      );
    } catch {
      return {
        answer: "Не вышло",
        message: { text: "Не смог перевести автомат в ремонт. Заявка при этом создана — скажи владельцу." },
      };
    }
    return {
      answer: "Автомат в ремонте",
      message: {
        text:
          "🔧 Автомат отмечен как «в ремонте».\n\n" +
          "Работы по графику ему больше не назначаются, а те, что висели, закрыты — " +
          "выполнить их всё равно некому.\n\n" +
          "Когда вернётся в строй, владелец вернёт его в работу, и сроки пересчитаются заново.",
      },
    };
  }

  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "problem") {
    return { answer: "Мастер истёк", message: { text: "Заявка прервалась. Начни заново." } };
  }

  if (cb.kind === "symptom") {
    deps.conversations.advance(chatId, "urgency", { symptom: cb.symptom });
    return {
      answer: SYMPTOM_LABELS[cb.symptom],
      message: { text: "Насколько срочно?", keyboard: urgencyKeyboard() },
    };
  }

  const entityId = String(conv.data.entityId ?? "");
  const symptom = String(conv.data.symptom ?? "other") as ProblemSymptom;
  if (!entityId) {
    deps.conversations.clear(chatId);
    return { answer: "Данные потерялись", message: { text: "Что-то потерялось — начни заново." } };
  }
  const name = String(conv.data.entityName ?? "автомат");

  // Заявка — это ЗАДАЧА, а не запись в журнале: работа ещё не сделана.
  // Создаётся свободной (ownerRef не задан): её разберут из общего пула.
  const task = await deps.core.createTask({
    title: `${SYMPTOM_LABELS[symptom]} — ${name}`,
    ownerKind: "human",
    entityId,
    description: `Заявка от ${person.name}. Срочность: ${URGENCY_LABELS[cb.urgency]}`,
    priority: URGENCY_PRIORITY[cb.urgency],
    ...masterClientKey("pr", conv.data, cb.urgency),
    createdBy: `person:${person.id}`,
  });

  return {
    answer: "Заявка создана",
    message: {
      text:
        `✅ Заявка создана.\n🏷 ${name}\n⚠️ ${SYMPTOM_LABELS[symptom]}\n${URGENCY_LABELS[cb.urgency]}\n\n` +
        "Она в общем списке — кто освободится, тот и возьмёт." +
        photoHint("фото поломки"),
      keyboard: problemDoneKeyboard(entityId),
    },
    ...startAfterPhoto(chatId, "task", task.id, "заявке", deps),
  };
}

// ── Фото после записи ───────────────────────────────────────────────────────

/**
 * Шаг «фото к уже сохранённой записи».
 *
 * Записываем сначала, снимаем потом. На точке рвётся связь, и если просить
 * фото до сохранения, при обрыве теряется факт работы, а не картинка.
 * Поэтому это не шаг мастера, а необязательное продолжение: мастер уже
 * отработал, запись в базе, а фото приложится, если получится.
 */
export function afterPhotoKeyboard(): NonNullable<StaffReply["keyboard"]> {
  // Кнопка — только действие. Инструкция «приложи фото…» жила в подписи и
  // раздувала её до 35–44 символов: телефон обрезал до «✅ Готово (приложи
  // фото пол…» — читалось как призыв приложить, а нажатие ЗАВЕРШАЛО шаг.
  // Подсказка теперь в тексте сообщения (photoHint).
  return { inline_keyboard: [[{ text: "✅ Готово", callback_data: "ph:ok" }]] };
}

/** Строка-подсказка шага фото — в ТЕКСТ сообщения, не в кнопку. */
export function photoHint(what = "фото"): string {
  return `\n\n📷 Приложи ${what}, если есть, — или жми «Готово».`;
}

function startAfterPhoto(
  chatId: number,
  ownerType: string,
  ownerId: string,
  what: string,
  deps: FieldDeps,
): Record<string, never> {
  deps.conversations.start(chatId, "after-photo", "photo", { ownerType, ownerId, what, photos: 0 });
  return {} as Record<string, never>;
}

export function parseAfterPhotoCallback(data: string): { kind: "done" } | null {
  return data === "ph:ok" ? { kind: "done" } : null;
}

/** Фото к сохранённой записи. null — этот шаг сейчас не активен. */
export async function handleAfterPhoto(
  chatId: number,
  file: { bytes: Buffer; mime: string | null },
  person: PersonRow,
  deps: FieldDeps,
): Promise<StaffReply | null> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "after-photo") return null;
  const ownerType = String(conv.data.ownerType ?? "");
  const ownerId = String(conv.data.ownerId ?? "");
  if (!ownerType || !ownerId) return null;

  const count = Number(conv.data.photos ?? 0) + 1;
  const ext = file.mime === "image/png" ? "png" : "jpg";
  await deps.core.uploadPhoto({
    ownerType,
    ownerId,
    bytes: file.bytes,
    mime: file.mime,
    filename: `after-${count}.${ext}`,
    createdBy: `person:${person.id}`,
    stage: "after",
  });
  deps.conversations.advance(chatId, "photo", { photos: count });
  return { text: `📷 Приложил (${count}). Ещё? Или «Готово».`, keyboard: afterPhotoKeyboard() };
}

export function finishAfterPhoto(chatId: number, deps: FieldDeps): { answer: string; message?: StaffReply } {
  const conv = deps.conversations.get(chatId);
  const count = Number(conv?.data.photos ?? 0);
  const what = String(conv?.data.what ?? "записи");
  deps.conversations.clear(chatId);
  return {
    answer: "Готово",
    message: { text: count > 0 ? `Готово. Фото по ${what}: ${count}.` : "Готово." },
  };
}

/**
 * Объект выбран — общая точка входа для всех мастеров. Каждый решает сам,
 * какой шаг следующий; пикер об этом не знает.
 */
export async function onObjectPicked(
  chatId: number,
  entityId: string,
  deps: FieldDeps,
): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  const name = await objectName(entityId, deps);
  if (!conv) return { text: "Мастер прервался — начни заново." };

  switch (conv.flow) {
    case "part-replace":
      deps.conversations.advance(chatId, "part", { entityId, entityName: name });
      return { text: `${name}. Какой узел меняли?`, keyboard: partKeyboard(false) };
    case "clean":
      deps.conversations.advance(chatId, "target", { entityId, entityName: name });
      return { text: `${name}. Что чистили?`, keyboard: cleanKeyboard() };
    case "service-check":
      deps.conversations.advance(chatId, "type", { entityId, entityName: name });
      return { text: `${name}. Какой осмотр?`, keyboard: inspectionTypeKeyboard() };
    case "problem":
      deps.conversations.advance(chatId, "symptom", { entityId, entityName: name });
      return { text: `${name}. Что случилось?`, keyboard: symptomKeyboard() };
    default:
      return { text: "Не пойму, к чему это. Начни заново кнопкой из меню." };
  }
}
