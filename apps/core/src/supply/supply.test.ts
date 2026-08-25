import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPurchaseUpserts, buildStockUpserts, fillFromStock, SupplyService } from "./supply.service";

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
   */
  const сводка = async (env: Record<string, string | undefined>) => {
    const было = process.env.OURVEND_ACCOUNTING_SOURCE;
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    try {
      const db = {
        select: () => ({
          from: () => ({
            where: () => Promise.resolve([{ count: 0, total: "0" }]),
            leftJoin: () => ({ where: () => ({ orderBy: () => Promise.resolve([]) }) }),
          }),
        }),
      } as never;
      return await new SupplyService(db).summary();
    } finally {
      if (было === undefined) delete process.env.OURVEND_ACCOUNTING_SOURCE;
      else process.env.OURVEND_ACCOUNTING_SOURCE = было;
    }
  };

  it("по умолчанию — stock (чтение БД mydon-stock)", async () => {
    assert.equal((await сводка({ OURVEND_ACCOUNTING_SOURCE: undefined })).source, "stock");
  });

  it("после переключения — own (собственный снапшот)", async () => {
    assert.equal((await сводка({ OURVEND_ACCOUNTING_SOURCE: "own" })).source, "own");
  });
});
