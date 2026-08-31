import { Inject, Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { person, task } from "@mydon/db";
import { can, effectiveRoles, normalizeMachineSerial, tashkentDay, tashkentDayStartOf, TZ } from "@mydon/shared";
import { Cron } from "croner";
import { and, asc, eq, isNotNull, isNull, lt, ne, or } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { EventsService } from "../events/events.service";
import { RulesService } from "../rules/rules.service";
import { readIntSetting, settingValue } from "../system/settings";
import { VendingService } from "../vending/vending.service";
import { TasksService } from "./tasks.service";
import { AGENT_SCHEDULE_SOURCE } from "./agent-schedule";

type Payload = Record<string, unknown>;
type TaskPriority = "low" | "normal" | "high" | "urgent";

export interface BridgeSource {
  type: string;
  key: string;
  scope: "machine" | "system";
  accept?: (payload: Payload) => boolean;
  priority: (payloads: readonly Payload[]) => TaskPriority;
  title: (name: string, payloads: readonly Payload[]) => string;
  description: (name: string, payloads: readonly Payload[]) => string;
}

const DESCRIPTION_ITEMS = 10;

function text(value: unknown, fallback = "—"): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function list(items: string[]): string {
  return items.length <= DESCRIPTION_ITEMS
    ? items.join(", ")
    : `${items.slice(0, DESCRIPTION_ITEMS).join(", ")} …и ещё ${items.length - DESCRIPTION_ITEMS}`;
}

export const BRIDGE_SOURCES: readonly BridgeSource[] = [
  {
    type: "vending.refill_detected",
    key: "refill_unconfirmed",
    scope: "machine",
    accept: (payload) => payload.recorded === false,
    priority: () => "normal",
    title: (name) => `Оформить заливку ${name}`,
    description: (_name, payloads) =>
      `Обнаружена заливка без отчёта: ${list(payloads.map((p) => `${String(p.units ?? "?")} шт, окно до ${text(p.windowTo)}`))}.`,
  },
  {
    type: "vending.shrinkage_alert",
    key: "shrinkage",
    scope: "machine",
    priority: () => "high",
    title: (name) => `Разобраться с недостачей: ${name}`,
    description: (_name, payloads) =>
      `Расхождения: ${list(payloads.map((p) => `${text(p.product, "товар")} — ${String(p.lossUnits ?? "?")} шт / ${String(p.lossValue ?? "?")} сум`))}.`,
  },
  {
    type: "ourvend.sync_stale",
    key: "sync_stale",
    scope: "system",
    priority: (payloads) => payloads.some((p) => p.hoursSinceSuccess === null) ? "urgent" : "high",
    title: () => "Сбор OurVend не бежит",
    description: (_name, payloads) => {
      const last = payloads[0] ?? {};
      return last.hoursSinceSuccess === null
        ? "Успешных прогонов ещё не было. Проверить сбор и доступ к кабинету."
        : `Последний успех был ${String(last.hoursSinceSuccess ?? "?")} ч назад; статус последнего прогона: ${text(last.lastRunStatus)}.`;
    },
  },
  {
    type: "ourvend.sync_failed_streak",
    key: "sync_failed",
    scope: "system",
    priority: () => "high",
    title: () => "Сбор OurVend падает подряд",
    description: (_name, payloads) => {
      const last = payloads[0] ?? {};
      return `Отказов подряд: ${String(last.streak ?? "?")}. Последняя ошибка: ${text(last.lastError)}.`;
    },
  },
];

export const BRIDGE_EVENT_TYPES = BRIDGE_SOURCES.map((source) => source.type);
export const BRIDGE_WINDOW_MS = 26 * 3_600_000;
export const BRIDGE_EVENTS_LIMIT = 500;
export const AUTO_CREATED_EVENT = "task.auto_created";
export const BRIDGE_RUN_EVENT = "task.bridge_run";
export const TASK_BRIDGE_MAX_PER_RUN_FALLBACK = 20;
/** Потолок immediate-событий просрочки за один прогон. */
export const OVERDUE_MAX_EVENTS = 20;
export const OVERDUE_EVENT = "task.overdue";

export interface BridgeRun {
  events: number;
  created: number;
  skipped: number;
  capped: boolean;
  disabled: boolean;
}

/** Срок автозадачи — следующее ташкентское утро, 10:00. */
export function nextMorning(now: Date): Date {
  return new Date(tashkentDayStartOf(now).getTime() + 34 * 3_600_000);
}

interface Group {
  src: BridgeSource;
  serial: string | null;
  day: string;
  payloads: Payload[];
}

@Injectable()
export class TaskBridgeService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(TaskBridgeService.name);
  private cron: Cron | null = null;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly tasks: TasksService,
    private readonly events: EventsService,
    private readonly vending: VendingService,
    private readonly rules: RulesService,
  ) {}

  async run(now = new Date()): Promise<BridgeRun> {
    if ((await settingValue(this.db, "TASK_BRIDGE_ENABLED")).trim() !== "1") {
      this.logger.log("Мост «событие → задача» выключен настройкой.");
      return { events: 0, created: 0, skipped: 0, capped: false, disabled: true };
    }

    const rows = await this.events.list({
      types: BRIDGE_EVENT_TYPES,
      since: new Date(now.getTime() - BRIDGE_WINDOW_MS),
      limit: BRIDGE_EVENTS_LIMIT,
    });
    const byType = new Map(BRIDGE_SOURCES.map((source) => [source.type, source]));
    const groups = new Map<string, Group>();

    for (const event of rows) {
      const src = byType.get(event.type);
      const payload = (event.payload ?? {}) as Payload;
      if (!src || (src.accept && !src.accept(payload))) continue;
      const rawSerial = src.scope === "machine" ? text(payload.serial, "") : "system";
      if (src.scope === "machine" && !rawSerial) {
        this.logger.warn(`Событие ${event.type} (${event.id}) без serial — задачу не создать.`);
        continue;
      }
      const serial = src.scope === "machine" ? normalizeMachineSerial(rawSerial) : null;
      const day = tashkentDay(event.occurredAt);
      const key = `${src.key}:${serial ?? "system"}:${day}`;
      const found = groups.get(key);
      if (found) found.payloads.push(payload);
      else groups.set(key, { src, serial, day, payloads: [payload] });
    }

    const registry = groups.size > 0 ? await this.vending.machineIndex() : null;
    const priorityWeight: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
    const ordered = [...groups.entries()].sort(([keyA, a], [keyB, b]) =>
      priorityWeight[a.src.priority(a.payloads)] - priorityWeight[b.src.priority(b.payloads)] ||
      keyA.localeCompare(keyB),
    );
    const rawLimit = await readIntSetting(
      this.db,
      "TASK_BRIDGE_MAX_PER_RUN",
      TASK_BRIDGE_MAX_PER_RUN_FALLBACK,
      this.logger,
    );
    const limit = Math.min(200, Math.max(1, Math.trunc(rawLimit)));
    const selected = ordered.slice(0, limit);
    const omitted = ordered.slice(limit).map(([key]) => key);
    const capped = omitted.length > 0;
    if (capped) {
      this.logger.warn(`Мост задач упёрся в потолок ${limit}; не обработаны: ${omitted.join(", ")}`);
      await this.events.record({
        source: "task-bridge",
        type: BRIDGE_RUN_EVENT,
        occurredAt: now,
        payload: { capped: true, limit, omitted },
      });
    }

    const needsManager = selected.some(([, group]) => group.src.scope === "system");
    const managers = needsManager ? await this.людиСПравом() : [];
    const managerId = managers[0]?.id;
    if (needsManager && !managerId) {
      this.logger.warn("Для инфраструктурных задач не найден активный менеджер — задачи идут в общий пул.");
      await this.events.record({
        source: "task-bridge",
        type: "tasks.no_confirmers",
        occurredAt: now,
        payload: { reason: "infrastructure_assignee", day: tashkentDay(now) },
      });
    }

    let created = 0;
    let skipped = 0;
    for (const [key, group] of selected) {
      const serial = group.serial;
      const entityId = serial ? registry?.firstIdBySerial.get(serial) : undefined;
      const name = serial ? (registry?.nameBySerial.get(serial) ?? serial) : "OurVend";
      const priority = group.src.priority(group.payloads);
      const result = await this.tasks.ensureForDay({
        title: group.src.title(name, group.payloads),
        description: group.src.description(name, group.payloads),
        ownerKind: "human",
        ...(group.src.scope === "system" && managerId ? { ownerRef: managerId } : {}),
        source: `${group.src.key}:${serial ?? "system"}`,
        dayKey: group.day,
        due: nextMorning(now),
        priority,
        ...(entityId ? { entityId } : {}),
        domain: "vendhub",
        createdBy: "task-bridge",
      });
      if (!result) {
        skipped += 1;
        continue;
      }
      created += 1;
      await this.events.record({
        source: "task-bridge",
        type: AUTO_CREATED_EVENT,
        occurredAt: now,
        payload: {
          taskId: result.id,
          key,
          eventType: group.src.type,
          serial,
          entityId: entityId ?? null,
          day: group.day,
        },
      });
    }

    return { events: rows.length, created, skipped, capped, disabled: false };
  }

  private async людиСПравом(): Promise<{ id: string }[]> {
    const rows = await this.db
      .select({ id: person.id, roles: person.roles, role: person.role })
      .from(person)
      .where(eq(person.active, "yes"))
      .orderBy(asc(person.createdAt), asc(person.id));
    return rows.filter((row) => can(effectiveRoles(row), "tasks.confirm")).map((row) => ({ id: row.id }));
  }

  /**
   * Просрочка → событие `task.overdue`, раз в ташкентские сутки на задачу.
   *
   * Первый календарный день просрочки остаётся существующему напоминанию бота;
   * правило подключается со следующего дня, чтобы не присылать два одинаковых
   * сигнала в одно утро. Дедуп — атомарной заявкой по известному заранее ключу.
   */
  async emitOverdue(now = new Date()): Promise<{ emitted: number; capped: boolean }> {
    // Тот же тумблер, что у run(): DEPLOY.md обещает владельцу, что
    // TASK_BRIDGE_ENABLED=0 останавливает ОБЕ работы крона без деплоя —
    // молчание здесь означало бы, что откат в проде не делает того, что
    // написано в рунбуке.
    if ((await settingValue(this.db, "TASK_BRIDGE_ENABLED")).trim() !== "1") {
      this.logger.log("Эмитент task.overdue выключен настройкой.");
      return { emitted: 0, capped: false };
    }
    const граница = tashkentDayStartOf(now);
    const строки = await this.db
      .select({ id: task.id, title: task.title, due: task.due, ownerRef: task.ownerRef })
      .from(task)
      .where(
        and(
          isNotNull(task.due),
          lt(task.due, граница),
          ne(task.status, "done"),
          ne(task.status, "cancelled"),
          or(isNull(task.source), ne(task.source, AGENT_SCHEDULE_SOURCE)),
        ),
      )
      .orderBy(asc(task.due))
      .limit(OVERDUE_MAX_EVENTS + 1);

    const capped = строки.length > OVERDUE_MAX_EVENTS;
    const день = tashkentDay(now);
    let emitted = 0;
    for (const t of строки.slice(0, OVERDUE_MAX_EVENTS)) {
      // Запрос обязан это гарантировать; проверка также не даёт ошибочной
      // строке драйвера породить раннее событие.
      if (t.due === null || t.due >= граница) continue;
      if (!(await this.rules.claim(`task-overdue:${день}:${t.id}`))) continue;
      await this.events.record({
        source: "tasks",
        type: OVERDUE_EVENT,
        occurredAt: now,
        payload: {
          taskId: t.id,
          title: t.title,
          due: t.due.toISOString(),
          ownerRef: t.ownerRef,
          daysOverdue: Math.max(1, Math.round((граница.getTime() - t.due.getTime()) / 86_400_000)),
        },
      });
      emitted += 1;
    }
    if (capped) {
      this.logger.warn(
        `Просроченных задач больше ${OVERDUE_MAX_EVENTS}: показано ${OVERDUE_MAX_EVENTS}, остальные молчат до разбора`,
      );
    }
    return { emitted, capped };
  }

  onModuleInit(): void {
    this.cron = new Cron("15 6 * * *", { timezone: TZ }, () => {
      void this.run().catch((error: unknown) =>
        this.logger.warn(`Мост «событие → задача» не отработал: ${error instanceof Error ? error.message : String(error)}`),
      );
      void this.emitOverdue().catch((error: unknown) =>
        this.logger.warn(`Эмитент просрочки не отработал: ${error instanceof Error ? error.message : String(error)}`),
      );
    });
  }

  onApplicationShutdown(): void {
    this.cron?.stop();
    this.cron = null;
  }
}
