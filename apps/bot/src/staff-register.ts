import { UNITS } from "@mydon/shared";
import type { CoreClient, PersonRow } from "./core-client";
import type { Conversations } from "./conversation";
import type { StaffReply } from "./staff";

/**
 * Заведение номенклатуры сотрудником прямо в Telegram: новый ингредиент или
 * запчасть — быстро, с фотографией, без веб-панели.
 *
 * Решение владельца (то же, что и с задачами): сотрудник заводит — владелец
 * утверждает. Поэтому карточка создаётся ЧЕРНОВИКОМ (`createdFrom=staff:<id>`):
 * она видна и с фото, но фактом реестра станет только после утверждения.
 *
 * Поток нарочно короткий, чтобы делалось «на бегу»:
 *   тип → название → фото (сколько нужно) → единица → черновик на утверждение.
 * Остальные поля (цена, поставщик) владелец допишет позже — они не держат ввод.
 */

/** Что заводим. Тип карточки реестра — как у machine/product. */
// «⚙️», не «🔧» — тот занят «Заменой детали» (один эмодзи — один смысл).
const TYPES = [
  { key: "ingredient", label: "🧂 Ингредиент" },
  { key: "component", label: "⚙️ Запчасть" },
] as const;

type RegisterType = (typeof TYPES)[number]["key"];

export interface RegisterDeps {
  core: CoreClient;
  conversations: Conversations;
}

/** Домен номенклатуры бота — кофейная сеть. У сотрудника своего домена нет. */
const DOMAIN = "vendhub";

/** Слова, которыми сотрудник начинает заведение. */
export function isRegisterTrigger(text: string): boolean {
  const t = text.trim().toLowerCase();
  if (/^\/?завест/.test(t) || /^завед/.test(t)) return true;
  // «новый ингредиент», «новая запчасть», «добавить ингредиент»
  return /(нов(ый|ая)|добав)/.test(t) && /(ингредиент|запчаст|товар|номенклатур)/.test(t);
}

export function typeLabel(key: string): string {
  return TYPES.find((t) => t.key === key)?.label ?? key;
}

/** Кнопки выбора типа. Префикс «r:» — своё пространство, отдельно от t:/c:/ap:. */
export function typeKeyboard(): NonNullable<StaffReply["keyboard"]> {
  return {
    inline_keyboard: [
      TYPES.map((t) => ({ text: t.label, callback_data: `r:type:${t.key}` })),
      // Первый шаг визарда обязан иметь выход кнопкой — как и все остальные.
      [{ text: "✖️ Отмена", callback_data: "r:cancel" }],
    ],
  };
}

/** Кнопки под шагом фото: закончить или отменить. */
export function photoStepKeyboard(): NonNullable<StaffReply["keyboard"]> {
  return {
    inline_keyboard: [
      [
        { text: "✅ Готово", callback_data: "r:photo:done" },
        { text: "✖️ Отмена", callback_data: "r:cancel" },
      ],
    ],
  };
}

/**
 * Кнопки единиц измерения. В callback_data идёт индекс, а не сама единица:
 * кириллица в callback_data съедает лимит 64 байта и легко ломается — индекс
 * надёжнее и короче.
 */
export function unitKeyboard(): NonNullable<StaffReply["keyboard"]> {
  const rows: { text: string; callback_data: string }[][] = [];
  UNITS.forEach((u, i) => {
    if (i % 3 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: u, callback_data: `r:unit:${i}` });
  });
  // Единственный шаг визарда без «Отмены» был тупиком кнопок: выйти можно
  // было только словом, о котором подсказка шага не напоминала.
  rows.push([{ text: "✖️ Отмена", callback_data: "r:cancel" }]);
  return { inline_keyboard: rows };
}

export type RegisterCallback =
  | { kind: "type"; type: RegisterType }
  | { kind: "photoDone" }
  | { kind: "unit"; unit: string }
  | { kind: "cancel" };

/** Строгий разбор нажатия. Данные кнопки приходят снаружи — доверять нельзя. */
export function parseRegisterCallback(data: string): RegisterCallback | null {
  if (data === "r:photo:done") return { kind: "photoDone" };
  if (data === "r:cancel") return { kind: "cancel" };
  const type = /^r:type:(ingredient|component)$/.exec(data);
  if (type) return { kind: "type", type: type[1] as RegisterType };
  const unit = /^r:unit:(\d+)$/.exec(data);
  if (unit) {
    const u = UNITS[Number(unit[1])];
    return u ? { kind: "unit", unit: u } : null;
  }
  return null;
}

/** Начать заведение: спросить тип. */
export function startRegister(chatId: number, deps: RegisterDeps): StaffReply {
  deps.conversations.start(chatId, "register", "type");
  return { text: "Что заводим?", keyboard: typeKeyboard() };
}

/** Подсказка, когда на шаге ждут кнопку/фото, а сотрудник пишет текст. */
export function registerStepHint(step: string): string {
  switch (step) {
    case "type":
      return "Выбери кнопкой, что заводим.";
    case "photo":
      return "Пришли фото или нажми «Готово». Написать «отмена» — бросить.";
    case "unit":
      return "Выбери единицу кнопкой.";
    default:
      return "Продолжай по кнопкам.";
  }
}

/**
 * Шаг «название»: заводим черновик карточки сразу, как только есть имя.
 *
 * Раньше остального, потому что фото нужно к чему привязывать (owner_id).
 * Единицу и прочее допишем следующими шагами — карточка уже существует.
 */
export async function handleRegisterName(
  chatId: number,
  name: string,
  person: PersonRow,
  deps: RegisterDeps,
): Promise<StaffReply> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "register") return { text: registerStepHint("") };
  const type = String(conv.data.type ?? "ingredient") as RegisterType;

  const created = await deps.core.createEntity({
    domain: DOMAIN,
    type,
    name: name.slice(0, 200),
    createdFrom: `staff:${person.id}`,
  });
  deps.conversations.advance(chatId, "photo", { entityId: created.id, name: created.name, photos: 0 });

  return {
    text:
      `«${created.name}» — черновик заведён.\n` +
      "Пришли фото (можно несколько). Нет фото — жми «Готово».",
    keyboard: photoStepKeyboard(),
  };
}

/**
 * Шаг «фото»: сотрудник прислал снимок. Байты уже скачаны вызывающим (у бота
 * нет доступа к Telegram-транспорту здесь) — мы только грузим их в Core и
 * привязываем к черновику.
 */
export async function handleRegisterPhoto(
  chatId: number,
  file: { bytes: Buffer; mime: string | null },
  person: PersonRow,
  deps: RegisterDeps,
): Promise<StaffReply | null> {
  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "register" || conv.step !== "photo") return null;
  const entityId = String(conv.data.entityId ?? "");
  if (!entityId) return null;

  const count = Number(conv.data.photos ?? 0) + 1;
  const ext = file.mime === "image/png" ? "png" : "jpg";
  await deps.core.uploadPhoto({
    ownerType: "entity",
    ownerId: entityId,
    bytes: file.bytes,
    mime: file.mime,
    filename: `photo-${count}.${ext}`,
    createdBy: `person:${person.id}`,
  });
  deps.conversations.advance(chatId, "photo", { photos: count });

  return {
    text: `Фото добавлено (${count}). Ещё? Или «Готово».`,
    keyboard: photoStepKeyboard(),
  };
}

/** Нажатие кнопки визарда: тип, «готово по фото», единица, отмена. */
export async function handleRegisterCallback(
  chatId: number,
  cb: RegisterCallback,
  _person: PersonRow,
  deps: RegisterDeps,
): Promise<{ answer: string; message?: StaffReply }> {
  if (cb.kind === "cancel") {
    deps.conversations.clear(chatId);
    return { answer: "Отменено", message: { text: "Заведение отменил." } };
  }

  const conv = deps.conversations.get(chatId);
  if (conv?.flow !== "register") {
    return { answer: "Визард истёк", message: { text: "Заведение прервалось. Начни заново: «новый ингредиент»." } };
  }

  if (cb.kind === "type") {
    deps.conversations.advance(chatId, "name", { type: cb.type });
    return {
      answer: typeLabel(cb.type),
      message: { text: `Заводим ${typeLabel(cb.type)}. Напиши название одним сообщением.` },
    };
  }

  if (cb.kind === "photoDone") {
    deps.conversations.advance(chatId, "unit");
    return { answer: "Дальше — единица", message: { text: "В чём считаем остаток?", keyboard: unitKeyboard() } };
  }

  // cb.kind === "unit": дописываем единицу и завершаем.
  const entityId = String(conv.data.entityId ?? "");
  const name = String(conv.data.name ?? "карточка");
  const photos = Number(conv.data.photos ?? 0);
  if (entityId) await deps.core.updateEntity(entityId, { unit: cb.unit });
  deps.conversations.clear(chatId);
  const photoNote = photos > 0 ? ` Фото: ${photos}.` : " Без фото — можно добавить позже.";
  return {
    answer: "Заведено",
    message: {
      text: `Готово: «${name}», ${cb.unit}.${photoNote}\nКарточка ждёт утверждения владельца ✅`,
    },
  };
}
