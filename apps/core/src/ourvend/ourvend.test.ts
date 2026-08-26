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
  PARITY_EVENT_SOURCE,
  PARITY_SCAN_LIMIT_MAX,
  parityScanLimit,
  type ParityDayRow,
  type ParityStockRow,
} from "./ourvend-parity.service";
import { buildSnapshotRows, OurvendSnapshotService, rewriteKeys, type SnapshotDay } from "./ourvend-snapshot.service";

/** Прогон с подменённым окружением: кеш источника учёта сбрасывается с обеих сторон. */
async function сОкружением<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const было: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    было[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  resetAccountingSourceCache();
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(было)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetAccountingSourceCache();
  }
}

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

  it("ключи перезаписи — только по ЧИСТЫМ строкам: пустой день сутки не стирает (R-FW-S7)", () => {
    // Пустой (или целиком забракованный) ответ кабинета сносил `(dt, серийник)`
    // целиком. До катовера это была тень, в режиме `own` — боевой учёт: сутки
    // продаж автомата исчезали бы из `sale` без ошибки и без следа.
    const days: SnapshotDay[] = [
      { dt: "2026-08-23", machineSerial: "A", rows: [] },
      { dt: "2026-08-23", machineSerial: "A", rows: [] },
      { dt: "2026-08-23", machineSerial: "B", rows: [{ product: "X", qty: 1, amount: 1 }] },
    ];
    const { clean } = buildSnapshotRows(days, true);
    const keys = rewriteKeys(clean);
    assert.deepEqual(keys, [{ dt: "2026-08-23", machineSerial: "b" }], "стираем только то, что заменяем");
  });

  it("день, у которого ВСЕ строки ушли в карантин, тоже не стирается", () => {
    const days: SnapshotDay[] = [{ dt: "2026-08-23", machineSerial: "A", rows: [{ product: "X", qty: "N/A" }] }];
    const { clean, quarantined } = buildSnapshotRows(days, true);
    assert.equal(quarantined.length, 1);
    assert.deepEqual(rewriteKeys(clean), [], "иначе брак в ответе кабинета сносил бы сутки автомата");
  });

  it("apply(): пустой день не выполняет ни одного DELETE", async () => {
    // Проверяется СЕРВИС, а не только чистая функция: удаление живёт в
    // транзакции, и обойти `rewriteKeys` там было бы нечем видно.
    const удаления: unknown[] = [];
    const tx = {
      delete: (t: unknown) => ({
        where: async () => {
          удаления.push(t);
        },
      }),
      insert: () => ({ values: async () => undefined }),
    };
    const db = {
      transaction: async (fn: (h: unknown) => Promise<unknown>) => fn(tx),
      insert: () => ({ values: async () => undefined }),
    } as never;
    const svc = new OurvendSnapshotService(db);

    const пусто = await svc.apply({ sales: [{ dt: "2026-08-23", machineSerial: "A", rows: [] }] });
    assert.deepEqual([удаления.length, пусто.saleDays, пусто.saleRows], [0, 0, 0]);

    // А непустой — стирает и заменяет, как и раньше.
    await svc.apply({ sales: [{ dt: "2026-08-23", machineSerial: "A", rows: [{ product: "X", qty: 1, amount: 1 }] }] });
    assert.equal(удаления.length, 1);
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

describe("Допуск сверки остатков — ОДНОСТОРОННИЙ (R-FW-P1a)", () => {
  // Зеркало снимает кабинет в 07:50, наш агент — в 08:05: продажа в этом окне
  // законно уменьшает НАШ (поздний) остаток. Обратное направление дрейфом от
  // продаж не объясняется.
  const s = (product: string, qty: number): ParityStockRow => ({ dt: "2026-08-24", serial: "m1", product, qty });

  it("наш остаток меньше зеркального на 1 при допуске 3 — не расхождение, но и не «совпало»", () => {
    const r = computeStockParity([s("Fanta", 5)], [s("Fanta", 6)], new Set(), 3);
    assert.deepEqual([r.checked, r.mismatches.length, r.withinTolerance], [1, 0, 1]);
  });

  it("на границе допуска (ровно 3) — ещё в допуске, 4 — уже расхождение", () => {
    assert.equal(computeStockParity([s("Fanta", 3)], [s("Fanta", 6)], new Set(), 3).mismatches.length, 0);
    const r = computeStockParity([s("Fanta", 2)], [s("Fanta", 6)], new Set(), 3);
    assert.deepEqual([r.mismatches.length, r.withinTolerance], [1, 0]);
    assert.match(r.mismatches[0]!.reason, /расходятся/);
  });

  it("НАШ ОСТАТОК БОЛЬШЕ — расхождение при любом допуске: убыванием это не объясняется", () => {
    const r = computeStockParity([s("Fanta", 7)], [s("Fanta", 6)], new Set(), 3);
    assert.deepEqual([r.mismatches.length, r.withinTolerance], [1, 0]);
    assert.match(r.mismatches[0]!.reason, /БОЛЬШЕ/);
    // И с огромным допуском тоже: сторона, а не размер, решает.
    assert.equal(computeStockParity([s("Fanta", 7)], [s("Fanta", 6)], new Set(), 100).mismatches.length, 1);
  });

  it("допуск 0 — прежнее посимвольное поведение", () => {
    assert.equal(computeStockParity([s("Fanta", 5)], [s("Fanta", 6)], new Set(), 0).mismatches.length, 1);
    const совпало = computeStockParity([s("Fanta", 6)], [s("Fanta", 6)], new Set(), 0);
    assert.deepEqual([совпало.mismatches.length, совпало.withinTolerance], [0, 0]);
  });

  it("точное совпадение «в допуске» не считается — иначе допуск прятал бы норму", () => {
    const r = computeStockParity([s("Fanta", 6)], [s("Fanta", 6)], new Set(), 3);
    assert.deepEqual([r.mismatches.length, r.withinTolerance], [0, 0]);
  });
});

describe("Вердикт паритета: продажи и остатки вместе", () => {
  // ЗЕРКАЛО ОБЯЗАНО БЫТЬ «ЖИВЫМ»: без `STOCK_DATABASE_URL`
  // `resolveAccountingSource` отвечает `own` независимо от настройки, а
  // `own` без зеркала — это режим `retired`, где сверять не с чем вовсе.
  // Стенд ниже про режим `mirror`, и изобразить его нечем, кроме переменной.
  const былURL = process.env.STOCK_DATABASE_URL;
  before(() => {
    process.env.STOCK_DATABASE_URL = "postgres://зеркало-для-теста";
    resetAccountingSourceCache();
  });
  after(() => {
    if (былURL === undefined) delete process.env.STOCK_DATABASE_URL;
    else process.env.STOCK_DATABASE_URL = былURL;
    resetAccountingSourceCache();
  });

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

  /**
   * Стаб БД, отвечающий ПО ТАБЛИЦЕ, а не по порядку запросов.
   *
   * Очередь «ответы подряд» ломалась на любой перестановке запросов внутри
   * `parity()` и молча начинала кормить сверку остатков продажами. Здесь
   * условие рендерится настоящим `PgDialect` и таблица опознаётся по тексту —
   * стаб исполняет тот же путь, что Postgres, и `daily()` с его ДВУМЯ
   * прогонами (`parity(7)` и `parity(1)`) обслуживается тем же набором.
   */
  const stubDb = (
    таблицы: { ownSales?: unknown[]; ownStock?: unknown[]; mirrorSales?: unknown[]; mirrorStock?: unknown[] },
    written: Record<string, unknown>[] = [],
  ) => {
    const диалект = new PgDialect();
    return {
      db: {
        execute: (q: SQL) => {
          const текст = диалект.sqlToQuery(q).sql;
          if (/from "ourvend_sale_snapshot"/.test(текст) && !/from "sale"/.test(текст)) {
            return Promise.resolve(таблицы.ownSales ?? []);
          }
          if (/from "ourvend_stock_snapshot"/.test(текст) && !/from "machine_stock"/.test(текст)) {
            return Promise.resolve(таблицы.ownStock ?? []);
          }
          if (/from "sale"/.test(текст)) return Promise.resolve(таблицы.mirrorSales ?? []);
          if (/from "machine_stock"/.test(текст)) return Promise.resolve(таблицы.mirrorStock ?? []);
          return Promise.resolve([]);
        },
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

  const продажиОК = {
    ownSales: [{ dt: "2026-08-24", serial: "m1", qty: 12, amount: 144000 }],
    mirrorSales: [{ dt: "2026-08-24", serial: "m1", qty: 12, amount: 144000 }],
  };

  it("продажи сошлись, остатки — нет: вердикт красный", async () => {
    const { db } = stubDb({
      ...продажиОК,
      ownStock: [{ dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 6 }],
      // Наш остаток БОЛЬШЕ зеркального: убыванием между снимками это не
      // объясняется, и допуск такую сторону не прощает.
      mirrorStock: [{ dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 5 }],
    });
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
    const остатки = [{ dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 6 }];
    const { db } = stubDb({ ...продажиОК, ownStock: остатки, mirrorStock: остатки }, written);
    const svc = new OurvendParityService(db, реестрБезСклада());

    assert.equal((await svc.parity(7)).ok, true);
    await svc.daily();

    const payload = written[0]!.payload as Record<string, unknown>;
    assert.equal(payload.ok, true);
    assert.ok("остатки_сверено" in payload, "сводка обязана нести обе половины");
    assert.equal(payload.остатки_расхождений, 0);
    // И ВЕРДИКТ ЗА ДЕНЬ — рядом, отдельными полями: по ним, и только по ним,
    // считается серия (`parityStreak` в @mydon/shared).
    assert.deepEqual(
      [payload.день_ok, payload.день_продаж_сверено, payload.день_остатков_сверено, payload.день_расхождений],
      [true, 1, 1, 0],
    );
    assert.equal(payload.режим, "mirror", "с чем сверяли — в журнал");
  });

  it("ВЕРДИКТ ДНЯ СЧИТАЕТСЯ ОТДЕЛЬНО ОТ НЕДЕЛИ (P1b): грязный день недели зелёный день не красит", async () => {
    // Окно `parity(7)` тянет один грязный день СЕМЬ вердиктов подряд: продажа
    // в пятнадцатиминутном разрыве между съёмами закрывала бы гейт на неделю,
    // и «семь зелёных подряд» на прод-данных выпадали бы в ~9 % месяцев.
    // Поэтому серия судится полями `день_*` из `parity(1)`.
    const диалект = new PgDialect();
    const записано: Record<string, unknown>[] = [];
    const неделя = (текст: string) => /current_date - 7::int/.test(текст);
    const db = {
      execute: (q: SQL) => {
        const текст = диалект.sqlToQuery(q).sql;
        const продажи = /from "ourvend_sale_snapshot"\s+where/.test(текст) || /from "sale"/.test(текст);
        const остатки = /from "ourvend_stock_snapshot"\s+where/.test(текст) || /from "machine_stock"/.test(текст);
        if (продажи) {
          const строки = [{ dt: "2026-08-24", serial: "m1", qty: 12, amount: 144000 }];
          // В недельном окне у зеркала лишний день — недельный вердикт красный.
          return Promise.resolve(
            неделя(текст) && /from "sale"/.test(текст)
              ? [...строки, { dt: "2026-08-20", serial: "m1", qty: 5, amount: 60000 }]
              : строки,
          );
        }
        if (остатки) return Promise.resolve([{ dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 6 }]);
        return Promise.resolve([]);
      },
      insert: () => ({ values: (v: Record<string, unknown>) => Promise.resolve(записано.push(v)) }),
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
    } as never;

    await new OurvendParityService(db, реестрБезСклада()).daily();
    const payload = записано[0]!.payload as Record<string, unknown>;
    assert.equal(payload.ok, false, "недельная витрина честно красная");
    assert.equal(payload.расхождений, 1);
    assert.equal(payload.день_ok, true, "а вердикт ЗА ДЕНЬ — зелёный: вчера всё сошлось");
    assert.equal(payload.день_расхождений, 0);
  });

  it("снимков остатков за период нет — гейт НЕ зелёный: сверять было не по чему", async () => {
    // Отмена рулинга F5 Task 4. Прод показал ровно «заглушка врёт»:
    // `ourvend_stock_snapshot` держал строки только за СЕГОДНЯ, фильтр
    // `dt < current_date` выбрасывал их целиком, и половина гейта П4 отдавала
    // «ok» в прогоне, где не сравнили ни одной строки. Семь таких «зелёных»
    // дней открыли бы переключение источника учёта.
    const { db } = stubDb({ ...продажиОК });
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
    const { db } = stubDb({
      ...продажиОК,
      ownStock: [
        { dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 6 },
        { dt: "2026-08-24", serial: "sklad4s", product: "Fanta", qty: 199 },
      ],
      mirrorStock: [
        { dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 6 },
        { dt: "2026-08-24", serial: "sklad4s", product: "Fanta", qty: 7028 },
      ],
    });
    const p = await new OurvendParityService(db, реестрСоСкладом("sklad4s")).parity(7);

    assert.equal(p.stock.checked, 1, "сверили только рабочий автомат");
    assert.deepEqual(p.stock.mismatches, []);
    assert.equal(p.stock.ok, true);
  });

  it("строки остатков есть, но общих автоматов нет — это уже проблема, вердикт красный", async () => {
    const { db } = stubDb({
      ...продажиОК,
      ownStock: [{ dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 6 }],
      mirrorStock: [{ dt: "2026-08-24", serial: "ДРУГОЙ", product: "Fanta", qty: 6 }],
    });
    const p = await new OurvendParityService(db, реестрБезСклада()).parity(7);

    assert.equal(p.stock.checked, 0);
    assert.equal(p.stock.ok, false);
    assert.equal(p.ok, false);
  });

  it("пустой снапшот продаж не отменяет запись сводки — иначе половина по остаткам теряется", async () => {
    const written: Record<string, unknown>[] = [];
    const остатки = [{ dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 6 }];
    const { db } = stubDb({ ownStock: остатки, mirrorStock: остатки }, written);
    await new OurvendParityService(db, реестрБезСклада()).daily();

    assert.equal(written.length, 1, "событие пишется всегда");
    const payload = written[0]!.payload as Record<string, unknown>;
    assert.equal(payload.остатки_сверено, 1);
    assert.match(String(payload.примечание), /продаж/);
  });
});

describe("С чем сверяем после флипа: режимы паритета (R-FW-P3)", () => {
  const реестр = () =>
    ({ machineRegistry: async () => ({ notInService: new Map(), nameBySerial: new Map() }) }) as never;

  /** Стаб своей БД: снапшот есть, зеркальные таблицы — пустые (в `own` они копия). */
  const своя = (настройки: { key: string; value: string }[]) => {
    const диалект = new PgDialect();
    return {
      execute: (q: SQL) => {
        const текст = диалект.sqlToQuery(q).sql;
        if (/from "ourvend_sale_snapshot"\s+where/.test(текст)) {
          return Promise.resolve([{ dt: "2026-08-24", serial: "m1", qty: 12, amount: 144000 }]);
        }
        if (/from "ourvend_stock_snapshot"\s+where/.test(текст)) {
          return Promise.resolve([{ dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 6 }]);
        }
        // Запрос границ дат для донора и зеркальные таблицы.
        if (/sale_min/.test(текст)) return Promise.resolve([{ sale_min: "2026-08-11", stock_min: "2026-08-11" }]);
        return Promise.resolve([]);
      },
      insert: () => ({ values: () => Promise.resolve([]) }),
      select: () => ({
        from: () => {
          const chain: Record<string, unknown> = {};
          chain.where = () => chain;
          chain.orderBy = () => chain;
          chain.limit = async () => [];
          chain.then = (res: (v: unknown) => unknown) => Promise.resolve(настройки).then(res);
          return chain;
        },
      }),
    } as never;
  };

  it("зеркало погашено — режим retired: вердикт красный и сказано словами", async () => {
    await сОкружением({ STOCK_DATABASE_URL: undefined }, async () => {
      const p = await new OurvendParityService(своя([]), реестр()).parity(7);
      assert.equal(p.mode, "retired");
      assert.equal(p.ok, false, "«зелёный» без второй стороны — гейт, который ничего не проверяет");
      assert.match(String(p.note), /сверять не с чем/);
      assert.deepEqual([p.checked, p.stock.checked], [0, 0]);
    });
  });

  it("после флипа при живом зеркале сверяем С ДОНОРОМ, а не со своей же копией", async () => {
    await сОкружением(
      { STOCK_DATABASE_URL: "postgres://ro@stock/mydon", OURVEND_ACCOUNTING_SOURCE: "own" },
      async () => {
        const запросы: string[] = [];
        const svc = new OurvendParityService(своя([{ key: "OURVEND_ACCOUNTING_SOURCE", value: "own" }]), реестр());
        (svc as unknown as { открытьДонора: (url: string) => Promise<unknown> }).открытьДонора = async () => ({
          unsafe: (q: string, params: unknown[]) => {
            запросы.push(q);
            assert.deepEqual(params, [7, "2026-08-11"], "окно и нижняя граница едут ПАРАМЕТРАМИ");
            return Promise.resolve(
              /ourvend_machine_stock/.test(q)
                ? [{ dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 6 }]
                : [{ dt: "2026-08-24", serial: "m1", qty: 12, amount: 144000 }],
            );
          },
          end: async () => undefined,
        });

        const p = await svc.parity(7);
        assert.equal(p.mode, "own-vs-donor");
        assert.deepEqual([p.ok, p.checked, p.stock.checked], [true, 1, 1]);
        // Читаем ИМЕННО таблицы донора — иначе сверка доказывала бы
        // идемпотентность upsert-а, а не сходимость чисел.
        assert.equal(запросы.length, 2);
        assert.ok(запросы.some((q) => /from ourvend_sales/.test(q)), `нет чтения ourvend_sales: ${запросы.join("|")}`);
        assert.ok(запросы.some((q) => /from ourvend_machine_stock/.test(q)));
        assert.ok(
          запросы.every((q) => /^\s*select/.test(q)),
          "к донору ходим ТОЛЬКО на чтение",
        );
      },
    );
  });

  it("до флипа режим mirror — прежняя сверка со своими таблицами", async () => {
    await сОкружением(
      { STOCK_DATABASE_URL: "postgres://ro@stock/mydon", OURVEND_ACCOUNTING_SOURCE: "stock" },
      async () => {
        const p = await new OurvendParityService(
          своя([{ key: "OURVEND_ACCOUNTING_SOURCE", value: "stock" }]),
          реестр(),
        ).parity(7);
        assert.equal(p.mode, "mirror");
      },
    );
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
    // Серия судится ПОЛЯМИ ДНЯ (P1b): недельная витрина рядом её не открывает.
    день_ok: true,
    день_продаж_сверено: 2,
    день_остатков_сверено: 68,
    день_расхождений: 0,
    день_примечание: null,
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
    // быть зелёным — сегодняшний день входит в серию. Ответы КЛЮЧУЮТСЯ
    // ТАБЛИЦЕЙ: `daily()` считает сверку дважды (`parity(7)` и `parity(1)`), и
    // очередь «ответы подряд» отдала бы второму прогону пустоту.
    const диалект = new PgDialect();
    const продажиДня = [{ dt: датаНазад(1), serial: "m1", qty: 12, amount: 144000 }];
    const остаткиДня = [{ dt: датаНазад(1), serial: "m1", product: "Fanta", qty: 6 }];

    const db = {
      execute: (q: SQL) => {
        const текст = диалект.sqlToQuery(q).sql;
        if (/from "sale"/.test(текст) || /from "ourvend_sale_snapshot"/.test(текст)) {
          return Promise.resolve(продажиДня);
        }
        if (/from "machine_stock"/.test(текст) || /from "ourvend_stock_snapshot"/.test(текст)) {
          return Promise.resolve(остаткиДня);
        }
        return Promise.resolve([]);
      },
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
    const svc = new OurvendParityService(db, реестр);
    // После флипа (`источник: "own"` при живом зеркале) сверка ходит В БАЗУ
    // ДОНОРА — подменяем подключение, иначе тест полез бы в сеть. Донор отдаёт
    // те же числа: этот стенд про эмиссию сигнала, а не про арифметику сверки.
    (svc as unknown as { открытьДонора: (url: string) => Promise<unknown> }).открытьДонора = async () => ({
      unsafe: (q: string) => Promise.resolve(/ourvend_machine_stock/.test(q) ? остаткиДня : продажиДня),
      end: async () => undefined,
    });
    return { svc, записано, условия, лимиты };
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
    // 1b. И ПО ИСТОЧНИКУ (R-FW-S6): `POST /events` под сервисным токеном
    // принимает любой `type`, и без этого фильтра семь подделанных «зелёных»
    // строк открывали бы переключение учёта.
    assert.match(текст, /"source" = \$\d/, `фильтр источника не доехал до SQL: ${текст}`);
    assert.ok(params.includes(PARITY_EVENT_SOURCE), `в параметрах запроса нет ${PARITY_EVENT_SOURCE}`);
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

  it("окно чтения растёт с порогом и упирается в потолок", async () => {
    // `CUTOVER_GREEN_DAYS` правится в панели. При фиксированных 60 строках
    // серия при пороге 60 упёрлась бы в лимит и гейт не открылся бы НИКОГДА —
    // молча. Сверху окно зажато потолком (R-FW-S1).
    assert.equal(parityScanLimit(7), 60, "маленький порог не сужает окно ниже пола");
    assert.equal(parityScanLimit(60), 60 + PARITY_STREAK_WINDOW);
    // И ПОТОЛОК: порог из env валидатора не проходит, а `limit 1000014` по
    // общей таблице `event` на каждый вызов — это не гейт, а способ положить
    // Core одной настройкой (R-FW-S1).
    assert.equal(parityScanLimit(1_000_000), PARITY_SCAN_LIMIT_MAX);
    assert.equal(PARITY_SCAN_LIMIT_MAX, 400);

    const { svc, лимиты } = стендПаритета({ зелёныхДо: 1, источник: "stock", порог: "60" });
    await svc.streak(сегодня);
    assert.equal(лимиты[0], 60 + PARITY_STREAK_WINDOW, "порог из настроек до запроса не доехал");
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
