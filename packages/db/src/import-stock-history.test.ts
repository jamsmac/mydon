import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatReport, ImportWriteFailure, importStockHistory, type DonorReader } from "./import-stock-history";
import type { Database } from "./index";

/**
 * Текст SQL-выражения drizzle — та же рекурсивная техника, что в
 * `backfill-product-ids.test.ts`: предикат частичного индекса лежит вложенным
 * чанком, и плоская версия его бы не нашла.
 */
function текстSQL(x: unknown): string {
  if (x && typeof x === "object") {
    const chunks = (x as { queryChunks?: unknown[] }).queryChunks;
    if (Array.isArray(chunks)) return chunks.map(текстSQL).join("");
    const v = (x as { value?: unknown }).value;
    if (Array.isArray(v)) return v.join("");
    const name = (x as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  return "";
}

/** Цель конфликта — списком имён колонок, как её увидит Postgres. */
function целиКонфликта(target: unknown): string[] {
  const cols = Array.isArray(target) ? target : [target];
  return cols.map((c) => (c as { name?: string }).name ?? "");
}

interface Состояние {
  /** Сколько отметок `stock.history.imported` уже в журнале. */
  отметок?: number;
  /** Сколько строк импорта уже лежит в базе (заливы). */
  строкИмпорта?: number;
  /** Имя таблицы, вставка в которую обязана упасть. */
  падать?: string;
}

/** Минимальная заглушка drizzle: select отдаёт заготовку по имени таблицы, insert копит строки. */
function стенд(
  donorRows: Partial<Record<"refills" | "stockCounts" | "purchases", unknown[]>>,
  уже: { clientKeys: string[]; extIds: string[] },
  состояние: Состояние = {},
) {
  const вставлено: Record<string, unknown[]> = { vending_refill: [], vending_stock_count: [], purchase: [], event: [] };
  /** Аргумент `onConflictDoNothing` по таблицам: цель конфликта — часть контракта. */
  const конфликты: Record<string, { target: string[]; where: string }> = {};
  const имя = (t: unknown): string => (t as { [k: symbol]: string })[Symbol.for("drizzle:Name")] ?? "";
  const заготовки: Record<string, unknown[]> = {
    vending_product: [{ id: "p-tuc", name: "TUC Sour cream" }],
    vending_alias: [],
    entity: [{ id: "e-olma", externalRef: "c2508160376" }],
    purchase: [{ extId: "1", dt: "2025-08-18", product: "Pepsi 0,5", qty: "24", unitPrice: "0" }],
    // Счётчики для решения «ставить ли отметку импорта» (R-P8a-5): их читают
    // ТОЛЬКО когда прогон не записал ни строки.
    event: [{ n: состояние.отметок ?? 0 }],
    vending_refill: [{ n: состояние.строкИмпорта ?? 0 }],
    vending_stock_count: [{ n: 0 }],
  };
  const db = {
    select: () => ({
      from: (t: unknown) =>
        Object.assign(Promise.resolve(заготовки[имя(t)] ?? []), { where: () => Promise.resolve(заготовки[имя(t)] ?? []) }),
    }),
    insert: (t: unknown) => ({
      values: (rows: unknown[]) => {
        const принять = (): Promise<unknown[]> => {
          if (состояние.падать === имя(t)) return Promise.reject(new Error(`база отказала на ${имя(t)}`));
          // Повтор ловится ровно так же, как в Postgres: по уникальному ключу.
          const новые = rows.filter((r) => {
            const x = r as { clientKey?: string; extId?: string };
            return !(x.clientKey && уже.clientKeys.includes(x.clientKey)) && !(x.extId && уже.extIds.includes(x.extId));
          });
          вставлено[имя(t)]!.push(...новые);
          return Promise.resolve(новые);
        };
        const цепь = {
          onConflictDoNothing: (cfg?: { target?: unknown; where?: unknown }) => {
            конфликты[имя(t)] = { target: целиКонфликта(cfg?.target), where: текстSQL(cfg?.where) };
            return { returning: принять };
          },
          returning: принять,
          then: (f: (v: unknown) => unknown, r?: (e: unknown) => unknown) => принять().then(f, r),
        };
        return цепь;
      },
    }),
  } as unknown as Database;
  const donor: DonorReader = {
    refills: async () => (donorRows.refills ?? []) as never,
    stockCounts: async () => (donorRows.stockCounts ?? []) as never,
    purchases: async () => (donorRows.purchases ?? []) as never,
  };
  return { db, donor, вставлено, конфликты };
}

const ЗАЛИВ = { id: 412, dt: "2026-04-22", machine_serial: "C2508160376", product: "TUC Sour cream", qty: "6" };
const ОБЩИЙ = { id: 413, dt: "2026-04-22", machine_serial: null, product: "TUC Sour cream", qty: "9" };
const ПЕРЕСЧЁТ = { id: 77, dt: "2026-07-14", product: "TUC Sour cream", qty: "24", counted_at: null };
const СЛУЖЕБНАЯ = { id: 78, dt: "2026-07-14", product: "Недостача (Рустам)", qty: "1", counted_at: null };

describe("Импорт истории склада (R-P8a-8)", () => {
  it("--dry-run считает всё и не пишет ничего", async () => {
    const { db, donor, вставлено } = стенд(
      { refills: [ЗАЛИВ, ОБЩИЙ], stockCounts: [ПЕРЕСЧЁТ, СЛУЖЕБНАЯ], purchases: [] },
      { clientKeys: [], extIds: [] },
    );
    const r = await importStockHistory(db, donor, { apply: false });
    assert.deepEqual([r.refills.found, r.refills.written, r.refills.noSerial], [2, 0, 1]);
    assert.deepEqual([r.stockCounts.found, r.stockCounts.written, r.stockCounts.serviceRows], [2, 0, 1]);
    assert.deepEqual(Object.values(вставлено).map((v) => v.length), [0, 0, 0, 0]);
  });

  it("примерка называет, ЧТО запишет --apply, а не только что нашла", async () => {
    // Без «к записи» число 107 приходится вычитать в уме (455−348), а
    // дописываемые закупки не видны вовсе: примерка честно покажет «+0»,
    // а --apply молча допишет строки. Это отчёт, по которому решают писать в прод.
    const { db, donor } = стенд(
      { refills: [ЗАЛИВ, ОБЩИЙ], stockCounts: [ПЕРЕСЧЁТ, СЛУЖЕБНАЯ], purchases: [{ id: 9, dt: "2026-07-13", product: "M&amp;Ms", qty: "6", unit_price: "8000" }] },
      { clientKeys: [], extIds: [] },
    );
    const r = await importStockHistory(db, donor, { apply: false });
    assert.deepEqual([r.refills.toWrite, r.stockCounts.toWrite, r.purchases.toWrite], [1, 1, 1]);
    assert.deepEqual([r.refills.written, r.stockCounts.written, r.purchases.added], [0, 0, 0]);
  });

  it("--apply пишет только импортируемое и оставляет одну отметку в журнале", async () => {
    const { db, donor, вставлено } = стенд(
      { refills: [ЗАЛИВ, ОБЩИЙ], stockCounts: [ПЕРЕСЧЁТ, СЛУЖЕБНАЯ], purchases: [] },
      { clientKeys: [], extIds: [] },
    );
    const r = await importStockHistory(db, donor, { apply: true });
    assert.deepEqual([r.refills.written, r.stockCounts.written], [1, 1]);
    assert.equal(вставлено.vending_refill!.length, 1);
    const отметка = вставлено.event![0] as { type: string; source: string; payload: Record<string, unknown> };
    assert.equal(отметка.type, "stock.history.imported");
    // Отметка — единственный след импорта в БД (R-P8a-5): если её payload
    // разойдётся с отчётом, восстановить числа переноса будет уже нечем.
    assert.deepEqual(отметка.payload, {
      refills: 1,
      stockCounts: 1,
      purchasesAdded: 0,
      unresolved: [],
      skippedNoSerial: 1,
      skippedService: 1,
    });
    assert.equal(отметка.source, "stock-import");
  });

  it("цель ON CONFLICT — ровно те уникальные ключи, что стоят в схеме", async () => {
    // Заглушка SQL не исполняет: если цель конфликта разойдётся со схемой,
    // юнит-тесты этого не заметят вовсе, а Postgres ответит «no unique or
    // exclusion constraint matching the ON CONFLICT specification» — на проде.
    const { db, donor, конфликты } = стенд(
      { refills: [ЗАЛИВ], stockCounts: [ПЕРЕСЧЁТ], purchases: [{ id: 3, dt: "2026-07-13", product: "M&amp;Ms", qty: "6", unit_price: "8000" }] },
      { clientKeys: [], extIds: [] },
    );
    await importStockHistory(db, donor, { apply: true });
    assert.deepEqual(конфликты.vending_refill, { target: ["client_key"], where: "" });
    assert.deepEqual(конфликты.vending_stock_count, { target: ["source", "ext_id"], where: "ext_id is not null" });
    assert.deepEqual(конфликты.purchase, { target: ["source", "ext_id"], where: "" });
  });

  it("повторный --apply: 0 новых, событие не врёт числом входа", async () => {
    const { db, donor, вставлено } = стенд(
      { refills: [ЗАЛИВ], stockCounts: [ПЕРЕСЧЁТ] },
      { clientKeys: ["stock:refill:412"], extIds: ["77"] },
      { отметок: 1, строкИмпорта: 1 },
    );
    const r = await importStockHistory(db, donor, { apply: true });
    assert.deepEqual([r.refills.found, r.refills.written, r.stockCounts.written], [1, 0, 0]);
    // «к записи 1 / записано 0» — единственный способ отличить «нечего писать»
    // от «не сумел записать».
    assert.deepEqual([r.refills.toWrite, r.stockCounts.toWrite], [1, 1]);
    // Отметка ставится на ФАКТ переноса, а не на факт запуска: R-P8a-5 знает
    // ровно одно событие. Второй прогон вторую отметку не ставит.
    assert.equal(вставлено.event!.length, 0);
  });

  it("отметка не теряется навсегда, если процесс умер между записью и событием", async () => {
    // Строки импорта в базе есть, отметки нет — и «записал → ставим отметку»
    // не сработает уже НИКОГДА: каждый следующий прогон пишет ноль. Проверка
    // выкатки `count(*) … = 1` стала бы невыполнимой без ручного INSERT.
    const { db, donor, вставлено } = стенд(
      { refills: [ЗАЛИВ] },
      { clientKeys: ["stock:refill:412"], extIds: [] },
      { отметок: 0, строкИмпорта: 107 },
    );
    const r = await importStockHistory(db, donor, { apply: true });
    assert.equal(r.refills.written, 0);
    assert.equal(вставлено.event!.length, 1, "след импорта восстановлен");
  });

  it("отметка не задваивается: она уже есть — второй раз не пишем", async () => {
    const { db, donor, вставлено } = стенд(
      { refills: [ЗАЛИВ] },
      { clientKeys: ["stock:refill:412"], extIds: [] },
      { отметок: 1, строкИмпорта: 107 },
    );
    await importStockHistory(db, donor, { apply: true });
    assert.equal(вставлено.event!.length, 0);
  });

  it("обрыв записи не съедает отчёт: видно, сколько успело лечь", async () => {
    const { db, donor } = стенд(
      { refills: [ЗАЛИВ], stockCounts: [ПЕРЕСЧЁТ] },
      { clientKeys: [], extIds: [] },
      { падать: "vending_stock_count" },
    );
    const err = await importStockHistory(db, donor, { apply: true }).then(
      () => null,
      (e: unknown) => e,
    );
    assert.ok(err instanceof ImportWriteFailure, "падение записи несёт отчёт с собой");
    assert.deepEqual([err.report.refills.written, err.report.stockCounts.written], [1, 0]);
    assert.match(formatReport(err.report), /заливы → vending_refill/);
  });

  it("закупки: недостающая дописывается, расхождение только называется", async () => {
    const { db, donor, вставлено } = стенд(
      {
        purchases: [
          { id: 1, dt: "2025-08-18", product: "Pepsi 0,5", qty: "24", unit_price: "0" },
          { id: 3, dt: "2026-07-13", product: "M&amp;Ms", qty: "6", unit_price: "8000", unit: "шт", total: "48000", note: "импорт:закупки" },
        ],
      },
      { clientKeys: [], extIds: ["1"] },
    );
    const r = await importStockHistory(db, donor, { apply: true });
    assert.deepEqual([r.purchases.mine, r.purchases.donor, r.purchases.added], [1, 2, 1]);
    const строка = вставлено.purchase![0] as { product: string; unit: string | null; total: string | null; note: string | null };
    assert.equal(строка.product, "M&Ms");
    // Дописанная строка обязана быть неотличима от 342 соседей зеркала: те же
    // колонки из того же SELECT, что тянет синк снабжения, а `total` — из
    // GENERATED-колонки донора, а не посчитанный тут в плавающей точке.
    assert.deepEqual([строка.unit, строка.total, строка.note], ["шт", "48000", "импорт:закупки"]);
  });

  it("нерешённые имена названы поимённо — это список владельцу, а не ошибка выкатки", async () => {
    const { db, donor } = стенд({ refills: [{ ...ЗАЛИВ, product: "Moxito Mango CAN 0.45" }] }, { clientKeys: [], extIds: [] });
    const r = await importStockHistory(db, donor, { apply: false });
    assert.deepEqual(r.unresolved, ["Moxito Mango CAN 0.45"]);
  });

  it("дробный залив не ломает прогон на 300-й строке, а называется в отчёте", async () => {
    // `refills.qty` у донора — NUMERIC, а `vending_refill.qty` — INTEGER.
    // Незамеченная дробь уронила бы пачку целиком (`'6.5'::int4`), и разовый
    // шаг выкатки выглядел бы сломанным. Строка откладывается ПОИМЁННО.
    const { db, donor, вставлено } = стенд(
      { refills: [{ ...ЗАЛИВ, id: 500, qty: "6.5" }, ЗАЛИВ] },
      { clientKeys: [], extIds: [] },
    );
    const r = await importStockHistory(db, donor, { apply: true });
    assert.deepEqual([r.refills.found, r.refills.written], [2, 1]);
    assert.deepEqual(r.refills.fractionalQty, ["500"]);
    assert.equal(вставлено.vending_refill!.length, 1);
  });

  it("считаются ВСЕ причины отказа, а не только серийник и служебные строки", async () => {
    // Строка с мусорным qty или битой датой иначе уходит в «пропущено» без
    // объяснения, и расхождение приходится ловить арифметикой по прогону,
    // который бывает один раз.
    const { db, donor } = стенд(
      {
        refills: [{ ...ЗАЛИВ, id: 600, qty: "не число" }, ОБЩИЙ],
        stockCounts: [{ ...ПЕРЕСЧЁТ, id: 700, dt: "позавчера" }, СЛУЖЕБНАЯ],
      },
      { clientKeys: [], extIds: [] },
    );
    const r = await importStockHistory(db, donor, { apply: false });
    assert.deepEqual(r.refills.reasons, { bad_qty: ["600"], no_serial: ["413"] });
    assert.deepEqual(r.stockCounts.reasons, { no_date: ["700"], service_row: ["78"] });
    const текст = formatReport(r);
    assert.match(текст, /негодный qty 1/);
    assert.match(текст, /негодная дата 1/);
    assert.match(текст, /id 600/);
  });

  it("залив цепляется к карточке автомата по любой форме серийника", async () => {
    // Реестр хранит «c2508160376», донор пишет «C2508160376», канон — без «c».
    const { db, donor, вставлено } = стенд({ refills: [ЗАЛИВ] }, { clientKeys: [], extIds: [] });
    await importStockHistory(db, donor, { apply: true });
    const строка = вставлено.vending_refill![0] as { machineId: string | null; machineSerial: string; productId: string | null };
    assert.deepEqual(
      [строка.machineId, строка.machineSerial, строка.productId],
      ["e-olma", "2508160376", "p-tuc"],
      "серийник — канон, карточка найдена по обеим формам, товар — по прайсу",
    );
  });

  it("отчёт начинается режимом и заканчивается разборной строкой итогов", async () => {
    const { db, donor } = стенд({ refills: [ЗАЛИВ, ОБЩИЙ], stockCounts: [ПЕРЕСЧЁТ] }, { clientKeys: [], extIds: [] });
    const текст = formatReport(await importStockHistory(db, donor, { apply: false }));
    const строки = текст.split("\n");
    assert.match(строки[0]!, /--dry-run/, "режим — первой строкой, до всяких чисел");
    const итоги = строки.at(-1)!;
    assert.match(итоги, /^ИТОГИ\(json\): /);
    assert.deepEqual(JSON.parse(итоги.slice("ИТОГИ(json): ".length)), {
      apply: false,
      refills: 0,
      stockCounts: 0,
      purchasesAdded: 0,
      toWrite: { refills: 1, stockCounts: 1, purchasesAdded: 0 },
      unresolved: 0,
    });
  });
});
