import { DUE_ICON, TZ, type DueStatus } from "@mydon/shared";

/**
 * monitor-maintenance — графики обслуживания превращаются в задачи.
 *
 * Тир T0: монитор ничего не решает и ничего не чинит. Он читает уже
 * посчитанные сроки (`GET /maintenance/due` — статус считается на чтении,
 * нигде не хранится) и делает ровно две вещи: ставит задачу на работу,
 * которая подходит к сроку, и эмитит событие на то, что уже горит.
 *
 * Почему задача, а не уведомление. Правила `rules.ts` физически не могут
 * дойти до сотрудника: у `Notification` нет адресата, доставка идёт по
 * allowlist владельца. Переделка контракта уведомлений — отдельная работа
 * с четырьмя согласованными изменениями. А задача сотруднику доходит уже
 * сегодня: её подхватит `sendReminders` в боте и утренний дайджест.
 *
 * Задача создаётся СВОБОДНОЙ, если у норматива нет именного исполнителя:
 * закрепления сотрудников за объектами нет, все работают по всему парку, и
 * «назначить наугад» хуже, чем честно оставить в общем пуле — назначенная
 * наугад работа создаёт ложное чувство, что её кто-то взял.
 */

/** Ступени напоминания о просрочке: 1-й, 3-й и 7-й день. */
const OVERDUE_STEPS = [1, 3, 7] as const;

/** Часы, к которым задача должна быть закрыта. Конец рабочего дня. */
const DUE_HOUR = 18;

export interface MaintenanceDueRow {
  planId: string;
  targetId: string;
  targetName: string;
  kind: string;
  kindLabel: string;
  partKind: string | null;
  partLabel: string | null;
  title: string | null;
  nextDueOn: string | null;
  lastDoneOn: string | null;
  taskLeadDays: number;
  daysLeft: number | null;
  countLeft: number | null;
  status: DueStatus;
  assigneeId: string | null;
  autoTask: boolean;
  /**
   * Работы по объекту имеют смысл (автомат в эксплуатации).
   *
   * Необязательное: старый Core поля не отдаёт, и прогон против него должен
   * вести себя как раньше — ставить задачи. Отсутствие признака не повод
   * прекратить обслуживание парка.
   */
  operational?: boolean;
  idleReason?: string | null;
  machineStatus?: string | null;
}

export interface EnsureTaskInput {
  title: string;
  ownerKind: "human";
  /** Maintenance belongs to the VendHub operating direction. */
  domain: "vendhub";
  ownerRef?: string;
  entityId: string;
  description?: string;
  due: string;
  priority: "low" | "normal" | "high" | "urgent";
  source: string;
  dayKey: string;
  createdBy: string;
}

/** Узкий контракт Core-клиента — как у CoffeeMonitorCoreClient, ради тестов. */
export interface MaintenanceMonitorCoreClient {
  maintenanceDue(): Promise<MaintenanceDueRow[]>;
  ensureTaskForDay(input: EnsureTaskInput): Promise<{ created: boolean; taskId?: string }>;
  recordEvent(input: { source: string; type: string; payload?: Record<string, unknown> }): Promise<unknown>;
}

export interface MaintenanceMonitorResult {
  /** Сколько задач реально создано (повторный прогон за день даёт 0). */
  tasks: number;
  overdue: number;
  unclaimed: number;
  /**
   * Работ, подошедших к сроку на автоматах вне эксплуатации.
   *
   * Не ошибка и не успех — отдельная величина. Без неё прогон, где половина
   * парка в ремонте, выглядит одинаково с прогоном, где работ просто нет.
   */
  idle: number;
  /** По каким автоматам и почему (до 20 строк — для брифинга, не для журнала). */
  idleReasons: string[];
  errors: string[];
}

export interface RunOptions {
  now?: () => Date;
}

/** YYYY-MM-DD по Ташкенту. */
function isoDate(d: Date): string {
  return d.toLocaleDateString("en-CA", { timeZone: TZ });
}

/** Момент конца рабочего дня в ISO — срок задачи. */
function dueInstant(dayKey: string): string {
  // Ташкент — UTC+5 без перехода на летнее время, поэтому смещение постоянно
  // и вычитается напрямую. Появится вторая зона — понадобится Intl.
  return `${dayKey}T${String(DUE_HOUR - 5).padStart(2, "0")}:00:00.000Z`;
}

/** Что писать в заголовке задачи. */
export function taskTitle(row: MaintenanceDueRow): string {
  const what = row.title ?? (row.partLabel ? `${row.kindLabel}: ${row.partLabel}` : row.kindLabel);
  return `${what} — ${row.targetName}`;
}

/** Приоритет по срочности: просрочено — высокий, срок сегодня — обычный. */
export function priorityOf(status: DueStatus): "normal" | "high" {
  return status === "overdue" ? "high" : "normal";
}

/**
 * СБОЙ ПРОГОНА — СОБЫТИЕ, А НЕ СТРОКА В ЛОГЕ. `result.errors` уезжали только
 * в `console.log` крона (`index.ts:447`), а логи контейнера живут до первого
 * деплоя: аварию 26.08.2026 («ни одной задачи ТО не поставлено ни разу»)
 * пришлось доказывать схемой и нулевыми счётчиками, потому что строк уже не
 * было. Под своим `try/catch`: сторож, который роняет прогон, хуже
 * отсутствующего.
 *
 * Отдельная функция, а не хвост перед одним `return`: `runMaintenanceMonitor`
 * выходит РАНО, если `maintenanceDue()` сам упал (Core не поднялся, битый
 * запрос) — и это САМЫЙ тяжёлый отказ прогона. Вызов ПЕРЕД ОБОИМИ `return`
 * закрывает именно этот путь (ревью Task 2, M1): раньше он проходил мимо
 * эмиссии, и `select count(*) from event where type = 'maintenance.monitor_failed'`
 * читался как «здоров» даже при мёртвом Core.
 */
async function записатьСбойПрогона(
  core: MaintenanceMonitorCoreClient,
  result: MaintenanceMonitorResult,
  today: string,
): Promise<void> {
  if (result.errors.length === 0) return;
  try {
    await core.recordEvent({
      source: "maintenance-monitor",
      type: "maintenance.monitor_failed",
      payload: {
        errorCount: result.errors.length,
        errors: result.errors.slice(0, 20),
        tasks: result.tasks,
        day: today,
      },
    });
  } catch (err) {
    result.errors.push(`событие о сбое не записано: ${String(err)}`);
  }
}

/**
 * Один проход. Сбой на одном нормативе не должен ронять остальные — каждый
 * обрабатывается в своём try/catch, ошибки копятся в `errors`.
 */
export async function runMaintenanceMonitor(
  core: MaintenanceMonitorCoreClient,
  opts: RunOptions = {},
): Promise<MaintenanceMonitorResult> {
  const now = (opts.now ?? (() => new Date()))();
  const today = isoDate(now);
  const result: MaintenanceMonitorResult = { tasks: 0, overdue: 0, unclaimed: 0, idle: 0, idleReasons: [], errors: [] };

  let rows: MaintenanceDueRow[];
  try {
    rows = await core.maintenanceDue();
  } catch (err) {
    result.errors.push(`сроки не прочитаны: ${String(err)}`);
    await записатьСбойПрогона(core, result, today);
    return result;
  }

  for (const row of rows) {
    try {
      // «Норматив не задан» — дефект настройки, а не сигнал. О нём владелец
      // узнаёт на экране, а не пушем в шесть утра.
      if (row.status === "unknown" || row.status === "ok") continue;

      // Автомат не в поле — задачу ставить некому и не на чем. Молча
      // пропустить нельзя: прогон выглядел бы как «работы не подошли», хотя
      // они подошли и не назначены. Считаем отдельно и называем причину.
      if (row.operational === false) {
        result.idle += 1;
        if (result.idleReasons.length < 20) {
          result.idleReasons.push(`${row.targetName}: ${row.idleReason ?? "не в эксплуатации"}`);
        }
        continue;
      }

      const dayKey = row.nextDueOn ?? today;

      if (row.autoTask) {
        const created = await core.ensureTaskForDay({
          title: taskTitle(row),
          ownerKind: "human",
          domain: "vendhub",
          // Пусто — задача свободная, её разберут из общего пула.
          ...(row.assigneeId ? { ownerRef: row.assigneeId } : {}),
          entityId: row.targetId,
          description: describe(row),
          due: dueInstant(dayKey),
          priority: priorityOf(row.status),
          source: `maint:${row.planId}`,
          dayKey,
          createdBy: "agent:maintenance-monitor",
        });
        if (created.created) {
          result.tasks += 1;
          // Свободная задача со сроком сегодня — то, что может остаться
          // невзятым. Проблема не в отсутствии исполнителя при создании
          // (это норма), а в том, что к сроку её никто не забрал.
          if (!row.assigneeId && row.status === "due") {
            await core.recordEvent({
              source: "maintenance-monitor",
              type: "maintenance.unclaimed",
              payload: {
                taskId: created.taskId ?? null,
                planId: row.planId,
                kind: row.kind,
                kindLabel: row.kindLabel,
                targetName: row.targetName,
                dueDate: dayKey,
              },
            });
            result.unclaimed += 1;
          }
        }
      }

      // Просрочка — владельцу, ступенями. Каждый день долбить бессмысленно:
      // после третьего одинакового сообщения их перестают читать.
      const daysOverdue = row.daysLeft === null ? null : -row.daysLeft;
      if (daysOverdue !== null && (OVERDUE_STEPS as readonly number[]).includes(daysOverdue)) {
        await core.recordEvent({
          source: "maintenance-monitor",
          type: "maintenance.overdue",
          payload: {
            planId: row.planId,
            kind: row.kind,
            kindLabel: row.kindLabel,
            targetId: row.targetId,
            targetName: row.targetName,
            partLabel: row.partLabel,
            dueDate: row.nextDueOn,
            daysOverdue,
            assigneeId: row.assigneeId,
          },
        });
        result.overdue += 1;
      }
    } catch (err) {
      result.errors.push(`${row.planId}: ${String(err)}`);
    }
  }

  await записатьСбойПрогона(core, result, today);
  return result;
}

function describe(row: MaintenanceDueRow): string {
  const lines = [`${DUE_ICON[row.status]} ${row.kindLabel}`];
  if (row.partLabel) lines.push(`Узел: ${row.partLabel}`);
  if (row.lastDoneOn) lines.push(`Прошлый раз: ${row.lastDoneOn}`);
  if (row.countLeft !== null) lines.push(`По счётчику осталось: ${row.countLeft}`);
  return lines.join("\n");
}
