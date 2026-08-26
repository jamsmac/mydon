import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { systemConfig } from "@mydon/db";
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../db/db.module";
import { RETENTION_BATCH, RETENTION_BUDGET_MS, RetentionService, SYNC_RUN_RETENTION_DAYS } from "./retention.service";

const ДИАЛЕКТ = new PgDialect();

/**
 * Настоящий рендер запроса в SQL-текст (тот же приём, что у
 * `ourvend-parity`/`registry-import` тестов): проверяем ТЕКСТ И ПАРАМЕТРЫ
 * запроса, а не то, что заглушка сумела вычитать из внутренностей drizzle.
 * Лимит пачки — `sql.raw`, поэтому попадает прямо в текст; cutoff — обычный
 * параметр, поэтому текст плюс сериализованные параметры вместе дают то, что
 * реально уйдёт в базу.
 */
function рендер(q: SQL): string {
  const { sql: текст, params } = ДИАЛЕКТ.sqlToQuery(q);
  return `${текст} -- params: ${JSON.stringify(params)}`;
}

/**
 * Стенд: `execute` симулирует DELETE-пачку по таблице, которую называет
 * рендер запроса, отдавая `{ count }` и укорачивая остаток строк — тот же
 * приём, что у `count` в `sales.service.ts` (`linked`). `select` отдаёт
 * настройки ретенции. `insert` копит записанные события.
 */
function стенд(опт: { строк: Record<string, number>; настройки?: Record<string, string> }) {
  const остаток: Record<string, number> = { ...опт.строк };
  const запросы: string[] = [];
  const события: { type: string; payload: Record<string, unknown> }[] = [];
  const настройки = Object.entries(опт.настройки ?? {}).map(([key, value]) => ({ key, value }));

  const ТАБЛИЦЫ = ["slot_snapshot", "product_sale", "machine_sale", "vending_sync_run"];

  const db = {
    execute: async (q: SQL) => {
      const текст = рендер(q);
      запросы.push(текст);
      const t = ТАБЛИЦЫ.find((name) => текст.includes(`"${name}"`));
      if (!t) throw new Error(`стенд: не распознал таблицу в запросе: ${текст}`);
      const есть = остаток[t] ?? 0;
      const пачка = Math.min(есть, RETENTION_BATCH);
      остаток[t] = есть - пачка;
      return { count: пачка } as never;
    },
    select: () => ({
      from: (t: unknown) => {
        const строки = t === systemConfig ? настройки : [];
        const chain: Record<string, unknown> = {};
        chain.where = () => chain;
        chain.limit = async () => строки;
        chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
          Promise.resolve(строки).then(res, rej);
        return chain;
      },
    }),
    insert: () => ({
      values: async (v: { source: string; type: string; payload: Record<string, unknown>; occurredAt: Date }) => {
        события.push({ type: v.type, payload: v.payload });
      },
    }),
  } as unknown as Db;

  return { svc: new RetentionService(db), запросы, события };
}

describe("Еженедельная ретенция (R-P8b-7)", () => {
  const вс = new Date("2026-09-06T04:10:00+05:00");

  it("чистит четыре таблицы и НЕ трогает журнал событий и сырой слой", async () => {
    const { svc, запросы } = стенд({ строк: { slot_snapshot: 100, product_sale: 10, machine_sale: 5, vending_sync_run: 3 } });
    const итог = await svc.sweep(вс);
    assert.deepEqual(итог.map((r) => r.table).sort(), ["machine_sale", "product_sale", "slot_snapshot", "vending_sync_run"]);
    // `event` — доказательная база (из неё же считается серия паритета), а
    // `raw_row` — сырой слой источников: обе таблицы вне ретенции по рулингу.
    assert.equal(запросы.filter((q) => /\bevent\b|\braw_row\b/.test(q)).length, 0);
  });

  it("граница по умолчанию — 180 суток, у журнала прогонов — 365", async () => {
    const { svc } = стенд({ строк: { slot_snapshot: 1, vending_sync_run: 1 } });
    const итог = await svc.sweep(вс);
    assert.equal(итог.find((r) => r.table === "slot_snapshot")!.olderThanDays, 180);
    assert.equal(итог.find((r) => r.table === "vending_sync_run")!.olderThanDays, SYNC_RUN_RETENTION_DAYS);
  });

  it("пол 90 суток держится и против env: панель такое отобьёт, окружение — нет", async () => {
    const { svc } = стенд({ строк: { slot_snapshot: 1 }, настройки: { SNAPSHOT_RETENTION_DAYS: "7" } });
    // Неделя хранения снесла бы данные под отчётом о мёртвом стоке (окно до 180).
    assert.equal((await svc.sweep(вс))[0]!.olderThanDays, 90);
  });

  it("удаляет ПАЧКАМИ, а не одним DELETE на 36 тысяч строк", async () => {
    const { svc, запросы } = стенд({ строк: { slot_snapshot: RETENTION_BATCH * 2 + 1 } });
    const r = (await svc.sweep(вс)).find((x) => x.table === "slot_snapshot")!;
    assert.equal(r.deleted, RETENTION_BATCH * 2 + 1);
    assert.equal(запросы.filter((q) => q.includes("slot_snapshot")).length, 3);
    assert.ok(запросы.every((q) => q.includes(String(RETENTION_BATCH))), "лимит пачки обязан быть в запросе");
  });

  it("удалять нечего — ни одного события: «удалено 0» это не новость", async () => {
    const { svc, события } = стенд({ строк: {} });
    assert.deepEqual(await svc.sweep(вс), []);
    assert.equal(события.length, 0);
  });

  it("удалено — событие с таблицей, числом и границей", async () => {
    const { svc, события } = стенд({ строк: { slot_snapshot: 42 } });
    await svc.sweep(вс);
    assert.equal(события[0]!.type, "system.retention");
    assert.deepEqual(события[0]!.payload, { table: "slot_snapshot", deleted: 42, olderThanDays: 180 });
  });

  it("бюджет: обрыв по времени выполнения ставит capped и не докапывает пачками следующего воскресенья", async () => {
    const { svc, запросы } = стенд({ строк: { slot_snapshot: RETENTION_BATCH * 3 } });
    // `clock()` зовётся: 1) расчёт дедлайна, 2) проверка перед первой пачкой
    // (ещё в бюджете), 3) проверка перед второй (уже за бюджетом) — реальные
    // часы стенки тест не ждёт, часы подставные.
    let тик = 0;
    (svc as unknown as { clock: () => number }).clock = () => (тик++ < 2 ? 0 : RETENTION_BUDGET_MS + 1);
    const r = (await svc.sweep(вс)).find((x) => x.table === "slot_snapshot")!;
    assert.equal(r.capped, true);
    assert.equal(r.deleted, RETENTION_BATCH);
    assert.equal(запросы.filter((q) => q.includes("slot_snapshot")).length, 1);
  });
});
