import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { event, machineSlot, productSale, vendingProduct, vendingStock } from "@mydon/db";
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

/**
 * Стаб БД для ingest: копит вставки. `aliases`/`products` кормят
 * loadProductIndex() (вне транзакции); `stockRows` — предзагрузку остатка ДО
 * пересчёта внутри транзакции (единственный select там — фильтр по имени
 * стабу не нужен, ingestStock сам сверяет by-name из полного среза).
 */
function writeDb(aliases: unknown[] = [], products: unknown[] = [], stockRows: unknown[] = []) {
  const inserts: { table: string; values: unknown }[] = [];
  const tx = {
    select: () => ({ from: async () => stockRows }),
    insert: (table: { [Symbol.toStringTag]?: string }) => ({
      values: (v: unknown) => {
        const name = tableName(table);
        inserts.push({ table: name, values: v });
        return { onConflictDoUpdate: () => Promise.resolve() };
      },
    }),
  };
  // loadProductIndex() читает vending_alias затем vending_product — различаем по счётчику.
  let call = 0;
  const db = {
    select: () => ({ from: async () => (call++ === 0 ? aliases : products) }),
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
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

describe("Вендинг Core: приёмка накладной на склад (§5.7)", () => {
  type OrderRow = { id: string; status: string; positions: unknown[] };
  /**
   * Стаб БД приёмки: отдаёт накладную, копит апдейт статуса/приход/события.
   * `aliases`/`products` — только для тестов с `distributed` (loadProductIndex
   * читает их вне транзакции); без distributed этот select не вызывается.
   */
  function receiveDb(order: OrderRow | null, aliases: unknown[] = [], products: unknown[] = []) {
    const stockUpserts: Record<string, unknown>[] = [];
    const updates: Record<string, unknown>[] = [];
    const events: Record<string, unknown>[] = [];
    const tx = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => (order ? [order] : []),
            orderBy: () => ({ limit: async () => (order ? [order] : []) }),
          }),
        }),
      }),
      update: () => ({ set: (v: Record<string, unknown>) => ({ where: async () => void updates.push(v) }) }),
      insert: (table: unknown) => ({
        values: (v: Record<string, unknown>) => {
          if (table === vendingStock) {
            stockUpserts.push(v);
            return { onConflictDoUpdate: async () => undefined };
          }
          if (table === event) events.push(v);
          return Promise.resolve(undefined);
        },
      }),
    };
    // loadProductIndex() читает vendingAlias затем vendingProduct — различаем по счётчику.
    let call = 0;
    const db = {
      select: () => ({ from: async () => (call++ === 0 ? aliases : products) }),
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never;
    return { db, stockUpserts, updates, events };
  }

  it("приёмка увеличивает остаток на заказанное и переводит в received", async () => {
    const order: OrderRow = {
      id: "o1",
      status: "approved",
      positions: [
        { product: "Montella", order: 12 },
        { product: "Fanta", order: 12 },
        { product: "  ", order: 5 }, // пустое имя → мимо
        { product: "Zero", order: 0 }, // ноль → мимо
      ],
    };
    const { db, stockUpserts, updates, events } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder();

    assert.equal(res.received, true);
    assert.equal(res.orderId, "o1");
    assert.equal(res.replenished, 2);
    assert.equal(res.units, 24);
    assert.deepEqual(updates[0], { status: "received" });
    assert.equal(stockUpserts.length, 2);
    assert.equal(stockUpserts[0]!.productName, "Montella");
    assert.equal(stockUpserts[0]!.quantity, 12);
    assert.equal(events[0]!.type, "vending.purchase_order.received");
  });

  it("накладная уже принята — приёмку не повторяем", async () => {
    const { db, stockUpserts } = receiveDb({ id: "o1", status: "received", positions: [] });
    const res = await new VendingService(db).receiveOrder();
    assert.equal(res.received, false);
    assert.equal(stockUpserts.length, 0);
    assert.match(res.reason ?? "", /уже принята/i);
  });

  it("непринятых накладных нет — понятная причина", async () => {
    const { db } = receiveDb(null);
    const res = await new VendingService(db).receiveOrder();
    assert.equal(res.received, false);
    assert.match(res.reason ?? "", /нет/i);
  });

  it("распределение по автоматам уменьшает зачисление на склад (реальный процесс, лист «Snack склад»)", async () => {
    // Было 0, закуп 10, сразу 5 в автомат — на складе должно остаться только 5.
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 10 }] };
    const { db, stockUpserts } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder(undefined, "owner", { TUC: 5 });

    assert.equal(res.units, 5); // на складе
    assert.equal(res.distributedUnits, 5); // в автоматах
    assert.equal(stockUpserts.length, 1);
    assert.equal(stockUpserts[0]!.quantity, 5);
  });

  it("распределено больше заказанного — отсекается до order, склад не уходит в минус", async () => {
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 10 }] };
    const { db, stockUpserts } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder(undefined, "owner", { TUC: 15 });

    assert.equal(res.distributedUnits, 10); // не больше order
    assert.equal(res.units, 0);
    assert.equal(stockUpserts.length, 0); // toWarehouse=0 → нечего вставлять
  });

  it("распределение по алиасу резолвится к канону — то же пространство имён, что и склад §5.4", async () => {
    const order: OrderRow = {
      id: "o1",
      status: "approved",
      positions: [{ product: "Montella Вода минеральная 330ml", order: 24 }],
    };
    const { db, stockUpserts } = receiveDb(
      order,
      [{ productId: "p1", alias: "Montella" }],
      [{ id: "p1", name: "Montella Вода минеральная 330ml" }],
    );
    const res = await new VendingService(db).receiveOrder(undefined, "owner", { montella: 10 });

    assert.equal(res.distributedUnits, 10);
    assert.equal(res.units, 14);
    assert.equal(stockUpserts[0]!.quantity, 14);
  });

  it("без distributed — как раньше: весь order идёт на склад", async () => {
    const order: OrderRow = { id: "o1", status: "approved", positions: [{ product: "TUC", order: 10 }] };
    const { db } = receiveDb(order);
    const res = await new VendingService(db).receiveOrder();
    assert.equal(res.distributedUnits, 0);
    assert.equal(res.units, 10);
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
    assert.deepEqual(res, { items: 2, adjustments: [] }); // счётчик по входу, расхождений нет (склад пуст)
    // Записана только валидная позиция.
    assert.equal(inserts.length, 1);
    const v = inserts[0]!.values as { productName: string; quantity: number };
    assert.equal(v.productName, "Montella");
    assert.equal(v.quantity, 24);
  });

  it("имя-вариант приводится к канону через алиас (регистр не важен)", async () => {
    const { db, inserts } = writeDb(
      [{ productId: "p1", alias: "Montella" }],
      [{ id: "p1", name: "Montella Вода минеральная 330ml" }],
    );
    const svc = new VendingService(db);
    await svc.ingestStock({ items: [{ product: "montella", quantity: 7 }] });
    const v = inserts[0]!.values as { productName: string };
    assert.equal(v.productName, "Montella Вода минеральная 330ml");
  });

  it("неизвестное имя (нет алиаса) остаётся как есть — на разбор позже", async () => {
    const { db, inserts } = writeDb([], []);
    const svc = new VendingService(db);
    await svc.ingestStock({ items: [{ product: "Новый Товар", quantity: 3 }] });
    const v = inserts[0]!.values as { productName: string };
    assert.equal(v.productName, "Новый Товар");
  });

  it("недостача при пересчёте: было 55 → стало 54, оценена по цене (реальный лист 02.08.2026)", async () => {
    const products = [{ id: "p1", name: "Montella Вода минеральная 330ml", purchasePrice: "2090.00" }];
    const stock = [{ productName: "Montella Вода минеральная 330ml", quantity: 55 }];
    const { db, inserts } = writeDb(
      [{ productId: "p1", alias: "Montella pet 0.33" }],
      products,
      stock,
    );
    const svc = new VendingService(db);
    const res = await svc.ingestStock({ items: [{ product: "Montella pet 0.33", quantity: 54 }] });

    assert.equal(res.adjustments.length, 1);
    const a = res.adjustments[0]!;
    assert.equal(a.product, "Montella Вода минеральная 330ml");
    assert.equal(a.before, 55);
    assert.equal(a.after, 54);
    assert.equal(a.delta, -1); // недостача
    assert.equal(a.value, 2090); // |delta| × цена
    assert.equal(a.noPrice, false);

    // Расхождение попадает в журнал (событие + audit), не только в ответ метода.
    const ev = inserts.find((i) => (i.values as { type?: string }).type === "vending.stock.recounted");
    assert.ok(ev, "должно быть событие о пересчёте");
    const audit = inserts.find((i) => (i.values as { action?: string }).action === "vending.stock.recount");
    assert.ok(audit, "должна быть запись в журнале действий");
  });

  it("излишек при пересчёте — тоже расхождение, но со знаком плюс", async () => {
    const stock = [{ productName: "Fanta Classic CAN 250ml", quantity: 7 }];
    const { db } = writeDb([], [], stock);
    const svc = new VendingService(db);
    const res = await svc.ingestStock({ items: [{ product: "Fanta Classic CAN 250ml", quantity: 19 }] });
    assert.equal(res.adjustments.length, 1);
    assert.equal(res.adjustments[0]!.delta, 12);
  });

  it("без цены в прайсе — value 0, noPrice=true, но расхождение видно", async () => {
    const stock = [{ productName: "Новый Товар", quantity: 10 }];
    const { db } = writeDb([], [], stock);
    const svc = new VendingService(db);
    const res = await svc.ingestStock({ items: [{ product: "Новый Товар", quantity: 8 }] });
    assert.equal(res.adjustments[0]!.value, 0);
    assert.equal(res.adjustments[0]!.noPrice, true);
  });

  it("цена с копейками не даёт «грязный» хвост float — value округлён до копеек", async () => {
    // 3 × 2090.55 = 6271.6499999999996 в чистом IEEE-754 — без округления это
    // легло бы в неизменяемый журнал как есть (найдено адверсариал-ревью).
    const products = [{ id: "p1", name: "Товар с копейками", purchasePrice: "2090.55" }];
    const stock = [{ productName: "Товар с копейками", quantity: 10 }];
    const { db } = writeDb([], products, stock);
    const svc = new VendingService(db);
    const res = await svc.ingestStock({ items: [{ product: "Товар с копейками", quantity: 7 }] });
    assert.equal(res.adjustments[0]!.value, 6271.65);
  });

  it("событие пересчёта пишет ПЕРЕДАННОГО actor, а не жёстко owner", async () => {
    const stock = [{ productName: "Fanta Classic CAN 250ml", quantity: 7 }];
    const { db, inserts } = writeDb([], [], stock);
    const svc = new VendingService(db);
    await svc.ingestStock({ items: [{ product: "Fanta Classic CAN 250ml", quantity: 19 }] }, "manager");
    const ev = inserts.find((i) => (i.values as { type?: string }).type === "vending.stock.recounted");
    assert.equal((ev!.values as { source: string }).source, "manager");
  });

  it("первый ввод по товару (в складе строки ещё не было) — не расхождение", async () => {
    const { db } = writeDb([], [], []); // склад пуст — ничего сравнивать
    const svc = new VendingService(db);
    const res = await svc.ingestStock({ items: [{ product: "Совершенно новый", quantity: 30 }] });
    assert.deepEqual(res.adjustments, []);
  });

  it("количество не изменилось — не расхождение (не шумим по пустякам)", async () => {
    const stock = [{ productName: "Sprite 250ml", quantity: 19 }];
    const { db } = writeDb([], [], stock);
    const svc = new VendingService(db);
    const res = await svc.ingestStock({ items: [{ product: "Sprite 250ml", quantity: 19 }] });
    assert.deepEqual(res.adjustments, []);
  });

  it("два алиаса на ОДИН канон в одной инвентаризации — одна дельта, не две (регресс)", async () => {
    // «Montella pet 0.33» и «montella zero 0.33» — оба ведут на один товар.
    // Реальная смена: было 7 → стало 12 (последняя позиция в списке). Наивный
    // снимок «до» один раз на батч даёт ДВЕ дельты от устаревшего 7 — баг,
    // пойманный адверсариал-ревью до релиза.
    const canonical = "Montella Вода минеральная 330ml";
    const products = [{ id: "p1", name: canonical, purchasePrice: "2090.00" }];
    const aliases = [
      { productId: "p1", alias: "Montella pet 0.33" },
      { productId: "p1", alias: "montella zero 0.33" },
    ];
    const stock = [{ productName: canonical, quantity: 7 }];
    const { db, inserts } = writeDb(aliases, products, stock);
    const svc = new VendingService(db);

    const res = await svc.ingestStock({
      items: [
        { product: "Montella pet 0.33", quantity: 10 },
        { product: "montella zero 0.33", quantity: 12 },
      ],
    });

    assert.equal(res.adjustments.length, 1, "должна быть ровно одна дельта на канонический товар");
    const a = res.adjustments[0]!;
    assert.equal(a.before, 7);
    assert.equal(a.after, 12); // последняя позиция в списке побеждает
    assert.equal(a.delta, 5);
    assert.equal(a.value, 5 * 2090);

    // И записан склад — тоже РОВНО одной строкой на канон (не дважды).
    const stockInserts = inserts.filter((i) => (i.values as { productName?: string }).productName === canonical);
    assert.equal(stockInserts.length, 1);
    assert.equal((stockInserts[0]!.values as { quantity: number }).quantity, 12);
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

describe("Вендинг Core: касса закупа (§5.8)", () => {
  /**
   * Стаб для recordCashSession: insert().values().returning() → строка с id
   * и createdAt (в реальной БД проставляется defaultNow(), .values() его не
   * передаёт — стаб должен достроить сам, иначе .toISOString() упадёт на undefined).
   */
  function cashInsertDb() {
    const inserted: Record<string, unknown>[] = [];
    const db = {
      insert: () => ({
        values: (v: Record<string, unknown>) => {
          inserted.push(v);
          return { returning: async () => [{ id: "cs1", createdAt: new Date("2026-08-02T12:00:00Z"), ...v }] };
        },
      }),
    } as never;
    return { db, inserted };
  }

  it("воспроизводит реальную запись 02.08.2026 до сума и сохраняет снимок", async () => {
    const { db, inserted } = cashInsertDb();
    const svc = new VendingService(db);
    const res = await svc.recordCashSession(2_400_000, [
      { name: "корзинка", lines: [{ label: "47×2090", amount: 98_230 }] },
      { name: "базар", lines: [{ label: "снеки", amount: 376_300 }] },
      { name: "базар", lines: [{ label: "напитки", amount: 1_023_000 }] },
    ]);
    assert.equal(res.totalSpent, 1_497_530);
    assert.equal(res.remainder, 902_470);
    assert.equal(res.id, "cs1");
    // В базу уходят СТРОКОВЫЕ numeric (toFixed) — Postgres numeric ожидает текст, не число.
    assert.equal(inserted[0]!.receivedAmount, "2400000.00");
    assert.equal(inserted[0]!.remainder, "902470.00");
  });

  it("createdBy по умолчанию owner, можно переопределить", async () => {
    const { db, inserted } = cashInsertDb();
    await new VendingService(db).recordCashSession(100_000, [{ name: "базар", lines: [{ label: "X", amount: 10_000 }] }]);
    assert.equal(inserted[0]!.createdBy, "owner");

    const { db: db2, inserted: inserted2 } = cashInsertDb();
    await new VendingService(db2).recordCashSession(100_000, [], "manager");
    assert.equal(inserted2[0]!.createdBy, "manager");
  });

  it("cashSessions() читает numeric-строки как числа, свежие сверху", async () => {
    const rows = [
      {
        id: "cs2",
        receivedAmount: "2400000.00",
        categories: [{ name: "базар", lines: [], subtotal: 100 }],
        totalSpent: "1497530.00",
        remainder: "902470.00",
        createdBy: "owner",
        createdAt: new Date("2026-08-02T10:00:00Z"),
      },
    ];
    const db = { select: () => ({ from: () => ({ orderBy: () => ({ limit: async () => rows }) }) }) } as never;
    const list = await new VendingService(db).cashSessions();
    assert.equal(list[0]!.receivedAmount, 2_400_000);
    assert.equal(list[0]!.remainder, 902_470);
    assert.equal(list[0]!.createdAt, "2026-08-02T10:00:00.000Z");
  });
});
