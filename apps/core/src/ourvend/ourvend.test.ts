import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeParity,
  computeStockParity,
  OurvendParityService,
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
  /** Очередь ответов `db.execute` — ровно в порядке запросов сервиса. */
  const stubDb = (ответы: unknown[][], written: Record<string, unknown>[] = []) => {
    const queue = [...ответы];
    return {
      db: {
        execute: () => Promise.resolve(queue.shift() ?? []),
        insert: () => ({ values: (v: Record<string, unknown>) => Promise.resolve(written.push(v)) }),
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
    const svc = new OurvendParityService(db);

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
    const svc = new OurvendParityService(db);

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
    await new OurvendParityService(db2).daily();

    const payload = written[0]!.payload as Record<string, unknown>;
    assert.equal(payload.ok, true);
    assert.ok("остатки_сверено" in payload, "сводка обязана нести обе половины");
    assert.equal(payload.остатки_расхождений, 0);
  });

  it("снимка остатков за период нет — это не расхождение, а «гейт ещё не запущен»", async () => {
    // Красный вердикт без единой строки расхождений владелец читает как
    // «паритет продаж сломался» — и идёт чинить не то.
    const { db } = stubDb([...продажиОК, [], []]);
    const p = await new OurvendParityService(db).parity(7);

    assert.equal(p.stock.checked, 0);
    assert.equal(p.stock.ok, true, "сверять нечего ≠ расходится");
    assert.match(String(p.stock.note), /снимков остатков/);
    assert.match(String(p.note), /остатки/, "общая записка обязана объяснить, чего не хватает");
    assert.equal(p.ok, true);
  });

  it("строки остатков есть, но общих автоматов нет — это уже проблема, вердикт красный", async () => {
    const { db } = stubDb([
      ...продажиОК,
      [{ dt: "2026-08-24", serial: "m1", product: "Fanta", qty: 6 }],
      [{ dt: "2026-08-24", serial: "ДРУГОЙ", product: "Fanta", qty: 6 }],
    ]);
    const p = await new OurvendParityService(db).parity(7);

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
    await new OurvendParityService(db).daily();

    assert.equal(written.length, 1, "событие пишется всегда");
    const payload = written[0]!.payload as Record<string, unknown>;
    assert.equal(payload.остатки_сверено, 1);
    assert.match(String(payload.примечание), /продаж/);
  });
});
