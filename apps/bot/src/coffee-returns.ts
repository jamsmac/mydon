import { parseContainerReturnMessage } from "@mydon/shared";
import { todayIso } from "./coffee-refill";
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

/** Записать все строки возвратов; ответ — сводка, как привыкли видеть в группе. */
export async function recordContainerReturns(
  parsed: ParsedReturns,
  person: PersonRow,
  deps: CoffeeReturnsDeps,
): Promise<StaffReply> {
  const returnedDate = todayIso();
  let saved = 0;
  for (const r of parsed.returns) {
    await deps.core.recordContainerReturn({
      position: r.position,
      containerNumber: r.containerNumber,
      weight: r.weight,
      returnedDate,
      ...(parsed.locationNote ? { locationNote: parsed.locationNote } : {}),
      createdBy: `person:${person.id}`,
    });
    saved += 1;
  }

  const where = parsed.locationNote ? ` (${parsed.locationNote})` : "";
  const lines = [`✅ Остатки записал: ${saved} наборов${where}.`];
  if (parsed.rejected.length > 0) {
    lines.push(
      `⚠ Не разобрал ${parsed.rejected.length} строк (числа вне диапазонов):`,
      ...parsed.rejected.slice(0, 5).map((l) => `  • ${l}`),
    );
  }
  return { text: lines.join("\n") };
}

// ── Расходники: «вода» → точка → «вода стаканы крышки» одним сообщением ─────

/** Слова, которыми начинают ввод расходников. */
export function isCoffeeConsumableTrigger(text: string): boolean {
  return /^(вода|стаканчик|стаканы|крышк|расходник)/i.test(text.trim());
}

export type CoffeeConsumableCallback = { kind: "location"; id: string } | { kind: "cancel" };

export function parseCoffeeConsumableCallback(data: string): CoffeeConsumableCallback | null {
  if (data === "cc:cancel") return { kind: "cancel" };
  const loc = /^cc:loc:([0-9a-f-]{36})$/.exec(data);
  return loc ? { kind: "location", id: loc[1] } : null;
}

export function coffeeConsumableStepHint(step: string): string {
  return step === "location"
    ? "Выбери точку кнопкой."
    : "Напиши три числа: вода, стаканчики, крышки — например «2 100 100». «отмена» — бросить.";
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

export async function handleCoffeeConsumableCallback(
  chatId: number,
  cb: CoffeeConsumableCallback,
  deps: CoffeeReturnsDeps,
): Promise<{ answer: string; message?: StaffReply }> {
  if (cb.kind === "cancel") {
    deps.conversations.clear(chatId);
    return { answer: "Отменено", message: { text: "Ввод расходников отменил." } };
  }
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "coffee-consumable") {
    return { answer: "Визард истёк", message: { text: "Ввод прервался. Начни заново: «вода»." } };
  }
  const locations = await deps.core.coffeeLocations();
  const loc = locations.find((l) => l.id === cb.id);
  if (!loc) return { answer: "Точка не найдена", message: { text: "Этой точки уже нет — начни заново." } };
  deps.conversations.advance(chatId, "counts", { locationId: loc.id, locationName: loc.name });
  return {
    answer: loc.name,
    message: { text: `«${loc.name}». Сколько принёс: вода, стаканчики, крышки — три числа, например «2 100 100».` },
  };
}

/** Три числа: вода, стаканчики, крышки. Порядок фиксированный — как в таблице группы. */
export function parseConsumableCounts(text: string): { water: number; cups: number; lids: number } | null {
  const m = /^(\d{1,4})\s+(\d{1,4})\s+(\d{1,4})$/.exec(text.trim());
  if (!m) return null;
  return { water: Number(m[1]), cups: Number(m[2]), lids: Number(m[3]) };
}

/** Последний шаг: три числа → upsert за сегодня. */
export async function handleCoffeeConsumableCounts(
  chatId: number,
  text: string,
  person: PersonRow,
  deps: CoffeeReturnsDeps,
): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "coffee-consumable" || conv.step !== "counts") {
    return { text: coffeeConsumableStepHint("") };
  }
  const counts = parseConsumableCounts(text);
  if (!counts) {
    return { text: "Не понял. Три числа через пробел: вода, стаканчики, крышки — например «2 100 100»." };
  }
  const locationId = String(conv.data.locationId ?? "");
  const locationName = String(conv.data.locationName ?? "");
  deps.conversations.clear(chatId);
  if (!locationId) return { text: "Данные потерялись — начни заново: «вода»." };

  await deps.core.recordCoffeeConsumable({
    locationId,
    loggedDate: todayIso(),
    ...counts,
    createdBy: `person:${person.id}`,
  });
  return {
    text: `✅ Записал: «${locationName}» — вода ${counts.water}, стаканчики ${counts.cups}, крышки ${counts.lids}. Повторная отправка за сегодня перезапишет.`,
  };
}
