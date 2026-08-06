import type { CoreClient, PersonRow } from "./core-client";
import type { Conversations } from "./conversation";
import type { StaffReply } from "./staff";

/**
 * Выбор объекта (автомата) — общий шаг для всех мастеров обслуживания.
 *
 * Закрепления сотрудников за объектами нет: формально каждому доступен весь
 * парк, и он растёт — автоматы подтягиваются из внешних систем постепенно.
 * Список из полусотни кнопок на телефоне бесполезен, поэтому три уровня,
 * каждый отсекает большинство:
 *
 *   1. недавние — где человек работал сам. Работает не потому, что он
 *      закреплён, а потому что маршрут дня повторяется;
 *   2. поиск подстрокой — когда объект знаком, но не в недавних;
 *   3. все, одним экраном — запасной выход.
 *
 * Мастера не копируют этот шаг, а вызывают его: иначе четыре копии пикера
 * разъедутся, и в одном мастере поиск будет, а в другом нет.
 */

export interface PickerDeps {
  core: CoreClient;
  conversations: Conversations;
}

/** Сколько недавних показываем. Больше пяти — уже список, а не подсказка. */
const RECENT_LIMIT = 5;
/** Потолок «показать все». Тот же, что в machinesKeyboard. */
const ALL_LIMIT = 30;

export type PickerCallback =
  | { kind: "picked"; id: string }
  | { kind: "search" }
  | { kind: "all" }
  | { kind: "cancel" };

/** Разбор нажатия. Пространство «mp:» общее для всех мастеров. */
export function parsePickerCallback(data: string): PickerCallback | null {
  const picked = /^mp:e:([0-9a-f-]{36})$/.exec(data);
  if (picked) return { kind: "picked", id: picked[1] };
  if (data === "mp:q") return { kind: "search" };
  if (data === "mp:all") return { kind: "all" };
  if (data === "mp:x") return { kind: "cancel" };
  return null;
}

function rows(items: { id: string; name: string }[]): { text: string; callback_data: string }[][] {
  return items.map((m) => [{ text: m.name.slice(0, 40), callback_data: `mp:e:${m.id}` }]);
}

/**
 * Экран выбора объекта.
 *
 * Недавние есть — показываем их и кнопку «найти». Недавних нет (первый день
 * человека) — сразу весь список: предлагать поиск тому, кто ещё не знает
 * названий, бессмысленно.
 */
export async function pickObject(
  person: PersonRow,
  deps: PickerDeps,
  prompt = "На каком автомате?",
): Promise<StaffReply> {
  const recent = await deps.core.recentObjects(person.id, RECENT_LIMIT).catch(() => []);
  if (recent.length > 0) {
    return {
      text: `${prompt}\n\nНедавние:`,
      keyboard: {
        inline_keyboard: [
          ...rows(recent),
          [
            { text: "🔎 Найти по названию", callback_data: "mp:q" },
            { text: "⋯ Все", callback_data: "mp:all" },
          ],
          [{ text: "✖️ Отмена", callback_data: "mp:x" }],
        ],
      },
    };
  }
  return allObjects(deps, prompt);
}

/** Весь список одним экраном. */
export async function allObjects(deps: PickerDeps, prompt = "На каком автомате?"): Promise<StaffReply> {
  const machines = await deps.core.machines();
  if (machines.length === 0) {
    return { text: "Автоматов в реестре пока нет — скажи владельцу." };
  }
  const shown = machines.slice(0, ALL_LIMIT);
  const tail = machines.length > shown.length ? `\n\nПоказал ${shown.length} из ${machines.length} — остальные через поиск.` : "";
  return {
    text: `${prompt}${tail}`,
    keyboard: {
      inline_keyboard: [
        ...rows(shown),
        [{ text: "🔎 Найти по названию", callback_data: "mp:q" }],
        [{ text: "✖️ Отмена", callback_data: "mp:x" }],
      ],
    },
  };
}

/** Приглашение к поиску. Сам ввод обрабатывает мастер на своём шаге. */
export function searchPrompt(): StaffReply {
  return {
    text: "Напиши часть названия или номер: «компас», «kaffit», «04».",
    keyboard: { inline_keyboard: [[{ text: "✖️ Отмена", callback_data: "mp:x" }]] },
  };
}

/** Результаты поиска. Пусто — говорим об этом и даём выход, а не молчим. */
export async function searchObjects(query: string, deps: PickerDeps): Promise<StaffReply> {
  const q = query.trim();
  if (q.length < 2) {
    return {
      text: "Слишком коротко — напиши хотя бы две буквы.",
      keyboard: { inline_keyboard: [[{ text: "✖️ Отмена", callback_data: "mp:x" }]] },
    };
  }
  const machines = await deps.core.machines();
  const lower = q.toLowerCase();
  const found = machines.filter((m) => m.name.toLowerCase().includes(lower)).slice(0, ALL_LIMIT);
  if (found.length === 0) {
    return {
      text: `По «${q}» ничего. Проверь букву или жми «Все» и листай.`,
      keyboard: {
        inline_keyboard: [
          [{ text: "⋯ Все", callback_data: "mp:all" }],
          [{ text: "✖️ Отмена", callback_data: "mp:x" }],
        ],
      },
    };
  }
  return {
    text: `Нашёл ${found.length}:`,
    keyboard: {
      inline_keyboard: [...rows(found), [{ text: "✖️ Отмена", callback_data: "mp:x" }]],
    },
  };
}

/** Имя объекта по id — для подстановки в тексты мастеров. */
export async function objectName(id: string, deps: PickerDeps): Promise<string> {
  const machines = await deps.core.machines();
  return machines.find((m) => m.id === id)?.name ?? "автомат";
}
