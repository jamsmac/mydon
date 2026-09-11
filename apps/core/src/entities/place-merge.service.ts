import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { auditLog, entity } from "@mydon/db";
import {
  MERGE_ATTR,
  MERGE_BASIS_LABELS,
  actorKindOf,
  isMergedPlace,
  isPlaceType,
  mergeRequestProblem,
  tashkentDay,
  type MergeBasis,
} from "@mydon/shared";
import { eq, inArray, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { requestActor } from "../common/request-actor";

/**
 * Слияние двух карточек одного места (М-9, М-10).
 *
 * ЗАЧЕМ. Одно место заведено дважды — «кардиология 4 корпус» и «4 корпус
 * кардиология» — и история разложена по обеим: у одной 51 заливка и 83 дня
 * расходников, у другой автомат, что стоит там сейчас. Переименование не
 * годится — половина истории осталась бы на карточке, которую никто не видит.
 *
 * ЧТО ДЕЛАЕТ — одной транзакцией:
 *  1. переносит на целевую карточку ВСЕ ссылки на исходную (таблица ниже);
 *  2. закрывает исходную пометкой «слита в …» и «выключена» (бот и вкладка
 *     кофе уже прячут выключенные места);
 *  3. пишет ОДНУ запись в журнал: что откуда перенесено, основание и причина.
 *
 * ЧЕГО НЕ ДЕЛАЕТ — не угадывает:
 *  • Совпадение адреса основанием не является (М-10): у KIUT четыре места по
 *    одному адресу. Нужно основание (один автомат, полевая проверка, слово
 *    владельца) и причина словами.
 *  • Коллизии уникальных ключей не «складываются». Две записи расходников за
 *    один день на двух карточках одного места могут быть двойным вводом, а
 *    могут — двумя сменами; сумма в первом случае удвоит расход. Любая
 *    коллизия — отказ со списком, разбирает человек.
 *  • Запросы на согласование, которые держат исходную карточку, и задачи,
 *    уже взятые агентом, — тоже отказ: их входные данные поменялись бы
 *    под ними.
 */

/** Все ссылки на место: таблица, колонка, дополнительное условие. */
const REFERENCES: { table: string; column: string; extra?: string }[] = [
  { table: "machine_placement", column: "location_id" },
  { table: "coffee_refill", column: "location_id" },
  { table: "coffee_consumable", column: "location_id" },
  { table: "coffee_consumable_log", column: "location_id" },
  { table: "coffee_wash_log", column: "location_id" },
  { table: "coffee_wash_schedule", column: "location_id" },
  { table: "coffee_sale", column: "location_id" },
  { table: "stock_movement", column: "warehouse_id" },
  { table: "stock_movement", column: "counterparty_id" },
  { table: "stock_batch", column: "warehouse_id" },
  { table: "part_count_session", column: "warehouse_id" },
  { table: "task", column: "entity_id" },
  { table: "maintenance_log", column: "entity_id" },
  { table: "maintenance_plan", column: "entity_id" },
  { table: "entity_draft", column: "entity_id" },
  { table: "raw_link", column: "entity_id" },
  { table: "note", column: "entity_id" },
  { table: "document", column: "entity_id" },
  { table: "money_flow", column: "entity_id" },
  { table: "attachment", column: "owner_id", extra: "owner_type = 'entity'" },
];

/** Коллизии уникальных ключей: запрос возвращает число пересечений. */
const COLLISIONS: { what: string; query: (s: string, t: string) => ReturnType<typeof sql> }[] = [
  {
    what: "расходники кофе за один и тот же день (coffee_consumable)",
    query: (s, t) => sql`select count(*)::int as n from coffee_consumable a join coffee_consumable b
      on a.logged_date = b.logged_date where a.location_id = ${s} and b.location_id = ${t}`,
  },
  {
    what: "продажи кофе одного товара за один день (coffee_sale)",
    query: (s, t) => sql`select count(*)::int as n from coffee_sale a join coffee_sale b
      on a.logged_date = b.logged_date and a.product_id = b.product_id
      where a.location_id = ${s} and b.location_id = ${t}`,
  },
  {
    what: "график мойки одной и той же позиции (coffee_wash_schedule)",
    query: (s, t) => sql`select count(*)::int as n from coffee_wash_schedule a join coffee_wash_schedule b
      on (a.position = b.position or (a.position is null and b.position is null))
      where a.location_id = ${s} and b.location_id = ${t}`,
  },
  {
    what: "действующий норматив ТО того же вида (maintenance_plan)",
    query: (s, t) => sql`select count(*)::int as n from maintenance_plan a join maintenance_plan b
      on a.kind = b.kind and a.part_kind is not distinct from b.part_kind
      where a.is_active and b.is_active and a.entity_id = ${s} and b.entity_id = ${t}`,
  },
  {
    what: "предложенная правка того же поля (entity_draft)",
    query: (s, t) => sql`select count(*)::int as n from entity_draft a join entity_draft b
      on a.field = b.field where a.entity_id = ${s} and b.entity_id = ${t}`,
  },
  {
    what: "запрос на согласование, который держит исходную карточку",
    query: (s) => sql`select count(*)::int as n from approval where decision = 'pending' and payload::text like ${`%${s}%`}`,
  },
  {
    what: "задача по исходной карточке, уже взятая агентом",
    query: (s) => sql`select count(*)::int as n from task where entity_id = ${s} and owner_kind = 'agent'
      and agent_run_id is not null and status not in ('done', 'cancelled')`,
  },
];

export interface MergePreview {
  source: { id: string; name: string; type: string };
  target: { id: string; name: string; type: string };
  /** Сколько строк переедет: «таблица.колонка» → число; нули не показываем. */
  moves: Record<string, number>;
  /** Препятствия; есть хоть одно — слияние откажет. */
  blockers: string[];
  /** Координаты: у целевой свои — исходные отбрасываются (записаны в журнал). */
  geo: "target_keeps" | "moved_from_source" | "none";
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Строки из `execute` — независимо от драйвера. На проде postgres-js отдаёт сам
 * массив строк (RowList), а pglite в сценариях на настоящем SQL — объект
 * `{ rows }`. Прочитай одно из двух напрямую — на другом движке счётчики тихо
 * обнулились бы, и предпросмотр честно показал бы «переносить нечего».
 */
function rowsOf<T>(res: unknown): T[] {
  if (Array.isArray(res)) return res as T[];
  const rows = (res as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as T[]) : [];
}

/** Число из `select count(*)::int as n`. */
function countOf(res: unknown): number {
  return Number(rowsOf<{ n?: unknown }>(res)[0]?.n ?? 0);
}

@Injectable()
export class PlaceMergeService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async preview(sourceId: string, targetId: string): Promise<MergePreview> {
    return this.db.transaction(async (tx) => this.plan(tx, sourceId, targetId, false));
  }

  async merge(
    sourceId: string,
    targetId: string,
    input: { basis: MergeBasis; reason: string },
    actorRef = requestActor("owner"),
  ): Promise<MergePreview & { mergedAt: string }> {
    const problem = mergeRequestProblem({ sourceId, targetId, basis: input.basis, reason: input.reason });
    if (problem) throw new BadRequestException(problem);

    return this.db.transaction(async (tx) => {
      const plan = await this.plan(tx, sourceId, targetId, true);
      if (plan.blockers.length > 0) {
        throw new ConflictException(`Слить нельзя: ${plan.blockers.join("; ")}`);
      }
      const [before] = await tx.select().from(entity).where(eq(entity.id, sourceId));
      const [targetBefore] = await tx.select().from(entity).where(eq(entity.id, targetId));

      for (const ref of REFERENCES) {
        const where = ref.extra ? sql.raw(` and ${ref.extra}`) : sql``;
        await tx.execute(
          sql`update ${sql.identifier(ref.table)} set ${sql.identifier(ref.column)} = ${targetId}
              where ${sql.identifier(ref.column)} = ${sourceId}${where}`,
        );
      }

      // Координаты: целевые главнее; своих нет — переезжают исходные.
      if (plan.geo === "moved_from_source") {
        await tx.execute(sql`update geo_point set entity_id = ${targetId} where entity_id = ${sourceId}`);
      } else {
        await tx.execute(sql`delete from geo_point where entity_id = ${sourceId}`);
      }

      // Контрагент: у целевой не задан — берём исходного; исходная карточка места уходит.
      await tx.execute(sql`insert into place_card (entity_id, contractor_id, updated_by)
        select ${targetId}::uuid, contractor_id, ${actorRef} from place_card where entity_id = ${sourceId}
        on conflict (entity_id) do update set
          contractor_id = coalesce(place_card.contractor_id, excluded.contractor_id),
          updated_at = now()`);
      await tx.execute(sql`delete from place_card where entity_id = ${sourceId}`);

      const mergedOn = tashkentDay(new Date());
      const attrs = {
        ...((before?.attrs ?? {}) as Record<string, unknown>),
        [MERGE_ATTR.mergedInto]: targetId,
        [MERGE_ATTR.mergedOn]: mergedOn,
        [MERGE_ATTR.disabled]: true,
      };
      await tx.update(entity).set({ attrs, updatedAt: new Date() }).where(eq(entity.id, sourceId));

      await tx.insert(auditLog).values({
        actorKind: actorKindOf(actorRef),
        actorRef,
        action: "entity.merge",
        target: targetId,
        before: { source: before, target: targetBefore },
        after: {
          sourceId,
          targetId,
          moves: plan.moves,
          geo: plan.geo,
          basis: input.basis,
          basisLabel: MERGE_BASIS_LABELS[input.basis],
          reason: input.reason.trim(),
          mergedOn,
        },
      });
      return { ...plan, mergedAt: mergedOn };
    });
  }

  /** Проверки и подсчёт — общие для предпросмотра и слияния (там — под блокировкой). */
  private async plan(tx: Tx, sourceId: string, targetId: string, lock: boolean): Promise<MergePreview> {
    if (sourceId === targetId) throw new BadRequestException("Карточку нельзя слить саму с собой");
    const q = tx.select().from(entity).where(inArray(entity.id, [sourceId, targetId]));
    const rows = lock ? await q.for("update") : await q;
    const source = rows.find((r) => r.id === sourceId);
    const target = rows.find((r) => r.id === targetId);
    if (!source) throw new NotFoundException(`Карточка ${sourceId} не найдена`);
    if (!target) throw new NotFoundException(`Карточка ${targetId} не найдена`);

    const blockers: string[] = [];
    if (!isPlaceType(source.type) || !isPlaceType(target.type)) blockers.push("сливаются только карточки мест");
    if (source.type !== target.type) blockers.push(`виды мест разные (${source.type} и ${target.type}) — это разные места`);
    if (isMergedPlace(source.attrs as Record<string, unknown>)) blockers.push("исходная карточка уже слита");
    if (isMergedPlace(target.attrs as Record<string, unknown>)) blockers.push("целевая карточка сама слита в другую");

    for (const c of COLLISIONS) {
      const res = await tx.execute(c.query(sourceId, targetId));
      const n = countOf(res);
      if (n > 0) blockers.push(`${c.what}: ${n}`);
    }

    const moves: Record<string, number> = {};
    for (const ref of REFERENCES) {
      const where = ref.extra ? sql.raw(` and ${ref.extra}`) : sql``;
      const res = await tx.execute(
        sql`select count(*)::int as n from ${sql.identifier(ref.table)} where ${sql.identifier(ref.column)} = ${sourceId}${where}`,
      );
      const n = countOf(res);
      if (n > 0) moves[`${ref.table}.${ref.column}`] = n;
    }

    const geoRes = await tx.execute(
      sql`select entity_id from geo_point where entity_id in (${sourceId}, ${targetId})`,
    );
    const withGeo = new Set(rowsOf<{ entity_id: string }>(geoRes).map((r) => r.entity_id));
    const geo = withGeo.has(targetId) ? "target_keeps" : withGeo.has(sourceId) ? "moved_from_source" : "none";

    return {
      source: { id: source.id, name: source.name, type: source.type },
      target: { id: target.id, name: target.name, type: target.type },
      moves,
      blockers,
      geo,
    };
  }
}
