import { dueLabel, TZ } from "@mydon/shared";
import type { CoreClient, PersonRow, TaskRow } from "./core-client";
import type { Conversations } from "./conversation";
import {
  handleRegisterCallback,
  handleRegisterName,
  parseRegisterCallback,
  registerStepHint,
  startRegister,
} from "./staff-register";
import {
  handleInventoryCallback,
  handleInventoryCount,
  inventoryStepHint,
  parseInventoryCallback,
  startInventory,
} from "./staff-inventory";
import {
  handleIntakeCallback,
  handleIntakeCount,
  intakeStepHint,
  parseIntakeCallback,
  startIntake,
} from "./staff-intake";
import {
  coffeeRefillStepHint,
  handleCoffeeRefillCallback,
  handleCoffeeRefillContainer,
  handleCoffeeRefillPackages,
  handleCoffeeRefillWeight,
  handleCoffeeWashCallback,
  parseCoffeeRefillCallback,
  parseCoffeeWashCallback,
  startCoffeeRefill,
  startCoffeeWash,
} from "./coffee-refill";
import {
  coffeeConsumableStepHint,
  handleCoffeeConsumableCallback,
  handleCoffeeConsumableCounts,
  parseCoffeeConsumableCallback,
  recordContainerReturns,
  startCoffeeConsumable,
  tryParseContainerReturns,
} from "./coffee-returns";
import { handleCoffeeFixCallback, parseCoffeeFixCallback, startCoffeeFix } from "./coffee-fix";
import {
  handleTaskDoneCallback,
  handleTaskDoneReport,
  parseTaskDoneCallback,
  startTaskDone,
  taskDoneStepHint,
} from "./task-done";
import {
  helpText,
  matchMenuLabel,
  matchTrigger,
  menuItemById,
  menuKeyboard,
  parseMenuCallback,
  type MenuItem,
} from "./menu";
import type { ReplyKeyboard } from "./telegram";

/**
 * Работа сотрудника в Telegram (решение владельца: сотрудники — через бота).
 *
 * Почему Telegram, а не веб-панель: у сотрудника уже есть Telegram и он уже
 * открыт. Пароли и обучение панели означали бы, что задачи просто не дойдут.
 *
 * Главное правило доступа: сотрудник видит и трогает ТОЛЬКО свои задачи.
 * Проверка идёт по chat_id, который нельзя подделать — Telegram подставляет
 * его сам, а не берёт из текста сообщения.
 */

export interface StaffReply {
  text: string;
  keyboard?: { inline_keyboard: { text: string; callback_data: string }[][] };
  /** Постоянное меню под полем ввода. Ставится редко — при /start и первом входе. */
  replyKeyboard?: ReplyKeyboard;
}

/** Кнопки под карточкой задачи. Префикс «t:» отделяет их от согласований («ap:»). */
export function taskKeyboard(task: TaskRow): StaffReply["keyboard"] {
  const row: { text: string; callback_data: string }[] = [];
  if (task.status !== "in_progress") {
    row.push({ text: "▶️ Взял в работу", callback_data: `t:${task.id}:progress` });
  }
  row.push({ text: "✅ Выполнил", callback_data: `t:${task.id}:done` });
  return { inline_keyboard: [row] };
}

/**
 * Клавиатура списка задач: по кнопке на задачу, номер совпадает с номером
 * строки в тексте.
 *
 * Раньше список приходил десятью отдельными сообщениями — по одному на задачу,
 * потому что у сообщения может быть только одна клавиатура. Это десять запросов
 * к Bot API подряд при персональном лимите ~1 сообщение в секунду и десять
 * всплывающих уведомлений на телефоне. Теперь список — одно сообщение, а выбор
 * задачи — номерная кнопка.
 */
export function tasksKeyboard(tasks: TaskRow[]): StaffReply["keyboard"] {
  const rows = tasks.slice(0, MAX_TASKS).map((t, i) => [
    { text: `${i + 1} · ${t.title}`.slice(0, 40), callback_data: `t:${t.id}:open` },
  ]);
  return { inline_keyboard: rows };
}

/** Сколько задач помещаем в одно сообщение. Дальше — «показать ещё» в PR 8. */
const MAX_TASKS = 10;

export type TaskAction = "progress" | "done" | "open";

/** Строгий разбор нажатия: данные кнопки приходят снаружи, доверять им нельзя. */
export function parseTaskCallback(data: string): { id: string; action: TaskAction } | null {
  const m = /^t:([0-9a-f-]{36}):(progress|done|open)$/.exec(data);
  if (!m) return null;
  return { id: m[1], action: m[2] as TaskAction };
}

function taskLine(t: TaskRow): string {
  const prio = t.priority === "urgent" ? "🔥 " : t.priority === "high" ? "❗ " : "";
  const state = t.status === "in_progress" ? " · в работе" : "";
  return `${prio}${t.title}\n   ${dueLabel(t.due)}${state}`;
}

/** Карточка одной задачи — то, что видно после нажатия номерной кнопки. */
export function formatTaskCard(t: TaskRow): string {
  const lines = [`📌 ${t.title}`, `🕐 ${dueLabel(t.due)}`];
  if (t.status === "in_progress") lines.push("▶️ В работе");
  if (t.description) lines.push("", t.description);
  return lines.join("\n");
}

/** Список задач сотрудника. Пусто — это хорошая новость, так и пишем. */
export function formatMyTasks(person: PersonRow, tasks: TaskRow[]): string {
  if (tasks.length === 0) {
    return `${person.name}, задач на тебе нет. Отдыхай 👌`;
  }
  const shown = tasks.slice(0, MAX_TASKS);
  const lines = shown.map((t, i) => `${i + 1}. ${taskLine(t)}`);
  const head = `${person.name}, твои задачи (${tasks.length}):`;
  const tail = tasks.length > shown.length ? [``, `…и ещё ${tasks.length - shown.length}.`] : [];
  return [head, "", ...lines, ...tail].join("\n");
}

/** Кнопки выбора автомата для инкассации. Префикс «c:» — отдельное пространство. */
export function machinesKeyboard(machines: { id: string; name: string }[]): StaffReply["keyboard"] {
  return {
    inline_keyboard: machines
      .slice(0, 30)
      .map((m) => [{ text: m.name.slice(0, 40), callback_data: `c:${m.id}` }]),
  };
}

/** Строгий разбор нажатия инкассации. */
export function parseCollectCallback(data: string): { machineId: string } | null {
  const m = /^c:([0-9a-f-]{36})$/.exec(data);
  return m ? { machineId: m[1] } : null;
}

/**
 * Время сбора — до секунды, по-ташкентски (требование спецификации VendCash).
 *
 * Через `toLocaleString` с явной зоной, а не через `getHours()`: последний
 * читает зону процесса. Сейчас это Asia/Tashkent только потому, что так задано
 * в docker-compose, и один запуск бота вне контейнера напечатал бы инкассацию
 * другим временем — молча и без ошибки.
 */
export function formatCollectedAt(iso: string): string {
  const d = new Date(iso);
  return d
    .toLocaleString("ru-RU", {
      timeZone: TZ,
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
    .replace(", ", " ");
}

export interface StaffDeps {
  core: CoreClient;
  conversations: Conversations;
}

/**
 * Сообщение от сотрудника (не владельца).
 * Возвращает ответ и, если есть задачи, — по одной клавиатуре на задачу
 * (их шлёт вызывающий: одно сообщение может нести только одну клавиатуру).
 */
export async function handleStaffMessage(
  chatId: number,
  text: string,
  person: PersonRow,
  deps: StaffDeps,
): Promise<{ reply: StaffReply; tasks?: TaskRow[] }> {
  const clean = text.trim();

  // «Отмена» бросает любой активный визард (заведение) — раньше всего прочего.
  if (/^(отмена|стоп|cancel)$/i.test(clean)) {
    if (deps.conversations.get(chatId)) {
      deps.conversations.clear(chatId);
      return { reply: { text: "Отменил." } };
    }
  }

  // Нажатие кнопки меню — раньше активного визарда и раньше ожидания отчёта.
  //
  // Кнопка это явное намерение сменить занятие. Отвечать на неё «выбери точку
  // кнопкой», потому что человек не дошёл до конца прошлого мастера, значит
  // запереть его внутри. Бросаем начатое и говорим об этом вслух — молча
  // потерянный мастер выглядит как потерянные данные.
  const pressed = matchMenuLabel(clean);
  if (pressed) {
    const dropped = deps.conversations.get(chatId) !== null;
    deps.conversations.clear(chatId);
    const started = await startMenuItem(pressed, chatId, person, deps);
    if (dropped) {
      started.reply = { ...started.reply, text: `Прошлое не дописано — бросил.\n\n${started.reply.text}` };
    }
    return started;
  }

  // Активный визард забирает ввод по шагу (название/факт — текстом, остальное —
  // кнопками и фото). Идёт прежде отчётов и триггеров, иначе визард перебьётся.
  const conv = deps.conversations.get(chatId);
  if (conv?.flow === "register") {
    if (conv.step === "name" && clean.length > 0 && !clean.startsWith("/")) {
      return { reply: await handleRegisterName(chatId, clean, person, deps) };
    }
    return { reply: { text: registerStepHint(conv.step) } };
  }
  if (conv?.flow === "inventory") {
    if (conv.step === "count" && clean.length > 0 && !clean.startsWith("/")) {
      return { reply: await handleInventoryCount(chatId, clean, person, deps) };
    }
    return { reply: { text: inventoryStepHint(conv.step) } };
  }
  if (conv?.flow === "intake") {
    if (conv.step === "count" && clean.length > 0 && !clean.startsWith("/")) {
      return { reply: await handleIntakeCount(chatId, clean, person, deps) };
    }
    return { reply: { text: intakeStepHint(conv.step) } };
  }
  if (conv?.flow === "coffee-refill") {
    if (clean.length > 0 && !clean.startsWith("/")) {
      if (conv.step === "weight") return { reply: await handleCoffeeRefillWeight(chatId, clean, deps) };
      if (conv.step === "packages") return { reply: await handleCoffeeRefillPackages(chatId, clean, deps) };
      if (conv.step === "container") return { reply: await handleCoffeeRefillContainer(chatId, clean, person, deps) };
    }
    return { reply: { text: coffeeRefillStepHint(conv.step) } };
  }
  if (conv?.flow === "task-done") {
    if (conv.step === "report" && clean.length > 0 && !clean.startsWith("/")) {
      return { reply: handleTaskDoneReport(chatId, clean, deps) };
    }
    return { reply: { text: taskDoneStepHint(conv.step) } };
  }
  if (conv?.flow === "coffee-consumable") {
    if (conv.step === "counts" && clean.length > 0 && !clean.startsWith("/")) {
      return { reply: await handleCoffeeConsumableCounts(chatId, clean, person, deps) };
    }
    return { reply: { text: coffeeConsumableStepHint(conv.step) } };
  }

  // Возвраты наборов — привычный формат группы «позиция. набор. вес», без
  // команд: строки вида «1. 027. 787» ни с чем не спутать, разбор
  // детерминированный. Сотрудник шлёт то же сообщение, что раньше в тему.
  const containerReturns = tryParseContainerReturns(clean);
  if (containerReturns) {
    return { reply: await recordContainerReturns(containerReturns, person, deps) };
  }

  // Первый вход: ставим постоянное меню и сразу показываем задачи.
  if (clean === "/start" || /привет|старт/i.test(clean)) {
    const tasks = await deps.core.myTasks("human", person.id);
    return {
      reply: {
        text: `${formatMyTasks(person, tasks)}\n\n${helpText()}`,
        ...(tasks.length > 0 ? { keyboard: tasksKeyboard(tasks) } : {}),
        replyKeyboard: menuKeyboard(),
      },
    };
  }

  // Слово попало в пункт меню — тот же обработчик, что и у кнопки.
  const hit = matchTrigger(clean);
  if (hit) return startMenuItem(hit, chatId, person, deps);

  // Всё остальное от сотрудника — комментарий к его текущей задаче:
  // проще написать боту, чем звонить владельцу.
  const tasks = await deps.core.myTasks("human", person.id);
  if (tasks.length === 1 && clean.length > 2) {
    await deps.core.addTaskComment(tasks[0].id, clean, `person:${person.id}`);
    return { reply: { text: `Передал владельцу по задаче «${tasks[0].title}».` } };
  }

  return { reply: { text: helpText(), replyKeyboard: menuKeyboard() } };
}

/**
 * Запуск пункта меню. Единственное место, где id пункта превращается в
 * действие: и кнопка, и слово, и inline-дубль приходят сюда.
 */
async function startMenuItem(
  item: MenuItem,
  chatId: number,
  person: PersonRow,
  deps: StaffDeps,
): Promise<{ reply: StaffReply; tasks?: TaskRow[] }> {
  if (!item.ready) {
    return { reply: { text: `«${item.label}» пока не готово — скоро включим.` } };
  }

  switch (item.id) {
    case "tasks": {
      const tasks = await deps.core.myTasks("human", person.id);
      return {
        reply: {
          text: formatMyTasks(person, tasks),
          ...(tasks.length > 0 ? { keyboard: tasksKeyboard(tasks) } : {}),
        },
      };
    }
    case "coll": {
      const machines = await deps.core.machines();
      if (machines.length === 0) {
        return { reply: { text: "Автоматов в реестре пока нет — скажи владельцу." } };
      }
      return {
        reply: {
          text: "С какого автомата собраны деньги? Время зафиксируется в момент нажатия.",
          keyboard: machinesKeyboard(machines),
        },
      };
    }
    case "new":
      return { reply: startRegister(chatId, deps) };
    case "intake":
      return { reply: await startIntake(chatId, deps) };
    case "count":
      return { reply: await startInventory(chatId, deps) };
    case "refill":
      return { reply: await startCoffeeRefill(chatId, deps) };
    case "clean":
      return { reply: await startCoffeeWash(chatId, deps) };
    case "cons":
      return { reply: await startCoffeeConsumable(chatId, deps) };
    case "fix":
      return { reply: await startCoffeeFix(person, deps) };
    default:
      // Пункт объявлен ready, но обработчика нет — это ошибка сборки меню,
      // а не сотрудника. Говорим ровно то же, что и про неготовый поток.
      return { reply: { text: `«${item.label}» пока не готово — скоро включим.` } };
  }
}

/** Нажатие кнопки под задачей. Права проверяются по chat_id нажавшего. */
export async function handleStaffCallback(
  chatId: number,
  data: string,
  person: PersonRow,
  deps: StaffDeps,
): Promise<{
  answer: string;
  message?: string;
  keyboard?: StaffReply["keyboard"];
  ownerNote?: string;
  /** Перерисовать исходное сообщение вместо отправки нового. */
  edit?: { text: string; keyboard?: StaffReply["keyboard"] };
}> {
  // Inline-дубль меню (m:<id>) — тот же обработчик, что у кнопки снизу.
  const menuHit = parseMenuCallback(data);
  if (menuHit) {
    const item = menuItemById(menuHit.id);
    if (!item) return { answer: "Кнопка устарела" };
    deps.conversations.clear(chatId);
    const started = await startMenuItem(item, chatId, person, deps);
    return {
      answer: item.label,
      message: started.reply.text,
      ...(started.reply.keyboard ? { keyboard: started.reply.keyboard } : {}),
    };
  }

  // Кнопки визарда заведения (r:type/photo/unit/cancel).
  const reg = parseRegisterCallback(data);
  if (reg) {
    const res = await handleRegisterCallback(chatId, reg, person, deps);
    return {
      answer: res.answer,
      ...(res.message ? { message: res.message.text, keyboard: res.message.keyboard } : {}),
    };
  }

  // Кнопки инвентаризации (i:wh/ing/cancel).
  const inv = parseInventoryCallback(data);
  if (inv) {
    const res = await handleInventoryCallback(chatId, inv, person, deps);
    return {
      answer: res.answer,
      ...(res.message ? { message: res.message.text, keyboard: res.message.keyboard } : {}),
    };
  }

  // Кнопки прихода (n:wh/ing/cancel).
  const intake = parseIntakeCallback(data);
  if (intake) {
    const res = await handleIntakeCallback(chatId, intake, person, deps);
    return {
      answer: res.answer,
      ...(res.message ? { message: res.message.text, keyboard: res.message.keyboard } : {}),
    };
  }

  // Кнопки заливки кофейного бункера (cf:loc/pos/cancel).
  const coffeeRefill = parseCoffeeRefillCallback(data);
  if (coffeeRefill) {
    const res = await handleCoffeeRefillCallback(chatId, coffeeRefill, person, deps);
    return {
      answer: res.answer,
      ...(res.message ? { message: res.message.text, keyboard: res.message.keyboard } : {}),
    };
  }

  // Кнопки мойки кофейного бункера (cw:loc/pos/cancel).
  const coffeeWash = parseCoffeeWashCallback(data);
  if (coffeeWash) {
    const res = await handleCoffeeWashCallback(chatId, coffeeWash, person, deps);
    return {
      answer: res.answer,
      ...(res.message ? { message: res.message.text, keyboard: res.message.keyboard } : {}),
    };
  }

  // Кнопки расходников (cc:loc/cancel).
  const coffeeConsumable = parseCoffeeConsumableCallback(data);
  if (coffeeConsumable) {
    const res = await handleCoffeeConsumableCallback(chatId, coffeeConsumable, deps);
    return {
      answer: res.answer,
      ...(res.message ? { message: res.message.text, keyboard: res.message.keyboard } : {}),
    };
  }

  // Кнопки закрытия задачи (dn:ok/np/x).
  const done = parseTaskDoneCallback(data);
  if (done) {
    const res = await handleTaskDoneCallback(chatId, done, person, deps);
    return {
      answer: res.answer,
      ...(res.message ? { message: res.message.text, keyboard: res.message.keyboard } : {}),
    };
  }

  // Кнопки «ошибся — исправить» (fx:del/keep). Core не даст удалить чужое.
  const coffeeFix = parseCoffeeFixCallback(data);
  if (coffeeFix) {
    const res = await handleCoffeeFixCallback(coffeeFix, person, deps);
    return { answer: res.answer, ...(res.message ? { message: res.message } : {}) };
  }

  // Кнопка инкассации: фиксируем сбор с точным временем.
  const collect = parseCollectCallback(data);
  if (collect) {
    const created = await deps.core.createCollection(collect.machineId, person.id);
    const when = formatCollectedAt(created.collectedAt);
    return {
      answer: "Сбор записан",
      message:
        `📥 Сбор зафиксирован: ${when}\n` +
        "Деньги передай менеджеру — сумму введут при приёме.",
      ownerNote: `📥 Инкассация: ${person.name} снял(а) выручку с автомата · ${when}. Ожидает приёма и пересчёта в панели.`,
    };
  }

  const parsed = parseTaskCallback(data);
  if (!parsed) return { answer: "Не понял кнопку" };

  const task = await deps.core.task(parsed.id);
  if (task.ownerKind !== "human" || task.ownerRef !== person.id) {
    // Не сообщаем ничего о чужой задаче — только отказ.
    return { answer: "Это не твоя задача" };
  }

  // Номерная кнопка из списка: раскрываем карточку на месте.
  if (parsed.action === "open") {
    return {
      answer: task.title.slice(0, 60),
      edit: { text: formatTaskCard(task), keyboard: taskKeyboard(task) },
    };
  }

  if (parsed.action === "progress") {
    await deps.core.setTaskStatus(parsed.id, "in_progress", `person:${person.id}`);
    // Перерисовываем карточку, а не шлём вторую: иначе в чате две карточки
    // одной задачи, и обе с живыми кнопками — «Взял» можно нажать дважды.
    const updated: TaskRow = { ...task, status: "in_progress" };
    return {
      answer: "Отметил: в работе",
      edit: { text: `${formatTaskCard(updated)}\n\n▶️ Взял в работу.`, keyboard: taskKeyboard(updated) },
    };
  }

  // «Выполнил» — мастер закрытия: отчёт, фото, подтверждение.
  //
  // Раньше здесь взводился отдельный однослотовый AwaitingReport («жду одну
  // строку»). Он удалён: мастер делает то же самое и ещё фото, а два
  // параллельных механизма ожидания текста в одном чате рано или поздно
  // разошлись бы — и отчёт уходил бы в тот, который не ждали.
  const started = startTaskDone(chatId, task, deps);
  return {
    answer: "Напиши, что сделано",
    // Кнопки старой карточки снимаем: пока идёт мастер, нажимать на неё
    // нечего, а повторное «Выполнил» перезапустило бы ввод с нуля.
    edit: { text: `${formatTaskCard(task)}\n\n▶️ Закрываю…` },
    message: started.text,
    ...(started.keyboard ? { keyboard: started.keyboard } : {}),
  };
}
