import { DUE_ICON, dueText, type DueStatus } from "@mydon/shared";
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
  | { kind: "do"; planId: string };

export function parseSchedulesCallback(data: string): SchedulesCallback | null {
  const h = /^sc:d:(7|14|30)$/.exec(data);
  if (h) return { kind: "horizon", days: Number(h[1]) };
  const p = /^sc:p:(\d{1,2})$/.exec(data);
  if (p) return { kind: "page", page: Number(p[1]) };
  const d = /^sc:do:([0-9a-f-]{36})$/.exec(data);
  if (d) return { kind: "do", planId: d[1] };
  return null;
}

/** Отбор и сортировка: сначала то, что горит сильнее, потом по дате. */
export function selectDue(rows: MaintenanceDueRow[], horizonDays: number): MaintenanceDueRow[] {
  const rank: Record<string, number> = { overdue: 0, due: 1, soon: 2 };
  return rows
    .filter((r) => SHOWN.includes(r.status))
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

  const rows2: { text: string; callback_data: string }[][] = slice.map((r) => [
    { text: `✅ ${r.targetName} · ${r.partLabel ?? r.kindLabel}`.slice(0, 40), callback_data: `sc:do:${r.planId}` },
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
  const rows = await deps.core.maintenanceDue().catch(() => []);
  // Горизонт и страница живут в разговоре: гонять их через callback_data
  // вместе с id норматива не поместилось бы в 64 байта.
  deps.conversations.start(chatId, "schedules", "list", { horizon: DEFAULT_HORIZON, page: 0, rows });
  return renderSchedules(rows, DEFAULT_HORIZON, 0);
}

/**
 * Нажатие в разделе. «✅ Сделал сейчас» не открывает мастер заново, а
 * записывает работу сразу: объект и вид работ уже известны из норматива,
 * переспрашивать их значит заставить человека вводить то, что система знает.
 */
export async function handleSchedulesCallback(
  chatId: number,
  cb: SchedulesCallback,
  person: PersonRow,
  deps: SchedulesDeps,
): Promise<{ answer: string; message?: StaffReply }> {
  const conv = deps.conversations.get(chatId);
  const cached = (conv?.data.rows as MaintenanceDueRow[] | undefined) ?? [];
  const rows = cached.length > 0 ? cached : await deps.core.maintenanceDue().catch(() => []);

  if (cb.kind === "horizon") {
    deps.conversations.start(chatId, "schedules", "list", { horizon: cb.days, page: 0, rows });
    return { answer: `${cb.days} дн.`, message: renderSchedules(rows, cb.days, 0) };
  }

  if (cb.kind === "page") {
    const horizon = Number(conv?.data.horizon ?? DEFAULT_HORIZON);
    deps.conversations.advance(chatId, "list", { page: cb.page });
    return { answer: `Стр. ${cb.page + 1}`, message: renderSchedules(rows, horizon, cb.page) };
  }

  const plan = rows.find((r) => r.planId === cb.planId);
  if (!plan) {
    return { answer: "Устарело", message: { text: "Список устарел — открой «🗓 Графики» заново." } };
  }

  await deps.core.createMaintenanceLog({
    entityId: plan.targetId,
    kind: plan.kind,
    ...(plan.partKind ? { partKind: plan.partKind } : {}),
    planId: plan.planId,
    personId: person.id,
    outcome: "done",
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
