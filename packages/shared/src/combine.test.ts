import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { combineSales, type Fleet, type RawOrder } from "./combine";

const ord = (o: Partial<RawOrder>): RawOrder => ({
  externalId: "", ts: "", machine: "", product: "", amount: "", payment: "", status: "", kind: "", ...o,
});

const fleet = (source: string, title: string, orders: RawOrder[], loaded = true): Fleet =>
  ({ source, title, loaded, orders });

const all = (fleets: Fleet[]) => combineSales(fleets, 1, 1000);

describe("Все продажи: сложение флотов", () => {
  it("два разных флота складываются, не задваиваются", () => {
    const r = all([
      fleet("gjvending", "gjvending", [ord({ ts: "2026-07-01 08:00", amount: "15000" })]),
      fleet("ourvend", "OurVend", [ord({ ts: "2026-07-01 09:00", amount: "12000" })]),
    ]);
    assert.equal(r.totalOrders, 2);
    assert.equal(r.totalRevenue, 27000);
    assert.equal(r.count, 2);
  });

  it("свод по источнику: обороты по каждому флоту", () => {
    const r = all([
      fleet("gjvending", "gjvending", [ord({ amount: "15000" }), ord({ amount: "5000" })]),
      fleet("ourvend", "OurVend", [ord({ amount: "12000" })]),
    ]);
    const gj = r.bySource.find((b) => b.source === "gjvending")!;
    const ov = r.bySource.find((b) => b.source === "ourvend")!;
    assert.equal(gj.orders, 2);
    assert.equal(gj.revenue, 20000);
    assert.equal(ov.orders, 1);
    assert.equal(ov.revenue, 12000);
  });

  it("не загруженный источник виден в своде как пустой", () => {
    const r = all([
      fleet("gjvending", "gjvending", [ord({ amount: "15000" })]),
      fleet("ourvend", "OurVend", [], false),
    ]);
    const ov = r.bySource.find((b) => b.source === "ourvend")!;
    assert.equal(ov.loaded, false);
    assert.equal(ov.orders, 0);
  });
});

describe("Все продажи: разрезы", () => {
  it("по способу оплаты", () => {
    const r = all([
      fleet("g", "g", [ord({ payment: "cash", amount: "1000" }), ord({ payment: "cash", amount: "2000" })]),
      fleet("o", "O", [ord({ payment: "Pay by cash", amount: "3000" })]),
    ]);
    const cash = r.byPayment.find((b) => b.key === "cash")!;
    assert.equal(cash.orders, 2);
    assert.equal(cash.revenue, 3000);
    assert.equal(r.byPayment.find((b) => b.key === "Pay by cash")!.revenue, 3000);
  });

  it("по месяцу, свежий сверху", () => {
    const r = all([
      fleet("g", "g", [ord({ ts: "2026-06-01 10:00", amount: "1000" }), ord({ ts: "2026-07-15 10:00", amount: "2000" })]),
    ]);
    assert.equal(r.byMonth[0].key, "2026-07");
    assert.equal(r.byMonth[1].key, "2026-06");
  });
});

describe("Все продажи: сумма и тестовые", () => {
  it("тестовая отгрузка не в счёт", () => {
    const r = all([
      fleet("g", "g", [ord({ amount: "0", kind: "testShipment" }), ord({ amount: "15000", kind: "sale" })]),
    ]);
    assert.equal(r.totalOrders, 1);
    assert.equal(r.totalRevenue, 15000);
  });

  it("нечитаемая сумма не идёт в оборот, но считается", () => {
    const r = all([fleet("g", "g", [ord({ amount: "—" }), ord({ amount: "1000" })])]);
    assert.equal(r.totalRevenue, 1000);
    assert.equal(r.unreadable, 1);
    assert.equal(r.totalOrders, 2); // строка есть, просто без денег
  });

  it("«15 000.00» и «15000» — одна сумма", () => {
    const r = all([fleet("g", "g", [ord({ amount: "15 000.00" }), ord({ amount: "15000" })])]);
    assert.equal(r.totalRevenue, 30000);
    assert.equal(r.unreadable, 0);
  });
});

describe("Все продажи: лента и страницы", () => {
  it("лента по времени убыванием, без времени — в конец", () => {
    const r = all([
      fleet("g", "g", [
        ord({ externalId: "A", ts: "2026-07-01 08:00" }),
        ord({ externalId: "C", ts: "" }),
        ord({ externalId: "B", ts: "2026-07-02 08:00" }),
      ]),
    ]);
    assert.deepEqual(r.orders.map((o) => o.externalId), ["B", "A", "C"]);
  });

  it("страница нарезается после сортировки, свод по всем", () => {
    const orders = Array.from({ length: 5 }, (_, i) =>
      ord({ externalId: String(i), ts: `2026-07-0${i + 1} 08:00`, amount: "1000" }),
    );
    const r = combineSales([fleet("g", "g", orders)], 1, 2);
    assert.equal(r.count, 5);
    assert.equal(r.totalRevenue, 5000);
    assert.equal(r.orders.length, 2);
    assert.equal(r.orders[0].externalId, "4"); // самый свежий
  });
});
