import { can, type Permission } from "@mydon/shared";
import type { ReplyKeyboard } from "./telegram";
import { isRegisterTrigger } from "./staff-register";
import { isIntakeTrigger } from "./staff-intake";
import { isInventoryTrigger } from "./staff-inventory";
import { isCoffeeRefillTrigger, isCoffeeWashTrigger } from "./coffee-refill";
import { isRefillTrigger } from "./staff-refill";
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

/** Право на пункт меню. Матрица прав живёт в @mydon/shared. */
export type MenuPerm = Permission;

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

/**
 * «задачи», «дела», «что делать» — с якорем ^, как у всех триггеров реестра.
 *
 * Без якоря подстрока «дела» ловила «сделал, но нет воды», а «мои» — «помоги»:
 * самое частое слово полевого отчёта перехватывалось списком задач, и
 * комментарий не доходил до владельца. «дела» с проверкой хвоста — чтобы
 * «делаю»/«сделал» не совпадали, а «дела на точке» совпадали.
 */
export function isTasksTrigger(text: string): boolean {
  return /^(задач|дела(?![\p{L}])|что делать|мои задач)/iu.test(text.trim());
}

/** «инкассация», «выручка», «сдать деньги» — с якорем, по образцу остальных. */
export function isCollectTrigger(text: string): boolean {
  return /^(инкасс|выручк|сдать деньги)/i.test(text.trim());
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
  // Ряд 1 — пара ежедневного кофейного обхода: заливка и расходники вместе,
  // их и связывает coffee-visit. Раньше заливка стояла восьмой, под редкими
  // «Заменой детали» и «Техосмотром», — вопреки собственному правилу выше.
  { id: "refill", label: "☕ Заливка бункера", perm: "coffee.refill", ready: true, match: isCoffeeRefillTrigger },
  { id: "cons", label: "💧 Расходники", perm: "coffee.consumable", ready: true, match: isCoffeeConsumableTrigger },
  // Ряд 2 — ежедневное: задачи и деньги.
  { id: "tasks", label: "📋 Мои задачи", perm: "tasks.own", ready: true, match: isTasksTrigger },
  { id: "coll", label: "📥 Инкассация", perm: "cash.collect", ready: true, match: isCollectTrigger },
  // Ряд 3 — мойки. Две разные чистки, и это не дублирование: у кофейной мойки
  // ключ «точка + позиция бункера 1..8», у чистки автомата — «автомат + узел».
  // Своим названием каждая говорит, о чём она, и путать их технику незачем.
  { id: "wash", label: "🧼 Мойка бункера", perm: "coffee.wash", ready: true, match: isCoffeeWashTrigger },
  {
    id: "clean",
    label: "🧽 Чистка автомата",
    perm: "coffee.wash",
    ready: true,
    match: (t) => /^(чистк|протёр|протер|санобработ)/i.test(t.trim()),
  },
  // Ряд 4 — аварийная пара: заявил поломку → заменил деталь.
  {
    id: "issue",
    label: "⚠️ Поломка",
    perm: "tasks.own",
    ready: true,
    match: (t) => /^(поломк|сломал|не работает|авари)/i.test(t.trim()),
  },
  {
    id: "part",
    label: "🔧 Замена детали",
    perm: "parts.replace",
    ready: true,
    match: (t) => /^(замен|поменял|поставил нов)/i.test(t.trim()),
  },
  // Ряд 5 — периодическое.
  {
    id: "insp",
    label: "🛠 Технический осмотр",
    perm: "maintenance.view",
    ready: true,
    match: (t) => /^(техосмотр|технический осмотр|осмотр|поверк)/i.test(t.trim()),
  },
  {
    id: "sched",
    label: "🗓 Графики",
    perm: "maintenance.view",
    ready: true,
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
  // Ряд 6 — склад.
  { id: "intake", label: "📦 Приход", perm: "stock.intake", ready: true, match: isIntakeTrigger },
  // «🧮», не «📋»: значок задач уже занят, а оператор сканирует меню по
  // эмодзи — один символ на два пункта провоцирует промах.
  { id: "count", label: "🧮 Инвентаризация", perm: "stock.count", ready: true, match: isInventoryTrigger },
  // Снек/дринк — отдельный пункт от кофейной заливки: там бункеры и вес,
  // здесь слоты и штуки. Один пункт на оба вынудил бы спрашивать «а какой
  // автомат?» до того, как техник вообще выбрал объект.
  // ready:false — мастера нет. В staff-refill.ts лежат только заготовки
  // (клавиатуры, разбор чисел, recordItem), входной точки и обработчика шагов
  // не существует: startMenuItem падал в default. Кнопка при этом стирала
  // начатое ПЕРЕД тем как ответить «пока не готово» — обход с выбранной точкой
  // и счётчиком заливок исчезал ради пункта, который ничего не делает.
  { id: "mrefill", label: "📦 Заполнил автомат", perm: "refill.create", ready: false, match: isRefillTrigger },
  // Ряд 7 — редкое.
  { id: "new", label: "🆕 Новая карточка", perm: "registry.propose", ready: true, match: isRegisterTrigger },
  { id: "fix", label: "↩️ Ошибся — исправить", perm: "tasks.own", ready: true, match: isCoffeeFixTrigger },
];

/**
 * Пункты, доступные сотруднику.
 *
 * Фильтр один и тот же для кнопок, справки и текстовых триггеров: спрятанный
 * кнопкой, но доступный словом пункт сделал бы всю модель прав косметикой.
 */
export function menuFor(roles?: readonly string[] | null): MenuItem[] {
  return STAFF_MENU.filter((i) => i.ready && can(roles, i.perm));
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
  // Подпись узнаём у ЛЮБОГО пункта, включая неготовые. Клавиатура живёт в
  // чате, пока её не заменят: убрав пункт из меню, мы не убираем его кнопку
  // с уже розданных экранов. Не узнать её значит пустить «📦 Заполнил
  // автомат» свободным текстом — комментарием к задаче или именем карточки.
  // Готовность проверяет вызывающий: неготовый пункт отвечает «пока не
  // готово», НЕ трогая начатое.
  return STAFF_MENU.find((i) => i.label === t) ?? null;
}

/**
 * Слово попало в пункт меню. Возвращаем пункт целиком, а не только id:
 * вызывающему нужен `ready`, чтобы объяснить «поток ещё не готов», а не
 * промолчать.
 */
export function matchTrigger(text: string, roles?: readonly string[] | null): MenuItem | null {
  return STAFF_MENU.find((i) => i.ready && can(roles, i.perm) && i.match(text)) ?? null;
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
