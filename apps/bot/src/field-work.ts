import {
  COMMON_PART_KINDS,
  INSPECTION_KIND,
  INSPECTION_LABELS,
  INSPECTION_TYPES,
  PART_KINDS,
  PART_LABELS,
  PART_LOCATION_LABELS,
  PART_OFF_LOCATIONS,
  PART_SWAP_REASONS,
  SWAP_REASON_LABELS,
  type PartLocation,
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
import type { CoreClient, PartUnitRow, PersonRow } from "./core-client";
import type { Conversations } from "./conversation";
import { objectName, pickObject } from "./machine-picker";
import { newRunId, onMachinePicked } from "./staff-refill";
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

/**
 * Флоу мастеров — те же строки, что в Conversations.flow.
 *
 * «refill» (заливка снек-автомата) живёт в staff-refill.ts, но объект выбирает
 * тем же пикером — и обязан быть здесь: список гейтит отмену пикера («Отмена»
 * с чужого экрана не гасит текущее дело). Забыть его значит получить мастер,
 * который эта кнопка убивает молча.
 */
export const FIELD_FLOWS = ["part-replace", "clean", "service-check", "problem", "refill"] as const;
export type FieldFlow = (typeof FIELD_FLOWS)[number];

// ── Замена узла (pt:) ───────────────────────────────────────────────────────

export type PartReplaceCallback =
  | { kind: "action"; action: "swap" | "remove" | "install" }
  | { kind: "part"; part: PartKind }
  | { kind: "morePartsPage" }
  | { kind: "noSerial" }
  | { kind: "reason"; reason: PartSwapReason }
  | { kind: "removePick"; part: PartKind; slot: number | null }
  | { kind: "removeTo"; to: PartLocation }
  | { kind: "installFrom"; partId: string }
  | { kind: "installNew" }
  | { kind: "slot"; slot: number | null }
  /** Замена по узлам (У3): какой узел снят (null — «нет в списке», прежний путь). */
  | { kind: "swapOld"; unitId: string | null }
  /** Замена по узлам (У3): какой запасной поставлен. */
  | { kind: "swapSpare"; unitId: string }
  | { kind: "cancel" };

export function parsePartReplaceCallback(data: string): PartReplaceCallback | null {
  if (data === "pt:more") return { kind: "morePartsPage" };
  if (data === "pt:old:0") return { kind: "swapOld", unitId: null };
  const old = /^pt:old:([0-9a-f-]{36})$/.exec(data);
  if (old) return { kind: "swapOld", unitId: old[1] };
  const spare = /^pt:sp:([0-9a-f-]{36})$/.exec(data);
  if (spare) return { kind: "swapSpare", unitId: spare[1] };
  if (data === "pt:s0") return { kind: "noSerial" };
  if (data === "pt:x") return { kind: "cancel" };
  if (data === "pt:new") return { kind: "installNew" };
  const action = /^pt:a:(swap|rm|in)$/.exec(data);
  if (action) {
    const map = { swap: "swap", rm: "remove", in: "install" } as const;
    return { kind: "action", action: map[action[1] as "swap" | "rm" | "in"] };
  }
  const part = /^pt:u:([a-z_]{3,20})$/.exec(data);
  if (part && (PART_KINDS as readonly string[]).includes(part[1])) {
    return { kind: "part", part: part[1] as PartKind };
  }
  const reason = /^pt:r:([a-z]{4,10})$/.exec(data);
  if (reason && (PART_SWAP_REASONS as readonly string[]).includes(reason[1])) {
    return { kind: "reason", reason: reason[1] as PartSwapReason };
  }
  const rm = /^pt:rm:([a-z_]{3,20}):(\d{1,2})$/.exec(data);
  if (rm && (PART_KINDS as readonly string[]).includes(rm[1])) {
    const slot = Number(rm[2]);
    return { kind: "removePick", part: rm[1] as PartKind, slot: slot > 0 ? slot : null };
  }
  const to = /^pt:to:([a-z]{4,12})$/.exec(data);
  if (to && (PART_OFF_LOCATIONS as readonly string[]).includes(to[1])) {
    return { kind: "removeTo", to: to[1] as PartLocation };
  }
  const from = /^pt:in:([0-9a-f-]{36})$/.exec(data);
  if (from) return { kind: "installFrom", partId: from[1] };
  const slot = /^pt:sl:(\d{1,2})$/.exec(data);
  if (slot) {
    const n = Number(slot[1]);
    return { kind: "slot", slot: n > 0 ? n : null };
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

/** Узлы, которых на автомате несколько, — у них спрашиваем номер места. */
const MULTI_SLOT: readonly PartKind[] = ["hopper", "mixer", "spiral"];

function actionKeyboard(): NonNullable<StaffReply["keyboard"]> {
  // Замена — первой: это самый частый случай, ради неё мастер и открывают.
  return {
    inline_keyboard: [
      [{ text: "🔁 Заменить", callback_data: "pt:a:swap" }],
      [{ text: "⬇️ Снять (увезти)", callback_data: "pt:a:rm" }],
      [{ text: "⬆️ Поставить", callback_data: "pt:a:in" }],
      [{ text: "✖️ Отмена", callback_data: "pt:x" }],
    ],
  };
}

function offLocationKeyboard(): NonNullable<StaffReply["keyboard"]> {
  const rows = PART_OFF_LOCATIONS.map((l) => [
    { text: PART_LOCATION_LABELS[l], callback_data: `pt:to:${l}` },
  ]);
  rows.push([{ text: "✖️ Отмена", callback_data: "pt:x" }]);
  return { inline_keyboard: rows };
}

/** Подпись узла в кнопке: номер и место — «M-017 · №1», без номера — серийник. */
function unitButtonText(u: PartUnitRow): string {
  const no = u.inventoryNo ?? (u.serialNumber ? `S/N ${u.serialNumber.slice(-8)}` : "без номера");
  return `${no}${u.where?.slot ? ` · №${u.where.slot}` : ""}`;
}

/** Куда увозят снятый узел: мойка первой для того, что моют, склад — для остального. */
function removedToKeyboard(kind: PartKind): NonNullable<StaffReply["keyboard"]> {
  const washable: readonly PartKind[] = ["mixer", "hopper", "brewer", "grinder"];
  const order: PartLocation[] = washable.includes(kind) ? ["washing", "warehouse", "repair"] : ["warehouse", "repair", "washing"];
  const rows = order.map((l) => [{ text: PART_LOCATION_LABELS[l], callback_data: `pt:to:${l}` }]);
  rows.push([{ text: "✖️ Отмена", callback_data: "pt:x" }]);
  return { inline_keyboard: rows };
}

function slotKeyboard(kind: PartKind): NonNullable<StaffReply["keyboard"]> {
  const rows: { text: string; callback_data: string }[][] = [];
  if (MULTI_SLOT.includes(kind)) {
    rows.push([1, 2, 3, 4].map((n) => ({ text: `№${n}`, callback_data: `pt:sl:${n}` })));
    rows.push([5, 6, 7, 8].map((n) => ({ text: `№${n}`, callback_data: `pt:sl:${n}` })));
  }
  rows.push([{ text: "Без номера", callback_data: "pt:sl:0" }]);
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
    case "action":
      return "Выбери действие кнопкой: заменить, снять или поставить.";
    case "part":
    case "inpart":
      return "Выбери узел кнопкой.";
    case "serial":
      return "Напиши серийный номер нового узла или жми «Не знаю».";
    case "inserial":
      return "Напиши серийный номер узла или жми «Не знаю».";
    case "reason":
      return "Выбери причину замены кнопкой.";
    case "rmpart":
      return "Выбери, какой узел снял.";
    case "rmto":
      return "Выбери, куда увёз узел.";
    case "insrc":
      return "Выбери узел со склада или «Новый узел».";
    case "inslot":
      return "Выбери номер места кнопкой.";
    case "swapold":
      return "Выбери, какой узел снял, кнопкой.";
    case "swapto":
      return "Выбери, куда увёз снятый узел.";
    case "swapnew":
      return "Выбери запасной узел со склада или «Новый узел».";
    default:
      return "Продолжай по кнопкам.";
  }
}

/** Шаг «серийник»: текст сотрудника. Общий для замены и установки. */
export function handlePartSerial(chatId: number, text: string, deps: FieldDeps): StaffReply {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "part-replace" || (conv.step !== "serial" && conv.step !== "inserial")) {
    return { text: "Замена прервалась. Начни заново кнопкой «🔧 Замена детали»." };
  }
  const serial = text.trim().slice(0, 64);
  if (conv.step === "inserial") {
    const kind = String(conv.data.partKind ?? "other") as PartKind;
    deps.conversations.advance(chatId, "inslot", { newSerial: serial });
    return { text: "Куда встал узел?", keyboard: slotKeyboard(kind) };
  }
  deps.conversations.advance(chatId, "reason", { newSerial: serial });
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

  // Развилка после выбора автомата: замена — прежний путь, снятие и установка —
  // новые. Снятый узел не исчезает из учёта: он уезжает в мойку/ремонт и
  // возвращается установкой со склада.
  if (cb.kind === "action") {
    const entityId = String(conv.data.entityId ?? "");
    if (cb.action === "swap") {
      deps.conversations.advance(chatId, "part", {});
      return { answer: "Замена", message: { text: "Какой узел меняли?", keyboard: partKeyboard(false) } };
    }
    if (cb.action === "remove") {
      const parts = (await deps.core.machineParts(entityId)).filter((p) => p.removedOn === null);
      if (parts.length === 0) {
        deps.conversations.clear(chatId);
        return {
          answer: "Узлов нет",
          message: {
            text:
              "На этом автомате узлы в реестре не заведены — снимать нечего.\n" +
              "Если узел ставили без записи, оформи «Заменить»: она заведёт учёт.",
          },
        };
      }
      const rows = parts.slice(0, 12).map((p) => [
        {
          text:
            PART_LABELS[p.partKind as PartKind] +
            (p.slot !== null ? ` №${p.slot}` : "") +
            (p.serialNumber ? ` · ${p.serialNumber.slice(-8)}` : ""),
          callback_data: `pt:rm:${p.partKind}:${p.slot ?? 0}`,
        },
      ]);
      rows.push([{ text: "✖️ Отмена", callback_data: "pt:x" }]);
      deps.conversations.advance(chatId, "rmpart", {});
      return { answer: "Снятие", message: { text: "Какой узел снял?", keyboard: { inline_keyboard: rows } } };
    }
    // install
    const storage = await deps.core.storageParts();
    const map: Record<string, string> = {};
    const rows = storage.slice(0, 8).map((p) => {
      map[p.id] = p.partKind;
      return [
        {
          text:
            PART_LABELS[p.partKind as PartKind] +
            (p.serialNumber ? ` · ${p.serialNumber.slice(-8)}` : "") +
            ` · ${PART_LOCATION_LABELS[p.location as PartLocation] ?? p.location}`,
          callback_data: `pt:in:${p.id}`,
        },
      ];
    });
    rows.push([{ text: "🆕 Новый узел", callback_data: "pt:new" }]);
    rows.push([{ text: "✖️ Отмена", callback_data: "pt:x" }]);
    deps.conversations.advance(chatId, "insrc", { storage: map });
    return {
      answer: "Установка",
      message: {
        text: storage.length > 0 ? "Что ставишь? Учтённые узлы — со склада и мойки:" : "Что ставишь?",
        keyboard: { inline_keyboard: rows },
      },
    };
  }

  if (cb.kind === "removePick") {
    deps.conversations.advance(chatId, "rmto", { partKind: cb.part, slot: cb.slot });
    return {
      answer: PART_LABELS[cb.part],
      message: { text: `${PART_LABELS[cb.part]}. Куда увёз?`, keyboard: offLocationKeyboard() },
    };
  }

  if (cb.kind === "removeTo" && conv.step === "swapto") {
    // Замена по узлам: снятый уезжает в cb.to; дальше — что поставили.
    const partKind = String(conv.data.partKind ?? "other") as PartKind;
    let spares: PartUnitRow[] = [];
    try {
      spares = (await deps.core.partsSpares(partKind)).filter((u) => !u.retiredAt);
    } catch {
      spares = [];
    }
    const map: Record<string, string> = {};
    const rows = spares.slice(0, 10).map((u) => {
      map[u.id] = u.label;
      return [{ text: `${unitButtonText(u)} · склад`, callback_data: `pt:sp:${u.id}` }];
    });
    rows.push([{ text: "🆕 Новый узел (без карточки)", callback_data: "pt:new" }]);
    rows.push([{ text: "✖️ Отмена", callback_data: "pt:x" }]);
    deps.conversations.advance(chatId, "swapnew", { removedTo: cb.to, spares: map });
    return {
      answer: PART_LOCATION_LABELS[cb.to],
      message: {
        text: spares.length > 0 ? `Снятый — ${PART_LOCATION_LABELS[cb.to].toLowerCase()}. Что поставил? Запасные на складе:` : `Снятый — ${PART_LOCATION_LABELS[cb.to].toLowerCase()}. Запасных ${PART_LABELS[partKind].toLowerCase()} на складе не числится. Что поставил?`,
        keyboard: { inline_keyboard: rows },
      },
    };
  }

  if (cb.kind === "removeTo") {
    const entityId = String(conv.data.entityId ?? "");
    const partKind = String(conv.data.partKind ?? "");
    if (!entityId || !partKind) {
      deps.conversations.clear(chatId);
      return { answer: "Данные потерялись", message: { text: "Что-то потерялось — начни заново." } };
    }
    const slot = typeof conv.data.slot === "number" ? conv.data.slot : undefined;
    const name = String(conv.data.entityName ?? "автомат");
    let res: Awaited<ReturnType<CoreClient["removePart"]>>;
    try {
      res = await deps.core.removePart({
        machineId: entityId,
        partKind,
        ...(slot !== undefined ? { slot } : {}),
        toLocation: cb.to,
        personId: person.id,
        ...masterClientKey("pt", conv.data, `rm-${cb.to}`),
        createdBy: `person:${person.id}`,
      });
    } catch (e) {
      deps.conversations.clear(chatId);
      return {
        answer: "Не вышло",
        message: { text: `Не смог записать снятие: ${e instanceof Error ? e.message : "ошибка"}. Начни заново.` },
      };
    }
    return {
      answer: "Снятие записано",
      message: {
        text:
          `✅ Записал снятие.\n🏷 ${name}\n🔧 ${PART_LABELS[partKind as PartKind]}` +
          `${slot !== undefined ? ` №${slot}` : ""}` +
          `${res.removed.serialNumber ? `\n🆔 ${res.removed.serialNumber}` : ""}` +
          `\n📍 Узел теперь: ${PART_LOCATION_LABELS[cb.to].toLowerCase()} — он числится там и вернётся установкой.` +
          photoHint(),
        keyboard: afterPhotoKeyboard(),
      },
      ...startAfterPhoto(chatId, "maintenance_log", res.log.id, "снятию", deps),
    };
  }

  if (cb.kind === "installFrom") {
    const map = (conv.data.storage ?? {}) as Record<string, string>;
    const kind = map[cb.partId];
    if (!kind) {
      deps.conversations.clear(chatId);
      return { answer: "Кнопка устарела", message: { text: "Список склада устарел — начни заново." } };
    }
    deps.conversations.advance(chatId, "inslot", { partId: cb.partId, partKind: kind });
    return {
      answer: PART_LABELS[kind as PartKind],
      message: { text: "Куда встал узел?", keyboard: slotKeyboard(kind as PartKind) },
    };
  }

  if (cb.kind === "installNew" && conv.step === "swapnew") {
    // Новый узел при замене по узлам: карточку заведёт Core, номер даст система.
    const partKind = String(conv.data.partKind ?? "other") as PartKind;
    deps.conversations.advance(chatId, "serial", { spareId: null });
    return {
      answer: "Новый узел",
      message: {
        text: `${PART_LABELS[partKind]}. Серийный номер нового узла?`,
        keyboard: {
          inline_keyboard: [
            [{ text: "Не знаю / нет номера", callback_data: "pt:s0" }],
            [{ text: "✖️ Отмена", callback_data: "pt:x" }],
          ],
        },
      },
    };
  }

  if (cb.kind === "installNew") {
    deps.conversations.advance(chatId, "inpart", {});
    return { answer: "Новый узел", message: { text: "Какой узел ставишь?", keyboard: partKeyboard(false) } };
  }

  if (cb.kind === "swapOld") {
    if (conv.step !== "swapold") {
      return { answer: "Кнопка устарела", message: { text: "Эта кнопка от прошлого шага — она уже не действует." } };
    }
    const partKind = String(conv.data.partKind ?? "other") as PartKind;
    if (cb.unitId === null) {
      // Узла нет в списке — прежний путь: серийник → причина, Core заведёт карточку.
      deps.conversations.advance(chatId, "serial", { oldUnitId: null });
      return {
        answer: "Не из списка",
        message: {
          text: `${PART_LABELS[partKind]}. Серийный номер нового узла?`,
          keyboard: {
            inline_keyboard: [
              [{ text: "Не знаю / нет номера", callback_data: "pt:s0" }],
              [{ text: "✖️ Отмена", callback_data: "pt:x" }],
            ],
          },
        },
      };
    }
    const olds = (conv.data.oldUnits ?? {}) as Record<string, { label: string; slot: number | null }>;
    const old = olds[cb.unitId];
    if (!old) {
      deps.conversations.clear(chatId);
      return { answer: "Кнопка устарела", message: { text: "Список узлов устарел — начни заново." } };
    }
    deps.conversations.advance(chatId, "swapto", { oldUnitId: cb.unitId, oldLabel: old.label, slot: old.slot });
    return {
      answer: old.label,
      message: { text: `Снят ${old.label}. Куда увёз?`, keyboard: removedToKeyboard(partKind) },
    };
  }

  if (cb.kind === "swapSpare") {
    if (conv.step !== "swapnew") {
      return { answer: "Кнопка устарела", message: { text: "Эта кнопка от прошлого шага — она уже не действует." } };
    }
    const spares = (conv.data.spares ?? {}) as Record<string, string>;
    const label = spares[cb.unitId];
    if (!label) {
      deps.conversations.clear(chatId);
      return { answer: "Кнопка устарела", message: { text: "Список склада устарел — начни заново." } };
    }
    deps.conversations.advance(chatId, "reason", { spareId: cb.unitId, spareLabel: label, newSerial: null });
    return { answer: label, message: { text: `Поставлен ${label}. Почему меняли?`, keyboard: reasonKeyboard() } };
  }

  if (cb.kind === "slot") {
    const entityId = String(conv.data.entityId ?? "");
    const partKind = String(conv.data.partKind ?? "");
    if (!entityId || !partKind) {
      deps.conversations.clear(chatId);
      return { answer: "Данные потерялись", message: { text: "Что-то потерялось — начни заново." } };
    }
    const name = String(conv.data.entityName ?? "автомат");
    const partId = typeof conv.data.partId === "string" ? conv.data.partId : undefined;
    const newSerial = typeof conv.data.newSerial === "string" ? conv.data.newSerial : undefined;
    let res: Awaited<ReturnType<CoreClient["installPart"]>>;
    try {
      res = await deps.core.installPart({
        machineId: entityId,
        partKind,
        ...(cb.slot !== null ? { slot: cb.slot } : {}),
        ...(partId ? { partId } : {}),
        ...(newSerial ? { serialNumber: newSerial } : {}),
        personId: person.id,
        ...masterClientKey("pt", conv.data, `in-${cb.slot ?? 0}`),
        createdBy: `person:${person.id}`,
      });
    } catch (e) {
      deps.conversations.clear(chatId);
      return {
        answer: "Не вышло",
        // Самая частая причина — место занято: там уже числится узел, и
        // правильная операция — «Заменить», она снимет прежний.
        message: { text: `Не смог записать установку: ${e instanceof Error ? e.message : "ошибка"}. Начни заново.` },
      };
    }
    return {
      answer: "Установка записана",
      message: {
        text:
          `✅ Записал установку.\n🏷 ${name}\n🔧 ${PART_LABELS[partKind as PartKind]}` +
          `${cb.slot !== null ? ` №${cb.slot}` : ""}` +
          `${res.installed.serialNumber ? `\n🆔 ${res.installed.serialNumber}` : ""}` +
          photoHint(),
        keyboard: afterPhotoKeyboard(),
      },
      ...startAfterPhoto(chatId, "maintenance_log", res.log.id, "установке", deps),
    };
  }

  if (cb.kind === "part") {
    // Одна клавиатура узлов на два пути: замена спрашивает серийник и причину,
    // установка — серийник и место. Ветка определяется шагом беседы.
    if (conv.step === "inpart") {
      deps.conversations.advance(chatId, "inserial", { partKind: cb.part });
      return {
        answer: PART_LABELS[cb.part],
        message: {
          text: `${PART_LABELS[cb.part]}. Серийный номер узла?`,
          keyboard: {
            inline_keyboard: [
              [{ text: "Не знаю / нет номера", callback_data: "pt:s0" }],
              [{ text: "✖️ Отмена", callback_data: "pt:x" }],
            ],
          },
        },
      };
    }
    // Замена по узлам (У3): если на автомате узлы этого вида заведены
    // карточками, техник выбирает снятый по номеру — серийник не нужен.
    // Нет карточек (старый автомат без автозаведения) — прежний путь.
    const entityId = String(conv.data.entityId ?? "");
    let installed: PartUnitRow[] = [];
    try {
      installed = (await deps.core.partsInstalled(entityId)).filter((u) => u.partKind === cb.part && !u.retiredAt);
    } catch {
      installed = [];
    }
    if (installed.length > 0) {
      const map: Record<string, { label: string; slot: number | null }> = {};
      const rows = installed.slice(0, 12).map((u) => {
        map[u.id] = { label: u.label, slot: u.where?.slot ?? null };
        return [{ text: unitButtonText(u), callback_data: `pt:old:${u.id}` }];
      });
      rows.push([{ text: "Нет в списке", callback_data: "pt:old:0" }]);
      rows.push([{ text: "✖️ Отмена", callback_data: "pt:x" }]);
      deps.conversations.advance(chatId, "swapold", { partKind: cb.part, oldUnits: map });
      return {
        answer: PART_LABELS[cb.part],
        message: { text: `${PART_LABELS[cb.part]}. Какой узел снял?`, keyboard: { inline_keyboard: rows } },
      };
    }
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
    if (conv.step === "inserial") {
      const kind = String(conv.data.partKind ?? "other") as PartKind;
      deps.conversations.advance(chatId, "inslot", { newSerial: null });
      return { answer: "Без номера", message: { text: "Куда встал узел?", keyboard: slotKeyboard(kind) } };
    }
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
  // Замена по узлам (У3): снятый выбран по карточке — известны место и куда
  // увезли; поставленный — запасной со склада или новый.
  const oldUnitId = typeof conv.data.oldUnitId === "string" ? conv.data.oldUnitId : null;
  const oldLabel = typeof conv.data.oldLabel === "string" ? conv.data.oldLabel : null;
  const slot = typeof conv.data.slot === "number" ? conv.data.slot : undefined;
  const removedTo = typeof conv.data.removedTo === "string" ? (conv.data.removedTo as PartLocation) : undefined;
  const spareId = typeof conv.data.spareId === "string" ? conv.data.spareId : undefined;
  const spareLabel = typeof conv.data.spareLabel === "string" ? conv.data.spareLabel : null;

  const res = await deps.core.swapPart({
    machineId: entityId,
    partKind,
    ...(oldUnitId && slot !== undefined ? { slot } : {}),
    ...(newSerial ? { newSerial } : {}),
    ...(spareId ? { partUnitId: spareId } : {}),
    ...(removedTo ? { removedTo } : {}),
    reason: cb.reason,
    personId: person.id,
    ...masterClientKey("pt", conv.data, cb.reason),
    createdBy: `person:${person.id}`,
  });

  const oldLine = oldLabel
    ? `\n🔁 Снят: ${oldLabel} → ${(PART_LOCATION_LABELS[removedTo ?? "warehouse"] ?? "склад").toLowerCase()}`
    : res.removed?.serialNumber
      ? `\n🔁 Снят: ${res.removed.serialNumber}`
      : res.removed
        ? "\n🔁 Снят прежний узел (номер не был записан)"
        : "\n🆕 Первая установка — прежнего узла в реестре не было";
  const newLine = spareLabel
    ? `\n⬆️ Поставлен: ${spareLabel} (со склада)`
    : newSerial
      ? `\n🆔 Новый: ${newSerial}`
      : oldLabel
        ? "\n⬆️ Поставлен новый узел — номер ему дала система, наклейка ждёт в «🔢 Номера узлов»"
        : "";

  return {
    answer: "Замена записана",
    message: {
      text:
        `✅ Записал замену.\n🏷 ${name}\n🔧 ${PART_LABELS[partKind as PartKind]}${slot !== undefined ? ` №${slot}` : ""}` +
        `${newLine}${oldLine}\n` +
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

/**
 * Заявки, о которых владельцу уже сообщили. Идемпотентный replay createTask
 * (тот же clientKey после таймаута) возвращает ту же задачу — второй пуш о
 * той же поломке слать нельзя. Память процесса: перезапуск в этом окне даст
 * максимум один лишний пуш, что лучше пропущенного.
 */
const notifiedProblems = new Set<string>();

export async function startProblem(chatId: number, person: PersonRow, deps: FieldDeps): Promise<StaffReply> {
  deps.conversations.start(chatId, "problem", "object", { runId: newRunId() });
  return pickObject(person, deps, "⚠️ Поломка. На каком автомате?");
}

export async function handleProblemCallback(
  chatId: number,
  cb: ProblemCallback,
  person: PersonRow,
  deps: FieldDeps,
): Promise<{ answer: string; message?: StaffReply; ownerNote?: string }> {
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
    domain: "vendhub",
    entityId,
    description: `Заявка от ${person.name}. Срочность: ${URGENCY_LABELS[cb.urgency]}`,
    priority: URGENCY_PRIORITY[cb.urgency],
    ...masterClientKey("pr", conv.data, cb.urgency),
    createdBy: `person:${person.id}`,
  });

  const firstNotice = !notifiedProblems.has(task.id);
  notifiedProblems.add(task.id);

  return {
    answer: "Заявка создана",
    message: {
      text:
        `✅ Заявка создана.\n🏷 ${name}\n⚠️ ${SYMPTOM_LABELS[symptom]}\n${URGENCY_LABELS[cb.urgency]}\n\n` +
        "Она в общем списке — кто освободится, тот и возьмёт." +
        photoHint("фото поломки"),
      keyboard: problemDoneKeyboard(entityId),
    },
    // Владелец узнаёт о поломке СРАЗУ — как об инкассации: раньше заявка
    // всплывала только просрочкой или строкой брифинга через сутки. Replay
    // по clientKey возвращает ту же задачу — пуш только при первом разе.
    ...(firstNotice
      ? {
          ownerNote:
            `⚠️ Поломка: ${name} — ${SYMPTOM_LABELS[symptom]} (${URGENCY_LABELS[cb.urgency]}).\n` +
            `Заявил: ${person.name}. Заявка в общем списке.`,
        }
      : {}),
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
      deps.conversations.advance(chatId, "action", { entityId, entityName: name });
      return { text: `${name}. Что делаем с узлом?`, keyboard: actionKeyboard() };
    case "clean":
      deps.conversations.advance(chatId, "target", { entityId, entityName: name });
      return { text: `${name}. Что чистили?`, keyboard: cleanKeyboard() };
    case "service-check":
      deps.conversations.advance(chatId, "type", { entityId, entityName: name });
      return { text: `${name}. Какой осмотр?`, keyboard: inspectionTypeKeyboard() };
    case "problem":
      deps.conversations.advance(chatId, "symptom", { entityId, entityName: name });
      return { text: `${name}. Что случилось?`, keyboard: symptomKeyboard() };
    case "refill":
      // Снек-заливка: дальше не вопрос, а готовый чек-лист из плана закупа.
      return onMachinePicked(chatId, entityId, name, deps);
    default:
      return { text: "Не пойму, к чему это. Начни заново кнопкой из меню." };
  }
}
