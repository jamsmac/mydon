import { ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { agent, auditLog } from "@mydon/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

type AgentRow = typeof agent.$inferSelect;

export interface AgentScheduleItem {
  cron: string;
  skill: string;
}

export interface WebSourceItem {
  name: string;
  url: string;
}

export interface UpsertAgentInput {
  name: string;
  business?: string;
  status?: string;
  description?: string | null;
  mission?: string | null;
  nonGoals?: string[];
  autonomyDefault?: "T0" | "T1" | "T2" | "T3" | "T4";
  skills?: string[];
  schedule?: AgentScheduleItem[];
  budgetPerDayUsd?: number | null;
  /** Что делать при исчерпании бюджета: pause | downgrade | ask. */
  budgetOnExceeded?: string | null;
  /** Сайты, разрешённые агенту для чтения. */
  webSources?: WebSourceItem[];
  /** Навыки, всегда идущие через согласование (break-glass). */
  breakGlass?: string[];
  /** Публичные Telegram-каналы идей. */
  ideaChannels?: string[];
  /** Страницы знаний в контексте агента: пути внутри apps/agents/shared (R-LS-10). */
  kbPages?: string[];
}

/**
 * Настройки агентов — карточка агента в панели (запрос владельца).
 *
 * Почему в базе, а не в файлах: паспорта лежат внутри Docker-образа, и любая
 * правка владельца слетала бы при следующем обновлении. Файлы остаются
 * НАЧАЛЬНЫМ сидом — первый запуск переносит их сюда, дальше источник истины здесь.
 *
 * Удаление — архивация: журнал и согласования ссылаются на агента по имени,
 * и стирание строки оставило бы историю без объяснения, кто её создал.
 */
@Injectable()
export class AgentsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Список агентов. По умолчанию без архивных — их не должно быть в работе. */
  list(opts: { includeArchived?: boolean } = {}): Promise<AgentRow[]> {
    return this.db
      .select()
      .from(agent)
      .where(opts.includeArchived ? undefined : isNull(agent.archivedAt))
      .orderBy(asc(agent.name));
  }

  async byName(name: string): Promise<AgentRow> {
    const [row] = await this.db.select().from(agent).where(eq(agent.name, name)).limit(1);
    if (!row) throw new NotFoundException(`Агент "${name}" не найден`);
    return row;
  }

  /** Заведение агента. Имя уникально: по нему агент связан с журналом. */
  async create(input: UpsertAgentInput, actorRef = "owner"): Promise<AgentRow> {
    const [existing] = await this.db
      .select({ id: agent.id })
      .from(agent)
      .where(eq(agent.name, input.name))
      .limit(1);
    if (existing) throw new ConflictException(`Агент с именем "${input.name}" уже есть`);

    return this.db.transaction(async (tx) => {
      const [created] = await tx
        .insert(agent)
        .values({
          name: input.name,
          business: input.business ?? "shared",
          // Новый агент заводится ВЫКЛЮЧЕННЫМ: включать — осознанное действие.
          status: input.status ?? "paused",
          description: input.description ?? null,
          mission: input.mission ?? null,
          nonGoals: input.nonGoals ?? [],
          autonomyDefault: input.autonomyDefault ?? "T1",
          skills: input.skills ?? [],
          schedule: input.schedule ?? [],
          budgetPerDayUsd: input.budgetPerDayUsd?.toString() ?? null,
          budgetOnExceeded: input.budgetOnExceeded ?? null,
          webSources: input.webSources ?? [],
          breakGlass: input.breakGlass ?? [],
          ideaChannels: input.ideaChannels ?? [],
          kbPages: input.kbPages ?? [],
        })
        .returning();

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "agent.create",
        target: created.name,
        after: created,
      });
      return created;
    });
  }

  /** Изменение настроек. В журнал пишем «до» и «после» — видно, что менялось. */
  async update(name: string, patch: Partial<UpsertAgentInput>, actorRef = "owner"): Promise<AgentRow> {
    const before = await this.byName(name);

    const values: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.business !== undefined) values.business = patch.business;
    if (patch.status !== undefined) values.status = patch.status;
    if (patch.description !== undefined) values.description = patch.description;
    if (patch.mission !== undefined) values.mission = patch.mission;
    if (patch.nonGoals !== undefined) values.nonGoals = patch.nonGoals;
    if (patch.autonomyDefault !== undefined) values.autonomyDefault = patch.autonomyDefault;
    if (patch.skills !== undefined) values.skills = patch.skills;
    if (patch.schedule !== undefined) values.schedule = patch.schedule;
    if (patch.budgetPerDayUsd !== undefined) {
      values.budgetPerDayUsd = patch.budgetPerDayUsd === null ? null : String(patch.budgetPerDayUsd);
    }
    if (patch.budgetOnExceeded !== undefined) values.budgetOnExceeded = patch.budgetOnExceeded;
    if (patch.webSources !== undefined) values.webSources = patch.webSources;
    if (patch.breakGlass !== undefined) values.breakGlass = patch.breakGlass;
    if (patch.ideaChannels !== undefined) values.ideaChannels = patch.ideaChannels;
    if (patch.kbPages !== undefined) values.kbPages = patch.kbPages;

    return this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(agent)
        .set(values)
        .where(eq(agent.id, before.id))
        .returning();

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "agent.update",
        target: name,
        before,
        after: updated,
      });
      return updated;
    });
  }

  /**
   * Удаление = архивация. Агент уходит из работы, история остаётся целой.
   * Освобождаем имя (переименовываем в name#archived-<время>), чтобы владелец
   * мог завести агента с тем же именем заново, не теряя старую историю.
   */
  async archive(name: string, actorRef = "owner"): Promise<AgentRow> {
    const before = await this.byName(name);
    if (before.archivedAt !== null) return before; // уже в архиве — повтор безопасен

    const stamp = new Date();
    return this.db.transaction(async (tx) => {
      const [archived] = await tx
        .update(agent)
        .set({
          archivedAt: stamp,
          status: "deprecated",
          name: `${before.name}#archived-${stamp.getTime()}`,
          updatedAt: stamp,
        })
        .where(eq(agent.id, before.id))
        .returning();

      await tx.insert(auditLog).values({
        actorKind: "human",
        actorRef,
        action: "agent.archive",
        target: before.name,
        before,
        after: archived,
      });
      return archived;
    });
  }

  /**
   * Перенос паспортов-файлов в базу при первом запуске.
   * Идемпотентно: существующих не трогаем — иначе обновление затирало бы
   * настройки, которые владелец поменял в карточке.
   */
  async seedIfEmpty(passports: UpsertAgentInput[]): Promise<{ seeded: number; skipped: number }> {
    let seeded = 0;
    let skipped = 0;
    for (const p of passports) {
      const [existing] = await this.db
        .select({ id: agent.id })
        .from(agent)
        .where(eq(agent.name, p.name))
        .limit(1);
      if (existing) {
        skipped += 1;
        continue;
      }
      await this.create(p, "system:seed");
      seeded += 1;
    }
    return { seeded, skipped };
  }

  /** Агенты, готовые к работе: включённые и не в архиве. */
  active(): Promise<AgentRow[]> {
    return this.db
      .select()
      .from(agent)
      .where(and(eq(agent.status, "active"), isNull(agent.archivedAt)))
      .orderBy(asc(agent.name));
  }
}
