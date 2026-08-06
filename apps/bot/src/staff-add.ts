import { ROLE_LABELS, STAFF_ROLES, rolesLabel, type StaffRole } from "@mydon/shared";
import type { CoreClient, PersonRow } from "./core-client";
import type { Conversations } from "./conversation";

/**
 * Подключение сотрудника — со стороны ВЛАДЕЛЬЦА.
 *
 * Без этого визарда приглашение можно выпустить только запросом к API:
 * контур подключения есть, а нажать на него негде. Владелец сидит в том же
 * боте, что и сотрудники, и заводить ради одной кнопки заход в панель —
 * лишний шаг там, где его можно не делать.
 *
 * Поток: кто → какие роли (мультивыбор) → ссылка.
 *
 * Ссылка показывается ОДИН раз. В БД лежит только хеш кода, и «покажи ещё
 * раз» невозможно by design — так и написано в ответе, чтобы владелец не
 * искал эту кнопку.
 */

export interface StaffAddDeps {
  core: CoreClient;
  conversations: Conversations;
}

const FLOW = "staff-add";

/** Слова, которыми владелец начинает подключение. */
export function isStaffAddTrigger(text: string): boolean {
  const t = text.trim().toLowerCase();
  return /^(подключ|нов(ый|ого) сотрудник|пригласи|выдай доступ|доступ сотрудник)/.test(t);
}

export type StaffAddCallback =
  | { kind: "person"; id: string }
  | { kind: "role"; role: StaffRole }
  | { kind: "done" }
  | { kind: "revoke"; id: string }
  | { kind: "cancel" };

/**
 * Разбор нажатия. Пространство «sa:». В роли идёт ИНДЕКС, а не название:
 * так callback_data остаётся коротким и не зависит от переименований.
 */
export function parseStaffAddCallback(data: string): StaffAddCallback | null {
  if (data === "sa:done") return { kind: "done" };
  if (data === "sa:x") return { kind: "cancel" };
  const p = /^sa:p:([0-9a-f-]{36})$/.exec(data);
  if (p) return { kind: "person", id: p[1] };
  const r = /^sa:r:(\d{1,2})$/.exec(data);
  if (r) {
    const role = STAFF_ROLES[Number(r[1])];
    return role ? { kind: "role", role } : null;
  }
  const v = /^sa:v:([0-9a-f-]{36})$/.exec(data);
  if (v) return { kind: "revoke", id: v[1] };
  return null;
}

/** Кого подключаем. Уже подключённые показываются с отметкой. */
function peopleKeyboard(people: PersonRow[]): { inline_keyboard: { text: string; callback_data: string }[][] } {
  return {
    inline_keyboard: [
      ...people.slice(0, 25).map((p) => [
        {
          text: `${p.tgChatId ? "🔗 " : ""}${p.name}`.slice(0, 40),
          callback_data: `sa:p:${p.id}`,
        },
      ]),
      [{ text: "✖️ Отмена", callback_data: "sa:x" }],
    ],
  };
}

/**
 * Мультивыбор ролей. Выбранные помечаются галочкой прямо в подписи —
 * отдельной строки «выбрано: …» не нужно, а состояние видно на кнопках.
 */
function rolesKeyboard(selected: readonly string[]): {
  inline_keyboard: { text: string; callback_data: string }[][];
} {
  const rows: { text: string; callback_data: string }[][] = [];
  STAFF_ROLES.forEach((r, i) => {
    // Владельца в этом списке нет: роль владельца не выдаётся приглашением.
    if (r === "owner") return;
    if (rows.length === 0 || rows[rows.length - 1].length === 2) rows.push([]);
    rows[rows.length - 1].push({
      text: `${selected.includes(r) ? "✅ " : ""}${ROLE_LABELS[r]}`,
      callback_data: `sa:r:${i}`,
    });
  });
  rows.push([{ text: "🔗 Выдать ссылку", callback_data: "sa:done" }]);
  rows.push([{ text: "✖️ Отмена", callback_data: "sa:x" }]);
  return { inline_keyboard: rows };
}

export interface OwnerReply {
  text: string;
  keyboard?: { inline_keyboard: { text: string; callback_data: string }[][] };
}

/** Начать: показать список сотрудников. */
export async function startStaffAdd(chatId: number, deps: StaffAddDeps): Promise<OwnerReply> {
  const people = await deps.core.people();
  if (people.length === 0) {
    return {
      text: "В реестре нет ни одного сотрудника. Заведи карточку в панели (/team), потом вернись сюда.",
    };
  }
  deps.conversations.start(chatId, FLOW, "person", { roles: [] });
  return {
    text: "Кого подключаем?\n🔗 — Telegram уже привязан, для него ссылка перепривяжет доступ.",
    keyboard: peopleKeyboard(people),
  };
}

/** Нажатие кнопки визарда владельца. */
export async function handleStaffAddCallback(
  chatId: number,
  cb: StaffAddCallback,
  deps: StaffAddDeps,
  botUsername: string,
): Promise<{ answer: string; message?: OwnerReply }> {
  if (cb.kind === "cancel") {
    deps.conversations.clear(chatId);
    return { answer: "Отменено", message: { text: "Подключение отменил." } };
  }

  if (cb.kind === "revoke") {
    // Отзыв доступа идёт мимо визарда: он нужен срочно и из любого места.
    const person = await deps.core.revokeAccess(cb.id);
    return {
      answer: "Доступ отозван",
      message: {
        text:
          `🚫 Доступ отозван: ${person.name}.\n` +
          "Привязка Telegram снята, роли сняты, живые приглашения погашены.\n" +
          "Карточка и история работ остались в реестре.",
      },
    };
  }

  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== FLOW) {
    return { answer: "Визард истёк", message: { text: "Начни заново: «подключить сотрудника»." } };
  }

  if (cb.kind === "person") {
    const people = await deps.core.people();
    const target = people.find((p) => p.id === cb.id);
    if (!target) return { answer: "Не найден", message: { text: "Такого сотрудника уже нет." } };
    deps.conversations.advance(chatId, "roles", { personId: target.id, personName: target.name, roles: [] });
    return {
      answer: target.name,
      message: {
        text: `${target.name}. Что ему можно?\nМожно выбрать несколько — роли складываются.`,
        keyboard: rolesKeyboard([]),
      },
    };
  }

  if (cb.kind === "role") {
    const current = (conv.data.roles as string[] | undefined) ?? [];
    // Повторное нажатие снимает выбор: кнопка-переключатель избавляет от
    // отдельной кнопки «убрать» и от вопроса «а как отменить».
    const next = current.includes(cb.role)
      ? current.filter((r) => r !== cb.role)
      : [...current, cb.role];
    deps.conversations.advance(chatId, "roles", { roles: next });
    const name = String(conv.data.personName ?? "сотрудник");
    return {
      answer: ROLE_LABELS[cb.role],
      message: {
        text: `${name}. Что ему можно?\nМожно выбрать несколько — роли складываются.`,
        keyboard: rolesKeyboard(next),
      },
    };
  }

  // «Выдать ссылку».
  const personId = String(conv.data.personId ?? "");
  const name = String(conv.data.personName ?? "сотрудник");
  const roles = (conv.data.roles as string[] | undefined) ?? [];
  if (!personId) {
    deps.conversations.clear(chatId);
    return { answer: "Данные потерялись", message: { text: "Начни заново: «подключить сотрудника»." } };
  }

  const res = await deps.core.issueInvite(personId, roles, "owner");
  deps.conversations.clear(chatId);

  return {
    answer: "Ссылка готова",
    message: {
      text: formatInvite(name, roles, res.code, res.expiresAt, botUsername),
      keyboard: {
        inline_keyboard: [[{ text: "🚫 Отозвать доступ", callback_data: `sa:v:${personId}` }]],
      },
    },
  };
}

/**
 * Сообщение со ссылкой.
 *
 * Ссылка отдельной строкой без другого текста рядом — чтобы её можно было
 * переслать сотруднику одним нажатием, не вычищая лишнее.
 */
export function formatInvite(
  name: string,
  roles: readonly string[],
  code: string,
  expiresAt: string,
  botUsername: string,
): string {
  const until = new Date(expiresAt).toLocaleString("ru-RU", {
    timeZone: "Asia/Tashkent",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return [
    `🔗 Ссылка для ${name}`,
    `Роли: ${rolesLabel(roles)}`,
    `Действует до ${until}, одноразовая.`,
    "",
    `https://t.me/${botUsername}?start=inv_${code}`,
    "",
    "Перешли её лично. Показать второй раз я не смогу — в базе хранится только отпечаток кода.",
  ].join("\n");
}
