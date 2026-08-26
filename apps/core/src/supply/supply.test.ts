import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { entity, machineStock, ourvendStockSnapshot, purchase, systemConfig } from "@mydon/db";
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { VendingService } from "../vending/vending.service";
import { resetAccountingSourceCache } from "../sales/accounting-source";
import {
  buildPurchaseUpserts,
  buildStockUpserts,
  fillFromStock,
  SupplyService,
  type StockLevelRow,
} from "./supply.service";

/**
 * Донор-заглушка: подменяет экспорт модуля `postgres` в кеше `require` — тот
 * самый, который открывает общий хелпер `stock-db.ts`. Нужна там, где режим
 * `stock` заставляет синк идти в чужую базу, а сети в тестах нет.
 */
function подменённыйДонор(): { restore: () => void } {
  const req = createRequire(__filename);
  const id = req.resolve("postgres");
  req("postgres"); // прогреваем кеш, чтобы подменять запись настоящего модуля
  const запись = req.cache[id]!;
  const было = запись.exports;
  const клиент = Object.assign(() => Promise.resolve([]), {
    end: () => Promise.resolve(undefined),
    unsafe: () => Promise.resolve([]),
  });
  запись.exports = () => клиент;
  return {
    restore: () => {
      запись.exports = было;
    },
  };
}

/** Реестр «не в строю» — единственное, что синку снабжения нужно от вендинга. */
const вендинг = (неВСтрою: string[] = [], счётчик?: { n: number }): VendingService =>
  ({
    machineRegistry: async () => {
      if (счётчик) счётчик.n += 1;
      return {
        notInService: new Map(неВСтрою.map((s) => [s, { name: s, status: "warehouse" }])),
        nameBySerial: new Map<string, string>(),
      };
    },
  }) as unknown as VendingService;

describe("Снабжение: подготовка строк источника", () => {
  it("приход: числа и срок годности переносятся, id источника — ключ", () => {
    const [v] = buildPurchaseUpserts([
      { id: 42, dt: "2026-07-20", product: "Зерно арабика", unit: "кг", qty: 10,
        unit_price: 78000, total: 780000, note: null, expiry_date: "2026-12-01" },
    ]).values;
    assert.equal(v.extId, "42");
    assert.equal(v.total, "780000");
    assert.equal(v.expiryDate, "2026-12-01");
  });

  it("приход без цены и срока — null, а не ноль-выдумка", () => {
    const [v] = buildPurchaseUpserts([
      { id: 1, dt: "2026-07-20", product: "Стаканы", unit: "шт", qty: 500,
        unit_price: null, total: null, note: "подарок поставщика", expiry_date: null },
    ]).values;
    assert.equal(v.unitPrice, null);
    assert.equal(v.total, null);
    assert.equal(v.expiryDate, null);
  });

  it("приход с нечисловым qty/ценой — в карантин, не нулём", () => {
    const { values, quarantined } = buildPurchaseUpserts([
      { id: 2, dt: "2026-07-20", product: "Мусор кол-во", unit: "кг", qty: "н/д",
        unit_price: 100, total: null, note: null, expiry_date: null },
      { id: 3, dt: "2026-07-20", product: "Мусор цена", unit: "кг", qty: 5,
        unit_price: "бесплатно", total: null, note: null, expiry_date: null },
      { id: 4, dt: "2026-07-20", product: "Годный", unit: "кг", qty: 5,
        unit_price: 100, total: 500, note: null, expiry_date: null },
    ]);
    assert.equal(values.length, 1);
    assert.equal(values[0].product, "Годный");
    assert.equal(quarantined.length, 2);
    assert.equal(quarantined[0].field, "qty");
    assert.equal(quarantined[1].field, "unit_price");
  });

  it("остатки: серийник к канону (обе формы в карте — machineSerialKeys), известный — привязан", () => {
    // Прод-карта строится machineSerialKeys — в ней ОБЕ формы; после канона в
    // ключе решает голая.
    const map = new Map([
      ["c2508160376", "ent-1"],
      ["2508160376", "ent-1"],
    ]);
    const [a, b] = buildStockUpserts(
      [
        { dt: "2026-07-28", machine_serial: "C2508160376", ourvend_name: "Вода", qty: 0, fetched_at: new Date() },
        { dt: "2026-07-28", machine_serial: "неизвестный", ourvend_name: "Чипсы", qty: 3, fetched_at: new Date() },
      ],
      map,
    ).values;
    assert.equal(a.machineId, "ent-1");
    assert.equal(a.machineSerial, "2508160376", "ключ записи — канон, не сырая форма");
    assert.equal(a.qty, "0");
    assert.equal(b.machineId, null);
  });

  it("остаток с нечисловым qty — в карантин", () => {
    const { values, quarantined } = buildStockUpserts(
      [{ dt: "2026-07-28", machine_serial: "M1", ourvend_name: "Вода", qty: "полно", fetched_at: new Date() }],
      new Map(),
    );
    assert.equal(values.length, 0);
    assert.equal(quarantined.length, 1);
    assert.equal(quarantined[0].field, "qty");
  });
});

describe("Дозаполнение карточек автоматов из источника", () => {
  it("пустой тип заполняется: coffee → 10, snack → 11", () => {
    assert.deepEqual(fillFromStock({}, { kind: "coffee", location: null }), { категория: 10 });
    assert.deepEqual(fillFromStock({}, { kind: "snack", location: null }), { категория: 11 });
  });

  it("заполненное владельцем НЕ перезатирается", () => {
    const patch = fillFromStock(
      { категория: 11, точка: "моя точка" },
      { kind: "coffee", location: "точка из источника" },
    );
    assert.equal(patch, null, "источник не должен спорить с владельцем");
  });

  it("незнакомый тип не переводим — лучше «не указан», чем догадка", () => {
    assert.equal(fillFromStock({}, { kind: "непонятно", location: null }), null);
  });

  it("точка заполняется, если её не было", () => {
    assert.deepEqual(fillFromStock({ категория: 10 }, { kind: "coffee", location: "ТЦ Compass" }), {
      точка: "ТЦ Compass",
    });
  });
});

describe("Сводка снабжения: источник остатков виден снаружи", () => {
  /**
   * Плитка «остатки на такое-то число» в обоих режимах выглядит одинаково, и
   * без этого поля владельцу нечем отличить «считаем сами» от «читаем чужую
   * базу» — а в дни поглощения это его первый вопрос.
   *
   * После R-P8b-3 источник решает не одна переменная, а правило: нет зеркала —
   * `own` по определению, есть зеркало — настройка панели (её здесь нет, значит
   * дефолт `stock`).
   */
  const сводка = async (env: Record<string, string | undefined>) => {
    const было: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      было[k] = process.env[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    resetAccountingSourceCache();
    try {
      const db = {
        select: () => ({
          from: (t: unknown) =>
            t === systemConfig
              ? Promise.resolve([])
              : {
                  where: () => Promise.resolve([{ count: 0, total: "0" }]),
                  leftJoin: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }),
                },
        }),
      } as never;
      return await new SupplyService(db, вендинг()).summary();
    } finally {
      for (const [k, v] of Object.entries(было)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      resetAccountingSourceCache();
    }
  };

  it("зеркало живо, настройки нет — stock", async () => {
    assert.equal(
      (await сводка({ STOCK_DATABASE_URL: "postgres://ro@stock/mydon", OURVEND_ACCOUNTING_SOURCE: undefined }))
        .source,
      "stock",
    );
  });

  it("зеркало живо, настройка own — own (собственный снапшот)", async () => {
    assert.equal(
      (await сводка({ STOCK_DATABASE_URL: "postgres://ro@stock/mydon", OURVEND_ACCOUNTING_SOURCE: "own" })).source,
      "own",
    );
  });

  it("зеркала нет — own, и это не «настройка не задана», а «читать нечего»", async () => {
    assert.equal(
      (await сводка({ STOCK_DATABASE_URL: undefined, OURVEND_ACCOUNTING_SOURCE: undefined })).source,
      "own",
    );
  });
});

describe("Сводка снабжения считает окно от переданного момента", () => {
  it("граница «закупы за 30 дней» едет от `now`, а не от стенных часов", async () => {
    // `now` — параметр по конвенции репо: половинчатая прокрутка («источник по
    // моменту, окно по часам стенки») превращает тест в проверку «примерно тех
    // же суток» и разъезжается ровно на границе календарного дня.
    const диалект = new PgDialect();
    const условия: string[] = [];
    const db = {
      select: () => ({
        from: (t: unknown) =>
          t === systemConfig
            ? Promise.resolve([])
            : {
                where: (cond: SQL) => {
                  условия.push(JSON.stringify(диалект.sqlToQuery(cond).params));
                  return Promise.resolve([{ count: 0, total: "0" }]);
                },
                leftJoin: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }),
              },
      }),
    } as never;

    await new SupplyService(db, вендинг()).summary(new Date("2026-09-06T10:00:00+05:00"));
    assert.ok(
      условия.some((c) => c.includes("2026-08-07")),
      `граница обязана считаться от переданного момента (06.09 − 30 сут = 07.08); было: ${условия.join(" | ")}`,
    );
  });
});

// ── Режим own: пишем остатки только по автоматам в строю (R-P8b-4) ───────────

describe("Остатки в режиме own: только автоматы в строю (R-P8b-4)", () => {
  const снимок = (serial: string, product: string, qty: number): StockLevelRow => ({
    dt: "2026-08-25",
    machine_serial: serial,
    ourvend_name: product,
    qty,
    fetched_at: new Date(),
  });

  it("SKLAD 4S из снапшота в machine_stock не попадает", () => {
    // Прод: 2508160360 — status='warehouse', в machine_stock последний раз
    // 18.07, но в ourvend_stock_snapshot приезжает 34 строки/сутки на 7028
    // «единиц» (заглушка 199). Гейт паритета его выбрасывает, запись — нет.
    const r = buildStockUpserts(
      [снимок("2508160376", "TUC Sour cream", 6), снимок("2508160360", "Заглушка", 199)],
      new Map([["2508160376", "ent-1"]]),
      new Set(["2508160360"]),
    );
    assert.equal(r.values.length, 1);
    assert.equal(r.values[0]!.machineSerial, "2508160376");
    assert.equal(r.skippedNotInService, 1);
    assert.equal(r.quarantined.length, 0, "чужой автомат — не брак данных, в карантин ему нельзя");
  });

  it("фильтр знает обе формы написания серийника", () => {
    const r = buildStockUpserts([снимок("C2508160360", "Заглушка", 199)], new Map(), new Set(["2508160360"]));
    assert.deepEqual([r.values.length, r.skippedNotInService], [0, 1]);
  });

  it("наружу едут СЕРИЙНИКИ, а не только счётчик (R-FW-S2)", () => {
    // Множество «не в строю» берётся из карточек, где «первая карточка
    // выигрывает целиком»: забытый дубль со `status ≠ in_service` уводит ЖИВОЙ
    // автомат из `machine_stock`. Число «пропущено 34» на вопрос «чей это
    // автомат» не отвечает — а это единственный важный вопрос.
    const r = buildStockUpserts(
      [снимок("2508160360", "Заглушка", 199), снимок("C2508160360", "Заглушка", 199), снимок("2508160376", "TUC", 6)],
      new Map(),
      new Set(["2508160360"]),
    );
    assert.deepEqual([r.values.length, r.skippedNotInService], [1, 2]);
    assert.deepEqual(r.skippedSerials, ["2508160360"], "серийники — канон и без дублей");
  });

  it("без множества (режим stock) поведение прежнее — зеркало таких строк не даёт", () => {
    const r = buildStockUpserts([снимок("2508160360", "Заглушка", 199)], new Map());
    assert.deepEqual([r.values.length, r.skippedNotInService], [1, 0]);
  });

  it("пустое множество фильтром не является: не в строю — только тот, про кого сказано", () => {
    const r = buildStockUpserts([снимок("2508160360", "Заглушка", 199)], new Map(), new Set());
    assert.deepEqual([r.values.length, r.skippedNotInService], [1, 0]);
  });

  it("нечисловой qty у автомата НЕ в строю — тоже не карантин: строка чужая целиком", () => {
    // Порядок проверок важен: сперва «наш ли это автомат», и только потом
    // «годное ли число». Иначе заглушка складского автомата будила бы
    // владельца событием supply.quarantine каждые десять минут.
    const r = buildStockUpserts(
      [{ dt: "2026-08-25", machine_serial: "2508160360", ourvend_name: "Заглушка", qty: "полно", fetched_at: new Date() }],
      new Map(),
      new Set(["2508160360"]),
    );
    assert.deepEqual([r.values.length, r.quarantined.length, r.skippedNotInService], [0, 0, 1]);
  });
});

// ── Мягкая деградация без STOCK_DATABASE_URL (R-P8b-6) ───────────────────────

interface МирСинка {
  /** Значение переменной на время прогона. `undefined` — переменная погашена (шаг 3 рунбука). */
  url?: string | undefined;
  снапшот?: StockLevelRow[];
  /** Канон серийников «не в строю» — реестр вендинга. */
  неВСтрою?: string[];
  автоматы?: { id: string; ref: string | null; attrs: Record<string, unknown> }[];
}

/**
 * Стенд синка снабжения: своя БД — заглушка, донора нет вовсе.
 *
 * Считает то, что после гашения переменной обязано быть НУЛЁМ, а не
 * исключением: обновлений карточек (дозаполнение из донора) и строк,
 * записанных в приход.
 */
function стендСинка(м: МирСинка) {
  const снапшот = м.снапшот ?? [];
  const автоматы = м.автоматы ?? [];
  const счёт = { обновленоКарточек: 0, вставокОстатков: 0, событий: 0 };

  const цепочка = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    chain.where = () => chain;
    chain.leftJoin = () => chain;
    chain.orderBy = () => chain;
    chain.limit = async (n: number) => rows.slice(0, n);
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res);
    return chain;
  };

  const db = {
    select: () => ({
      from: (t: unknown) => {
        if (t === purchase) return цепочка([{ np: 0, count: 0, total: "0" }]);
        if (t === machineStock) return цепочка([{ ns: 0 }]);
        if (t === ourvendStockSnapshot) return цепочка(снапшот);
        if (t === entity) return цепочка(автоматы);
        return цепочка([]); // systemConfig и всё прочее
      },
    }),
    insert: (t: unknown) => ({
      values: (v: unknown) => {
        if (t === machineStock) счёт.вставокОстатков += Array.isArray(v) ? v.length : 1;
        else счёт.событий += 1;
        const ok = Promise.resolve([]);
        return { onConflictDoUpdate: () => ok, onConflictDoNothing: () => ok, then: ok.then.bind(ok) };
      },
    }),
    update: () => ({
      set: () => ({
        where: async () => {
          счёт.обновленоКарточек += 1;
          return [];
        },
      }),
    }),
    execute: async () => ({ count: 0 }),
  } as never;

  const обращения = { n: 0 };
  const svc = new SupplyService(db, вендинг(м.неВСтрою ?? [], обращения));
  // Логгер подменяется целиком: строка «пропущено N …» — буквальное
  // обязательство R-P8b-4 и единственный след пропажи строк между снапшотом и
  // `machine_stock`; без чтения лога её можно было удалить, не уронив тестов.
  const строки: string[] = [];
  const собрать = (m: unknown) => {
    строки.push(String(m));
  };
  (svc as unknown as { log: { log: (m: unknown) => void; warn: (m: unknown) => void } }).log = {
    log: собрать,
    warn: собрать,
  };
  return { svc, счёт, обращенийКРеестру: () => обращения.n, строкиЛога: () => [...строки] };
}

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

describe("Синк снабжения без STOCK_DATABASE_URL деградирует молча и без исключений (R-P8b-6)", () => {
  const строка: StockLevelRow = {
    dt: "2026-08-25",
    machine_serial: "2508160376",
    ourvend_name: "TUC Sour cream",
    qty: 6,
    fetched_at: new Date("2026-08-25T03:05:00Z"),
  };

  it("приход пуст, дозаполнение карточек пропущено, остатки — из своего снапшота", async () => {
    await сОкружением({ STOCK_DATABASE_URL: undefined }, async () => {
      const { svc, счёт } = стендСинка({
        снапшот: [строка],
        автоматы: [{ id: "ent-1", ref: "2508160376", attrs: {} }],
      });
      const r = await svc.sync();
      assert.equal(r.purchases, 0, "донора нет — приходу взяться неоткуда");
      assert.equal(счёт.обновленоКарточек, 0, "дозаполнение entity.attrs без донора должно ПРОПУСКАТЬСЯ, а не падать");
      assert.equal(r.stock, 1, "остатки при этом продолжают идти — из собственного снапшота");
      assert.equal(счёт.вставокОстатков, 1);
    });
  });

  it("фильтр «в строю» действует и здесь: складской автомат в machine_stock не едет", async () => {
    await сОкружением({ STOCK_DATABASE_URL: undefined }, async () => {
      const { svc } = стендСинка({
        снапшот: [строка, { ...строка, machine_serial: "2508160360", ourvend_name: "Заглушка", qty: 199 }],
        неВСтрою: ["2508160360"],
      });
      assert.equal((await svc.sync()).stock, 1);
    });
  });

  it("в режиме stock реестр не спрашивается ВООБЩЕ — два лишних запроса каждые 10 минут", async () => {
    // «Не в строю» нужен только собственному снапшоту: зеркало складских строк
    // не отдаёт. Без прогона в режиме `stock` мутация «спрашивать всегда»
    // осталась бы зелёной, а прод платил бы за неё каждые десять минут.
    await сОкружением(
      { STOCK_DATABASE_URL: "postgres://ro@stock/mydon", OURVEND_ACCOUNTING_SOURCE: "stock" },
      async () => {
        const донор = подменённыйДонор();
        try {
          const { svc, обращенийКРеестру } = стендСинка({ неВСтрою: ["2508160360"] });
          await svc.sync();
          assert.equal(обращенийКРеестру(), 0, "в режиме stock реестр спрашивать не за чем");
        } finally {
          донор.restore();
        }
      },
    );
  });

  it("пропуск «не в строю» ОБЪЯВЛЯЕТСЯ строкой лога — иначе строки исчезают без следа", async () => {
    // Строка лога — буквальное обязательство R-P8b-4 и единственный след
    // пропажи строк между снапшотом и `machine_stock`. Без теста её можно было
    // удалить, не уронив ни одной проверки.
    await сОкружением({ STOCK_DATABASE_URL: undefined }, async () => {
      const { svc, строкиЛога } = стендСинка({
        снапшот: [строка, { ...строка, machine_serial: "2508160360", ourvend_name: "Заглушка", qty: 199 }],
        неВСтрою: ["2508160360"],
      });
      await svc.sync();
      const пропуск = строкиЛога().filter((l) => l.includes("пропущено"));
      assert.equal(пропуск.length, 1, "ровно одна строка на прогон");
      assert.match(пропуск[0]!, /2508160360/, "и она называет серийник, а не только число");
    });

    // Пропускать нечего — молчим: строка «пропущено 0» приучила бы её не читать.
    await сОкружением({ STOCK_DATABASE_URL: undefined }, async () => {
      const { svc, строкиЛога } = стендСинка({ снапшот: [строка] });
      await svc.sync();
      assert.equal(строкиЛога().filter((l) => l.includes("пропущено")).length, 0);
    });
  });

  it("ИЗМЕНЕНИЕ множества «не в строю» — предупреждением, а не тишиной (R-FW-S2)", async () => {
    // Состав меняется редко и осознанно. Внезапно появившийся там серийник —
    // это забытый дубль карточки или чужая правка статуса, и в режиме `own` он
    // молча уносит живой автомат из учёта остатков.
    await сОкружением({ STOCK_DATABASE_URL: undefined }, async () => {
      const { svc, строкиЛога } = стендСинка({
        снапшот: [строка, { ...строка, machine_serial: "2508160360", ourvend_name: "Заглушка", qty: 199 }],
        неВСтрою: ["2508160360"],
      });
      await svc.sync();
      assert.equal(строкиЛога().filter((l) => l.includes("изменилось")).length, 0, "первый прогон сравнивать не с чем");
      await svc.sync();
      assert.equal(строкиЛога().filter((l) => l.includes("изменилось")).length, 0, "тот же состав — молчим");
    });
  });

  it("состав «не в строю» ИЗМЕНИЛСЯ между прогонами — предупреждение с обоими списками", async () => {
    await сОкружением({ STOCK_DATABASE_URL: undefined }, async () => {
      const снимки = [строка, { ...строка, machine_serial: "2508160360", ourvend_name: "Заглушка", qty: 199 }];
      const { svc, строкиЛога } = стендСинка({ снапшот: снимки, неВСтрою: [] });
      await svc.sync();
      // Второй прогон — тот же сервис, но реестр «переобулся»: карточка автомата
      // получила статус warehouse (или всплыл её дубль).
      (svc as unknown as { vending: unknown }).vending = вендинг(["2508160360"]);
      await svc.sync();
      const тревога = строкиЛога().filter((l) => l.includes("изменилось"));
      assert.equal(тревога.length, 1);
      assert.match(тревога[0]!, /\[пусто\] → \[2508160360\]/);
    });
  });

  it("снапшота нет вовсе — ноль строк и ни одного исключения", async () => {
    await сОкружением({ STOCK_DATABASE_URL: undefined }, async () => {
      const { svc, счёт } = стендСинка({ снапшот: [] });
      assert.deepEqual(await svc.sync(), { purchases: 0, stock: 0 });
      assert.equal(счёт.событий, 0, "пустой прогон не должен писать событие синка");
    });
  });

  // Теста «мост П3 включается в момент гашения переменной» здесь НЕТ намеренно.
  // Он проверял `Boolean(process.env.STOCK_DATABASE_URL)` сразу после того, как
  // сам эту переменную и выставил: ни `receiveOrder`, ни `mirrorAlive` он не
  // звал, то есть мутация `const mirrorAlive = true` его бы не уронила. Ложный
  // сигнал «мост покрыт здесь» вреднее отсутствия теста. Настоящее покрытие
  // обеих сторон гейта живёт в `apps/core/src/vending/vending.service.test.ts`
  // («мост П3»), там же, где сам `mirrorAlive`.
});
