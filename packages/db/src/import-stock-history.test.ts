import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatReport, importStockHistory, type DonorReader } from "./import-stock-history";
import type { Database } from "./index";

/** Минимальная заглушка drizzle: select отдаёт заготовку по имени таблицы, insert копит строки. */
function стенд(
  donorRows: Partial<Record<"refills" | "stockCounts" | "purchases", unknown[]>>,
  уже: { clientKeys: string[]; extIds: string[] },
) {
  const вставлено: Record<string, unknown[]> = { vending_refill: [], vending_stock_count: [], purchase: [], event: [] };
  const имя = (t: unknown): string => (t as { [k: symbol]: string })[Symbol.for("drizzle:Name")] ?? "";
  const заготовки: Record<string, unknown[]> = {
    vending_product: [{ id: "p-tuc", name: "TUC Sour cream" }],
    vending_alias: [],
    entity: [{ id: "e-olma", externalRef: "c2508160376" }],
    purchase: [{ extId: "1", dt: "2025-08-18", product: "Pepsi 0,5", qty: "24", unitPrice: "0" }],
  };
  const db = {
    select: () => ({
      from: (t: unknown) =>
        Object.assign(Promise.resolve(заготовки[имя(t)] ?? []), { where: () => Promise.resolve(заготовки[имя(t)] ?? []) }),
    }),
    insert: (t: unknown) => ({
      values: (rows: unknown[]) => {
        const принять = (): Promise<unknown[]> => {
          // Повтор ловится ровно так же, как в Postgres: по уникальному ключу.
          const новые = rows.filter((r) => {
            const x = r as { clientKey?: string; extId?: string };
            return !(x.clientKey && уже.clientKeys.includes(x.clientKey)) && !(x.extId && уже.extIds.includes(x.extId));
          });
          вставлено[имя(t)]!.push(...новые);
          return Promise.resolve(новые);
        };
        const цепь = {
          onConflictDoNothing: () => ({ returning: принять }),
          returning: принять,
          then: (f: (v: unknown) => unknown) => принять().then(f),
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
  return { db, donor, вставлено };
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

  it("--apply пишет только импортируемое и оставляет одну отметку в журнале", async () => {
    const { db, donor, вставлено } = стенд(
      { refills: [ЗАЛИВ, ОБЩИЙ], stockCounts: [ПЕРЕСЧЁТ, СЛУЖЕБНАЯ], purchases: [] },
      { clientKeys: [], extIds: [] },
    );
    const r = await importStockHistory(db, donor, { apply: true });
    assert.deepEqual([r.refills.written, r.stockCounts.written], [1, 1]);
    assert.equal(вставлено.vending_refill!.length, 1);
    assert.equal((вставлено.event![0] as { type: string }).type, "stock.history.imported");
  });

  it("повторный --apply: 0 новых, событие не врёт числом входа", async () => {
    const { db, donor, вставлено } = стенд(
      { refills: [ЗАЛИВ], stockCounts: [ПЕРЕСЧЁТ] },
      { clientKeys: ["stock:refill:412"], extIds: ["77"] },
    );
    const r = await importStockHistory(db, donor, { apply: true });
    assert.deepEqual([r.refills.found, r.refills.written, r.stockCounts.written], [1, 0, 0]);
    // Отметка ставится на ФАКТ переноса, а не на факт запуска: R-P8a-5 знает
    // ровно одно событие. Второй прогон, не записавший ни строки, вторую
    // отметку не ставит — иначе журнал наполнялся бы нулевыми «импортами».
    assert.equal(вставлено.event!.length, 0);
  });

  it("закупки: недостающая дописывается, расхождение только называется", async () => {
    const { db, donor, вставлено } = стенд(
      {
        purchases: [
          { id: 1, dt: "2025-08-18", product: "Pepsi 0,5", qty: "24", unit_price: "0" },
          { id: 3, dt: "2026-07-13", product: "M&amp;Ms", qty: "6", unit_price: "8000" },
        ],
      },
      { clientKeys: [], extIds: ["1"] },
    );
    const r = await importStockHistory(db, donor, { apply: true });
    assert.deepEqual([r.purchases.mine, r.purchases.donor, r.purchases.added], [1, 2, 1]);
    assert.equal((вставлено.purchase![0] as { product: string }).product, "M&Ms");
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
      unresolved: 0,
    });
  });
});
