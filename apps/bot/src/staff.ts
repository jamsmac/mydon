import { can, dueLabel, TZ } from "@mydon/shared";
import type { CoreClient, PersonRow, TaskRow } from "./core-client";
import type { Conversations } from "./conversation";
import { nextLocationKeyboard, parseVisitCallback, visitFromFlow, visitKeyboard, visitSummary } from "./coffee-visit";
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
  continueVisitRefill,
  coffeeRefillStepHint,
  handleCoffeeRefillBefore,
  handleCoffeeRefillCallback,
  handleCoffeeRefillContainer,
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
  continueVisitConsumable,
  tryParseContainerReturns,
} from "./coffee-returns";
import { handleCoffeeFixCallback, parseCoffeeFixCallback, startCoffeeFix } from "./coffee-fix";
import {
  finishAfterPhoto,
  handleCleanCallback,
  handlePartReplaceCallback,
  handlePartSerial,
  handleProblemCallback,
  FIELD_FLOWS,
  handleServiceCheckCallback,
  onObjectPicked,
  parseAfterPhotoCallback,
  parseCleanCallback,
  parsePartReplaceCallback,
  parseProblemCallback,
  parseServiceCheckCallback,
  partReplaceStepHint,
  startClean,
  startPartReplace,
  startProblem,
  startServiceCheck,
} from "./field-work";
import { allObjects, parsePickerCallback, searchObjects, searchPrompt } from "./machine-picker";
import { handleSchedulesCallback, parseSchedulesCallback, startSchedules } from "./schedules";
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
  return {
    inline_keyboard: [
      row,
      // Отдельным рядом: «не смогу» — не повседневная кнопка, и стоять
      // рядом с «Выполнил» ей нельзя. «🙅», не «↩️»: тот значок занят
      // «Ошибся — исправить» (удаление записи) — один символ на два действия
      // разной цены провоцирует промах при сканировании по эмодзи.
      [{ text: "🙅 Не смогу", callback_data: `t:${task.id}:free` }],
    ],
  };
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
export function tasksKeyboard(tasks: TaskRow[], free: TaskRow[] = []): StaffReply["keyboard"] {
  const rows = tasks.slice(0, MAX_TASKS).map((t, i) => [
    { text: `${i + 1} · ${t.title}`.slice(0, 40), callback_data: `t:${t.id}:open` },
  ]);
  free.slice(0, MAX_FREE).forEach((t, i) => {
    rows.push([
      {
        text: `✋ Взять ${tasks.length + i + 1} · ${t.title}`.slice(0, 40),
        callback_data: `t:${t.id}:claim`,
      },
    ]);
  });
  return { inline_keyboard: rows };
}

/** Сколько свободных задач показываем в списке. Дальше — «показать ещё». */
const MAX_FREE = 5;

/** Сколько задач помещаем в одно сообщение. Дальше — «показать ещё» в PR 8. */
const MAX_TASKS = 10;

export type TaskAction = "progress" | "done" | "open" | "claim" | "free";

/** Строгий разбор нажатия: данные кнопки приходят снаружи, доверять им нельзя. */
export function parseTaskCallback(data: string): { id: string; action: TaskAction } | null {
  const m = /^t:([0-9a-f-]{36}):(progress|done|open|claim|free)$/.exec(data);
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

/**
 * Список задач сотрудника плюс блок свободных.
 *
 * Свободные показываются всем: закрепления за объектами нет, и задача от
 * монитора графиков рождается ничьей. Блок не рисуется при пустом пуле —
 * заголовок «Свободные:» без строк читается как поломка.
 */
export function formatMyTasks(person: PersonRow, tasks: TaskRow[], free: TaskRow[] = []): string {
  if (tasks.length === 0 && free.length === 0) {
    return `${person.name}, задач на тебе нет. Отдыхай 👌`;
  }

  const parts: string[] = [];
  if (tasks.length > 0) {
    const shown = tasks.slice(0, MAX_TASKS);
    parts.push(`${person.name}, твои задачи (${tasks.length}):`, "");
    parts.push(...shown.map((t, i) => `${i + 1}. ${taskLine(t)}`));
    if (tasks.length > shown.length) parts.push("", `…и ещё ${tasks.length - shown.length}.`);
  } else {
    parts.push(`${person.name}, на тебе сейчас ничего.`);
  }

  if (free.length > 0) {
    const shown = free.slice(0, MAX_FREE);
    parts.push("", "🆓 Свободные — кто возьмёт:", "");
    parts.push(...shown.map((t, i) => `${tasks.length + i + 1}. ${taskLine(t)}`));
    if (free.length > shown.length) parts.push("", `…и ещё ${free.length - shown.length} свободных.`);
  }

  return parts.join("\n");
}

/** Кнопки выбора автомата для инкассации. Префикс «c:» — отдельное пространство. */
export function machinesKeyboard(machines: { id: string; name: string }[]): StaffReply["keyboard"] {
  // «Отмена» обязательна: это был единственный список выбора во всём боте без
  // выхода кнопкой, при том что любое нажатие по строке сразу пишет сбор.
  // `c:cancel` не конфликтует с `c:<uuid>` — parseCollectCallback требует uuid.
  return {
    inline_keyboard: [
      ...machines.slice(0, 30).map((m) => [{ text: m.name.slice(0, 40), callback_data: `c:${m.id}` }]),
      [{ text: "✖️ Отмена", callback_data: "c:cancel" }],
    ],
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

  // «Отмена» бросает активный визард — раньше всего прочего. Но слово обязано
  // вести себя как кнопка «✖️ Отмена» (#149): посреди начатого обхода
  // бросается только подшаг, а точка и счётчики остаются — иначе одинаково
  // подписанные действия имели бы противоположную цену, и набравший слово
  // (справка сама его предлагает) терял обход молча.
  if (/^(отмена|стоп|cancel)$/i.test(clean)) {
    const active = deps.conversations.get(chatId);
    if (active) {
      const visit = visitFromFlow(active);
      if (visit && active.flow !== "coffee-visit") {
        deps.conversations.start(chatId, "coffee-visit", "menu", { ...visit });
        return {
          reply: { text: `Отменил. Ты на точке «${visit.locationName}».`, keyboard: visitKeyboard(visit) },
        };
      }
      deps.conversations.clear(chatId);
      return {
        reply: {
          text: visit ? `Отменил. Обход по «${visit.locationName}» закрыт — записанное цело.` : "Отменил.",
        },
      };
    }
  }

  // Нажатие кнопки меню — раньше активного визарда и раньше ожидания отчёта.
  //
  // Кнопка это явное намерение сменить занятие. Отвечать на неё «выбери точку
  // кнопкой», потому что человек не дошёл до конца прошлого мастера, значит
  // запереть его внутри. Бросаем начатое и говорим об этом вслух — молча
  // потерянный мастер выглядит как потерянные данные.
  const pressed = matchMenuLabel(clean);
  if (pressed && !pressed.ready) {
    // Кнопка с уже розданной клавиатуры: пункт убрали, а кнопка осталась.
    // Отвечаем ДО каких-либо действий с беседой — раньше нажатие сначала
    // гасило начатое (обход, отчёт) и лишь потом говорило «не готово».
    return { reply: { text: `«${pressed.label}» пока не готово — скоро включим.` } };
  }
  if (pressed && !can(person.roles, pressed.perm)) {
    // Кнопка могла остаться на экране от прежнего набора ролей: клавиатура
    // живёт в чате, пока её не заменят. Отказ должен быть внятным, а не
    // «не понял» — человек нажал то, что видит.
    return { reply: { text: `«${pressed.label}» тебе сейчас недоступно. Скажи владельцу.` } };
  }
  if (pressed) {
    const prev = deps.conversations.get(chatId);

    // Идёт обход, и нажата кнопка того же дела — продолжаем на текущей точке.
    //
    // На экране два одинаковых «💧 Расходники»: inline в меню точки и та же
    // надпись в постоянной нижней клавиатуре. Человек жмёт нижнюю — она
    // привычнее и всегда на виду. Раньше это сбрасывало обход и снова
    // спрашивало «Расходники какой точки?» — ровно то повторное называние
    // точки, ради устранения которого обход и делался.
    const visit = visitFromFlow(prev);
    if (visit && (pressed.id === "cons" || pressed.id === "refill")) {
      // Продолжаем обход на той же точке. Но если человек был ПОСРЕДИ ввода
      // (набранный вес, замер, вода) — сказать об этом обязательно: молча
      // выброшенные цифры выглядят как сохранённые.
      const midStep = prev !== null && prev.flow !== "coffee-visit" && prev.step !== "position" && prev.step !== "menu";
      const reply =
        pressed.id === "cons"
          ? continueVisitConsumable(chatId, visit, deps)
          : await continueVisitRefill(chatId, visit, deps);
      if (midStep) {
        reply.text = `Прошлый ввод не дописан — бросил.

${reply.text}`;
      }
      return { reply };
    }

    // Меню точки — не «недописанный мастер»: обход это законченная запись плюс
    // предложение продолжить. Пугать «прошлое не дописано» после КАЖДОЙ
    // успешной заливки значит приучить не читать предупреждение вовсе.
    const dropped = prev !== null && prev.flow !== "coffee-visit";
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
      if (conv.step === "container") return { reply: await handleCoffeeRefillContainer(chatId, clean, person, deps) };
      if (conv.step === "before") return { reply: await handleCoffeeRefillBefore(chatId, clean, deps) };
      if (conv.step === "weight") return { reply: await handleCoffeeRefillWeight(chatId, clean, deps, person) };
    }
    return { reply: { text: coffeeRefillStepHint(conv.step) } };
  }
  if (conv?.flow === "part-replace") {
    if (conv.step === "object" && clean.length > 0 && !clean.startsWith("/")) {
      return { reply: await searchObjects(clean, deps) };
    }
    if (conv.step === "serial" && clean.length > 0 && !clean.startsWith("/")) {
      return { reply: handlePartSerial(chatId, clean, deps) };
    }
    return { reply: { text: partReplaceStepHint(conv.step) } };
  }
  // Остальные мастера обслуживания вводят текстом только поиск объекта.
  if (conv?.flow === "clean" || conv?.flow === "service-check" || conv?.flow === "problem") {
    if (conv.step === "object" && clean.length > 0 && !clean.startsWith("/")) {
      return { reply: await searchObjects(clean, deps) };
    }
    return { reply: { text: "Выбери кнопкой." } };
  }
  if (conv?.flow === "after-photo") {
    // Текст на шаге фото — это уже другой разговор. Не держим человека:
    // запись сохранена, фото было необязательным.
    deps.conversations.clear(chatId);
  }
  if (conv?.flow === "task-done") {
    if (conv.step === "report" && clean.length > 0 && !clean.startsWith("/")) {
      return { reply: handleTaskDoneReport(chatId, clean, deps) };
    }
    return { reply: { text: taskDoneStepHint(conv.step) } };
  }
  if (conv?.flow === "coffee-consumable") {
    // Шаги — water/cups/lids/confirm. Раньше здесь стояло "counts": шаг из
    // прежней версии, которого после перехода на ввод по одному числу не
    // существует. Условие не совпадало никогда, и текстовый ввод расходников
    // молча умер — бот отвечал тем же вопросом по кругу. Тесты этого не
    // поймали, потому что зовут обработчик напрямую, мимо диспетчера.
    const numericStep = conv.step === "water" || conv.step === "cups" || conv.step === "lids";
    if ((numericStep || conv.step === "confirm") && clean.length > 0 && !clean.startsWith("/")) {
      return { reply: await handleCoffeeConsumableCounts(chatId, clean, person, deps) };
    }
    return { reply: { text: coffeeConsumableStepHint(conv.step) } };
  }

  // Возвраты наборов — привычный формат группы «позиция. набор. вес», без
  // команд: строки вида «1. 027. 787» ни с чем не спутать, разбор
  // детерминированный. Сотрудник шлёт то же сообщение, что раньше в тему.
  const containerReturns = tryParseContainerReturns(clean);
  if (containerReturns) {
    // Единственная кофейная мутация, стоявшая до всех проверок прав: строку
    // формата группы мог записать любой подключённый, включая карточку без
    // ролей. Гейтим тем же правом, что и заливку, — это один контур работы.
    if (!can(person.roles, "coffee.refill")) {
      return { reply: { text: "Возвраты наборов тебе сейчас недоступны. Скажи владельцу." } };
    }
    return { reply: await recordContainerReturns(containerReturns, person, deps) };
  }

  // Первый вход: ставим постоянное меню и сразу показываем задачи.
  if (clean === "/start" || /привет|старт/i.test(clean)) {
    const tasks = await deps.core.myTasks("human", person.id);
    return {
      reply: {
        text: `${formatMyTasks(person, tasks)}\n\n${helpText(person.roles)}`,
        ...(tasks.length > 0 ? { keyboard: tasksKeyboard(tasks) } : {}),
        replyKeyboard: menuKeyboard(person.roles),
      },
    };
  }

  // Слово попало в пункт меню — тот же обработчик, что и у кнопки.
  const hit = matchTrigger(clean, person.roles);
  if (hit) {
    // Слово «вода»/«бункер» посреди обхода — то же, что кнопка того же дела:
    // продолжаем на текущей точке, не спрашивая её заново (D8 из 17.08 —
    // словесный вход шёл мимо visitFromFlow и терял точку обхода).
    const visit = visitFromFlow(conv);
    if (visit && (hit.id === "cons" || hit.id === "refill")) {
      const reply =
        hit.id === "cons"
          ? continueVisitConsumable(chatId, visit, deps)
          : await continueVisitRefill(chatId, visit, deps);
      return { reply };
    }
    return startMenuItem(hit, chatId, person, deps);
  }

  // Меню точки: непонятый текст не должен уходить комментарием к чужой задаче
  // (единственный flow без своей текстовой ветки — хвост 17.08). Человек стоит
  // на точке и говорит с обходом — подсказываем кнопки, ничего не теряя.
  const visitMenu = visitFromFlow(conv);
  if (visitMenu && conv?.flow === "coffee-visit") {
    return {
      reply: {
        text: `Ты на точке «${visitMenu.locationName}». Не понял — жми кнопку: ещё бункер, расходники или «Завершить точку».`,
        keyboard: visitKeyboard(visitMenu),
      },
    };
  }

  // Всё остальное от сотрудника — комментарий к его текущей задаче:
  // проще написать боту, чем звонить владельцу.
  const tasks = await deps.core.myTasks("human", person.id);
  if (tasks.length === 1 && clean.length > 2) {
    await deps.core.addTaskComment(tasks[0].id, clean, `person:${person.id}`);
    return { reply: { text: `Передал владельцу по задаче «${tasks[0].title}».` } };
  }

  return { reply: { text: helpText(person.roles), replyKeyboard: menuKeyboard(person.roles) } };
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
  // Последний рубеж для ВСЕХ трёх входов (кнопка, слово, inline-дубль):
  // входы проверяют право сами, но модель прав не должна зависеть от того,
  // что ни один из них не забыл — Core ролей не проверяет вовсе.
  if (!can(person.roles, item.perm)) {
    return { reply: { text: `«${item.label}» тебе сейчас недоступно. Скажи владельцу.` } };
  }

  switch (item.id) {
    case "tasks": {
      const [tasks, free] = await Promise.all([
        deps.core.myTasks("human", person.id),
        // Свободные — общий пул. Их видят все: закрепления за объектами нет.
        deps.core.unassignedTasks().catch(() => [] as TaskRow[]),
      ]);
      return {
        reply: {
          text: formatMyTasks(person, tasks, free),
          ...(tasks.length + free.length > 0 ? { keyboard: tasksKeyboard(tasks, free) } : {}),
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
    case "wash":
      return { reply: await startCoffeeWash(chatId, deps) };
    case "cons":
      return { reply: await startCoffeeConsumable(chatId, deps) };
    case "fix":
      return { reply: await startCoffeeFix(person, deps) };
    case "part":
      return { reply: await startPartReplace(chatId, person, deps) };
    case "clean":
      return { reply: await startClean(chatId, person, deps) };
    case "insp":
      return { reply: await startServiceCheck(chatId, person, deps) };
    case "issue":
      return { reply: await startProblem(chatId, person, deps) };
    case "sched":
      return { reply: await startSchedules(chatId, deps) };
    default:
      // Пункт объявлен ready, но обработчика нет — это ошибка сборки меню,
      // а не сотрудника. Говорим ровно то же, что и про неготовый поток.
      return { reply: { text: `«${item.label}» пока не готово — скоро включим.` } };
  }
}

/** Ответ мастера → ответ обработчика кнопки. Четыре копии этого не нужны. */
function unwrap(res: { answer: string; message?: StaffReply }): {
  answer: string;
  message?: string;
  keyboard?: StaffReply["keyboard"];
} {
  return {
    answer: res.answer,
    ...(res.message ? { message: res.message.text, keyboard: res.message.keyboard } : {}),
  };
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
    // Право и готовность — ДО clear, зеркально текстовому пути: иначе
    // старые inline-кнопки продолжали пускать после отзыва роли (callback_data
    // приходит снаружи и подделывается), а сам запрет стоил бы человеку
    // активного мастера.
    if (!item.ready) return { answer: "Пока не готово", message: `«${item.label}» пока не готово — скоро включим.` };
    if (!can(person.roles, item.perm)) {
      return { answer: "Недоступно", message: `«${item.label}» тебе сейчас недоступно. Скажи владельцу.` };
    }
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

  // Кнопки инвентаризации (i:wh/ing/нумпад/cancel).
  const inv = parseInventoryCallback(data);
  if (inv) {
    const res = await handleInventoryCallback(chatId, inv, person, deps);
    return {
      answer: res.answer,
      // `edit` — набор цифр нумпадом: перерисовываем то же сообщение.
      ...(res.edit ? { edit: { text: res.edit.text, ...(res.edit.keyboard ? { keyboard: res.edit.keyboard } : {}) } } : {}),
      ...(res.message ? { message: res.message.text, keyboard: res.message.keyboard } : {}),
    };
  }

  // Кнопки прихода (n:wh/ing/нумпад/cancel).
  const intake = parseIntakeCallback(data);
  if (intake) {
    const res = await handleIntakeCallback(chatId, intake, person, deps);
    return {
      answer: res.answer,
      ...(res.edit ? { edit: { text: res.edit.text, ...(res.edit.keyboard ? { keyboard: res.edit.keyboard } : {}) } } : {}),
      ...(res.message ? { message: res.message.text, keyboard: res.message.keyboard } : {}),
    };
  }

  // Кнопки заливки кофейного бункера (cf:loc/pos/n/cancel).
  const coffeeRefill = parseCoffeeRefillCallback(data);
  if (coffeeRefill) {
    const res = await handleCoffeeRefillCallback(chatId, coffeeRefill, person, deps);
    return {
      answer: res.answer,
      // `edit` — набор цифр: перерисовываем то же сообщение. Иначе вес из
      // четырёх нажатий оставил бы в чате четыре сообщения подряд.
      ...(res.edit ? { edit: { text: res.edit.text, ...(res.edit.keyboard ? { keyboard: res.edit.keyboard } : {}) } } : {}),
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

  // Кнопки расходников (cc:loc/n/save/fix/cancel).
  const coffeeConsumable = parseCoffeeConsumableCallback(data);
  if (coffeeConsumable) {
    const res = await handleCoffeeConsumableCallback(chatId, coffeeConsumable, person, deps);
    return {
      answer: res.answer,
      ...(res.edit ? { edit: { text: res.edit.text, ...(res.edit.keyboard ? { keyboard: res.edit.keyboard } : {}) } } : {}),
      ...(res.message ? { message: res.message.text, keyboard: res.message.keyboard } : {}),
    };
  }

  // Меню обхода точки (cv:): точка выбрана один раз, дальше делаем на ней всё.
  const visitCb = parseVisitCallback(data);
  if (visitCb) {
    const conv = deps.conversations.get(chatId);
    // Обход жив и внутри его мастеров: человек мог нажать кнопку меню точки,
    // не закончив подшаг заливки/расходников. Это кнопки ТЕКУЩЕГО обхода, и
    // отвергать их как устаревшие значило бы отказывать в законном действии
    // и советовать «отмену», которая всё уносит.
    const visit = visitFromFlow(conv);

    // Двойное нажатие «Следующая точка»: первое уже открыло выбор точки, и
    // второй тап (медленная сеть, привычный даблтап) раньше натыкался на
    // барьер ниже с ложным «у тебя не дописано другое».
    if (visitCb.kind === "next" && conv?.flow === "coffee-refill" && conv.step === "location") {
      return { answer: "Уже выбираешь точку", message: "Уже выбираешь точку — жми кнопку из списка выше." };
    }

    // Кнопки обхода живут в чате вечно, а слот беседы один. Нажатие старой
    // кнопки во время НЕ-кофейного мастера молча стирало его: недописанный
    // отчёт по задаче исчезал без единого слова. Отказываем, а не затираем.
    if (conv !== null && visit === null) {
      return {
        answer: "Кнопка устарела",
        message: "Эта кнопка от прошлого обхода. Сейчас у тебя не дописано другое — сначала доделай его.",
      };
    }

    // Недописанный ввод подшага (набранный вес, замер, номер набора) кнопки
    // меню точки бросают ЗАКОННО — но об этом обязательно сказать: молча
    // выброшенные цифры выглядят как сохранённые (у нижнего меню такое
    // предупреждение уже есть — staff-путь midStep).
    const midInput = conv !== null && conv.flow !== "coffee-visit";
    const droppedNote = midInput ? "Прошлый ввод не дописан — бросил.\n\n" : "";

    // Кнопки обхода запускают мастера записи — право проверяется здесь же:
    // кнопка живёт в чате вечно, а роль могли отозвать после её раздачи.
    if (visitCb.kind === "next" || visitCb.kind === "more") {
      if (!can(person.roles, "coffee.refill")) {
        return { answer: "Недоступно", message: "Заливка тебе сейчас недоступна. Скажи владельцу." };
      }
    }
    if (visitCb.kind === "consumables" && !can(person.roles, "coffee.consumable")) {
      return { answer: "Недоступно", message: "Расходники тебе сейчас недоступны. Скажи владельцу." };
    }

    if (visitCb.kind === "next") {
      const started = await startCoffeeRefill(chatId, deps);
      return { answer: "Следующая точка", message: droppedNote + started.text, keyboard: started.keyboard };
    }
    if (!visit) {
      // conv === null здесь означает и «завершил», и «истёк по тишине» (TTL
      // 45 минут) — врать «завершён» во втором случае нельзя: человек решит,
      // что точка закрыта записью.
      return { answer: "Обход не найден", message: "Обход завершён или истёк по тишине. Начни заново: «бункер»." };
    }
    if (visitCb.kind === "more") {
      const step = await continueVisitRefill(chatId, visit, deps);
      // Перерисовываем то же сообщение: меню точки не остаётся в чате ещё
      // одним вечным экраном с живыми cv:-кнопками.
      return {
        answer: "Ещё бункер",
        edit: { text: droppedNote + step.text, ...(step.keyboard ? { keyboard: step.keyboard } : {}) },
      };
    }
    if (visitCb.kind === "consumables") {
      const step = continueVisitConsumable(chatId, visit, deps);
      return {
        answer: "Расходники",
        edit: { text: droppedNote + step.text, ...(step.keyboard ? { keyboard: step.keyboard } : {}) },
      };
    }
    deps.conversations.clear(chatId);
    return {
      answer: "Точка закрыта",
      message: droppedNote + visitSummary(visit),
      keyboard: nextLocationKeyboard(),
    };
  }

  // Общий пикер объекта (mp:) — един для всех мастеров обслуживания.
  const picked = parsePickerCallback(data);
  if (picked) {
    if (picked.kind === "cancel") {
      // Пикер принадлежит полевым мастерам: «Отмена» с чужого устаревшего
      // экрана не гасит текущее дело — тот же барьер, что у остальных отмен.
      const current = deps.conversations.get(chatId);
      if (current !== null && !(FIELD_FLOWS as readonly string[]).includes(current.flow)) {
        return { answer: "Кнопка устарела", message: "Эта кнопка от прошлого шага — она уже не действует." };
      }
      deps.conversations.clear(chatId);
      return { answer: "Отменено", message: "Отменил." };
    }
    const conv = deps.conversations.get(chatId);
    if (!conv) return { answer: "Мастер истёк", message: "Начни заново кнопкой из меню." };
    if (picked.kind === "search") {
      const r = searchPrompt();
      return { answer: "Поиск", message: r.text, ...(r.keyboard ? { keyboard: r.keyboard } : {}) };
    }
    if (picked.kind === "all") {
      const r = await allObjects(deps);
      return { answer: "Все", message: r.text, ...(r.keyboard ? { keyboard: r.keyboard } : {}) };
    }
    const r = await onObjectPicked(chatId, picked.id, deps);
    return { answer: "Выбрано", message: r.text, ...(r.keyboard ? { keyboard: r.keyboard } : {}) };
  }

  const schedCb = parseSchedulesCallback(data);
  if (schedCb) {
    // Раздел читает графики и пишет журнал ТО, а обработчик при пустой беседе
    // сам перезапрашивает данные из Core — подделанный callback без этой
    // проверки отдавал бы список работ и запись «сделал» любому сотруднику.
    if (!can(person.roles, "maintenance.view")) {
      return { answer: "Недоступно", message: "«🗓 Графики» тебе сейчас недоступно. Скажи владельцу." };
    }
    return unwrap(await handleSchedulesCallback(chatId, schedCb, person, deps));
  }

  const partCb = parsePartReplaceCallback(data);
  if (partCb) {
    const res = await handlePartReplaceCallback(chatId, partCb, person, deps);
    return unwrap(res);
  }

  const cleanCb = parseCleanCallback(data);
  if (cleanCb) return unwrap(await handleCleanCallback(chatId, cleanCb, person, deps));

  const svCb = parseServiceCheckCallback(data);
  if (svCb) return unwrap(await handleServiceCheckCallback(chatId, svCb, person, deps));

  const prCb = parseProblemCallback(data);
  if (prCb) return unwrap(await handleProblemCallback(chatId, prCb, person, deps));

  if (parseAfterPhotoCallback(data)) return unwrap(finishAfterPhoto(chatId, deps));

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

  // Инкассация: «Отмена» просто закрывает список — беседа им не занята.
  if (data === "c:cancel") {
    return { answer: "Отменено", message: "Инкассацию отменил." };
  }

  // Кнопка инкассации: фиксируем сбор с точным временем.
  const collect = parseCollectCallback(data);
  if (collect) {
    // Право — у самой записи, а не только у открытия меню: клавиатура с
    // автоматами живёт в чате вечно, и после отзыва роли collector старая
    // кнопка писала бы сбор и слала владельцу ложное «снял выручку».
    if (!can(person.roles, "cash.collect")) {
      return { answer: "Недоступно", message: "Инкассация тебе сейчас недоступна. Скажи владельцу." };
    }
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

  // «Беру» — единственное действие над ЧУЖОЙ (ничьей) задачей, поэтому
  // проверяется до проверки владения. Гонку разрешает Core.
  if (parsed.action === "claim") {
    if (task.ownerRef !== null) {
      return {
        answer: task.ownerRef === person.id ? "Она уже твоя" : "Уже взял другой",
        edit: { text: `${formatTaskCard(task)}\n\n✋ Задачу уже взяли.` },
      };
    }
    const ok = await deps.core.claimTask(parsed.id, person.id);
    if (!ok) {
      return {
        answer: "Уже взял другой",
        edit: { text: `${formatTaskCard(task)}\n\n✋ Успел кто-то другой.` },
      };
    }
    const mine: TaskRow = { ...task, ownerRef: person.id };
    return {
      answer: "Взял",
      edit: { text: `${formatTaskCard(mine)}\n\n✋ Задача твоя.`, keyboard: taskKeyboard(mine) },
    };
  }

  if (task.ownerKind !== "human" || task.ownerRef !== person.id) {
    // Не сообщаем ничего о чужой задаче — только отказ.
    return { answer: "Это не твоя задача" };
  }

  // «Не смогу» — вернуть задачу в пул. Без этого застрявший техник молча
  // блокирует работу до срока: другим она уже не видна как свободная.
  if (parsed.action === "free") {
    await deps.core.releaseTask(parsed.id, person.id);
    const freed: TaskRow = { ...task, ownerRef: null, status: "todo" };
    return {
      answer: "Вернул в общий список",
      edit: { text: `${formatTaskCard(freed)}\n\n↩️ Вернул в общий список — возьмёт кто-то другой.` },
    };
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
  // Мастер закрытия занимает единственный слот беседы. Начатый обход или
  // другой недописанный мастер он бросает — сказать об этом обязательно:
  // путь через нижнее меню предупреждает, кнопки задач не должны молчать.
  const prevConv = deps.conversations.get(chatId);
  const droppedVisit = visitFromFlow(prevConv);
  const droppedOther = prevConv !== null && droppedVisit === null && prevConv.flow !== "task-done";
  const started = startTaskDone(chatId, task, deps);
  const dropNote = droppedVisit
    ? `⚠️ Обход по «${droppedVisit.locationName}» прерван — после задачи начни точку заново.\n\n`
    : droppedOther
      ? "Прошлое не дописано — бросил.\n\n"
      : "";
  return {
    answer: "Напиши, что сделано",
    // Кнопки старой карточки снимаем: пока идёт мастер, нажимать на неё
    // нечего, а повторное «Выполнил» перезапустило бы ввод с нуля.
    edit: { text: `${formatTaskCard(task)}\n\n▶️ Закрываю…` },
    message: dropNote + started.text,
    ...(started.keyboard ? { keyboard: started.keyboard } : {}),
  };
}
