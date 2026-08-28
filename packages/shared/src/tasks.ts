/**
 * Общая логика задач: разбор сроков «человеческими» словами и группировка
 * по срочности. Живёт в общем пакете, потому что нужна и панели, и боту:
 * сотрудник в Telegram тоже пишет «завтра», а не ISO-дату.
 */

/** Минимум полей задачи, нужный для группировки — чтобы не тянуть весь тип. */
export interface TaskLike {
  due: string | null;
  priority: "low" | "normal" | "high" | "urgent";
}

export function parseDue(raw: string, now: Date = new Date()): Date | null {
  const s = raw.trim().toLowerCase();
  if (s.length === 0) return null;

  const at = /(?:в|к)\s*(\d{1,2})(?::(\d{2}))?/.exec(s);
  const hh = at ? Math.min(23, Number(at[1])) : 18; // по умолчанию к концу дня
  const mm = at?.[2] ? Math.min(59, Number(at[2])) : 0;

  const set = (d: Date): Date => {
    d.setHours(hh, mm, 0, 0);
    return d;
  };

  if (/сегодня|сейчас/.test(s)) return set(new Date(now));
  // «послезавтра» проверяем ПЕРВЫМ: оно содержит «завтра», и при обратном
  // порядке задача вставала бы на день раньше срока.
  if (/послезавтра/.test(s)) return set(new Date(now.getTime() + 48 * 3600_000));
  if (/завтра/.test(s)) return set(new Date(now.getTime() + 24 * 3600_000));

  const inDays = /через\s+(\d{1,2})\s*(дн|день|дня)/.exec(s);
  if (inDays) return set(new Date(now.getTime() + Number(inDays[1]) * 24 * 3600_000));

  const inWeek = /через\s+недел/.test(s);
  if (inWeek) return set(new Date(now.getTime() + 7 * 24 * 3600_000));

  // День недели: «в понедельник», «пн» — ближайший будущий.
  const WEEK: Record<string, number> = {
    "пн": 1, "понедельник": 1, "вт": 2, "вторник": 2, "ср": 3, "среда": 3, "среду": 3,
    "чт": 4, "четверг": 4, "пт": 5, "пятница": 5, "пятницу": 5, "сб": 6, "суббота": 6, "субботу": 6,
    "вс": 0, "воскресенье": 0,
  };
  for (const [word, target] of Object.entries(WEEK)) {
    if (new RegExp(`(^|\\s)${word}(\\s|$)`).test(s)) {
      const d = new Date(now);
      const diff = (target - d.getDay() + 7) % 7 || 7; // всегда вперёд
      d.setDate(d.getDate() + diff);
      return set(d);
    }
  }

  // Дата вида 25.08 или 25.08.2026
  const date = /(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/.exec(s);
  if (date) {
    const day = Number(date[1]);
    const month = Number(date[2]) - 1;
    const year = date[3] ? Number(date[3].length === 2 ? `20${date[3]}` : date[3]) : now.getFullYear();
    const d = new Date(year, month, day);
    if (!Number.isNaN(d.getTime())) return set(d);
  }

  return null;
}

export type GroupKey = "overdue" | "today" | "week" | "later" | "someday";

export interface TaskGroup<T extends TaskLike = TaskLike> {
  key: GroupKey;
  title: string;
  /** Подпись под заголовком: объясняет группу словами, а не кодом. */
  hint?: string;
  tasks: T[];
}

const TITLES: Record<GroupKey, { title: string; hint?: string }> = {
  overdue: { title: "Просрочено", hint: "Срок прошёл, задача не закрыта" },
  today: { title: "Сегодня" },
  week: { title: "На этой неделе" },
  later: { title: "Позже" },
  someday: { title: "Без срока", hint: "Сроки не поставлены — легко забыть" },
};

/** Начало суток в ташкентском поясе для переданного момента. */
function dayStart(d: Date): number {
  // Считаем через локальную дату сервера панели: контейнер живёт в Asia/Tashkent
  // (TZ задан в compose), поэтому «сегодня» здесь — то же «сегодня», что у владельца.
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

export function groupByUrgency<T extends TaskLike>(tasks: T[], now: Date = new Date()): TaskGroup<T>[] {
  const startToday = dayStart(now);
  const startTomorrow = startToday + 24 * 3600_000;
  const startAfterWeek = startToday + 8 * 24 * 3600_000; // сегодня + 7 дней

  const buckets: Record<GroupKey, T[]> = {
    overdue: [],
    today: [],
    week: [],
    later: [],
    someday: [],
  };

  for (const t of tasks) {
    if (t.due === null) {
      buckets.someday.push(t);
      continue;
    }
    const due = new Date(t.due).getTime();
    if (Number.isNaN(due)) {
      // Нераспознанная дата — не выбрасываем: пусть будет видна, чем пропадёт.
      buckets.someday.push(t);
    } else if (due < now.getTime()) {
      buckets.overdue.push(t);
    } else if (due < startTomorrow) {
      buckets.today.push(t);
    } else if (due < startAfterWeek) {
      buckets.week.push(t);
    } else {
      buckets.later.push(t);
    }
  }

  const order: GroupKey[] = ["overdue", "today", "week", "later", "someday"];
  return order
    .filter((k) => buckets[k].length > 0)
    .map((k) => ({ key: k, ...TITLES[k], tasks: buckets[k] }));
}

/** Срок словами: «сегодня 14:00», «вчера», «через 3 дня» — вместо голой даты. */
export function dueLabel(due: string | null, now: Date = new Date()): string {
  if (due === null) return "без срока";
  const d = new Date(due);
  if (Number.isNaN(d.getTime())) return "срок не распознан";

  const startToday = dayStart(now);
  const days = Math.floor((dayStart(d) - startToday) / (24 * 3600_000));
  const time = d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });

  if (days === 0) return d.getTime() < now.getTime() ? `сегодня в ${time} — прошло` : `сегодня в ${time}`;
  if (days === 1) return `завтра в ${time}`;
  if (days === -1) return "вчера";
  if (days < -1) return `просрочено на ${Math.abs(days)} дн.`;
  if (days <= 7) return `через ${days} дн.`;
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

/** Пометка срочности. «normal» не показываем — иначе пометки у всех и смысла ноль. */
export function priorityLabel(p: TaskLike["priority"]): string | null {
  if (p === "urgent") return "🔥 срочно";
  if (p === "high") return "важно";
  if (p === "low") return "не спешит";
  return null;
}

/** `confirmed` — не статус БД, а приёмка поверх `done`. */
export type TaskState = "todo" | "in_progress" | "done" | "confirmed" | "cancelled";

const DB_TASK_STATES = new Set(["todo", "in_progress", "done", "cancelled"]);

/** Что показать человеку; одно правило для бота и панели. */
export function taskState(task: { status: string; confirmedAt: string | null }): TaskState {
  if (task.status === "done" && task.confirmedAt !== null) return "confirmed";
  return DB_TASK_STATES.has(task.status) ? (task.status as TaskState) : "todo";
}

export const TASK_STATE_LABELS: Record<TaskState, string> = {
  todo: "Не начата",
  in_progress: "В работе",
  done: "Выполнена",
  confirmed: "Подтверждено",
  cancelled: "Отменена",
};
