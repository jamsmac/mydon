import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPurchaseUpserts, buildStockUpserts, fillFromStock } from "./supply.service";

describe("Снабжение: подготовка строк источника", () => {
  it("приход: числа и срок годности переносятся, id источника — ключ", () => {
    const [v] = buildPurchaseUpserts([
      { id: 42, dt: "2026-07-20", product: "Зерно арабика", unit: "кг", qty: 10,
        unit_price: 78000, total: 780000, note: null, expiry_date: "2026-12-01" },
    ]);
    assert.equal(v.extId, "42");
    assert.equal(v.total, "780000");
    assert.equal(v.expiryDate, "2026-12-01");
  });

  it("приход без цены и срока — null, а не ноль-выдумка", () => {
    const [v] = buildPurchaseUpserts([
      { id: 1, dt: "2026-07-20", product: "Стаканы", unit: "шт", qty: 500,
        unit_price: null, total: null, note: "подарок поставщика", expiry_date: null },
    ]);
    assert.equal(v.unitPrice, null);
    assert.equal(v.total, null);
    assert.equal(v.expiryDate, null);
  });

  it("остатки: серийник к нижнему регистру, известный — привязан к автомату", () => {
    const map = new Map([["c2508160376", "ent-1"]]);
    const [a, b] = buildStockUpserts(
      [
        { dt: "2026-07-28", machine_serial: "C2508160376", ourvend_name: "Вода", qty: 0, fetched_at: new Date() },
        { dt: "2026-07-28", machine_serial: "неизвестный", ourvend_name: "Чипсы", qty: 3, fetched_at: new Date() },
      ],
      map,
    );
    assert.equal(a.machineId, "ent-1");
    assert.equal(a.qty, "0");
    assert.equal(b.machineId, null);
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
