import { DUE_ICON, dueText, type DueStatus } from "@mydon/shared";
import { todayIso } from "./coffee-refill";
import type { CoreClient, MaintenanceDueRow, PersonRow } from "./core-client";
import type { Conversations } from "./conversation";
import type { StaffReply } from "./staff";

/**
 * Раздел «🗓 Графики»: что предстоит и что уже горит.
 *
 * Фильтр здесь по СОСТОЯНИЮ, а не по людям. Закрепления сотрудников за
 * объектами нет — формально каждому доступен весь парк, и показывать технику
 * все автоматы значит гарантировать, что раздел перестанут открывать. Поэтому
 * в него попадает только то, что горит: просрочено, сегодня, скоро.
 *
 * Зелёное и «норматив не задан» не показываются вовсе. Сюда заходят узнать,
 * что делать, а не читать реестр; полный список — у владельца в панели.
 */

export interface SchedulesDeps {
  core: CoreClient;
  conversations: Conversations;
}

/** Горизонт по умолчанию. Дальше двух недель планировать в поле бессмысленно. */
const DEFAULT_HORIZON = 14;
/** Строк на страницу. Больше — уже простыня, которую листают, а не читают. */
const PAGE = 8;

/** Что показываем. «ok» и «unknown» — забота владельца, не техника. */
const SHOWN: readonly DueStatus[] = ["overdue", "due", "soon"];

export type SchedulesCallback =
  | { kind: "horizon"; days: number }
  | { kind: "page"; page: number }
  | { kind: "open"; planId: string }
  | { kind: "done"; planId: string }
  | { kind: "back" };

export function parseSchedulesCallback(data: string): SchedulesCallback | null {
  const h = /^sc:d:(7|14|30)$/.exec(data);
  if (h) return { kind: "horizon", days: Number(h[1]) };
  const p = /^sc:p:(\d{1,2})$/.exec(data);
  if (p) return { kind: "page", page: Number(p[1]) };
  // «sc:do» теперь ОТКРЫВАЕТ карточку, а не пишет. В списке задач такая же
  // кнопка-строка открывает карточку, и оператор приучен тапать «посмотреть» —
  // здесь тап без подтверждения писал журнал ТО и сдвигал срок на весь период,
  // без self-service-отмены. Заодно обезврежены старые кнопки в чатах: они
  // несут sc:do и раньше писали бы «сделал» по случайному нажатию.
  const d = /^sc:do:([0-9a-f-]{36})$/.exec(data);
  if (d) return { kind: "open", planId: d[1] };
  const w = /^sc:done:([0-9a-f-]{36})$/.exec(data);
  if (w) return { kind: "done", planId: w[1] };
  if (data === "sc:back") return { kind: "back" };
  return null;
}

/** Отбор и сортировка: сначала то, что горит сильнее, потом по дате. */
export function selectDue(rows: MaintenanceDueRow[], horizonDays: number): MaintenanceDueRow[] {
  const rank: Record<string, number> = { overdue: 0, due: 1, soon: 2 };
  return rows
    .filter((r) => SHOWN.includes(r.status))
    // Автомата нет на месте — техник туда не поедет. Показать строку значит
    // отправить человека к аппарату, которого на точке нет, и дать ему кнопку
    // «✅ Сделал сейчас»: срок уехал бы на весь период вперёд по работе,
    // которой не было. Владелец видит такие строки в панели, техник — нет.
    .filter((r) => r.operational !== false)
    .filter((r) => r.daysLeft === null || r.daysLeft <= horizonDays)
    .sort((a, b) => {
      const byStatus = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
      if (byStatus !== 0) return byStatus;
      return (a.daysLeft ?? 0) - (b.daysLeft ?? 0);
    });
}

function line(r: MaintenanceDueRow): string {
  const what = r.title ?? (r.partLabel ? `${r.kindLabel}: ${r.partLabel}` : r.kindLabel);
  return `${DUE_ICON[r.status]} ${r.targetName}\n   ${what} · ${dueText({
    status: r.status,
    daysLeft: r.daysLeft,
    countLeft: r.countLeft,
    nextDueOn: r.nextDueOn,
  })}`;
}

/** Экран раздела. */
export function renderSchedules(
  rows: MaintenanceDueRow[],
  horizonDays = DEFAULT_HORIZON,
  page = 0,
): StaffReply {
  const picked = selectDue(rows, horizonDays);
  if (picked.length === 0) {
    return {
      text: `🗓 На ближайшие ${horizonDays} дней ничего не подходит.\nВсё сделано, ничего не просрочено. 👌`,
      keyboard: { inline_keyboard: [horizonRow(horizonDays)] },
    };
  }

  const pages = Math.ceil(picked.length / PAGE);
  const safePage = Math.min(Math.max(page, 0), pages - 1);
  const slice = picked.slice(safePage * PAGE, safePage * PAGE + PAGE);

  const overdue = picked.filter((r) => r.status === "overdue").length;
  const head =
    `🗓 Предстоит на ${horizonDays} дней: ${picked.length}` +
    (overdue > 0 ? ` · 🔴 просрочено ${overdue}` : "");

  // Без «✅» в подписи: строка — селектор (открывает карточку), а не действие.
  // Галочка на селекторе читалась как «уже сделано» и провоцировала тап.
  const rows2: { text: string; callback_data: string }[][] = slice.map((r) => [
    { text: `${r.targetName} · ${r.partLabel ?? r.kindLabel}`.slice(0, 40), callback_data: `sc:do:${r.planId}` },
  ]);
  if (pages > 1) {
    const nav: { text: string; callback_data: string }[] = [];
    if (safePage > 0) nav.push({ text: "◀️", callback_data: `sc:p:${safePage - 1}` });
    nav.push({ text: `${safePage + 1}/${pages}`, callback_data: `sc:p:${safePage}` });
    if (safePage < pages - 1) nav.push({ text: "▶️", callback_data: `sc:p:${safePage + 1}` });
    rows2.push(nav);
  }
  rows2.push(horizonRow(horizonDays));

  return {
    text: [head, "", ...slice.map(line)].join("\n"),
    keyboard: { inline_keyboard: rows2 },
  };
}

function horizonRow(current: number): { text: string; callback_data: string }[] {
  return [7, 14, 30].map((d) => ({
    text: d === current ? `• ${d} дн.` : `${d} дн.`,
    callback_data: `sc:d:${d}`,
  }));
}

export async function startSchedules(chatId: number, deps: SchedulesDeps): Promise<StaffReply> {
  let rows: MaintenanceDueRow[];
  try {
    rows = await deps.core.maintenanceDue();
  } catch {
    // «Не прочитал» ≠ «пусто»: праздничное «Всё сделано 👌» при недоступном
    // Core обещало технику отсутствие просрочек, которых бот просто не видел, —
    // для санобработки это пропуск обязательных работ с уверенным тоном.
    return { text: "Не смог получить графики — сервер не ответил. Попробуй ещё раз через минуту." };
  }
  // Горизонт и страница живут в разговоре: гонять их через callback_data
  // вместе с id норматива не поместилось бы в 64 байта.
  deps.conversations.start(chatId, "schedules", "list", { horizon: DEFAULT_HORIZON, page: 0, rows });
  return renderSchedules(rows, DEFAULT_HORIZON, 0);
}

/** Карточка норматива: что, где, срок — и явная кнопка записи. */
function planCard(r: MaintenanceDueRow): StaffReply {
  const what = r.title ?? (r.partLabel ? `${r.kindLabel}: ${r.partLabel}` : r.kindLabel);
  return {
    text:
      `${DUE_ICON[r.status]} ${r.targetName}\n${what}\n` +
      `${dueText({ status: r.status, daysLeft: r.daysLeft, countLeft: r.countLeft, nextDueOn: r.nextDueOn })}\n\n` +
      "Запись сдвинет следующий срок на весь период вперёд.",
    keyboard: {
      inline_keyboard: [
        [{ text: "✅ Сделал сейчас — записать", callback_data: `sc:done:${r.planId}` }],
        [{ text: "◀️ К списку", callback_data: "sc:back" }],
      ],
    },
  };
}

/**
 * Нажатие в разделе. Строка списка открывает карточку; запись — отдельной
 * широкой кнопкой на карточке: объект и вид работ известны из норматива,
 * но необратимое «сделал» не должно случаться от тапа «посмотреть».
 */
export async function handleSchedulesCallback(
  chatId: number,
  cb: SchedulesCallback,
  person: PersonRow,
  deps: SchedulesDeps,
): Promise<{ answer: string; message?: StaffReply }> {
  const conv = deps.conversations.get(chatId);

  // Кнопки раздела живут в чате вечно, а слот беседы один. Старая кнопка
  // «Графиков» не должна ни перетирать чужой мастер (start затирал недописанный
  // отчёт), ни подменять ему шаг (advance("list") окирпичивал заливку). Тот же
  // барьер, что поставлен кнопкам обхода в #149.
  //
  // Исключения — состояния, которые сама ветка считает НЕ «недописанным
  // мастером»: меню точки обхода и необязательный шаг фото. Нижняя кнопка
  // «Графиков» в них легально проходит — inline-путь обязан вести себя так же,
  // иначе техник получает ложное «у тебя не дописано другое».
  const droppable = conv === null || conv.flow === "schedules" || conv.flow === "coffee-visit" || conv.flow === "after-photo";
  if (!droppable) {
    return {
      answer: "Кнопка устарела",
      message: { text: "Эта кнопка от прошлого экрана. Сейчас у тебя не дописано другое — сначала доделай его." },
    };
  }

  const cached = (conv?.data.rows as MaintenanceDueRow[] | undefined) ?? [];
  const fetched = cached.length > 0 ? cached : await deps.core.maintenanceDue().catch(() => null);
  if (fetched === null) {
    // Тот же принцип, что в startSchedules: сбой чтения не притворяется
    // пустым списком «всё сделано».
    return { answer: "Сервер не ответил", message: { text: "Не смог получить графики — попробуй ещё раз через минуту." } };
  }
  const rows = fetched;

  if (cb.kind === "horizon") {
    deps.conversations.start(chatId, "schedules", "list", { horizon: cb.days, page: 0, rows });
    return { answer: `${cb.days} дн.`, message: renderSchedules(rows, cb.days, 0) };
  }

  if (cb.kind === "page") {
    const horizon = Number(conv?.data.horizon ?? DEFAULT_HORIZON);
    // advance — только своему разговору: чужому (например, меню точки) он
    // подменил бы шаг. Отрисовка от разговора не зависит.
    if (conv?.flow === "schedules") deps.conversations.advance(chatId, "list", { page: cb.page });
    return { answer: `Стр. ${cb.page + 1}`, message: renderSchedules(rows, horizon, cb.page) };
  }

  if (cb.kind === "back") {
    const horizon = Number(conv?.data.horizon ?? DEFAULT_HORIZON);
    const page = Number(conv?.data.page ?? 0);
    return { answer: "Список", message: renderSchedules(rows, horizon, page) };
  }

  const plan = rows.find((r) => r.planId === cb.planId);
  if (!plan) {
    return { answer: "Устарело", message: { text: "Список устарел — открой «🗓 Графики» заново." } };
  }

  if (cb.kind === "open") {
    return { answer: plan.targetName.slice(0, 60), message: planCard(plan) };
  }

  await deps.core.createMaintenanceLog({
    entityId: plan.targetId,
    kind: plan.kind,
    ...(plan.partKind ? { partKind: plan.partKind } : {}),
    planId: plan.planId,
    personId: person.id,
    outcome: "done",
    // Тот же план в тот же день — одно «сделал»: двойной тап по карточке
    // после таймаута не должен дважды сдвигать срок.
    clientKey: `sc:${plan.planId}:${todayIso()}`,
    createdBy: `person:${person.id}`,
  });

  // Из списка запись убираем сразу: увидеть её там же после «сделал» —
  // повод нажать второй раз.
  const left = rows.filter((r) => r.planId !== cb.planId);
  const horizon = Number(conv?.data.horizon ?? DEFAULT_HORIZON);
  deps.conversations.start(chatId, "schedules", "list", { horizon, page: 0, rows: left });

  const what = plan.partLabel ? `${plan.kindLabel}: ${plan.partLabel}` : plan.kindLabel;
  return {
    answer: "Записал",
    message: {
      text: `✅ Записал: ${what} — ${plan.targetName}.\nСледующий срок пересчитан.\n\n${renderSchedules(left, horizon, 0).text}`,
      ...(renderSchedules(left, horizon, 0).keyboard
        ? { keyboard: renderSchedules(left, horizon, 0).keyboard }
        : {}),
    },
  };
}
