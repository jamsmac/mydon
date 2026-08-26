import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { systemConfig } from "@mydon/db";
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Db } from "../db/db.module";
import { RETENTION_BATCH, RETENTION_BUDGET_MS, RETENTION_EVENT, RetentionService, SYNC_RUN_RETENTION_DAYS } from "./retention.service";

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

/** Сами параметры, а не их JSON: `Date` и ISO-строка сериализуются ОДИНАКОВО. */
function параметры(q: SQL): unknown[] {
  return ДИАЛЕКТ.sqlToQuery(q).params;
}

/**
 * Стенд: `execute` симулирует DELETE-пачку по таблице, которую называет
 * рендер запроса, отдавая `{ count }` и укорачивая остаток строк — тот же
 * приём, что у `count` в `sales.service.ts` (`linked`). `select` отдаёт
 * настройки ретенции. `insert` копит записанные события.
 */
function стенд(опт: {
  строк: Record<string, number>;
  настройки?: Record<string, string>;
  /**
   * Ломает пачку: получает имя таблицы и НОМЕР пачки по этой таблице (с 1).
   * Вернул `true` — запрос падает. Нужен, чтобы проверить обрыв ПОСЕРЕДИНЕ
   * цикла: событие о чистке пишется в `finally`, и без этого крючка ветку
   * «строки снесены, а в журнале ни следа» проверить нечем.
   */
  ломать?: (таблица: string, пачка: number) => boolean;
}) {
  const остаток: Record<string, number> = { ...опт.строк };
  const запросы: string[] = [];
  /** Параметры каждого запроса — ТИПАМИ, а не текстом (см. `параметры`). */
  const аргументы: unknown[][] = [];
  const события: { type: string; payload: Record<string, unknown> }[] = [];
  const настройки = Object.entries(опт.настройки ?? {}).map(([key, value]) => ({ key, value }));

  const ТАБЛИЦЫ = ["slot_snapshot", "product_sale", "machine_sale", "vending_sync_run", "vending_stock_count"];
  const пачек: Record<string, number> = {};

  const db = {
    execute: async (q: SQL) => {
      const текст = рендер(q);
      запросы.push(текст);
      аргументы.push(параметры(q));
      const t = ТАБЛИЦЫ.find((name) => текст.includes(`"${name}"`));
      if (!t) throw new Error(`стенд: не распознал таблицу в запросе: ${текст}`);
      пачек[t] = (пачек[t] ?? 0) + 1;
      if (опт.ломать?.(t, пачек[t]!)) throw new Error(`стенд: база отказала на пачке ${пачек[t]} таблицы ${t}`);
      // Примерка (R-FW-S2) спрашивает `count(*)`, а не удаляет: postgres.js
      // отдаёт на такой запрос МАССИВ СТРОК, и стенд обязан отвечать той же
      // формой — иначе разбор ответа зеленел бы на подставленном `{ count }`.
      if (текст.includes("count(*)")) return [{ n: остаток[t] ?? 0 }] as never;
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

  return { svc: new RetentionService(db), запросы, аргументы, события };
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

  it("пол 180 суток держится и против env: панель такое отобьёт, окружение — нет", async () => {
    const { svc } = стенд({ строк: { slot_snapshot: 1 }, настройки: { SNAPSHOT_RETENTION_DAYS: "7" } });
    // Неделя хранения снесла бы данные под отчётом о мёртвом стоке (окно 180).
    assert.equal((await svc.sweep(вс))[0]!.olderThanDays, 180);
    // И 90 — тоже ниже пола: признание footgun'а в тексте help защитой не было
    // (R-FW-S8), а вернуть срезанную историю нечем.
    const { svc: svc90 } = стенд({ строк: { slot_snapshot: 1 }, настройки: { SNAPSHOT_RETENTION_DAYS: "90" } });
    assert.equal((await svc90.sweep(вс))[0]!.olderThanDays, 180);
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
    assert.deepEqual(события[0]!.payload, {
      table: "slot_snapshot",
      deleted: 42,
      olderThanDays: 180,
      aborted: false,
    });
  });

  it("ОБРЫВ НА ПАЧКЕ: событие всё равно пишется, с фактическим числом и aborted (R-FW-S3)", async () => {
    // Пачки коммитятся сами по себе, а событие писалось ПОСЛЕ цикла: падение на
    // третьей пачке означало снесённые безвозвратно строки и ни следа в
    // журнале — при том что эта запись и есть единственное свидетельство
    // чистки.
    const { svc, события } = стенд({
      строк: { slot_snapshot: RETENTION_BATCH * 3 },
      ломать: (таблица, пачка) => таблица === "slot_snapshot" && пачка === 3,
    });

    const r = await svc.sweep(вс);
    const снимки = r.find((x) => x.table === "slot_snapshot")!;
    assert.deepEqual([снимки.deleted, снимки.aborted], [RETENTION_BATCH * 2, true]);
    assert.equal(события[0]!.payload.deleted, RETENTION_BATCH * 2, "в журнале — ФАКТИЧЕСКИ удалённое число");
    assert.equal(события[0]!.payload.aborted, true, "и признак, что список неполон");
  });

  it("ОБРЫВ НА ПЕРВОЙ ПАЧКЕ: следа тоже не теряем — deleted 0 и aborted", async () => {
    // Блокировка или обрыв соединения на самом первом DELETE: снести не успели
    // ничего, но чистка ОТКАЗАЛА. `finally` писал событие только при
    // `deleted > 0` — то есть единственный отказ, о котором в журнале не
    // оставалось ни строки, был как раз самый ранний. «Удалено 0» и правда не
    // новость; «не смогли удалить» — новость.
    const { svc, события } = стенд({
      строк: { slot_snapshot: RETENTION_BATCH * 3 },
      ломать: (таблица, пачка) => таблица === "slot_snapshot" && пачка === 1,
    });

    const r = await svc.sweep(вс);
    const снимки = r.find((x) => x.table === "slot_snapshot")!;
    assert.deepEqual([снимки.deleted, снимки.aborted, снимки.capped], [0, true, false]);
    assert.equal(события.length, 1, "ровно одно событие — про отказавшую цель, остальные чистить нечего");
    assert.deepEqual(события[0]!.payload, {
      table: "slot_snapshot",
      deleted: 0,
      olderThanDays: 180,
      aborted: true,
    });
  });

  it("обрыв одной цели не уносит остальные: у каждой своя таблица", async () => {
    const { svc } = стенд({
      строк: { slot_snapshot: 10, vending_sync_run: 5 },
      ломать: (таблица) => таблица === "slot_snapshot",
    });
    const r = await svc.sweep(вс);
    assert.ok(
      r.some((x) => x.table === "vending_sync_run"),
      "журнал прогонов обязан почиститься, даже когда снимки не дались",
    );
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

describe("Ретенция истории склада (R-H-8)", () => {
  const вс = new Date("2026-09-06T04:10:00+05:00");

  it("чистит ПЯТЬ таблиц: к четырём добавилась vending_stock_count", async () => {
    const { svc, запросы } = стенд({
      строк: { slot_snapshot: 1, product_sale: 1, machine_sale: 1, vending_sync_run: 1, vending_stock_count: 1 },
    });
    const итог = await svc.sweep(вс);
    assert.deepEqual(итог.map((r) => r.table).sort(), [
      "machine_sale", "product_sale", "slot_snapshot", "vending_stock_count", "vending_sync_run",
    ]);
    // `event` и `raw_row` по-прежнему вне ретенции: журнал событий —
    // доказательная база (из него же считается серия паритета).
    assert.equal(запросы.filter((q) => /\bevent\b|\braw_row\b/.test(q)).length, 0);
  });

  it("граница истории склада по умолчанию — 730 суток, а не 180 снимков", async () => {
    const { svc } = стенд({ строк: { vending_stock_count: 1, slot_snapshot: 1 } });
    const итог = await svc.sweep(вс);
    assert.equal(итог.find((r) => r.table === "vending_stock_count")!.olderThanDays, 730);
    assert.equal(итог.find((r) => r.table === "slot_snapshot")!.olderThanDays, 180);
  });

  it("пол 730 держится и против env: панель отобьёт 365, окружение — нет, а Math.max — да", async () => {
    const { svc } = стенд({ строк: { vending_stock_count: 1 }, настройки: { STOCK_COUNT_RETENTION_DAYS: "365" } });
    assert.equal((await svc.sweep(вс))[0]!.olderThanDays, 730);
  });

  it("720 суток окно НЕ сужают, 1095 — расширяют: ключ умеет только продлить", async () => {
    const { svc: узкий } = стенд({ строк: { vending_stock_count: 1 }, настройки: { STOCK_COUNT_RETENTION_DAYS: "720" } });
    assert.equal((await узкий.sweep(вс))[0]!.olderThanDays, 730);
    const { svc: широкий } = стенд({ строк: { vending_stock_count: 1 }, настройки: { STOCK_COUNT_RETENTION_DAYS: "1095" } });
    assert.equal((await широкий.sweep(вс))[0]!.olderThanDays, 1095);
  });

  it("граница для vending_stock_count уходит ГОЛЫМИ СУТКАМИ, а не моментом", async () => {
    // `dt` — колонка типа `date`. Сравнение её с `timestamptz` Postgres
    // приводит к UTC-полуночи, то есть к 05:00 по Ташкенту: строки последних
    // пяти часов «того» дня срезались бы раньше срока (урок VendCash).
    const { svc, запросы } = стенд({ строк: { vending_stock_count: 1 } });
    await svc.sweep(вс);
    const q = запросы.find((x) => x.includes('"vending_stock_count"'))!;
    assert.match(
      q,
      /"vending_stock_count"\."dt" < \$/,
      "резать обязано по dt (по нему же фильтрует лист) и СТРОГО меньше: строка на границе остаётся",
    );
    assert.match(q, /"2024-09-06"/, "граница обязана быть строкой YYYY-MM-DD");
    assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(q), false, "момента в параметрах быть не должно");
    // Четыре старые цели по-прежнему сравниваются МОМЕНТОМ — их поведение не
    // менялось (`cutoffAs` по умолчанию "timestamp"). Проверяем это на запросе
    // снимков, который стенд выдаёт в том же прогоне (пустая таблица — всё
    // равно одна пачка): иначе «голые сутки» уехали бы во все пять целей и
    // тест бы этого не заметил.
    const снимки = запросы.find((x) => x.includes('"slot_snapshot"'))!;
    assert.match(снимки, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, "снимки обязаны резаться моментом, а не сутками");
  });

  it("удалять нечего — ни события, ни строки в результате: правило П8b новой целью не сломано", async () => {
    const { svc, события } = стенд({ строк: {} });
    assert.deepEqual(await svc.sweep(вс), []);
    assert.equal(события.length, 0);
  });
});

describe("Ручной прогон ретенции: примерка и полный расклад (R-FW-S2)", () => {
  const вс = new Date("2026-09-06T04:10:00+05:00");

  it("граница уезжает СТРОКОЙ, а не объектом Date — иначе драйвер падает до сервера", async () => {
    // НАЙДЕНО СМОУКОМ ПРОТИВ ЖИВОГО POSTGRES, ради которого роут и заводился.
    // `Date` в сыром параметре шаблона `sql` уходит в postgres.js без типа
    // колонки, и драйвер бросает «The "string" argument must be of type string
    // … Received an instance of Date» — то есть четыре первые цели ретенции
    // падали КАЖДОЕ воскресенье (`aborted: true`, ноль удалённых). Прежний
    // сторож этого не видел: `JSON.stringify` даёт для `Date` и для ISO-строки
    // один и тот же текст, поэтому проверяем ТИП параметра.
    const { svc, аргументы } = стенд({ строк: { slot_snapshot: 1, vending_stock_count: 1 } });
    await svc.sweep(вс);
    assert.ok(аргументы.length > 0, "запросов не было вовсе");
    for (const пара of аргументы) {
      for (const п of пара) {
        assert.equal(п instanceof Date, false, `параметр уехал объектом Date: ${String(п)}`);
        assert.equal(typeof п, "string", `параметр обязан быть строкой, а не ${typeof п}`);
      }
    }
  });

  it("`dryRun` НЕ удаляет и НЕ пишет событие, но исполняет тот же предикат", async () => {
    const { svc, запросы, события } = стенд({ строк: { vending_stock_count: 3, slot_snapshot: 7 } });
    const итог = await svc.sweep(вс, { dryRun: true });

    assert.equal(итог.find((r) => r.table === "vending_stock_count")!.deleted, 3, "примерка обязана назвать число");
    assert.equal(события.length, 0, "чистки не было — записи о чистке быть не может");
    assert.equal(запросы.some((q) => /delete from/i.test(q)), false, "примерка не удаляет ни строки");
    // Тот же самый предикат по `dt` голыми сутками — ради него роут и заведён.
    const q = запросы.find((x) => x.includes('"vending_stock_count"'))!;
    assert.match(q, /"vending_stock_count"\."dt" < \$/);
    assert.match(q, /"2024-09-06"/, "граница обязана быть строкой YYYY-MM-DD и в примерке тоже");
  });

  it("`includeEmpty` отдаёт ВСЕ пять целей, включая «удалено 0» — а событий по нулям по-прежнему нет", async () => {
    const { svc, события } = стенд({ строк: { vending_stock_count: 2 } });
    const итог = await svc.sweep(вс, { includeEmpty: true });
    assert.deepEqual(итог.map((r) => r.table).sort(), [
      "machine_sale", "product_sale", "slot_snapshot", "vending_stock_count", "vending_sync_run",
    ]);
    assert.equal(итог.find((r) => r.table === "slot_snapshot")!.deleted, 0);
    assert.deepEqual(события.map((e) => e.payload.table), ["vending_stock_count"], "журналу нули не нужны");
  });

  it("настоящий прогон через роут пишет ТЕ ЖЕ события, что крон", async () => {
    const { svc, события } = стенд({ строк: { vending_stock_count: 4 } });
    await svc.sweep(вс, { includeEmpty: true });
    assert.equal(события.length, 1);
    assert.equal(события[0]!.type, RETENTION_EVENT);
    assert.deepEqual(события[0]!.payload, { table: "vending_stock_count", deleted: 4, olderThanDays: 730, aborted: false });
  });
});
