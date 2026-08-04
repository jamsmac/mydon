import type { CoreClient, PersonRow } from "./core-client";
import type { StaffReply } from "./staff";

/**
 * «Ошибся — исправить»: сотрудник сам отменяет свою последнюю запись
 * (заливку, возврат набора или расходники) прямо в Telegram — не звонит
 * владельцу и не ждёт правки в панели.
 *
 * Правила честной правки: показываем, что именно будет удалено, просим
 * подтвердить кнопкой, а Core удаляет только запись этого же автора и
 * сохраняет строку целиком в журнале аудита. После удаления сотрудник
 * просто вносит данные заново привычным способом.
 */

export interface CoffeeFixDeps {
  core: CoreClient;
}

type EntryKind = "refill" | "container_return" | "consumable";

/** Слова, с которых начинают исправление. «Отмена» занята визардами — не трогаем. */
export function isCoffeeFixTrigger(text: string): boolean {
  return /^(исправить|ошибся|ошиблась|удали)/i.test(text.trim());
}

const KIND_CODE: Record<EntryKind, string> = { refill: "r", container_return: "c", consumable: "s" };
const CODE_KIND: Record<string, EntryKind> = { r: "refill", c: "container_return", s: "consumable" };

export type CoffeeFixCallback = { kind: "delete"; entry: EntryKind; id: string } | { kind: "keep" };

/** Строгий разбор нажатия: данные кнопки приходят снаружи, доверять им нельзя. */
export function parseCoffeeFixCallback(data: string): CoffeeFixCallback | null {
  if (data === "fx:keep") return { kind: "keep" };
  const m = /^fx:del:([rcs]):([0-9a-f-]{36})$/.exec(data);
  if (!m) return null;
  return { kind: "delete", entry: CODE_KIND[m[1]], id: m[2] };
}

/** Показать последнюю запись сотрудника и спросить подтверждение удаления. */
export async function startCoffeeFix(person: PersonRow, deps: CoffeeFixDeps): Promise<StaffReply> {
  const { entry } = await deps.core.coffeeLastEntry(`person:${person.id}`);
  if (!entry) {
    return { text: "Твоих записей не нашёл — исправлять нечего. Если ошибка в чужой записи, скажи владельцу." };
  }
  return {
    text:
      `Твоя последняя запись:\n${entry.text}\n\n` +
      "Удалить её? Строка сохранится в журнале аудита — потом внесёшь правильную.",
    keyboard: {
      inline_keyboard: [
        [
          { text: "🗑 Да, удалить", callback_data: `fx:del:${KIND_CODE[entry.kind]}:${entry.id}` },
          { text: "Оставить", callback_data: "fx:keep" },
        ],
      ],
    },
  };
}

/** Нажатие кнопки подтверждения. Core сам не даст удалить чужую запись. */
export async function handleCoffeeFixCallback(
  cb: CoffeeFixCallback,
  person: PersonRow,
  deps: CoffeeFixDeps,
): Promise<{ answer: string; message?: string }> {
  if (cb.kind === "keep") {
    return { answer: "Оставил как есть" };
  }
  try {
    await deps.core.deleteCoffeeEntry(cb.entry, cb.id, `person:${person.id}`);
  } catch {
    // 400 — чужая запись; 404 — уже удалена. Различать сотруднику незачем.
    return { answer: "Не получилось", message: "Эту запись удалить не вышло — возможно, её уже поправили. Скажи владельцу." };
  }
  return {
    answer: "Удалено",
    message: "Запись удалена (сохранена в аудите) ✅ Теперь внеси правильные данные тем же способом, что и раньше.",
  };
}
