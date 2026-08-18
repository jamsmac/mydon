import { parseContainerReturnMessage } from "@mydon/shared";
import { visitFromFlow, visitKeyboard, type VisitState } from "./coffee-visit";
import { applyPress, numpadKeyboard, numpadText, parseNumpadCallback, type NumpadPress } from "./numpad";
import { parseAmount, todayIso } from "./coffee-refill";
import type { CoreClient, PersonRow } from "./core-client";
import type { Conversations } from "./conversation";
import type { StaffReply } from "./staff";

/**
 * Возвраты наборов и расходники — прямо в Telegram, привычным форматом.
 *
 * Сотрудники годами писали в группу «Остатки с бункеров» строками
 * «позиция. набор. вес» (например «1. 027. 787», заголовок — точка). Бот
 * принимает ТО ЖЕ САМОЕ сообщение без команд и обучения: формат ни с чем
 * не спутать, разбор детерминированный (parseContainerReturnMessage —
 * та же регулярка, что в историческом импорте).
 *
 * Расходники (вода/стаканчики/крышки) — короткий визард: «вода» → точка
 * кнопкой → три числа одним сообщением. Дата всегда «сегодня» (Asia/Tashkent),
 * upsert по (точка, дата) — повторная отправка правит, а не дублирует.
 */

export interface CoffeeReturnsDeps {
  core: CoreClient;
  conversations: Conversations;
}

// ── Возвраты наборов: сообщение привычного формата, без триггер-слова ────────

export interface ParsedReturns {
  returns: { position: number; containerNumber: number; weight: number }[];
  locationNote: string | null;
  rejected: string[];
}

/** Сообщение — про возвраты? Хотя бы одна строка «позиция. набор. вес». */
export function tryParseContainerReturns(text: string): ParsedReturns | null {
  const parsed = parseContainerReturnMessage(text);
  return parsed.returns.length > 0 ? parsed : null;
}

/**
 * Записать все строки возвратов; ответ — сводка, как привыкли видеть в группе.
 *
 * Строки пишутся по одной, и сбой ловится ПО СТРОКЕ: раньше исключение на
 * третьей строке из пяти улетало наверх целиком — две уже записаны, ответа
 * нет, человек пересылал всё сообщение и дублировал записанное. Теперь ответ
 * честный: что записано, а какие строки надо отправить заново.
 */
export async function recordContainerReturns(
  parsed: ParsedReturns,
  person: PersonRow,
  deps: CoffeeReturnsDeps,
): Promise<StaffReply> {
  const returnedDate = todayIso();

  // Пересланный СТАРЫЙ список: все строки (двух и более) уже есть в журнале
  // за прошлые дни. Записать его сегодняшней датой значит закрыть свежие
  // заливки устаревшими весами — сверка расхода портится молча. Отклоняем с
  // понятным выходом; одна строка проходит всегда (это и путь-переопределение:
  // реально повторившийся вес шлётся отдельной строкой). Журнал недоступен —
  // пишем как есть: потерять сегодняшние остатки хуже редкого дубля.
  if (parsed.returns.length >= 2) {
    const recent = await deps.core.containerReturns(300).catch(() => null);
    if (recent) {
      const firstDate = new Map<string, string>();
      for (const r of recent) {
        const k = `${r.position}:${r.containerNumber}:${r.weight}`;
        const d = String(r.returnedDate);
        const prev = firstDate.get(k);
        if (prev === undefined || d > prev) firstDate.set(k, d);
      }
      const dates = parsed.returns.map((r) => firstDate.get(`${r.position}:${r.containerNumber}:${r.weight}`));
      const allOld = dates.every((d) => d !== undefined && d < returnedDate);
      if (allOld) {
        return {
          text: [
            "⚠️ Похоже, это уже записанный список: все строки до единой совпадают с журналом за прошлые дни.",
            "Повторно не записал — старые веса закрыли бы сегодняшние заливки в сверке.",
            "Если это НОВЫЕ остатки за сегодня — отправь строки по одной.",
          ].join("\n"),
        };
      }
    }
  }

  let saved = 0;
  const failed: string[] = [];
  for (const r of parsed.returns) {
    try {
      await deps.core.recordContainerReturn({
        position: r.position,
        containerNumber: r.containerNumber,
        weight: r.weight,
        returnedDate,
        ...(parsed.locationNote ? { locationNote: parsed.locationNote } : {}),
        createdBy: `person:${person.id}`,
      });
      saved += 1;
    } catch {
      // Формат строки — тот же, каким её набирают: скопировал и отправил.
      failed.push(`${r.position}. ${String(r.containerNumber).padStart(3, "0")}. ${r.weight}`);
    }
  }

  const where = parsed.locationNote ? ` (${parsed.locationNote})` : "";
  const lines: string[] = [];
  if (failed.length === parsed.returns.length) {
    lines.push("⚠️ Сервер не ответил — ни одна строка не записана. Отправь сообщение ещё раз через минуту.");
  } else {
    lines.push(`✅ Остатки записал: ${saved} из ${parsed.returns.length} наборов${where}.`);
    if (failed.length > 0) {
      lines.push(
        "⚠️ Эти строки не прошли — отправь ТОЛЬКО их ещё раз:",
        ...failed.map((l) => `  ${l}`),
      );
    }
  }
  if (parsed.rejected.length > 0) {
    lines.push(
      `⚠ Не разобрал ${parsed.rejected.length} строк (числа вне диапазонов):`,
      ...parsed.rejected.slice(0, 5).map((l) => `  • ${l}`),
    );
  }
  return { text: lines.join("\n") };
}

// ── Расходники: по одному числу, клавиатурой, с проверкой перед записью ─────

/**
 * Раньше три числа вводились одной строкой «2 100 100». На складе это работало,
 * на обходе — нет: порядок надо помнить, а ошибку видно только в ответе бота,
 * когда запись уже ушла. Теперь каждое число спрашивается отдельно и крупными
 * кнопками, а перед записью показывается всё вместе — с возможностью поправить
 * любое одно, не набирая заново остальные два.
 */

/** Слова, которыми начинают ввод расходников. */
export function isCoffeeConsumableTrigger(text: string): boolean {
  // «залил воду» — про 19-литровую бутыль на точке, а не про кофейный бункер:
  // у заливки этот случай исключён (залил(?!\s*вод)), ловим его здесь.
  return /^(вода|стаканчик|стаканы|крышк|расходник|залил\s*вод)/i.test(text.trim());
}

/** Поля в фиксированном порядке — он же порядок вопросов и строк в сводке. */
export const CONSUMABLE_FIELDS = [
  { key: "water", label: "Вода", unit: "бут." },
  { key: "cups", label: "Стаканчики", unit: "шт." },
  { key: "lids", label: "Крышки", unit: "шт." },
] as const;

export type ConsumableField = (typeof CONSUMABLE_FIELDS)[number]["key"];

export type CoffeeConsumableCallback =
  | { kind: "location"; id: string }
  | { kind: "num"; press: NumpadPress }
  | { kind: "save" }
  | { kind: "fix"; field: ConsumableField }
  | { kind: "cancel" };

export function parseCoffeeConsumableCallback(data: string): CoffeeConsumableCallback | null {
  if (data === "cc:cancel") return { kind: "cancel" };
  if (data === "cc:save") return { kind: "save" };
  const fix = /^cc:fix:(water|cups|lids)$/.exec(data);
  if (fix) return { kind: "fix", field: fix[1] as ConsumableField };
  const loc = /^cc:loc:([0-9a-f-]{36})$/.exec(data);
  if (loc) return { kind: "location", id: loc[1] };
  const press = parseNumpadCallback("cc", data);
  if (press) return { kind: "num", press };
  return null;
}

export function coffeeConsumableStepHint(step: string): string {
  const field = CONSUMABLE_FIELDS.find((f) => f.key === step);
  if (field) return `${field.label}: сколько? Число, или «-» если не привозил.`;
  return step === "confirm"
    ? "Проверь и жми «Сохранить», или поправь нужную строку кнопкой."
    : "Выбери точку кнопкой.";
}

/** Экран одного числа. «Пропустить» = ноль: не привозил — тоже факт. */
function countStep(field: ConsumableField, draft: string): StaffReply {
  const f = CONSUMABLE_FIELDS.find((x) => x.key === field)!;
  return {
    text: numpadText(`${f.label}: сколько привёз?\n(не привозил — «пропустить»)`, draft, f.unit),
    keyboard: numpadKeyboard("cc", { skip: true }),
  };
}

/**
 * Сводка перед записью. Правится любая одна строка — остальные две при этом
 * сохраняются: переписывать всё из-за одной опечатки люди не станут, они
 * просто отправят с ошибкой.
 */
function confirmStep(locationName: string, counts: Record<ConsumableField, number>): StaffReply {
  const lines = CONSUMABLE_FIELDS.map((f) => `${f.label}: ${counts[f.key]} ${f.unit}`);
  return {
    text: [`«${locationName}» — проверь:`, "", ...lines, "", "Запись за сегодня перезапишется."].join("\n"),
    keyboard: {
      inline_keyboard: [
        [{ text: "✅ Сохранить", callback_data: "cc:save" }],
        CONSUMABLE_FIELDS.map((f) => ({ text: `✏️ ${f.label}`, callback_data: `cc:fix:${f.key}` })),
        [{ text: "✖️ Отмена", callback_data: "cc:cancel" }],
      ],
    },
  };
}

/** Начать ввод расходников: выбрать точку. */
export async function startCoffeeConsumable(chatId: number, deps: CoffeeReturnsDeps): Promise<StaffReply> {
  const locations = await deps.core.coffeeLocations();
  const active = locations.filter((l) => l.isActive);
  if (active.length === 0) {
    return { text: "Точек с кофемашинами в реестре пока нет — скажи владельцу." };
  }
  deps.conversations.start(chatId, "coffee-consumable", "location");
  return {
    text: "Расходники какой точки?",
    keyboard: {
      inline_keyboard: [
        ...active.slice(0, 30).map((l) => [{ text: l.name.slice(0, 40), callback_data: `cc:loc:${l.id}` }]),
        [{ text: "✖️ Отмена", callback_data: "cc:cancel" }],
      ],
    },
  };
}

/** Расходники на точке, которая уже выбрана в обходе — без повторного выбора. */
export function continueVisitConsumable(chatId: number, visit: VisitState, deps: CoffeeReturnsDeps): StaffReply {
  deps.conversations.start(chatId, "coffee-consumable", "water", {
    locationId: visit.locationId,
    locationName: visit.locationName,
    refills: visit.refills,
    // Флаг «расходники уже внесены» обязан пережить повторный заход: без него
    // кнопка теряла «(внесены)», сводка врала «не вносил», и человек вносил
    // второй раз — а запись это upsert, тихо переписывающий первую.
    consumables: visit.consumables,
    started: visit.started,
    draft: "",
  });
  return countStep("water", "");
}

export async function handleCoffeeConsumableCallback(
  chatId: number,
  cb: CoffeeConsumableCallback,
  person: PersonRow,
  deps: CoffeeReturnsDeps,
): Promise<{ answer: string; message?: StaffReply; edit?: StaffReply }> {
  const current = deps.conversations.get(chatId);

  if (cb.kind === "cancel") {
    // Устаревший экран расходников не должен гасить то, чем человек занят
    // сейчас: слот беседы один на всё.
    if (current !== null && current.flow !== "coffee-consumable") {
      return { answer: "Кнопка устарела", message: { text: "Эта кнопка от прошлого шага — она уже не действует." } };
    }
    // Бросаем расходники, но не обход — точка остаётся выбранной.
    const visit = visitFromFlow(current);
    if (visit) {
      deps.conversations.start(chatId, "coffee-visit", "menu", { ...visit });
      return {
        answer: "Отменено",
        message: {
          text: `Расходники отменил. Ты на точке «${visit.locationName}».`,
          keyboard: visitKeyboard(visit),
        },
      };
    }
    deps.conversations.clear(chatId);
    return { answer: "Отменено", message: { text: "Ввод расходников отменил." } };
  }

  const conv = current;
  if (conv?.flow !== "coffee-consumable") {
    // «Уже сохранены» — только из меню точки, куда переводит именно запись.
    // Из другого мастера сюда попадает и брошенный без записи ввод, и врать
    // про него «сохранены» значит оставить точку без расходников за день.
    if (conv?.flow === "coffee-visit") {
      const visit = visitFromFlow(conv);
      if (visit && visit.consumables) {
        return {
          answer: "Уже записано",
          message: {
            text: `Эти расходники уже сохранены. Ты на точке «${visit.locationName}».`,
            keyboard: visitKeyboard(visit),
          },
        };
      }
    }
    if (conv === null) {
      return { answer: "Визард истёк", message: { text: "Ввод прервался. Начни заново: «вода»." } };
    }
    return { answer: "Кнопка устарела", message: { text: "Этот экран уже неактуален. Продолжай там, где остановился." } };
  }

  if (cb.kind === "location") {
    const locations = await deps.core.coffeeLocations();
    const loc = locations.find((l) => l.id === cb.id);
    if (!loc) return { answer: "Точка не найдена", message: { text: "Этой точки уже нет — начни заново." } };
    // fixing сбрасываем явно: устаревшая кнопка точки могла прийти ПОСЛЕ шага
    // правки, и залипший флаг пропускал бы вопросы про стаканчики и крышки —
    // за новую точку уходили цифры, названные для старой.
    deps.conversations.advance(chatId, "water", { locationId: loc.id, locationName: loc.name, draft: "", fixing: false });
    return { answer: loc.name, message: countStep("water", "") };
  }

  const locationName = String(conv.data.locationName ?? "");

  if (cb.kind === "fix") {
    // Пришли из проверки — значит и вернуться надо в проверку, а не идти
    // дальше по цепочке: человек правит одну строку, а не вводит всё заново.
    deps.conversations.advance(chatId, cb.field, { draft: "", fixing: true });
    return { answer: "Поправь", edit: countStep(cb.field, "") };
  }

  if (cb.kind === "save") {
    const counts = countsOf(conv.data);
    const locationId = String(conv.data.locationId ?? "");
    const refills = typeof conv.data.refills === "number" ? conv.data.refills : 0;
    if (!locationId) return { answer: "Данные потерялись", message: { text: "Начни заново: «вода»." } };
    await deps.core.recordCoffeeConsumable({
      locationId,
      loggedDate: todayIso(),
      ...counts,
      createdBy: `person:${person.id}`,
    });
    const visit: VisitState = { locationId, locationName, refills, consumables: true, started: true };
    deps.conversations.start(chatId, "coffee-visit", "menu", { ...visit });
    const lines = CONSUMABLE_FIELDS.map((f) => `${f.label}: ${counts[f.key]} ${f.unit}`);
    return {
      answer: "Записал",
      edit: {
        text: [`✅ Расходники записаны: «${locationName}»`, ...lines].join("\n"),
        keyboard: visitKeyboard(visit),
      },
    };
  }

  // cb.kind === "num" — набор числа для текущего поля.
  const field = CONSUMABLE_FIELDS.find((f) => f.key === conv.step)?.key;
  if (!field) return { answer: "Не сейчас" };
  const draft = String(conv.data.draft ?? "");

  if (cb.press.kind === "digit" || cb.press.kind === "erase") {
    const next = applyPress(draft, cb.press);
    if (next === draft) return { answer: "Пусто" };
    deps.conversations.advance(chatId, field, { draft: next });
    return { answer: next === "" ? "—" : next, edit: countStep(field, next) };
  }

  const value = cb.press.kind === "skip" ? 0 : Math.round(parseAmount(draft) ?? NaN);
  if (!Number.isFinite(value) || value < 0) return { answer: "Набери число или «пропустить»" };

  const idx = CONSUMABLE_FIELDS.findIndex((f) => f.key === field);
  const nextField = conv.data.fixing === true ? undefined : CONSUMABLE_FIELDS[idx + 1];
  if (nextField) {
    deps.conversations.advance(chatId, nextField.key, { [field]: value, draft: "" });
    return { answer: `${value}`, edit: countStep(nextField.key, "") };
  }

  const updated = deps.conversations.advance(chatId, "confirm", { [field]: value, draft: "", fixing: false });
  return { answer: `${value}`, edit: confirmStep(locationName, countsOf(updated?.data ?? {})) };
}

/** Числа из разговора: незаданное поле — ноль, а не «неизвестно». */
function countsOf(data: Record<string, unknown>): Record<ConsumableField, number> {
  return {
    water: typeof data.water === "number" ? data.water : 0,
    cups: typeof data.cups === "number" ? data.cups : 0,
    lids: typeof data.lids === "number" ? data.lids : 0,
  };
}

/** Три числа одной строкой — прежний способ, его не отнимаем. */
export function parseConsumableCounts(text: string): { water: number; cups: number; lids: number } | null {
  const m = /^(\d{1,4})\s+(\d{1,4})\s+(\d{1,4})$/.exec(text.trim());
  if (!m) return null;
  return { water: Number(m[1]), cups: Number(m[2]), lids: Number(m[3]) };
}

/** Текстовый ввод на любом шаге: одно число — текущее поле, три числа — все сразу. */
export async function handleCoffeeConsumableCounts(
  chatId: number,
  text: string,
  _person: PersonRow,
  deps: CoffeeReturnsDeps,
): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "coffee-consumable") return { text: coffeeConsumableStepHint("") };
  const locationName = String(conv.data.locationName ?? "");

  const triple = parseConsumableCounts(text);
  if (triple) {
    deps.conversations.advance(chatId, "confirm", { ...triple, draft: "" });
    return confirmStep(locationName, triple);
  }

  const field = CONSUMABLE_FIELDS.find((f) => f.key === conv.step)?.key;
  if (!field) return { text: coffeeConsumableStepHint(conv.step) };
  const value = /^[-—]$/.test(text.trim()) ? 0 : Math.round(parseAmount(text) ?? NaN);
  if (!Number.isFinite(value) || value < 0) {
    return { text: "Не понял число. Напиши количество, или «-» если не привозил." };
  }
  const idx = CONSUMABLE_FIELDS.findIndex((f) => f.key === field);
  const nextField = conv.data.fixing === true ? undefined : CONSUMABLE_FIELDS[idx + 1];
  if (nextField) {
    deps.conversations.advance(chatId, nextField.key, { [field]: value, draft: "" });
    return countStep(nextField.key, "");
  }
  const updated = deps.conversations.advance(chatId, "confirm", { [field]: value, draft: "", fixing: false });
  return confirmStep(locationName, countsOf(updated?.data ?? {}));
}
