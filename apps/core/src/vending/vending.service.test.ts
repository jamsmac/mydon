import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { machineSlot, productSale, vendingProduct, vendingStock } from "@mydon/db";
import { VendingService } from "./vending.service";

type Row = { machineSerial: string; coilId: string; productName: string | null; capacity: number; quantity: number };
type SaleRow = { machineSerial: string; productName: string; quantity: number; capturedAt: Date };
type ProdRow = { name: string; purchasePrice: string | null; packSize: number };

/** Стаб БД: machines()/deficitSummary() читают `select().from()`. */
function readDb(rows: Row[]) {
  return { select: () => ({ from: async () => rows }) } as never;
}

/** Стаб БД для прогноза: слоты и продажи в разные таблицы, различаем по ссылке. */
function forecastDb(slots: Row[], sales: SaleRow[]) {
  return { select: () => ({ from: async (t: unknown) => (t === productSale ? sales : t === machineSlot ? slots : slots) }) } as never;
}

type StockRow = { productName: string; quantity: number; countedAt: Date };

/** Стаб БД для закупа: слоты + продажи + прайс + склад, различаем по ссылке. */
function purchaseDb(slots: Row[], sales: SaleRow[], products: ProdRow[], stock: StockRow[] = []) {
  return {
    select: () => ({
      from: async (t: unknown) =>
        t === productSale ? sales : t === vendingProduct ? products : t === vendingStock ? stock : slots,
    }),
  } as never;
}

/** Стаб БД для ingest: копит вставки. */
function writeDb() {
  const inserts: { table: string; values: unknown }[] = [];
  const tx = {
    insert: (table: { [Symbol.toStringTag]?: string }) => ({
      values: (v: unknown) => {
        const name = tableName(table);
        inserts.push({ table: name, values: v });
        return { onConflictDoUpdate: () => Promise.resolve() };
      },
    }),
  };
  const db = { transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx) } as never;
  return { db, inserts };
}
function tableName(t: unknown): string {
  // drizzle-таблица знает своё имя; для стаба достаточно эвристики по ключам.
  const keys = Object.keys((t ?? {}) as Record<string, unknown>);
  return keys.includes("capturedAt") && !keys.includes("syncedAt") ? "slot_snapshot" : "machine_slot";
}

const slot = (machineSerial: string, coilId: string, productName: string | null, capacity: number, quantity: number): Row => ({
  machineSerial,
  coilId,
  productName,
  capacity,
  quantity,
});

describe("Вендинг Core: дефицит по автоматам (Фаза 1c)", () => {
  it("считает дефицит/заполненность, статус, сортировку", async () => {
    const rows = [
      // AH: два валидных слота — дефицит (6-0)+(6-1)=11
      slot("AH", "31", "Montella", 6, 0),
      slot("AH", "34", "CocaCola", 6, 1),
      // NOSLOT: слоты без товара → no_slots, в конце
      slot("NOSLOT", "1", null, 6, 0),
    ];
    const svc = new VendingService(readDb(rows));
    const machines = await svc.machines();
    const ah = machines.find((m) => m.serial === "AH")!;
    assert.equal(ah.status, "ok");
    assert.equal(ah.deficit, 11);
    assert.equal(ah.capacity, 12);
    assert.equal(ah.fillRate, 8); // round(1/12*100)
    // no_slots-автомат уходит в конец.
    assert.equal(machines[machines.length - 1].serial, "NOSLOT");
    assert.equal(machines[machines.length - 1].status, "no_slots");
  });

  it("сводная потребность по товарам — только ok, с разбивкой", async () => {
    const rows = [
      slot("AH", "31", "Montella", 6, 0), // деф 6
      slot("Olma", "40", "Montella", 6, 3), // деф 3
      slot("Olma", "41", "Fanta", 6, 6), // деф 0 — не в сводке
    ];
    const svc = new VendingService(readDb(rows));
    const summary = await svc.deficitSummary();
    const m = summary.find((s) => s.product === "Montella")!;
    assert.equal(m.total, 9);
    assert.deepEqual(m.perMachine, { AH: 6, Olma: 3 });
    assert.ok(!summary.some((s) => s.product === "Fanta"), "нулевой дефицит не попадает в сводку");
  });
});

describe("Вендинг Core: прогноз расхода (§5.6)", () => {
  it("daysLeft = остаток / (продажи7/7), только ok-автоматы, свежий батч продаж", async () => {
    const t1 = new Date("2026-07-30T00:00:00Z"); // старый батч — игнор
    const t2 = new Date("2026-08-02T00:00:00Z"); // свежий
    const slots: Row[] = [
      // AH ok: Montella остаток 2 (валиден), Fanta остаток 6 (продаж нет)
      { machineSerial: "AH", coilId: "31", productName: "Montella", capacity: 6, quantity: 2 },
      { machineSerial: "AH", coilId: "32", productName: "Fanta", capacity: 6, quantity: 6 },
      // NOSLOT: без назначенных слотов → не ok, его остаток в прогноз не идёт
      { machineSerial: "NOSLOT", coilId: "1", productName: null, capacity: 6, quantity: 0 },
    ];
    const sales: SaleRow[] = [
      { machineSerial: "AH", productName: "Montella", quantity: 999, capturedAt: t1 }, // старый — игнор
      { machineSerial: "AH", productName: "Montella", quantity: 14, capturedAt: t2 }, // sold7=14 → daily=2
    ];
    const svc = new VendingService(forecastDb(slots, sales));
    const { all, critical } = await svc.forecast();

    const montella = all.find((r) => r.product === "Montella")!;
    assert.equal(montella.inMachines, 2);
    assert.equal(montella.daily, 2);
    assert.equal(montella.daysLeft, 1); // 2 / 2
    // Fanta без продаж → хватит «навсегда», не критичен.
    const fanta = all.find((r) => r.product === "Fanta")!;
    assert.equal(fanta.daysLeft, Infinity);
    // Критичны только те, чей запас ≤ 3 дней.
    assert.deepEqual(critical.map((r) => r.product), ["Montella"]);
  });
});

describe("Вендинг Core: сводный закуп (§5.4–5.5)", () => {
  const t = new Date("2026-08-02T00:00:00Z");
  // Один ok-автомат: Montella нужна 4 (есть цена+продажи), Dead нужна 2 (цена
  // есть, продаж нет → «не закупать»), NoPrice нужна 3 (нет цены → на разбор).
  const slots: Row[] = [
    { machineSerial: "AH", coilId: "1", productName: "Montella", capacity: 6, quantity: 2 },
    { machineSerial: "AH", coilId: "2", productName: "Dead", capacity: 5, quantity: 3 },
    { machineSerial: "AH", coilId: "3", productName: "NoPrice", capacity: 6, quantity: 3 },
  ];
  const sales: SaleRow[] = [
    { machineSerial: "AH", productName: "Montella", quantity: 14, capturedAt: t },
    { machineSerial: "AH", productName: "NoPrice", quantity: 5, capturedAt: t }, // продажи есть, цены нет
  ];
  const products: ProdRow[] = [
    { name: "Montella", purchasePrice: "5000.00", packSize: 12 },
    { name: "Dead", purchasePrice: "3000.00", packSize: 10 },
    // NoPrice отсутствует в прайсе намеренно.
  ];

  it("округляет до упаковки, считает обе суммы и переплату по товару с ценой и продажами", async () => {
    const svc = new VendingService(purchaseDb(slots, sales, products));
    const s = await svc.purchase();

    const montella = s.items.find((i) => i.product === "Montella")!;
    assert.equal(montella.buy, 4); // дефицит 6−2, склад 0
    assert.equal(montella.order, 12); // ceil(4/12)*12
    assert.equal(montella.costExact, 20000); // 4×5000
    assert.equal(montella.costRounded, 60000); // 12×5000
    assert.equal(s.overpay, 40000);
  });

  it("товар без продаж выносит в excludedNoSales и не включает в денежные итоги", async () => {
    const svc = new VendingService(purchaseDb(slots, sales, products));
    const s = await svc.purchase();
    assert.deepEqual(s.excludedNoSales.map((i) => i.product), ["Dead"]);
    // В items только Montella (Dead исключён, NoPrice без цены, но продажи?)
    assert.ok(!s.items.some((i) => i.product === "Dead"));
  });

  it("товар без цены помечает noPrice и держит вне денежных итогов, но в items", async () => {
    const svc = new VendingService(purchaseDb(slots, sales, products));
    const s = await svc.purchase();
    assert.ok(s.noPrice.includes("NoPrice"));
    assert.ok(s.items.some((i) => i.product === "NoPrice")); // есть продажи → участвует
    assert.equal(s.costRounded, 60000); // деньги — только Montella
  });

  it("остаток склада вычитается из потребности: buy = need − stock (§5.4)", async () => {
    // Склад Montella 1 → нехватка 4−1=3, но округление до упаковки 12 то же.
    const stock: StockRow[] = [{ productName: "Montella", quantity: 1, countedAt: t }];
    const svc = new VendingService(purchaseDb(slots, sales, products, stock));
    const s = await svc.purchase();
    const montella = s.items.find((i) => i.product === "Montella")!;
    assert.equal(montella.stock, 1);
    assert.equal(montella.covered, 1); // min(1, 4)
    assert.equal(montella.buy, 3); // max(0, 4−1)
    assert.equal(montella.order, 12); // ceil(3/12)*12
    assert.equal(montella.costExact, 15000); // 3×5000
  });

  it("склад покрывает потребность полностью — товар выпадает из закупа (buy=0)", async () => {
    const stock: StockRow[] = [{ productName: "Montella", quantity: 10, countedAt: t }];
    const svc = new VendingService(purchaseDb(slots, sales, products, stock));
    const s = await svc.purchase();
    const montella = s.items.find((i) => i.product === "Montella")!;
    assert.equal(montella.buy, 0);
    assert.equal(montella.order, 0); // buy 0 → заказывать нечего
    assert.equal(montella.surplus, 6); // 10 − 4
    assert.equal(s.costRounded, 0); // единственная денежная позиция закрыта складом
  });
});

describe("Вендинг Core: отправка закупа на утверждение (§5.7)", () => {
  const t = new Date("2026-08-02T00:00:00Z");
  const slots: Row[] = [{ machineSerial: "AH", coilId: "1", productName: "Montella", capacity: 6, quantity: 2 }];
  const sales: SaleRow[] = [{ machineSerial: "AH", productName: "Montella", quantity: 14, capturedAt: t }];
  const products: ProdRow[] = [{ name: "Montella", purchasePrice: "5000.00", packSize: 12 }];

  /** Стаб очереди согласований: копит запросы, отдаёт id. */
  function approvalsStub() {
    const requests: { agent: string; action: string; tier: string; payload?: Record<string, unknown> }[] = [];
    const svc = {
      request: async (input: { agent: string; action: string; tier: string; payload?: Record<string, unknown> }) => {
        requests.push(input);
        return { id: `ap-${requests.length}` };
      },
    };
    return { svc, requests };
  }

  it("создаёт заявку со снимком закупа и суммой в действии", async () => {
    const { svc, requests } = approvalsStub();
    const vending = new VendingService(purchaseDb(slots, sales, products), svc);
    const res = await vending.submitPurchase("owner");

    assert.equal(res.submitted, true);
    assert.equal(res.approvalId, "ap-1");
    assert.equal(res.positions, 1);
    assert.equal(res.costRounded, 60000); // order 12 × 5000

    assert.equal(requests.length, 1);
    const r = requests[0]!;
    assert.equal(r.agent, "vending");
    assert.equal(r.tier, "T2");
    assert.match(r.action, /Закуп вендинга: 1 поз/);
    const po = (r.payload as { purchaseOrder: { positions: unknown[]; costRounded: number } }).purchaseOrder;
    assert.equal(po.positions.length, 1);
    assert.equal(po.costRounded, 60000);
  });

  it("нечего заказывать — заявку не создаёт", async () => {
    const { svc, requests } = approvalsStub();
    // Слот заполнен под завязку → дефицита нет.
    const full: Row[] = [{ machineSerial: "AH", coilId: "1", productName: "Montella", capacity: 6, quantity: 6 }];
    const vending = new VendingService(purchaseDb(full, sales, products), svc);
    const res = await vending.submitPurchase("owner");
    assert.equal(res.submitted, false);
    assert.equal(requests.length, 0);
    assert.match(res.reason ?? "", /нечего/i);
  });

  it("без подключённой очереди согласований — явная ошибка", async () => {
    const vending = new VendingService(purchaseDb(slots, sales, products));
    await assert.rejects(() => vending.submitPurchase(), /ApprovalsService не подключён/);
  });
});

describe("Вендинг Core: инвентаризация склада (§5.4)", () => {
  it("перезаписывает остаток по товару (upsert), пустое имя пропускает", async () => {
    const { db, inserts } = writeDb();
    const svc = new VendingService(db);
    const res = await svc.ingestStock({
      countedAt: "2026-08-02T09:00:00Z",
      items: [
        { product: "Montella", quantity: 24 },
        { product: "  ", quantity: 5 }, // пустое имя → пропуск
      ],
    });
    assert.deepEqual(res, { items: 2 }); // счётчик по входу
    // Записана только валидная позиция.
    assert.equal(inserts.length, 1);
    const v = inserts[0]!.values as { productName: string; quantity: number };
    assert.equal(v.productName, "Montella");
    assert.equal(v.quantity, 24);
  });
});

describe("Вендинг Core: приём слотов", () => {
  it("пишет актуальный слот и снапшот, считает is_valid", async () => {
    const { db, inserts } = writeDb();
    const svc = new VendingService(db);
    const res = await svc.ingestSlots({
      machines: [{ serial: "AH", slots: [{ coilId: "31", product: "Montella", capacity: 6, quantity: 0 }] }],
    });
    assert.deepEqual(res, { machines: 1, slots: 1 });
    // Один слот → одна строка планограммы + одна строка истории.
    assert.equal(inserts.filter((i) => i.table === "machine_slot").length, 1);
    assert.equal(inserts.filter((i) => i.table === "slot_snapshot").length, 1);
    const ms = inserts.find((i) => i.table === "machine_slot")!.values as { isValid: boolean; productName: string | null };
    assert.equal(ms.isValid, true); // 0 < 6 ≤ 100
    assert.equal(ms.productName, "Montella");
  });

  it("пустое имя товара → null (слот не назначен), вместимость 0 → невалиден", async () => {
    const { db, inserts } = writeDb();
    const svc = new VendingService(db);
    await svc.ingestSlots({ machines: [{ serial: "M", slots: [{ coilId: "1", product: "  ", capacity: 0, quantity: 0 }] }] });
    const ms = inserts.find((i) => i.table === "machine_slot")!.values as { isValid: boolean; productName: string | null };
    assert.equal(ms.productName, null);
    assert.equal(ms.isValid, false);
  });
});
