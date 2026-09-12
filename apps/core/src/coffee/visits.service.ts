import { Inject, Injectable } from "@nestjs/common";
import { coffeeConsumable, coffeeRefill, entity } from "@mydon/db";
import { and, eq, gte, lte } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";

/**
 * Визит: приезд человека на точку (слово владельца 12.09.2026).
 *
 * ЧТО ЭТО. «Он убирается и в это же время заменяет бункера — и это визит.»
 * То есть визит — не отдельная операция, а ОБЁРТКА над теми, что уже есть:
 * приехал → убрался → поменял бункера → залил → записал расходники. В учёте до
 * сих пор были видны только следы визита по отдельности, и на простые вопросы
 * — как часто объезжают точку, не забыта ли она — ответить было нечем.
 *
 * ВЫЧИСЛЯЕТСЯ, А НЕ ХРАНИТСЯ (тот же принцип, что у реестра пробелов R-K4).
 * Визит — это факт, что в такой-то день на такой-то точке что-то делали. Всё,
 * из чего он складывается, уже записано; отдельная таблица завтра разошлась бы
 * с фактами. Появится запись — визит появится сам, исчезнет — исчезнет.
 *
 * ЧЕГО ЗДЕСЬ НЕТ И ПОЧЕМУ.
 *   • Возвраты бункеров. `coffee_container_return` НЕ знает точки: сообщение в
 *     группе — это список наборов, привезённых с объезда, без адреса. Поэтому
 *     замена бункеров, о которой говорит владелец, в визите не видна, хотя она
 *     и есть главное его содержание. Это отдельный пробел, а не недоделка
 *     здесь: пока возврат не знает, откуда приехал набор, привязать его к
 *     точке можно только догадкой.
 *   • Фото уборки из Telegram. За девять месяцев их 6106, и 548 опознанных
 *     пар «точка · день» — готовая метка визита. Но они живут в переписке, а
 *     не в базе; пока не занесены, визит без заливки и расходников невидим.
 *     Таких дней по сверке 12.09.2026 — семь.
 */

export interface Visit {
  locationId: string;
  locationName: string;
  /** Ташкентский день визита. */
  day: string;
  refills: number;
  /** Расходники: вода, стаканчики, крышки — один блок на точку и день. */
  consumables: boolean;
  /** Кто оставил следы: авторы записей этого дня, без повторов. */
  actors: string[];
}

@Injectable()
export class VisitsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Визиты за окно дат. Границы включительные — окно «с 1-го по 30-е» человек
   * понимает именно так, и отчёт, теряющий последний день, объяснить нельзя.
   */
  async list(from: string, to: string): Promise<Visit[]> {
    const [refillRows, consumableRows] = await Promise.all([
      this.db
        .select({
          locationId: coffeeRefill.locationId,
          name: entity.name,
          day: coffeeRefill.enteredDate,
          createdBy: coffeeRefill.createdBy,
        })
        .from(coffeeRefill)
        .innerJoin(entity, eq(entity.id, coffeeRefill.locationId))
        .where(and(gte(coffeeRefill.enteredDate, from), lte(coffeeRefill.enteredDate, to))),
      this.db
        .select({
          locationId: coffeeConsumable.locationId,
          name: entity.name,
          day: coffeeConsumable.loggedDate,
          createdBy: coffeeConsumable.createdBy,
        })
        .from(coffeeConsumable)
        .innerJoin(entity, eq(entity.id, coffeeConsumable.locationId))
        .where(and(gte(coffeeConsumable.loggedDate, from), lte(coffeeConsumable.loggedDate, to))),
    ]);

    const byKey = new Map<string, Visit & { actorSet: Set<string> }>();
    const touch = (locationId: string, locationName: string, day: string) => {
      const key = `${locationId}|${day}`;
      let v = byKey.get(key);
      if (v === undefined) {
        v = { locationId, locationName, day, refills: 0, consumables: false, actors: [], actorSet: new Set() };
        byKey.set(key, v);
      }
      return v;
    };
    for (const r of refillRows) {
      const v = touch(r.locationId, r.name, r.day);
      v.refills += 1;
      if (r.createdBy !== null) v.actorSet.add(r.createdBy);
    }
    for (const c of consumableRows) {
      const v = touch(c.locationId, c.name, c.day);
      v.consumables = true;
      if (c.createdBy !== null) v.actorSet.add(c.createdBy);
    }
    return [...byKey.values()]
      .map(({ actorSet, ...v }) => ({ ...v, actors: [...actorSet].sort() }))
      .sort((a, b) => (a.day === b.day ? a.locationName.localeCompare(b.locationName) : a.day.localeCompare(b.day)));
  }

  /**
   * Когда точку посещали в последний раз — и сколько дней назад это было.
   *
   * Точки БЕЗ единого визита в окне тоже нужны: «ни разу» — это и есть ответ,
   * ради которого отчёт читают. Молча их пропустить значило бы показать
   * благополучную картину по тем, кого объезжают.
   */
  async lastSeen(from: string, to: string, today: string): Promise<{ locationId: string; locationName: string; lastVisit: string | null; daysAgo: number | null }[]> {
    const visits = await this.list(from, to);
    const last = new Map<string, { name: string; day: string }>();
    for (const v of visits) {
      const prev = last.get(v.locationId);
      if (prev === undefined || v.day > prev.day) last.set(v.locationId, { name: v.locationName, day: v.day });
    }
    const locations = await this.db.select({ id: entity.id, name: entity.name }).from(entity).where(eq(entity.type, "location"));
    const days = (day: string): number => {
      const a = Date.parse(`${day}T00:00:00Z`);
      const b = Date.parse(`${today}T00:00:00Z`);
      return Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round((b - a) / 86_400_000)) : 0;
    };
    return locations
      .map((l) => {
        const seen = last.get(l.id);
        return {
          locationId: l.id,
          locationName: l.name,
          lastVisit: seen?.day ?? null,
          daysAgo: seen === undefined ? null : days(seen.day),
        };
      })
      .sort((a, b) => (b.daysAgo ?? Number.MAX_SAFE_INTEGER) - (a.daysAgo ?? Number.MAX_SAFE_INTEGER));
  }
}
