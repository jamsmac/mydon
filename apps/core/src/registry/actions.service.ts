import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gte, inArray, isNotNull, lt } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  coffeeConsumable,
  coffeeContainerReturn,
  coffeeRefill,
  coffeeWashLog,
  collection,
  entity,
  maintenanceLog,
  person,
  stockMovement,
  task,
  vendingRefill,
} from "@mydon/db";
import { maintenanceKindLabel, partLabel } from "@mydon/shared";
import { DB, type Db } from "../db/db.module";

/**
 * Лента действий сотрудников — ответ на вопрос владельца «кто что сделал».
 *
 * Собирается ЧТЕНИЕМ доменных таблиц, а не из audit_log: штатные полевые
 * вводы (заливки, возвраты, расходники, мойки, склад) в audit_log не пишутся
 * вовсе, поэтому журнал аудита полной ленты дать не может по построению.
 *
 * В ленту попадают только действия с УСТАНОВЛЕННЫМ человеком (personId
 * распарсен из createdBy/performedBy «person:<id>»/«staff:<id>» или лежит
 * FK-полем). Владелец, агенты — не входят; перенесённая история инкассаций
 * (source ≠ realtime) и незакрытые работы обслуживания отфильтрованы.
 *
 * Оговорка про расходники: их строка — СОСТОЯНИЕ дня (upsert по точке+дате),
 * а не журнал; в ленте видна последняя правка строки с её автором, и правка
 * задним числом сдвигает момент. Честный лог вводов — отдельная задача.
 */

export interface ActionRow {
  /** Момент действия, ISO. */
  ts: string;
  kind:
    | "coffee_refill"
    | "vending_refill"
    | "container_return"
    | "consumable"
    | "wash"
    | "maintenance"
    | "collection"
    | "intake"
    | "stock_adjustment"
    | "task_done"
    | "task_created"
    | "entity_draft";
  /** Готовая русская строка с деталями — единый вид для бота и панели. */
  label: string;
  personId: string;
  personName: string;
}

/** Больше не отдаём: бот и панель считают по строкам, молчаливый срез врал бы. */
export const ACTIONS_CAP = 2000;

/** Окно дня по Ташкенту. Пояс фиксированный (+05, без переводов). */
function dayStart(iso: string): Date {
  return new Date(`${iso}T00:00:00+05:00`);
}
function nextDayStart(iso: string): Date {
  return new Date(dayStart(iso).getTime() + 86_400_000);
}

/** person:<uuid> | staff:<uuid> → uuid. Всё прочее (owner, agent:*, import) — null. */
export function personIdOf(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const m = /^(?:person|staff):([0-9a-f-]{36})$/.exec(ref);
  return m ? m[1] : null;
}

@Injectable()
export class ActionsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Действия сотрудников за [from..to] (даты YYYY-MM-DD по Ташкенту,
   * включительно). `personId` — сузить до одного человека.
   */
  async actions(from: string, to: string, personId?: string): Promise<ActionRow[]> {
    const lo = dayStart(from);
    const hi = nextDayStart(to);

    const place = alias(entity, "place");
    const obj = alias(entity, "obj");
    const ing = alias(entity, "ing");

    // Выборки независимы — параллельно: ленту дёргает и брифинг каждое утро.
    const [
      peopleRows,
      refills,
      snackRefills,
      returns,
      consumables,
      washes,
      logs,
      collections,
      moves,
      done,
      created,
      drafts,
    ] = await Promise.all([
      this.db.select({ id: person.id, name: person.name }).from(person),
      this.db
        .select({
          at: coffeeRefill.createdAt,
          by: coffeeRefill.createdBy,
          position: coffeeRefill.position,
          weight: coffeeRefill.filledWeight,
          container: coffeeRefill.containerNumber,
          placeName: place.name,
        })
        .from(coffeeRefill)
        .innerJoin(place, eq(coffeeRefill.locationId, place.id))
        .where(and(gte(coffeeRefill.createdAt, lo), lt(coffeeRefill.createdAt, hi))),
      // Снек/дринк-заправки: свой полевой контур со своим журналом.
      this.db
        .select({
          at: vendingRefill.performedAt,
          pid: vendingRefill.personId,
          by: vendingRefill.createdBy,
          product: vendingRefill.productName,
          qty: vendingRefill.qty,
          serial: vendingRefill.machineSerial,
        })
        .from(vendingRefill)
        .where(and(gte(vendingRefill.performedAt, lo), lt(vendingRefill.performedAt, hi))),
      this.db
        .select({
          at: coffeeContainerReturn.createdAt,
          by: coffeeContainerReturn.createdBy,
          position: coffeeContainerReturn.position,
          container: coffeeContainerReturn.containerNumber,
          weight: coffeeContainerReturn.weight,
        })
        .from(coffeeContainerReturn)
        .where(and(gte(coffeeContainerReturn.createdAt, lo), lt(coffeeContainerReturn.createdAt, hi))),
      this.db
        .select({
          at: coffeeConsumable.updatedAt,
          by: coffeeConsumable.createdBy,
          water: coffeeConsumable.water,
          cups: coffeeConsumable.cups,
          lids: coffeeConsumable.lids,
          placeName: place.name,
        })
        .from(coffeeConsumable)
        .innerJoin(place, eq(coffeeConsumable.locationId, place.id))
        .where(and(gte(coffeeConsumable.updatedAt, lo), lt(coffeeConsumable.updatedAt, hi))),
      this.db
        .select({
          at: coffeeWashLog.performedAt,
          by: coffeeWashLog.performedBy,
          position: coffeeWashLog.position,
          placeName: place.name,
        })
        .from(coffeeWashLog)
        .innerJoin(place, eq(coffeeWashLog.locationId, place.id))
        .where(and(gte(coffeeWashLog.performedAt, lo), lt(coffeeWashLog.performedAt, hi))),
      // Только ЗАКРЫТЫЕ работы: «начато и не закрыто» — не итог, а процесс.
      this.db
        .select({
          at: maintenanceLog.performedAt,
          pid: maintenanceLog.personId,
          kind: maintenanceLog.kind,
          part: maintenanceLog.partKind,
          objName: obj.name,
        })
        .from(maintenanceLog)
        .innerJoin(obj, eq(maintenanceLog.entityId, obj.id))
        .where(
          and(
            gte(maintenanceLog.performedAt, lo),
            lt(maintenanceLog.performedAt, hi),
            isNotNull(maintenanceLog.personId),
            isNotNull(maintenanceLog.outcome),
          ),
        ),
      // Только realtime: перенесённая история (import/manual_history) — не
      // «сотрудник наработал сегодня», а заливка прошлого в базу.
      this.db
        .select({
          at: collection.collectedAt,
          pid: collection.operatorId,
          status: collection.status,
          objName: obj.name,
        })
        .from(collection)
        .innerJoin(obj, eq(collection.machineId, obj.id))
        .where(
          and(
            gte(collection.collectedAt, lo),
            lt(collection.collectedAt, hi),
            isNotNull(collection.operatorId),
            eq(collection.source, "realtime"),
          ),
        ),
      this.db
        .select({
          at: stockMovement.createdAt,
          by: stockMovement.createdBy,
          kind: stockMovement.kind,
          qty: stockMovement.qty,
          unit: stockMovement.unit,
          ingName: ing.name,
        })
        .from(stockMovement)
        .innerJoin(ing, eq(stockMovement.ingredientId, ing.id))
        .where(
          and(
            gte(stockMovement.createdAt, lo),
            lt(stockMovement.createdAt, hi),
            inArray(stockMovement.kind, ["intake", "adjustment"]),
          ),
        ),
      this.db
        .select({ at: task.completedAt, ref: task.ownerRef, title: task.title })
        .from(task)
        .where(
          and(
            isNotNull(task.completedAt),
            gte(task.completedAt, lo),
            lt(task.completedAt, hi),
            eq(task.ownerKind, "human"),
            eq(task.status, "done"),
          ),
        ),
      this.db
        .select({ at: task.createdAt, by: task.createdBy, title: task.title })
        .from(task)
        .where(and(gte(task.createdAt, lo), lt(task.createdAt, hi))),
      this.db
        .select({ at: entity.createdAt, by: entity.createdFrom, name: entity.name, type: entity.type })
        .from(entity)
        .where(and(gte(entity.createdAt, lo), lt(entity.createdAt, hi))),
    ]);

    const people = new Map(peopleRows.map((p) => [p.id, p.name]));
    const out: ActionRow[] = [];
    const push = (ts: Date | null, kind: ActionRow["kind"], pid: string | null, label: string): void => {
      if (ts === null || pid === null) return;
      const name = people.get(pid);
      if (name === undefined) return; // автор не из реестра людей — не полевое действие
      if (personId !== undefined && pid !== personId) return;
      out.push({ ts: ts.toISOString(), kind, label, personId: pid, personName: name });
    };

    for (const r of refills) {
      push(
        r.at,
        "coffee_refill",
        personIdOf(r.by),
        `☕ Заливка: ${r.placeName} · бункер ${r.position} · ${r.weight} г${r.container === null ? "" : ` · набор ${r.container}`}`,
      );
    }
    for (const r of snackRefills) {
      push(
        r.at,
        "vending_refill",
        r.pid ?? personIdOf(r.by),
        `🍫 Заправка автомата ${r.serial}: ${r.product} ×${r.qty}`,
      );
    }
    for (const r of returns) {
      push(
        r.at,
        "container_return",
        personIdOf(r.by),
        `↩️ Возврат набора ${String(r.container).padStart(3, "0")} · поз. ${r.position} · ${r.weight} г`,
      );
    }
    for (const r of consumables) {
      push(
        r.at,
        "consumable",
        personIdOf(r.by),
        `💧 Расходники: ${r.placeName} · вода ${r.water}, стаканы ${r.cups}, крышки ${r.lids}`,
      );
    }
    for (const r of washes) {
      push(
        r.at,
        "wash",
        personIdOf(r.by),
        `🧼 Мойка: ${r.placeName}${r.position === null ? " · вся машина" : ` · бункер ${r.position}`}`,
      );
    }
    for (const r of logs) {
      push(
        r.at,
        "maintenance",
        r.pid,
        `🛠 ${maintenanceKindLabel(r.kind)}${r.part ? `: ${partLabel(r.part)}` : ""} — ${r.objName}`,
      );
    }
    for (const r of collections) {
      push(r.at, "collection", r.pid, `📥 Инкассация: ${r.objName}${r.status === "cancelled" ? " (отменена)" : ""}`);
    }
    for (const r of moves) {
      const qty = Number(r.qty);
      push(
        r.at,
        r.kind === "intake" ? "intake" : "stock_adjustment",
        personIdOf(r.by),
        r.kind === "intake"
          ? `📦 Приход: ${r.ingName} +${qty} ${r.unit}`
          : `🧮 Инвентаризация: ${r.ingName} ${qty > 0 ? "+" : ""}${qty} ${r.unit}`,
      );
    }
    for (const r of done) {
      const pid = r.ref !== null && /^[0-9a-f-]{36}$/.test(r.ref) ? r.ref : null;
      push(r.at, "task_done", pid, `✅ Закрыл задачу: ${r.title}`);
    }
    for (const r of created) {
      push(r.at, "task_created", personIdOf(r.by), `⚠️ Завёл заявку: ${r.title}`);
    }
    for (const r of drafts) {
      push(r.at, "entity_draft", personIdOf(r.by), `🆕 Завёл карточку: ${r.name} (${r.type})`);
    }

    out.sort((a, b) => b.ts.localeCompare(a.ts));
    return out.slice(0, ACTIONS_CAP);
  }
}
