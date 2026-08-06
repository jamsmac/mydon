import type { ReplyKeyboard } from "./telegram";
import { isRegisterTrigger } from "./staff-register";
import { isIntakeTrigger } from "./staff-intake";
import { isInventoryTrigger } from "./staff-inventory";
import { isCoffeeRefillTrigger, isCoffeeWashTrigger } from "./coffee-refill";
import { isCoffeeConsumableTrigger } from "./coffee-returns";
import { isCoffeeFixTrigger } from "./coffee-fix";

/**
 * Меню сотрудника: один реестр и для кнопок, и для текстовых триггеров.
 *
 * До этого меню не было вовсе — сотрудник должен был помнить восемь слов из
 * справки. Полевой работник этого не делает: он пишет «залил кофе» и получает
 * справку, потому что не угадал формулировку.
 *
 * Почему один реестр, а не «кнопки отдельно, слова отдельно»: разъехавшись,
 * они дают пункт, спрятанный кнопкой, но доступный словом. Когда появятся
 * права (`perm`), такая дыра сделала бы всю модель прав косметикой.
 *
 * Регексы триггеров НЕ переписываются — переиспользуются существующие
 * `is*Trigger()` из модулей мастеров. Каждая «причёсанная» копия теряет
 * формулировки, которыми сотрудники реально пишут.
 *
 * В `callback_data` идёт короткий id пункта, а не подпись: кириллица съела бы
 * лимит в 64 байта. Префикс «m:» свободен.
 */

/**
 * Право на пункт меню. Пока не проверяется: колонки `person.roles` ещё нет,
 * все пункты доступны всем. Поле заведено сразу, чтобы при появлении ролей
 * менялась одна функция `menuFor`, а не тринадцать мест вызова.
 */
export type MenuPerm =
  | "tasks.own"
  | "maintenance.view"
  | "parts.replace"
  | "coffee.wash"
  | "coffee.refill"
  | "coffee.consumable"
  | "cash.collect"
  | "stock.intake"
  | "stock.count"
  | "registry.propose";

export interface MenuItem {
  /** Короткий id для callback_data. */
  id: string;
  /** Подпись кнопки — она же ключ точного совпадения текста. */
  label: string;
  perm: MenuPerm;
  /** Готов ли поток. `false` — пункт не показываем и слово не ловим. */
  ready: boolean;
  /** Ловит формулировку, которой сотрудник начинает этот поток. */
  match: (text: string) => boolean;
}

/** «задачи», «дела», «что делать» — вынесено из staff.ts дословно. */
export function isTasksTrigger(text: string): boolean {
  return /задач|дела|что делать|мои/i.test(text.trim());
}

/** «инкассация», «выручка», «сдать деньги» — вынесено из staff.ts дословно. */
export function isCollectTrigger(text: string): boolean {
  return /инкасс|выручк|сдать деньги/i.test(text.trim());
}

/**
 * Порядок задаёт раскладку: по два в ряд сверху вниз. Наверху то, что
 * открывают каждый день, внизу — редкое.
 *
 * `ready: false` у пунктов, чьи мастера появятся в следующих PR. Кнопка,
 * которая ничего не делает, для полевого сотрудника хуже отсутствующей: один
 * раз нажал впустую — больше не поверит и остальным.
 */
export const STAFF_MENU: readonly MenuItem[] = [
  { id: "tasks", label: "📋 Мои задачи", perm: "tasks.own", ready: true, match: isTasksTrigger },
  {
    id: "sched",
    label: "🗓 Графики",
    perm: "maintenance.view",
    ready: false,
    // Хвостовая проверка у «то» обязательна: иначе раздел перехватывал бы
    // «точка», «товар», «тоже» — половину фраз про точки, как только поток
    // станет ready.
    //
    // Именно (?![\p{L}\p{N}]) с флагом u, а НЕ \b: в JavaScript граница слова
    // определяется через [A-Za-z0-9_], кириллица словом не считается, и `то\b`
    // не сработает вообще ни на чём. Ошибка тихая — регекс просто перестаёт
    // ловить, не падая.
    match: (t) => /^(график|обслуживани|то(?![\p{L}\p{N}]))/iu.test(t.trim()),
  },
  {
    id: "part",
    label: "🔧 Замена детали",
    perm: "parts.replace",
    ready: true,
    match: (t) => /^(замен|поменял|поставил нов)/i.test(t.trim()),
  },
  {
    id: "insp",
    label: "🛠 Технический осмотр",
    perm: "maintenance.view",
    ready: true,
    match: (t) => /^(техосмотр|технический осмотр|осмотр|поверк)/i.test(t.trim()),
  },
  // Две разные чистки, и это не дублирование: у кофейной мойки ключ
  // «точка + позиция бункера 1..8», у чистки автомата — «автомат + узел».
  // Своим названием каждая говорит, о чём она, и путать их технику незачем.
  { id: "wash", label: "🧼 Мойка бункера", perm: "coffee.wash", ready: true, match: isCoffeeWashTrigger },
  {
    id: "clean",
    label: "🧽 Чистка автомата",
    perm: "coffee.wash",
    ready: true,
    match: (t) => /^(чистк|протёр|протер|санобработ)/i.test(t.trim()),
  },
  {
    id: "issue",
    label: "⚠️ Поломка",
    perm: "tasks.own",
    ready: true,
    match: (t) => /^(поломк|сломал|не работает|авари)/i.test(t.trim()),
  },
  { id: "refill", label: "☕ Заливка бункера", perm: "coffee.refill", ready: true, match: isCoffeeRefillTrigger },
  { id: "cons", label: "💧 Расходники", perm: "coffee.consumable", ready: true, match: isCoffeeConsumableTrigger },
  { id: "coll", label: "📥 Инкассация", perm: "cash.collect", ready: true, match: isCollectTrigger },
  { id: "intake", label: "📦 Приход", perm: "stock.intake", ready: true, match: isIntakeTrigger },
  { id: "count", label: "📋 Инвентаризация", perm: "stock.count", ready: true, match: isInventoryTrigger },
  { id: "new", label: "🆕 Новая карточка", perm: "registry.propose", ready: true, match: isRegisterTrigger },
  { id: "fix", label: "↩️ Ошибся — исправить", perm: "tasks.own", ready: true, match: isCoffeeFixTrigger },
];

/**
 * Пункты, доступные сотруднику.
 *
 * `roles` пока не используется: колонки нет, фильтровать нечем, и притворяться
 * что фильтр работает — хуже, чем честно его не иметь. Параметр в сигнатуре
 * стоит уже сейчас, чтобы включение прав не переписывало вызовы.
 */
export function menuFor(_roles?: readonly string[] | null): MenuItem[] {
  return STAFF_MENU.filter((i) => i.ready);
}

/** Две кнопки в ряд: на телефоне это предел, при котором подпись не режется. */
export function menuKeyboard(roles?: readonly string[] | null): ReplyKeyboard {
  const rows: { text: string }[][] = [];
  menuFor(roles).forEach((item, i) => {
    if (i % 2 === 0) rows.push([]);
    rows[rows.length - 1].push({ text: item.label });
  });
  return {
    keyboard: rows,
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Жми кнопки снизу 👇",
  };
}

/**
 * Точное совпадение с подписью кнопки.
 *
 * Проверяется РАНЬШЕ активного мастера: нажатие кнопки меню — это явное
 * намерение сменить занятие, и отвечать на него «выбери точку кнопкой»
 * означает запереть человека в мастере, из которого он уже уходит.
 *
 * Именно точное совпадение, не `includes`: иначе отчёт по задаче, где
 * встретилось слово «📋 Мои задачи», улетел бы в открытие списка.
 */
export function matchMenuLabel(text: string): MenuItem | null {
  const t = text.trim();
  return STAFF_MENU.find((i) => i.label === t) ?? null;
}

/**
 * Слово попало в пункт меню. Возвращаем пункт целиком, а не только id:
 * вызывающему нужен `ready`, чтобы объяснить «поток ещё не готов», а не
 * промолчать.
 */
export function matchTrigger(text: string): MenuItem | null {
  return STAFF_MENU.find((i) => i.ready && i.match(text)) ?? null;
}

/** Пункт по id — для разбора `m:<id>`. */
export function menuItemById(id: string): MenuItem | null {
  return STAFF_MENU.find((i) => i.id === id) ?? null;
}

/** Разбор нажатия inline-дубля меню. */
export function parseMenuCallback(data: string): { id: string } | null {
  const m = /^m:([a-z]{3,8})$/.exec(data);
  return m ? { id: m[1] } : null;
}

/** Справка строится из того же реестра — расходиться с меню ей нечем. */
export function helpText(roles?: readonly string[] | null): string {
  const items = menuFor(roles);
  return [
    "Жми кнопки снизу — так быстрее всего.",
    "",
    "Что умею:",
    ...items.map((i) => `• ${i.label}`),
    "",
    "Можно и словами: «задачи», «залил кофе», «помыл», «приход».",
    "«отмена» — бросить начатое.",
  ].join("\n");
}
