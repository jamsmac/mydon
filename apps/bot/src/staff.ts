import { dueLabel } from "@mydon/shared";
import type { CoreClient, PersonRow, TaskRow } from "./core-client";
import type { Conversations } from "./conversation";
import {
  handleRegisterCallback,
  handleRegisterName,
  isRegisterTrigger,
  parseRegisterCallback,
  registerStepHint,
  startRegister,
} from "./staff-register";
import {
  handleInventoryCallback,
  handleInventoryCount,
  inventoryStepHint,
  isInventoryTrigger,
  parseInventoryCallback,
  startInventory,
} from "./staff-inventory";

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
}

/** Кнопки под задачей. Префикс «t:» отделяет их от кнопок согласований («ap:»). */
export function taskKeyboard(task: TaskRow): StaffReply["keyboard"] {
  const row: { text: string; callback_data: string }[] = [];
  if (task.status !== "in_progress") {
    row.push({ text: "▶️ Взял", callback_data: `t:${task.id}:progress` });
  }
  row.push({ text: "✅ Сделал", callback_data: `t:${task.id}:done` });
  return { inline_keyboard: [row] };
}

/** Строгий разбор нажатия: данные кнопки приходят снаружи, доверять им нельзя. */
export function parseTaskCallback(data: string): { id: string; action: "progress" | "done" } | null {
  const m = /^t:([0-9a-f-]{36}):(progress|done)$/.exec(data);
  if (!m) return null;
  return { id: m[1], action: m[2] as "progress" | "done" };
}

function taskLine(t: TaskRow): string {
  const prio = t.priority === "urgent" ? "🔥 " : t.priority === "high" ? "❗ " : "";
  const state = t.status === "in_progress" ? " · в работе" : "";
  return `${prio}${t.title}\n   ${dueLabel(t.due)}${state}`;
}

/** Список задач сотрудника. Пусто — это хорошая новость, так и пишем. */
export function formatMyTasks(person: PersonRow, tasks: TaskRow[]): string {
  if (tasks.length === 0) {
    return `${person.name}, задач на тебе нет. Отдыхай 👌`;
  }
  const lines = tasks.map((t, i) => `${i + 1}. ${taskLine(t)}`);
  return [`${person.name}, твои задачи (${tasks.length}):`, "", ...lines].join("\n");
}

const HELP_STAFF = [
  "Что можно писать:",
  "",
  "• «задачи» — список того, что на тебе",
  "• «инкассация» — сдать выручку с автомата",
  "• «новый ингредиент» / «новая запчасть» — завести карточку с фото",
  "• «инвентаризация» — пересчитать остаток на складе",
  "• кнопки под задачей: «Взял» и «Сделал»",
  "• после «Сделал» напиши одной строкой, что именно сделано — это отчёт",
].join("\n");

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

/** Время сбора — до секунды, по-ташкентски (требование спецификации VendCash). */
export function formatCollectedAt(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Ожидание отчёта: сотрудник нажал «Сделал», следующее его сообщение — отчёт.
 * Держим в памяти процесса: состояние живёт минуты, переживать перезапуск ему
 * незачем — после перезапуска сотрудник просто нажмёт «Сделал» снова.
 */
export class AwaitingReport {
  private readonly map = new Map<number, { taskId: string; at: number }>();

  constructor(private readonly ttlMs = 15 * 60_000) {}

  set(chatId: number, taskId: string, now = Date.now()): void {
    this.map.set(chatId, { taskId, at: now });
  }

  /** Забрать и снять ожидание. Просроченное не возвращаем. */
  take(chatId: number, now = Date.now()): string | null {
    const item = this.map.get(chatId);
    if (!item) return null;
    this.map.delete(chatId);
    return now - item.at > this.ttlMs ? null : item.taskId;
  }

  /** Периодическая уборка: без неё карта растёт от брошенных нажатий. */
  sweep(now = Date.now()): void {
    for (const [chatId, item] of this.map) {
      if (now - item.at > this.ttlMs) this.map.delete(chatId);
    }
  }
}

export interface StaffDeps {
  core: CoreClient;
  awaiting: AwaitingReport;
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

  // Завести номенклатуру: «новый ингредиент», «новая запчасть».
  if (isRegisterTrigger(clean)) {
    return { reply: startRegister(chatId, deps) };
  }

  // Инвентаризация склада: «инвентаризация», «пересчёт».
  if (isInventoryTrigger(clean)) {
    return { reply: await startInventory(chatId, deps) };
  }

  // Ждём отчёт после «Сделал» — любое следующее сообщение считаем отчётом.
  const awaitingTaskId = deps.awaiting.take(chatId);
  if (awaitingTaskId !== null && clean.length > 0 && !clean.startsWith("/")) {
    const task = await deps.core.task(awaitingTaskId);
    // Чужую задачу закрыть нельзя, даже если id как-то попал к сотруднику.
    if (task.ownerKind !== "human" || task.ownerRef !== person.id) {
      return { reply: { text: "Эта задача не на тебе." } };
    }
    await deps.core.setTaskStatus(awaitingTaskId, "done", `person:${person.id}`, clean);
    return { reply: { text: `Записал: «${clean}». Задача закрыта ✅` } };
  }

  if (clean === "/start" || /привет|старт/i.test(clean)) {
    const tasks = await deps.core.myTasks("human", person.id);
    return {
      reply: { text: `${formatMyTasks(person, tasks)}\n\n${HELP_STAFF}` },
      tasks,
    };
  }

  if (/задач|дела|что делать|мои/i.test(clean)) {
    const tasks = await deps.core.myTasks("human", person.id);
    return { reply: { text: formatMyTasks(person, tasks) }, tasks };
  }

  // Инкассация: оператор выбирает автомат кнопкой — время зафиксируется само.
  if (/инкасс|выручк|сдать деньги/i.test(clean)) {
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

  // Всё остальное от сотрудника — комментарий к его текущей задаче:
  // проще написать боту, чем звонить владельцу.
  const tasks = await deps.core.myTasks("human", person.id);
  if (tasks.length === 1 && clean.length > 2) {
    await deps.core.addTaskComment(tasks[0].id, clean, `person:${person.id}`);
    return { reply: { text: `Передал владельцу по задаче «${tasks[0].title}».` } };
  }

  return { reply: { text: HELP_STAFF } };
}

/** Нажатие кнопки под задачей. Права проверяются по chat_id нажавшего. */
export async function handleStaffCallback(
  chatId: number,
  data: string,
  person: PersonRow,
  deps: StaffDeps,
): Promise<{ answer: string; message?: string; keyboard?: StaffReply["keyboard"]; ownerNote?: string }> {
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

  if (parsed.action === "progress") {
    await deps.core.setTaskStatus(parsed.id, "in_progress", `person:${person.id}`);
    return { answer: "Отметил: в работе", message: `Взял в работу: ${task.title}` };
  }

  // «Сделал» — просим отчёт: без него закрытие ничего не объясняет.
  deps.awaiting.set(chatId, parsed.id);
  return {
    answer: "Напиши, что сделано",
    message: `Что сделано по задаче «${task.title}»? Напиши одним сообщением — это отчёт.`,
  };
}
