import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { event, systemConfig } from "@mydon/db";
import { PARITY_STREAK_WINDOW, tashkentDay } from "@mydon/shared";
import type { SQL } from "drizzle-orm";
// Настоящий рендер условия в SQL: проверяем ФИЛЬТР ЗАПРОСА, а не то, что
// заглушка сумела вычитать из внутренностей drizzle.
import { PgDialect } from "drizzle-orm/pg-core";
import { resetAccountingSourceCache } from "../sales/accounting-source";
import {
  computeParity,
  computeStockParity,
  CUTOVER_READY_EVENT,
  OurvendParityService,
  PARITY_EVENT,
  parityScanLimit,
  type ParityDayRow,
  type ParityStockRow,
} from "./ourvend-parity.service";
import { buildSnapshotRows, rewriteKeys, type SnapshotDay } from "./ourvend-snapshot.service";

describe("Снапшот OurVend: построчная проверка присланных дней", () => {
  it("нечисловое qty/amount — в карантин, не нулём в базу", () => {
    const days: SnapshotDay[] = [
      {
        dt: "2026-08-23",
        machineSerial: "2508160376",
        rows: [
          { product: "Fanta", qty: "12", amount: "144000" },
          { product: "Мусор", qty: "N/A", amount: "1" },
          { product: "Мусор2", qty: "1", amount: "12 000" },
        ],
      },
    ];
    const { clean, quarantined } = buildSnapshotRows(days, true);
    assert.equal(clean.length, 1);
    assert.equal(clean[0].qty, 12);
    assert.equal(quarantined.length, 2);
    assert.equal(quarantined[0].field, "qty");
    assert.equal(quarantined[1].field, "amount");
  });

  it("снимок остатков (без денег): amount не проверяется и не требуется", () => {
    const days: SnapshotDay[] = [
      { dt: "2026-08-24", machineSerial: "2508160376", rows: [{ product: "Вода", qty: 6.5 }] },
    ];
    const { clean, quarantined } = buildSnapshotRows(days, false);
    assert.equal(clean.length, 1);
    assert.equal(clean[0].qty, 6.5);
    assert.equal(quarantined.length, 0);
  });

  it("серийник приводится к канону (без «c»), битая дата отбрасывает день", () => {
    const days: SnapshotDay[] = [
      { dt: "23.08.2026", machineSerial: "X", rows: [{ product: "A", qty: 1, amount: 1 }] },
      { dt: "2026-08-23", machineSerial: "C2508160376", rows: [{ product: "A", qty: 1, amount: 1 }] },
    ];
    const { clean } = buildSnapshotRows(days, true);
    assert.equal(clean.length, 1);
    assert.equal(clean[0].machineSerial, "2508160376");
  });

  it("двойники (день, автомат, товар) агрегируются суммой — 23505 невозможен", () => {
    const days: SnapshotDay[] = [
      {
        dt: "2026-08-23",
        machineSerial: "2508160376",
        rows: [
          { product: "Снек", qty: 2, amount: 20000 },
          { product: "Снек", qty: 3, amount: 30000 },
        ],
      },
    ];
    const { clean } = buildSnapshotRows(days, true);
    assert.equal(clean.length, 1);
    assert.equal(clean[0].qty, 5);
    assert.equal(clean[0].amount, 50000);
  });

  it("битые формы (rows не массив, null-элемент) отбрасываются, а не роняют приём", () => {
    const days = [
      { dt: "2026-08-23", machineSerial: "A", rows: {} },
      { dt: "2026-08-23", machineSerial: "B", rows: [null, { product: "X", qty: 1, amount: 1 }] },
    ] as unknown as SnapshotDay[];
    const { clean, quarantined } = buildSnapshotRows(days, true);
    assert.equal(clean.length, 1);
    assert.equal(quarantined.length, 0);
  });

  it("ключи перезаписи включают дни БЕЗ строк — пустой день стирает старое", () => {
    const days: SnapshotDay[] = [
      { dt: "2026-08-23", machineSerial: "A", rows: [] },
      { dt: "2026-08-23", machineSerial: "A", rows: [] },
      { dt: "2026-08-23", machineSerial: "B", rows: [{ product: "X", qty: 1, amount: 1 }] },
    ];
    const keys = rewriteKeys(days);
    assert.equal(keys.length, 2, "дубли ключей схлопываются, пустые дни остаются");
  });
});

describe("Паритет собственного снапшота со stock-дорожкой (гейт П2)", () => {
  const row = (dt: string, serial: string, qty: number, amount: number): ParityDayRow => ({
    dt,
    serial,
    qty,
    amount,
  });

  it("полное совпадение — ноль расхождений", () => {
    const own = [row("2026-08-23", "2508160376", 12, 144000)];
    const stock = [row("2026-08-23", "2508160376", 12, 144000)];
    const { checked, mismatches } = computeParity(own, stock);
    assert.equal(checked, 1);
    assert.equal(mismatches.length, 0);
  });

  it("разошлись суммы — расхождение с обеими сторонами в отчёте", () => {
    const own = [row("2026-08-23", "m1", 12, 144000)];
    const stock = [row("2026-08-23", "m1", 11, 132000)];
    const { mismatches } = computeParity(own, stock);
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0].reason, "суммы расходятся");
    assert.equal(mismatches[0].ownQty, 12);
    assert.equal(mismatches[0].stockQty, 11);
  });

  it("день есть у нас, нет у stock — и наоборот — оба видны", () => {
    const own = [row("2026-08-22", "m1", 1, 1000)];
    const stock = [row("2026-08-23", "m1", 2, 2000)];
    const { mismatches } = computeParity(own, stock);
    assert.equal(mismatches.length, 2);
    assert.ok(mismatches.some((m) => m.reason.includes("stock-дорожки нет")));
    assert.ok(mismatches.some((m) => m.reason.includes("нашем снапшоте нет")));
  });

  it("копеечная разница float не считается расхождением", () => {
    const own = [row("2026-08-23", "m1", 12, 144000.001)];
    const stock = [row("2026-08-23", "m1", 12, 144000)];
    assert.equal(computeParity(own, stock).mismatches.length, 0);
  });
});

describe("Паритет ОСТАТКОВ автоматов (гашение связи №1, П4)", () => {
  const s = (dt: string, serial: string, product: string, qty: number): ParityStockRow => ({
    dt,
    serial,
    product,
    qty,
  });

  it("полное совпадение по (день, автомат, товар) — ноль расхождений", () => {
    const own = [s("2026-08-24", "2508160376", "Fanta", 6), s("2026-08-24", "2508160376", "Twix", 4)];
    const { checked, mismatches } = computeStockParity(own, [...own]);
    assert.equal(checked, 2);
    assert.equal(mismatches.length, 0);
  });

  it("разошлось количество — в отчёте обе стороны", () => {
    const own = [s("2026-08-24", "m1", "Fanta", 6)];
    const stock = [s("2026-08-24", "m1", "Fanta", 5)];
    const { mismatches } = computeStockParity(own, stock);
    assert.equal(mismatches.length, 1);
    assert.equal(mismatches[0].own, 6);
    assert.equal(mismatches[0].stock, 5);
    assert.equal(mismatches[0].product, "Fanta");
  });

  it("позиция есть только у одной стороны — видна, а не теряется", () => {
    const own = [s("2026-08-24", "m1", "Fanta", 6)];
    const stock = [s("2026-08-24", "m1", "Twix", 3)];
    const { mismatches } = computeStockParity(own, stock);
    assert.equal(mismatches.length, 2);
    assert.ok(mismatches.some((m) => m.product === "Fanta" && m.stock === 0));
    assert.ok(mismatches.some((m) => m.product === "Twix" && m.own === 0));
  });

  it("автомат, которого нет у второй стороны, в сверку не идёт вовсе", () => {
    // Иначе аппарат, ещё не заведённый в чужой дорожке, красил бы гейт
    // навсегда — и семь зелёных дней не наступили бы никогда.
    const own = [s("2026-08-24", "m1", "Fanta", 6), s("2026-08-24", "m2", "Twix", 3)];
    const stock = [s("2026-08-24", "m1", "Fanta", 6)];
    const { checked, mismatches } = computeStockParity(own, stock);
    assert.equal(checked, 1, "считаем только автоматы, которые есть у обеих сторон");
    assert.equal(mismatches.length, 0);
  });

  it("разное написание одного товара — не расхождение", () => {
    const own = [s("2026-08-24", "m1", "Red  Bull", 6)];
    const stock = [s("2026-08-24", "m1", "red bull", 6)];
    assert.equal(computeStockParity(own, stock).mismatches.length, 0);
  });
});

describe("Вердикт паритета: продажи и остатки вместе", () => {
  /**
   * Реестр автоматов для сверки остатков: складские и «в ремонте» из неё
   * выкидываются явно, тем же источником правды, что у плана закупа.
   */
  const реестрБезСклада = () =>
    ({ machineRegistry: async () => ({ notInService: new Map(), nameBySerial: new Map() }) }) as never;
  const реестрСоСкладом = (...серийники: string[]) =>
    ({
      machineRegistry: async () => ({
        notInService: new Map(серийники.map((s) => [s, { name: s, status: "warehouse" }])),
        nameBySerial: new Map(),
      }),
    }) as never;

  /** Очередь ответов `db.execute` — ровно в порядке запросов сервиса. */
  const stubDb = (ответы: unknown[][], written: Record<string, unknown>[] = []) => {
    const queue = [...ответы];
    return {
      db: {
        execute: () => Promise.resolve(queue.shift() ?? []),
        insert: () => ({ values: (v: Record<string, unknown>) => Promise.resolve(written.push(v)) }),
        // Журнал событий и настройки — ПУСТЫЕ: этот стенд про сверку, а не про
        // серию. Пустой журнал даёт `greenDays: 0`, то есть сигнал катовера
        // молчит и сверку не заслоняет; проверяют его тесты ниже, на своём
        // стенде с событиями.
        select: () => ({
          from: () => {
            const chain: Record<string, unknown> = {};
            chain.where = () => chain;
            chain.orderBy = () => chain;
            chain.limit = async () => [];
            chain.then = (res: (v: unknown) => unknown) => Promise.resolve([]).then(res);
            return chain;
          },
        }),
      } as never,
      written,
    };
  };

  const продажиОК = [
    [{ dt: "2026-08-24", serial: "m1", qty: 12, amount: 144000 }],
    [{ dt: "2026-08-24", serial: "m1", qty: 12, amount: 144000 }],
  ];

  it("продажи сошлись, остатки — нет: вердикт красный", async () => {
    const { db } = stubDb([
      ...продажиОК,
      [{ dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 6 }],
      [{ dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 5 }],
    ]);
    const svc = new OurvendParityService(db, реестрБезСклада());

    const p = await svc.parity(7);
    assert.equal(p.mismatches.length, 0, "продажи чистые");
    assert.equal(p.stock.mismatches.length, 1);
    assert.equal(p.stock.checked, 1);
    assert.equal(p.stock.ok, false);
    assert.equal(p.ok, false, "переключать источник нельзя, пока расходится хоть одна половина");
  });

  it("обе половины чистые — вердикт зелёный, и обе попадают в суточное событие", async () => {
    const written: Record<string, unknown>[] = [];
    const { db } = stubDb(
      [
        ...продажиОК,
        [{ dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 6 }],
        [{ dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 6 }],
      ],
      written,
    );
    const svc = new OurvendParityService(db, реестрБезСклада());

    assert.equal((await svc.parity(7)).ok, true);

    // daily() ходит в базу заново — очередь пополняем ещё одним прогоном.
    const { db: db2 } = stubDb(
      [
        ...продажиОК,
        [{ dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 6 }],
        [{ dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 6 }],
      ],
      written,
    );
    await new OurvendParityService(db2, реестрБезСклада()).daily();

    const payload = written[0]!.payload as Record<string, unknown>;
    assert.equal(payload.ok, true);
    assert.ok("остатки_сверено" in payload, "сводка обязана нести обе половины");
    assert.equal(payload.остатки_расхождений, 0);
  });

  it("снимков остатков за период нет — гейт НЕ зелёный: сверять было не по чему", async () => {
    // Отмена рулинга F5 Task 4. Прод показал ровно «заглушка врёт»:
    // `ourvend_stock_snapshot` держал строки только за СЕГОДНЯ, фильтр
    // `dt < current_date` выбрасывал их целиком, и половина гейта П4 отдавала
    // «ok» в прогоне, где не сравнили ни одной строки. Семь таких «зелёных»
    // дней открыли бы переключение источника учёта.
    const { db } = stubDb([...продажиОК, [], []]);
    const p = await new OurvendParityService(db, реестрБезСклада()).parity(7);

    assert.equal(p.stock.checked, 0);
    assert.equal(p.stock.ok, false, "ноль сверенных пар — не повод разрешать переключение");
    assert.match(String(p.stock.note), /сверять не по чему/);
    assert.match(String(p.note), /остатки/, "общая записка обязана объяснить, чего не хватает");
    assert.equal(p.ok, false);
  });

  it("складские автоматы в сверку остатков не идут — их мусор гейт не красит", async () => {
    // SKLAD 4S отдаёт заглушку 199 по всем слотам и в `machine_stock` уже
    // бывал: вернувшись, он дал бы гейту 34 расхождения из мусора.
    const { db } = stubDb([
      ...продажиОК,
      [
        { dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 6 },
        { dt: "2026-08-24", serial: "sklad4s", product: "Fanta", qty: 199 },
      ],
      [
        { dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 6 },
        { dt: "2026-08-24", serial: "sklad4s", product: "Fanta", qty: 7028 },
      ],
    ]);
    const p = await new OurvendParityService(db, реестрСоСкладом("sklad4s")).parity(7);

    assert.equal(p.stock.checked, 1, "сверили только рабочий автомат");
    assert.deepEqual(p.stock.mismatches, []);
    assert.equal(p.stock.ok, true);
  });

  it("строки остатков есть, но общих автоматов нет — это уже проблема, вердикт красный", async () => {
    const { db } = stubDb([
      ...продажиОК,
      [{ dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 6 }],
      [{ dt: "2026-08-24", serial: "ДРУГОЙ", product: "Fanta", qty: 6 }],
    ]);
    const p = await new OurvendParityService(db, реестрБезСклада()).parity(7);

    assert.equal(p.stock.checked, 0);
    assert.equal(p.stock.ok, false);
    assert.equal(p.ok, false);
  });

  it("пустой снапшот продаж не отменяет запись сводки — иначе половина по остаткам теряется", async () => {
    const written: Record<string, unknown>[] = [];
    const { db } = stubDb(
      [[], [], [{ dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 6 }], [{ dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 6 }]],
      written,
    );
    await new OurvendParityService(db, реестрБезСклада()).daily();

    assert.equal(written.length, 1, "событие пишется всегда");
    const payload = written[0]!.payload as Record<string, unknown>;
    assert.equal(payload.остатки_сверено, 1);
    assert.match(String(payload.примечание), /продаж/);
  });
});

/**
 * Сигнал «можно переключать» (R-P8b-2).
 *
 * Стенд отдельный от сверки: здесь проверяется не арифметика паритета (она под
 * тестами выше и в `@mydon/shared`), а ТРИ условия эмиссии — порог, источник
 * учёта и дедуп по ташкентским суткам.
 */
describe("Сигнал «можно переключать» (R-P8b-2)", () => {
  const сегодня = new Date("2026-09-01T08:40:00+05:00");

  // Зеркало донора обязано быть «настроено», иначе `resolveAccountingSource`
  // отдаёт `own` независимо от настройки (без зеркала учёт по-другому
  // невозможен) — и режим `stock` в тесте нечем изобразить.
  const былURL = process.env.STOCK_DATABASE_URL;
  before(() => {
    process.env.STOCK_DATABASE_URL = "postgres://зеркало-для-теста";
  });
  after(() => {
    if (былURL === undefined) delete process.env.STOCK_DATABASE_URL;
    else process.env.STOCK_DATABASE_URL = былURL;
  });

  type Событие = { id: string; type: string; occurredAt: Date; payload: Record<string, unknown> };

  interface Мир {
    /**
     * Сколько зелёных дней должно получиться ВСЕГО, считая сегодняшний, —
     * его допишет сам `daily()`. Поэтому засеваем на один день меньше: событие
     * за сегодня, посеянное руками, спорило бы по времени с настоящим.
     */
    зелёныхДо: number;
    источник: "stock" | "own";
    /**
     * Что уже лежит в журнале: и свои события (дедуп сигнала), и ЧУЖИЕ —
     * `event` общая на весь Core, и окно серии обязано их не видеть.
     */
    уже?: { type: string; occurredAt: Date }[];
    /** `CUTOVER_GREEN_DAYS` в `system_config`: от него зависит окно чтения. */
    порог?: string;
    /** Вставка события этого типа падает — проверка, что сигнал не топит вердикт. */
    ломатьВставку?: string;
  }

  /** Значения-параметры из условия drizzle: стабу надо увидеть и тип, и границу суток. */
  const параметры = (cond: unknown): unknown[] => {
    const out: unknown[] = [];
    const walk = (n: unknown): void => {
      if (!n || typeof n !== "object") return;
      if (n instanceof Date) {
        out.push(n);
        return;
      }
      if (Array.isArray(n)) {
        for (const x of n) walk(x);
        return;
      }
      const chunks = (n as { queryChunks?: unknown[] }).queryChunks;
      if (Array.isArray(chunks)) {
        for (const c of chunks) walk(c);
        return;
      }
      const v = (n as { value?: unknown }).value;
      if (typeof v === "string" || v instanceof Date) out.push(v);
    };
    walk(cond);
    return out;
  };

  const зелёныйПейлоад = {
    ok: true,
    дней: 7,
    сверено_пар: 14,
    расхождений: 0,
    остатки_сверено: 68,
    остатки_расхождений: 0,
    примечание: null,
  };

  /** Ташкентская дата за N суток до `сегодня` — тем же смещением, что и код (`tashkentDay`). */
  const датаНазад = (n: number): string => tashkentDay(new Date(сегодня.getTime() - n * 86_400_000));

  const стендПаритета = (м: Мир) => {
    resetAccountingSourceCache();

    const события: Событие[] = [];
    for (let i = 1; i < м.зелёныхДо; i += 1) {
      const d = датаНазад(i);
      события.push({ id: `p${i}`, type: PARITY_EVENT, occurredAt: new Date(`${d}T08:40:00+05:00`), payload: { ...зелёныйПейлоад } });
    }
    for (const [i, e] of (м.уже ?? []).entries()) {
      события.push({ id: `u${i}`, type: e.type, occurredAt: e.occurredAt, payload: {} });
    }

    const настройки = [
      { key: "OURVEND_ACCOUNTING_SOURCE", value: м.источник },
      ...(м.порог ? [{ key: "CUTOVER_GREEN_DAYS", value: м.порог }] : []),
    ];
    /** Условия `where` по журналу событий — чтобы проверить фильтр В SQL, а не в памяти. */
    const условия: unknown[] = [];
    /** Значения `limit` по журналу событий — окно чтения обязано расти с порогом. */
    const лимиты: number[] = [];
    const записано: { type: string; payload: Record<string, unknown>; occurredAt?: Date }[] = [];

    // Обе половины сверки сходятся: событие, которое напишет `daily()`, обязано
    // быть зелёным — сегодняшний день входит в серию.
    const очередь: unknown[][] = [
      [{ dt: датаНазад(1), serial: "m1", qty: 12, amount: 144000 }],
      [{ dt: датаНазад(1), serial: "m1", qty: 12, amount: 144000 }],
      [{ dt: датаНазад(1), serial: "m1", product: "Fanta", qty: 6 }],
      [{ dt: датаНазад(1), serial: "m1", product: "Fanta", qty: 6 }],
    ];

    const db = {
      execute: () => Promise.resolve(очередь.shift() ?? []),
      select: () => ({
        from: (t: unknown) => {
          let текущие: unknown[] = t === event ? [...события] : t === systemConfig ? настройки : [];
          const chain: Record<string, unknown> = {};
          chain.where = (cond?: unknown) => {
            if (t === event) условия.push(cond);
            const п = параметры(cond);
            const типы = п.filter((v): v is string => typeof v === "string");
            const даты = п.filter((v): v is Date => v instanceof Date);
            if (t === event) {
              текущие = (текущие as Событие[]).filter(
                (e) =>
                  (типы.length === 0 || типы.includes(e.type)) &&
                  (даты.length === 0 || e.occurredAt.getTime() >= даты[0]!.getTime()),
              );
            }
            return chain;
          };
          chain.orderBy = () => {
            текущие = [...(текущие as Событие[])].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
            return chain;
          };
          chain.limit = async (n: number) => {
            if (t === event) лимиты.push(n);
            return текущие.slice(0, n);
          };
          chain.then = (res: (v: unknown) => unknown) => Promise.resolve(текущие).then(res);
          return chain;
        },
      }),
      insert: () => ({
        values: async (v: { type: string; payload: Record<string, unknown>; occurredAt?: Date }) => {
          if (v.type === м.ломатьВставку) throw new Error("база отказала на вставке события");
          записано.push(v);
          // Событие немедленно видно и счёту серии, и дедупу — как в настоящей
          // базе. Дата берётся из самой строки: датируй стаб реальным «сейчас»
          // — и серия зависела бы от дня прогона тестов.
          события.push({
            id: `w${записано.length}`,
            type: v.type,
            occurredAt: v.occurredAt ?? сегодня,
            payload: v.payload,
          });
        },
      }),
    } as never;

    const реестр = { machineRegistry: async () => ({ notInService: new Map(), nameBySerial: new Map() }) } as never;
    return { svc: new OurvendParityService(db, реестр), записано, условия, лимиты };
  };

  it("порог взят — событие с числом дней и днём начала серии", async () => {
    const { svc, записано } = стендПаритета({ зелёныхДо: 7, источник: "stock" });
    await svc.daily(сегодня);
    const c = записано.find((e) => e.type === CUTOVER_READY_EVENT);
    assert.ok(c, "события cutover_ready нет");
    assert.deepEqual(c.payload, { greenDays: 7, since: "2026-08-26" });
  });

  it("повтор в те же ташкентские сутки — молчание", async () => {
    const { svc, записано } = стендПаритета({
      зелёныхДо: 7,
      источник: "stock",
      уже: [{ type: CUTOVER_READY_EVENT, occurredAt: new Date("2026-09-01T02:00:00+05:00") }],
    });
    await svc.daily(сегодня);
    assert.equal(записано.filter((e) => e.type === CUTOVER_READY_EVENT).length, 0);
  });

  it("после флипа сигнал не повторяется НИКОГДА: звать переключать уже некуда", async () => {
    const { svc, записано } = стендПаритета({ зелёныхДо: 9, источник: "own" });
    await svc.daily(сегодня);
    assert.equal(записано.filter((e) => e.type === CUTOVER_READY_EVENT).length, 0);
    assert.equal(записано.filter((e) => e.type === PARITY_EVENT).length, 1, "сам паритет писаться не перестал");
  });

  it("шесть дней — событие ourvend.parity есть, cutover_ready нет", async () => {
    const { svc, записано } = стендПаритета({ зелёныхДо: 6, источник: "stock" });
    await svc.daily(сегодня);
    assert.equal(записано.filter((e) => e.type === PARITY_EVENT).length, 1);
    assert.equal(записано.filter((e) => e.type === CUTOVER_READY_EVENT).length, 0);
  });

  it("окно серии фильтруется по типу В SQL: чужое событие в те же сутки её не красит", async () => {
    // `event` — общая таблица Core: один `sales.sync` даёт ~150 строк в сутки.
    // Убери фильтр — и окно в 60 строк забьётся чужими событиями, а «позднейший
    // за сутки» сделает день красным: серия навсегда встанет в ноль.
    const { svc, условия } = стендПаритета({
      зелёныхДо: 7,
      источник: "stock",
      // ПОЗЖЕ вердикта тех же суток — именно так чужое событие подменило бы день.
      уже: [{ type: "sales.sync", occurredAt: new Date("2026-08-31T20:00:00+05:00") }],
    });

    const серия = await svc.streak(сегодня);

    // 1. Фильтр стоит В ЗАПРОСЕ: текст SQL называет колонку, параметр — тип.
    const { sql: текст, params } = new PgDialect().sqlToQuery(условия[0] as SQL);
    assert.match(текст, /"type" = \$\d/, `фильтр типа не доехал до SQL: ${текст}`);
    assert.ok(params.includes(PARITY_EVENT), `в параметрах запроса нет ${PARITY_EVENT}`);
    // 2. И результат чужого события не видит.
    assert.deepEqual([серия.greenDays, серия.days.length], [6, 6]);
  });

  it("вчерашний cutover_ready сегодняшний не глушит: дедуп ровно по суткам", async () => {
    // Расширь кто-нибудь окно дедупа до недели — сигнал стал бы недельным, и
    // владелец узнал бы о готовности через шесть дней после того, как она
    // наступила (а серия к тому времени могла и оборваться).
    const { svc, записано } = стендПаритета({
      зелёныхДо: 7,
      источник: "stock",
      уже: [{ type: CUTOVER_READY_EVENT, occurredAt: new Date("2026-08-31T23:00:00+05:00") }],
    });

    await svc.daily(сегодня);

    assert.equal(записано.filter((e) => e.type === CUTOVER_READY_EVENT).length, 1);
  });

  it("окно чтения растёт с порогом: 90 зелёных дней в 60 строк не поместятся", async () => {
    // `CUTOVER_GREEN_DAYS` правится в панели и сверху ничем не ограничен. При
    // фиксированных 60 строках серия упёрлась бы в 60 и гейт не открылся бы
    // НИКОГДА — молча.
    assert.equal(parityScanLimit(7), 60, "маленький порог не сужает окно ниже пола");
    assert.equal(parityScanLimit(90), 90 + PARITY_STREAK_WINDOW);

    const { svc, лимиты } = стендПаритета({ зелёныхДо: 1, источник: "stock", порог: "90" });
    await svc.streak(сегодня);
    assert.equal(лимиты[0], 90 + PARITY_STREAK_WINDOW, "порог из настроек до запроса не доехал");
  });

  it("падение сигнала не выдаёт себя за падение сверки", async () => {
    // Вердикт УЖЕ записан и красным не стал. Упади сигнал под общим ловцом
    // крона — в логе осталось бы «Паритет OurVend не посчитался», то есть
    // неправда о сверке вместо правды о сигнале.
    const { svc, записано } = стендПаритета({
      зелёныхДо: 7,
      источник: "stock",
      ломатьВставку: CUTOVER_READY_EVENT,
    });

    await svc.daily(сегодня);

    assert.equal(записано.filter((e) => e.type === PARITY_EVENT).length, 1, "вердикт обязан уцелеть");
    assert.equal(записано.filter((e) => e.type === CUTOVER_READY_EVENT).length, 0);
  });

  it("счёт серии читает журнал, а не пересчитывает историю заново", async () => {
    // Снапшоты дозаливаются задним числом: пересчитай мы вчерашние дни по
    // СЕГОДНЯШНЕМУ содержимому таблиц — «семь зелёных подряд» нарисовались бы
    // там, где в те дни гейт был красным.
    const { svc } = стендПаритета({ зелёныхДо: 7, источник: "stock" });
    const серия = await svc.streak(сегодня);
    assert.deepEqual([серия.greenDays, серия.threshold, серия.readyForCutover], [6, 7, false]);
    assert.equal(серия.since, "2026-08-26", "сегодняшнего события ещё нет — серия стоит на вчера");
    assert.equal(серия.days.length, 6);
  });
});
