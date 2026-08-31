import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildUpserts, daysAgoLocal, todayLocal, type StockSaleRow } from "./sales.service";

/**
 * Прогон с НАСТОЯЩЕЙ зоной процесса — гард против возврата к календарю процесса.
 *
 * «Прогнать пакет с TZ=UTC» для этого файла ничего не доказывает: `config.ts`
 * выполняет `process.env.TZ = "Asia/Tashkent"` при импорте, а этот файл
 * импортирует `sales.service` → `db.module` → `config` — то есть процесс
 * тестов живёт в Ташкенте НЕЗАВИСИМО от окружения запуска (проверено: offset
 * −300 после импорта под `TZ=UTC`). Полуночные тесты на этом были инертны:
 * возврат `todayLocal`/`daysAgoLocal` к `getFullYear`/`getDate`/`setDate`
 * проходил их зелёными. Node перечитывает `TZ` при присваивании, поэтому гард
 * флипает зону процесса САМ — на календаре процесса такие тесты теперь падают.
 */
async function вЗонеПроцесса<T>(tz: string, fn: () => T | Promise<T>): Promise<T> {
  const было = process.env.TZ;
  process.env.TZ = tz;
  try {
    return await fn();
  } finally {
    if (было === undefined) delete process.env.TZ;
    else process.env.TZ = было;
  }
}

describe("Продажи: подготовка строк из mydon-stock", () => {
  const map = new Map([["72ac181f0000", "ent-1"]]);

  it("серийник узнан → строка привязана к автомату реестра", () => {
    const rows: StockSaleRow[] = [
      { dt: "2026-07-28", machine_serial: "72AC181F0000", ourvend_name: "Americano", qty: 3, amount: 60000, fetched_at: "2026-07-29T07:50:03+05:00" },
    ];
    const [v] = buildUpserts(rows, map).values;
    assert.equal(v.machineId, "ent-1", "регистр серийника не должен мешать сопоставлению");
    assert.equal(v.machineSerial, "72ac181f0000");
    assert.equal(v.qty, "3");
    assert.equal(v.amount, "60000");
  });

  it("неизвестный серийник → строка сохраняется без привязки, не теряется", () => {
    const rows: StockSaleRow[] = [
      { dt: "2026-07-28", machine_serial: "C2508160376", ourvend_name: "Вода 330ml", qty: 1, amount: 3000, fetched_at: new Date() },
    ];
    const [v] = buildUpserts(rows, map).values;
    assert.equal(v.machineId, null);
    // Канон в КЛЮЧЕ записи: «C…» и голая форма не должны плодить двойников
    // при переключении источника (миграция 0064 привела историю).
    assert.equal(v.machineSerial, "2508160376");
  });

  it("обе формы серийника дают ОДИН ключ записи — двойников при cutover нет", () => {
    const rows: StockSaleRow[] = [
      { dt: "2026-07-28", machine_serial: "c2508160376", ourvend_name: "Вода", qty: 1, amount: 3000, fetched_at: new Date() },
      { dt: "2026-07-28", machine_serial: "2508160376", ourvend_name: "Вода", qty: 2, amount: 6000, fetched_at: new Date() },
    ];
    const { values } = buildUpserts(rows, map);
    assert.equal(values[0].machineSerial, values[1].machineSerial);
  });

  it("битые строки (пустой серийник или товар) отбрасываются", () => {
    const rows = [
      { dt: "2026-07-28", machine_serial: "", ourvend_name: "X", qty: 1, amount: 1, fetched_at: new Date() },
      { dt: "", machine_serial: "abc", ourvend_name: "X", qty: 1, amount: 1, fetched_at: new Date() },
    ] as StockSaleRow[];
    assert.equal(buildUpserts(rows, map).values.length, 0);
  });

  it("нечисловые qty/amount — в карантин, а не нулём в выручку", () => {
    const rows = [
      { dt: "2026-07-28", machine_serial: "72AC181F0000", ourvend_name: "Americano", qty: "н/д", amount: 60000, fetched_at: new Date() },
      { dt: "2026-07-28", machine_serial: "72AC181F0000", ourvend_name: "Latte", qty: 2, amount: "", fetched_at: new Date() },
      { dt: "2026-07-28", machine_serial: "72AC181F0000", ourvend_name: "Tea", qty: 1, amount: 5000, fetched_at: new Date() },
    ] as StockSaleRow[];
    const { values, quarantined } = buildUpserts(rows, map);
    assert.equal(values.length, 1, "проходит только строка с обоими числами");
    assert.equal(values[0].product, "Tea");
    assert.equal(quarantined.length, 2);
    assert.equal(quarantined[0].field, "qty");
    assert.equal(quarantined[1].field, "amount");
  });

  it("ноль — законное число, не карантин", () => {
    const rows = [
      { dt: "2026-07-28", machine_serial: "72AC181F0000", ourvend_name: "Free", qty: 0, amount: 0, fetched_at: new Date() },
    ] as StockSaleRow[];
    const { values, quarantined } = buildUpserts(rows, map);
    assert.equal(values.length, 1);
    assert.equal(values[0].qty, "0");
    assert.equal(quarantined.length, 0);
  });

  it("todayLocal отдаёт дату YYYY-MM-DD по ТАШКЕНТСКИМ суткам, а не по часам процесса", async () => {
    // 20:30 UTC — это 01:30 УЖЕ следующих суток в Ташкенте: прежний
    // `getDate()` отдавал здесь 29 июля, то есть витрина продаж до 05:00
    // показывала вчерашний день как сегодняшний. Зону UTC тест выставляет
    // САМ (`вЗонеПроцесса`): полагаться на `TZ` запуска нельзя — импорт
    // `config.ts` уже перепинил процесс на Ташкент.
    await вЗонеПроцесса("UTC", () => {
      assert.equal(todayLocal(new Date("2026-07-29T20:30:00.000Z")), "2026-07-30");
      // И наоборот: 23:59 ташкентских — ещё те же сутки, границу не перескочили.
      assert.equal(todayLocal(new Date("2026-07-29T23:59:00.000+05:00")), "2026-07-29");
    });
  });

  it("daysAgoLocal(30) от 03.08 — это 05.07, ровно 30 календарных дат 05.07–03.08 (найдено внешним аудитом, P2)", () => {
    const now = new Date("2026-08-03T00:30:00.000+05:00"); // 3 августа, ночь в Ташкенте
    assert.equal(daysAgoLocal(30, now), "2026-07-05");
    // Проверка счётом: 03.08 − 05.07 включительно с обеих сторон = 30 дат.
    const from = Date.parse("2026-07-05T00:00:00.000+05:00");
    const to = Date.parse("2026-08-03T00:00:00.000+05:00");
    assert.equal(Math.round((to - from) / 86_400_000) + 1, 30);
  });

  it("daysAgoLocal(7) от 03.08 — это 28.07, не 27.07 (старая граница today−N давала 8 дат вместо 7)", () => {
    const now = new Date("2026-08-03T00:30:00.000+05:00");
    assert.equal(daysAgoLocal(7, now), "2026-07-28");
  });

  it("daysAgoLocal(1) — граница «сегодня» (N=1 значит только сегодняшняя дата)", () => {
    const now = new Date("2026-08-03T00:30:00.000+05:00");
    assert.equal(daysAgoLocal(1, now), todayLocal(now));
    assert.equal(daysAgoLocal(1, now), "2026-08-03");
  });

  it("окно отсчитывается от НАЧАЛА ташкентских суток: 01:30 ночи не сдвигает границу", async () => {
    // Прежний `setDate` сдвигал КАЛЕНДАРЬ ПРОЦЕССА: при `TZ=UTC` этот момент
    // был ещё 2 августа, и «30 дней» уезжали на 04.07 — на дату раньше.
    // Зона UTC — самим тестом: без флипа возврат к `setDate` зеленел бы на
    // Ташкенте, закреплённом `config.ts` при импорте.
    await вЗонеПроцесса("UTC", () => {
      assert.equal(daysAgoLocal(30, new Date("2026-08-02T20:30:00.000Z")), "2026-07-05");
      // Полдень тех же суток обязан дать ТУ ЖЕ границу — окно считается сутками,
      // а не «минус 29 × 24 часа от момента».
      assert.equal(daysAgoLocal(30, new Date("2026-08-03T12:00:00.000+05:00")), "2026-07-05");
    });
  });
});

// ── Алиасы имён продаж (склейка «имя источника → карточка») ──────────────────

import { SalesService } from "./sales.service";

type Row = Record<string, unknown>;

interface AliasStubOpts {
  /** Очередь ответов select по порядку вызовов. */
  selects?: Row[][];
  /** true — уникальный индекс имени отсёк вставку: алиас уже существует. */
  insertConflict?: boolean;
  inserted?: Row[];
}

/** Заглушка БД под цепочки addAlias/removeAlias — по образцу tasks.test.ts. */
function aliasStubDb(opts: AliasStubOpts) {
  const queue = [...(opts.selects ?? [])];
  const selectChain = () => {
    let memo: Row[] | null = null;
    const rows = async () => (memo ??= queue.shift() ?? []);
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.leftJoin = () => chain;
    chain.groupBy = () => chain;
    chain.orderBy = () => chain;
    chain.limit = rows;
    chain.then = (res: (v: unknown) => unknown) => rows().then(res);
    return chain;
  };
  const tx = {
    select: selectChain,
    insert: () => ({
      values: (v: Row) => {
        const row = { id: "al-1", ...v };
        opts.inserted?.push(row);
        const returning = async () => (opts.insertConflict ? [] : [row]);
        return {
          onConflictDoNothing: () => ({ returning }),
          returning,
          then: (res: (x: unknown) => unknown) => Promise.resolve([row]).then(res),
        };
      },
    }),
    delete: () => ({ where: async () => [] }),
  };
  return {
    select: selectChain,
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
}

const CARD = "66666666-6666-4666-8666-666666666666";

describe("Алиасы имён продаж", () => {
  it("привязка пишет алиас и след в аудите", async () => {
    const inserted: Row[] = [];
    // очередь: карточка найдена (product) → тени-карточки с таким именем нет.
    const s = new SalesService(aliasStubDb({
      selects: [[{ id: CARD, type: "product" }], []],
      inserted,
    }));
    const r = await s.addAlias("Moxito Fresh Lime CAN 450ml", CARD);
    assert.equal(r.name, "Moxito Fresh Lime CAN 450ml");
    assert.ok(inserted.some((x) => x.action === "sales.alias_added"));
  });

  it("имя, совпадающее с другой карточкой, не принимается — продажа засчиталась бы дважды", async () => {
    const s = new SalesService(aliasStubDb({
      selects: [[{ id: CARD, type: "product" }], [{ id: "другая" }]],
    }));
    await assert.rejects(() => s.addAlias("Plus 18 Energy 330ml", CARD), /дважды/);
  });

  it("занятый алиас не перепривязывается молча", async () => {
    const s = new SalesService(aliasStubDb({
      selects: [[{ id: CARD, type: "product" }], [], [{ id: "al-9", entityId: "чужая", name: "X" }]],
      insertConflict: true,
    }));
    await assert.rejects(() => s.addAlias("X", CARD), /другой карточке/);
  });

  it("повторная привязка того же имени к той же карточке — идемпотентна", async () => {
    const s = new SalesService(aliasStubDb({
      selects: [[{ id: CARD, type: "product" }], [], [{ id: "al-9", entityId: CARD, name: "X" }]],
      insertConflict: true,
    }));
    const r = await s.addAlias("X", CARD);
    assert.equal(r.id, "al-9");
  });

  it("алиас к не-товару и пустое имя — отказ", async () => {
    const s1 = new SalesService(aliasStubDb({ selects: [[{ id: CARD, type: "machine" }]] }));
    await assert.rejects(() => s1.addAlias("X", CARD), /только к товарам/);
    const s2 = new SalesService(aliasStubDb({}));
    await assert.rejects(() => s2.addAlias("   ", CARD), /Пустое имя/);
  });
});

// ── Мягкая деградация без STOCK_DATABASE_URL (R-P8b-6) ───────────────────────

import { createRequire } from "node:module";
import { entity, ourvendSaleSnapshot, ourvendStockSnapshot, sale } from "@mydon/db";
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { resetAccountingSourceCache } from "./accounting-source";

/**
 * Счётчик открытий чужой базы.
 *
 * Подменяет экспорт модуля `postgres` в кеше `require` — того самого, который
 * `sales.service` берёт ленивым `await import("postgres")`. Иначе утверждение
 * «донор не открывается вовсе» проверялось бы только тем, что синк вернул
 * строки: код, открывший соединение и НЕ воспользовавшийся им, прошёл бы такой
 * тест зелёным, а на проде после гашения переменной висел бы на
 * `connect_timeout` каждые десять минут.
 */
function счётчикДонора(): { открытий: () => number; restore: () => void } {
  const req = createRequire(__filename);
  const id = req.resolve("postgres");
  req("postgres"); // прогреваем кеш, чтобы подменять запись настоящего модуля
  const запись = req.cache[id]!;
  const было = запись.exports;
  let открытий = 0;
  запись.exports = (...args: unknown[]) => {
    открытий += 1;
    throw new Error(`донора открывать нельзя: postgres(${String(args[0])})`);
  };
  return {
    открытий: () => открытий,
    restore: () => {
      запись.exports = было;
    },
  };
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

interface МирПродаж {
  снапшот?: StockSaleRow[];
  /** Момент последнего съёма снапшота ПРОДАЖ — для `configured` (R-P8b-5). */
  снапшотAt?: Date | null;
  /** Момент последнего съёма снапшота ОСТАТКОВ. Не задан — тот же, что у продаж. */
  остаткиAt?: Date | null;
  автоматы?: { id: string; ref: string | null }[];
}

/** Стенд синка продаж: своя БД — заглушка, донора нет вовсе. */
function стендПродаж(м: МирПродаж) {
  const снапшот = м.снапшот ?? [];
  const автоматы = м.автоматы ?? [];
  const снимки = м.снапшотAt ? [{ at: м.снапшотAt }] : [];
  // Снимки ОСТАТКОВ — по умолчанию ровесники продаж: обе половины приезжают
  // одним прогоном агента, и `configured` в режиме `own` смотрит на ОБЕ
  // (R-FW-P2). Задавать отдельно нужно там, где половины разъехались.
  const снимкиОстатков = м.остаткиAt === undefined ? снимки : м.остаткиAt ? [{ at: м.остаткиAt }] : [];
  const счёт = { вставокПродаж: 0, событий: 0 };

  const цепочка = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.groupBy = () => chain;
    chain.limit = async (n: number) => rows.slice(0, n);
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res);
    return chain;
  };

  const db = {
    select: () => ({
      from: (t: unknown) => {
        if (t === sale) return цепочка([{ n: 0, tQty: "0", tAmt: "0", yQty: "0", yAmt: "0", mQty: "0", mAmt: "0", last: null }]);
        if (t === ourvendSaleSnapshot) return цепочка(снапшот.length > 0 ? снапшот : снимки);
        if (t === ourvendStockSnapshot) return цепочка(снимкиОстатков);
        if (t === entity) return цепочка(автоматы);
        return цепочка([]); // systemConfig и всё прочее
      },
    }),
    insert: (t: unknown) => ({
      values: (v: unknown) => {
        if (t === sale) счёт.вставокПродаж += Array.isArray(v) ? v.length : 1;
        else счёт.событий += 1;
        const ok = Promise.resolve([]);
        return { onConflictDoUpdate: () => ok, onConflictDoNothing: () => ok, then: ok.then.bind(ok) };
      },
    }),
    execute: async () => ({ count: 0 }),
  } as never;

  return { svc: new SalesService(db), счёт };
}

const СТРОКА: StockSaleRow = {
  dt: "2026-08-25",
  machine_serial: "2508160376",
  ourvend_name: "TUC Sour cream",
  qty: 3,
  amount: 45_000,
  fetched_at: new Date("2026-08-25T03:05:00Z"),
};

describe("Синк продаж без STOCK_DATABASE_URL деградирует молча и без исключений (R-P8b-6)", () => {
  it("источник — свой снапшот, чужая база не открывается вовсе", async () => {
    await сОкружением({ STOCK_DATABASE_URL: undefined }, async () => {
      const донор = счётчикДонора();
      try {
        const { svc, счёт } = стендПродаж({ снапшот: [СТРОКА] });
        assert.equal((await svc.sync()).upserted, 1);
        assert.equal(донор.открытий(), 0, "после гашения переменной к донору ходить не за чем");
        assert.equal(счёт.событий, 1, "событие синка при этом пишется как обычно");
      } finally {
        донор.restore();
      }
    });
  });

  it("зеркало ещё живо, но источник own — донора всё равно не трогаем", async () => {
    // Порядок рунбука: сперва флип на own, и только через три зелёных дня
    // гашение переменной. В это окно код обязан читать СВОЙ снапшот, а не
    // ходить в чужую базу «за компанию».
    await сОкружением(
      { STOCK_DATABASE_URL: "postgres://ro@stock/mydon", OURVEND_ACCOUNTING_SOURCE: "own" },
      async () => {
        const донор = счётчикДонора();
        try {
          const { svc } = стендПродаж({ снапшот: [СТРОКА] });
          assert.equal((await svc.sync()).upserted, 1);
          assert.equal(донор.открытий(), 0);
        } finally {
          донор.restore();
        }
      },
    );
  });

  it("снапшот пуст — ноль строк, ни события, ни исключения", async () => {
    await сОкружением({ STOCK_DATABASE_URL: undefined }, async () => {
      const { svc, счёт } = стендПродаж({ снапшот: [] });
      assert.deepEqual(await svc.sync(), { upserted: 0 });
      assert.equal(счёт.событий, 0);
    });
  });
});

describe("Старт синка продаж не может уронить Core (final-review M1)", () => {
  it("база недоступна на старте — хук РЕЗОЛВИТСЯ, крон зарегистрирован", async () => {
    // `onModuleInit` читал источник учёта ради ОДНОЙ строки лога. Отклонённый
    // хук прерывает bootstrap Nest целиком: не стартует ничего — ни
    // `/ourvend/health`, ни бот, ни кроны. `DATABASE_URL` может смотреть на
    // внешний Postgres, где `depends_on: service_healthy` из compose не
    // работает вовсе, так что сценарий не теоретический.
    const мёртваяБаза = {
      select: () => ({
        from: () => {
          throw new Error("база не поднялась");
        },
      }),
    } as never;
    const svc = new SalesService(мёртваяБаза);
    await svc.onModuleInit();
    try {
      assert.notEqual(
        (svc as unknown as { cron: unknown }).cron,
        null,
        "крон обязан регистрироваться безусловно: без него синк не побежит НИКОГДА",
      );
    } finally {
      svc.onApplicationShutdown();
    }
  });
});

describe("«Источник настроен» — это «источник ЧИТАЕМ» (R-P8b-5/6)", () => {
  /**
   * Плитка продаж рисует «появится после сбора» по `configured`. Пока флаг
   * читался как «own ИЛИ есть переменная», он был тождественно истинным: в
   * режиме `own` он всегда true, а `stock` без переменной невозможен по
   * определению (`resolveAccountingSource`). То есть витрина обещала
   * «настроено» и в тот день, когда агент снапшота лежал третьи сутки и учёт
   * стоял молча — ровно тот случай, ради которого флаг и заведён.
   */
  const сейчас = new Date("2026-09-05T13:00:00+05:00");

  it("own и снапшот встал (37 ч при пороге 36) — НЕ настроено", async () => {
    await сОкружением({ STOCK_DATABASE_URL: undefined }, async () => {
      const { svc } = стендПродаж({ снапшотAt: new Date("2026-09-03T19:00:00Z") });
      assert.equal((await svc.summary(сейчас)).configured, false);
    });
  });

  it("own и снапшот свежий — настроено", async () => {
    await сОкружением({ STOCK_DATABASE_URL: undefined }, async () => {
      const { svc } = стендПродаж({ снапшотAt: new Date("2026-09-05T03:05:00Z") });
      assert.equal((await svc.summary(сейчас)).configured, true);
    });
  });

  it("own и снапшота нет вовсе — НЕ настроено, а не «настроено, но пусто»", async () => {
    await сОкружением({ STOCK_DATABASE_URL: undefined }, async () => {
      const { svc } = стендПродаж({ снапшотAt: null });
      assert.equal((await svc.summary(сейчас)).configured, false);
    });
  });

  it("own, продажи свежие, ОСТАТКИ встали — НАСТРОЕНО: у флага ПРОДАЖ своя половина", async () => {
    // Упала Lot-сессия: `machine_stock` заморожен, а часы продаж свежие.
    //
    // Флаг читают ТРИ витрины, и все три объясняют его словами про ПРОДАЖИ:
    // чип карточки «Журнал продаж» → «снапшот не пришёл», пустой журнал →
    // «снапшота за сутки нет», бот — тем же текстом. Погасить их из-за
    // вставших ОСТАТКОВ значит сказать владельцу неправду о продажах, которые
    // в этот момент едут: у пустого журнала и бота эффект приглушён ветвью
    // `lastSaleDt === null`, у чипа панели — нет вовсе.
    //
    // Вставшую половину остатков ловят те, кому она и адресована и кто умеет
    // назвать таблицу словами: сторож (`SyncStaleService.checkSnapshot`) и
    // `OurvendHealth.snapshotStale` — оба по-прежнему по ОБЕИМ половинам.
    await сОкружением({ STOCK_DATABASE_URL: undefined }, async () => {
      const { svc } = стендПродаж({
        снапшотAt: new Date("2026-09-05T03:05:00Z"),
        остаткиAt: new Date("2026-09-03T19:00:00Z"),
      });
      assert.equal((await svc.summary(сейчас)).configured, true);
    });
  });

  it("own, остатки свежие, ПРОДАЖИ встали — НЕ настроено", async () => {
    // Обратная половина той же монеты: молчит ровно та таблица, про которую
    // витрина и говорит, — флаг обязан погаснуть.
    await сОкружением({ STOCK_DATABASE_URL: undefined }, async () => {
      const { svc } = стендПродаж({
        снапшотAt: new Date("2026-09-03T19:00:00Z"),
        остаткиAt: new Date("2026-09-05T03:05:00Z"),
      });
      assert.equal((await svc.summary(сейчас)).configured, false);
    });
  });

  it("сводка называет ДЕЙСТВУЮЩИЙ источник — витрине иначе нечем выбрать текст", async () => {
    // `configured: false` означает разное: в `stock` — «нет переменной», в
    // `own` — «снапшот не обновляется». Без этого поля витрина предлагала бы
    // владельцу настроить переменную, которую шаг 3 рунбука удаляет.
    await сОкружением({ STOCK_DATABASE_URL: undefined }, async () => {
      const { svc } = стендПродаж({ снапшотAt: new Date("2026-09-05T03:05:00Z") });
      assert.equal((await svc.summary(сейчас)).source, "own");
    });
    await сОкружением(
      { STOCK_DATABASE_URL: "postgres://ro@stock/mydon", OURVEND_ACCOUNTING_SOURCE: "stock" },
      async () => {
        const { svc } = стендПродаж({ снапшотAt: null });
        assert.equal((await svc.summary(сейчас)).source, "stock");
      },
    );
  });

  it("stock и переменная есть — настроено, свежесть теневого снапшота ни при чём", async () => {
    await сОкружением(
      { STOCK_DATABASE_URL: "postgres://ro@stock/mydon", OURVEND_ACCOUNTING_SOURCE: "stock" },
      async () => {
        const { svc } = стендПродаж({ снапшотAt: new Date("2026-01-01T00:00:00Z") });
        assert.equal((await svc.summary(сейчас)).configured, true);
      },
    );
  });
});

// ── Сутки витрин — ташкентские, а не часы процесса ───────────────────────────

import { tashkentDay, tashkentDayStartOf } from "@mydon/shared";

const ДИАЛЕКТ = new PgDialect();

/**
 * Стенд витрин, запоминающий ПАРАМЕТРЫ отрендеренных условий.
 *
 * Даты витрин в ответе не видны (`summary` отдаёт суммы, `daily` — строки БД),
 * поэтому «какие сутки спросили» проверяется единственным честным способом —
 * по параметрам запроса.
 */
function стендВитрин() {
  const params: unknown[] = [];
  // Условия рендерятся настоящим `PgDialect` (приём из
  // `retention.service.test.ts`): проверяем, ЧТО уехало в запрос, а не то, что
  // заглушка сумела вычитать из внутренностей drizzle. Колонки (`sale.dt` в
  // списке полей) параметров не несут и отличаются от выражений наличием
  // `queryChunks`.
  const запомнить = (в: unknown): void => {
    if (в !== null && typeof в === "object" && "queryChunks" in в) {
      params.push(...ДИАЛЕКТ.sqlToQuery(в as SQL).params);
    }
  };
  const цепочка = (rows: unknown[]) => {
    const chain: Record<string, unknown> = {};
    chain.where = (в: unknown) => (запомнить(в), chain);
    chain.having = (в: unknown) => (запомнить(в), chain);
    chain.leftJoin = () => chain;
    chain.groupBy = () => chain;
    chain.orderBy = () => chain;
    chain.limit = async () => rows;
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res);
    return chain;
  };
  const сводка = { tQty: "0", tAmt: "0", yQty: "0", yAmt: "0", mQty: "0", mAmt: "0", last: null };
  const db = {
    select: (поля?: Record<string, unknown>) => ({
      from: (t: unknown) => {
        for (const в of Object.values(поля ?? {})) запомнить(в);
        return цепочка(t === sale ? [сводка] : []);
      },
    }),
  } as never;
  return { svc: new SalesService(db), params };
}

describe("Сутки витрин продаж — ташкентские, когда процесс ЖИВЁТ в UTC (зону флипает тест)", () => {
  it("summary спрашивает ташкентские сегодня/вчера/−30, а не сутки процесса", async () => {
    // 20:30 UTC — это 01:30 УЖЕ 26 августа в Ташкенте: прежний `getDate()`
    // спрашивал у базы 25-е как «сегодня» — плитка «сегодня» до 05:00
    // показывала вчерашнюю выручку, «вчера» — позавчерашнюю. Зона UTC не из
    // окружения запуска (его перепинивает `config.ts` при импорте), а
    // выставлена самим тестом — на календаре процесса эти параметры стали бы
    // 25/24/27, и assert упал бы.
    const сейчас = new Date("2026-08-25T20:30:00.000Z");
    await вЗонеПроцесса("UTC", () =>
      сОкружением(
        { STOCK_DATABASE_URL: "postgres://ro@stock/mydon", OURVEND_ACCOUNTING_SOURCE: "stock" },
        async () => {
          const { svc, params } = стендВитрин();
          await svc.summary(сейчас);
          assert.deepEqual(
            [...new Set(params)],
            ["2026-08-26", "2026-08-25", "2026-07-28"],
            "сегодня, вчера и граница 30 дат — ташкентскими сутками",
          );
        },
      ),
    );
  });

  it("daily берёт границу от НАЧАЛА ташкентских суток момента", async () => {
    // Ожидание считается независимо — теми же общими функциями зоны, что и
    // остальные суточные отчёты; своей копии смещения в тесте нет.
    const ожидание = tashkentDay(new Date(tashkentDayStartOf(new Date()).getTime() - 29 * 86_400_000));
    await вЗонеПроцесса("UTC", async () => {
      const { svc, params } = стендВитрин();
      await svc.daily(30);
      assert.deepEqual(params, [ожидание], "одна граница окна — ташкентская дата today−29");
    });
  });
});
