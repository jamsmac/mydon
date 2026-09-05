import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assembleGoodsStock, parityRows, type GoodsStock, type GoodsStockRow, type VendingParityRow } from "./goods-stock";

const W = "wh-1";
const d = (s: string) => new Date(`${s}T06:00:00+05:00`);
const products = [
  { id: "p-snickers", name: "Snickers 50gr", entityId: "c-snickers", isActive: true },
  { id: "p-bounty", name: "Bounty Coconut 55gr", entityId: "c-bounty", isActive: true },
  { id: "p-nocard", name: "Pulpy", entityId: null, isActive: true },
  { id: "p-old", name: "Strobar 40gr", entityId: "c-old", isActive: false },
];

describe("Остатки товаров — одна дверь (R-GS-1…6)", () => {
  it("список — активные позиции прайса, остаток из леджера, ноль у позиции без движений (R-GS-2)", () => {
    const g = assembleGoodsStock({
      warehouseId: W, products,
      qtyByCard: new Map([["c-snickers", 40]]),
      countedById: new Map([["p-snickers", d("2026-09-01")]]),
      countedByName: new Map(),
    });
    assert.deepEqual(g.rows.map((r: GoodsStockRow) => [r.productName, r.quantity]), [["Bounty Coconut 55gr", 0], ["Pulpy", null], ["Snickers 50gr", 40]]);
    assert.equal(g.rows.some((r: GoodsStockRow) => r.productName === "Strobar 40gr"), false, "неактивный не показывается");
    assert.equal(g.warehouseId, W);
  });

  it("позиция без карточки — quantity null, а не 0 (R-GS-3)", () => {
    const g = assembleGoodsStock({ warehouseId: W, products, qtyByCard: new Map(), countedById: new Map(), countedByName: new Map() });
    assert.equal(g.rows.find((r: GoodsStockRow) => r.productId === "p-nocard")?.quantity, null);
    assert.equal(g.rows.find((r: GoodsStockRow) => r.productId === "p-snickers")?.quantity, 0);
  });

  it("без центрального склада все остатки неизвестны и warehouseId null (R-GS-3)", () => {
    const g = assembleGoodsStock({ warehouseId: null, products, qtyByCard: new Map([["c-snickers", 40]]), countedById: new Map(), countedByName: new Map() });
    assert.ok(g.rows.every((r: GoodsStockRow) => r.quantity === null));
    assert.equal(g.warehouseId, null);
  });

  it("дата — по id, фолбэк по нормализованному имени; asOf — самая поздняя; никто не считал — null (R-GS-6)", () => {
    const g = assembleGoodsStock({
      warehouseId: W, products, qtyByCard: new Map(),
      countedById: new Map([["p-snickers", d("2026-08-20")]]),
      countedByName: new Map([["bounty coconut 55gr", d("2026-09-01")]]),
    });
    assert.equal(g.rows.find((r: GoodsStockRow) => r.productId === "p-snickers")?.countedAt?.toISOString(), d("2026-08-20").toISOString());
    assert.equal(g.rows.find((r: GoodsStockRow) => r.productId === "p-bounty")?.countedAt?.toISOString(), d("2026-09-01").toISOString());
    assert.equal(g.rows.find((r: GoodsStockRow) => r.productId === "p-nocard")?.countedAt, null);
    assert.equal(g.asOf?.toISOString(), d("2026-09-01").toISOString());
    const пусто = assembleGoodsStock({ warehouseId: W, products, qtyByCard: new Map(), countedById: new Map(), countedByName: new Map() });
    assert.equal(пусто.asOf, null);
  });

  it("includeInactive отдаёт и неактивные (для сверки)", () => {
    const g = assembleGoodsStock({ warehouseId: W, products, qtyByCard: new Map([["c-old", 3]]), countedById: new Map(), countedByName: new Map(), includeInactive: true });
    assert.deepEqual(g.rows.find((r: GoodsStockRow) => r.productId === "p-old"), { productName: "Strobar 40gr", productId: "p-old", cardId: "c-old", quantity: 3, countedAt: null, isActive: false });
  });
});

describe("Сверка по объединению прайса и таблицы (R-GS-5)", () => {
  const goods = (over: Partial<GoodsStock> = {}): GoodsStock => ({
    warehouseId: W,
    asOf: null,
    rows: [
      { productName: "Snickers 50gr", productId: "p-snickers", cardId: "c-snickers", quantity: 40, countedAt: null, isActive: true },
      { productName: "Bounty Coconut 55gr", productId: "p-bounty", cardId: "c-bounty", quantity: 0, countedAt: null, isActive: true },
      { productName: "Pulpy", productId: "p-nocard", cardId: null, quantity: null, countedAt: null, isActive: true },
      { productName: "Strobar 40gr", productId: "p-old", cardId: "c-old", quantity: 3, countedAt: null, isActive: false },
    ],
    ...over,
  });
  const canon = (raw: string) => raw;

  it("таблица = леджер → ok; расхождение → mismatch с diff = таблица − леджер", () => {
    const rows = parityRows(goods(), [{ productName: "Snickers 50gr", productId: "p-snickers", quantity: 35 }, { productName: "Bounty Coconut 55gr", productId: "p-bounty", quantity: 0 }], canon);
    const sn = rows.find((r: VendingParityRow) => r.productId === "p-snickers")!;
    assert.equal(sn.status, "mismatch"); assert.equal(sn.diff, -5); assert.equal(sn.isMismatch, true);
    assert.equal(rows.find((r: VendingParityRow) => r.productId === "p-bounty")?.status, "ok");
  });

  it("пустая таблица: все позиции no_row, расхождение — только у тех, где леджер ≠ 0", () => {
    const rows = parityRows(goods(), [], canon);
    const noRow = rows.filter((r: VendingParityRow) => r.status === "no_row");
    assert.equal(noRow.length, 3, "Snickers, Bounty и неактивный Strobar с остатком; Pulpy без карточки — no_card");
    assert.equal(rows.filter((r: VendingParityRow) => r.isMismatch).length, 2, "Snickers 40 и Strobar 3");
    assert.equal(rows.find((r: VendingParityRow) => r.productId === "p-bounty")?.isMismatch, false, "новый товар с нулём — не расхождение");
  });

  it("строка таблицы без карточки прайса — no_card, ledger null", () => {
    const rows = parityRows(goods(), [{ productName: "Неизвестный", productId: null, quantity: 7 }], canon);
    const x = rows.find((r: VendingParityRow) => r.productName === "Неизвестный")!;
    assert.equal(x.status, "no_card"); assert.equal(x.ledger, null); assert.equal(x.table, 7); assert.equal(x.isMismatch, false);
  });

  it("строка таблицы без product_id сопоставляется по канону имени", () => {
    const rows = parityRows(goods(), [{ productName: "snickers 50GR", productId: null, quantity: 40 }], (raw: string) => (raw.toLowerCase().startsWith("snickers") ? "Snickers 50gr" : raw));
    assert.equal(rows.find((r: VendingParityRow) => r.productId === "p-snickers")?.status, "ok");
  });

  it("неактивная позиция: с остатком — inactive_with_stock и расхождение; без остатка и без строки — не показывается", () => {
    const rows = parityRows(goods(), [{ productName: "Strobar 40gr", productId: "p-old", quantity: 3 }], canon);
    assert.equal(rows.find((r: VendingParityRow) => r.productId === "p-old")?.status, "inactive_with_stock");
    const g0 = goods({ rows: goods().rows.map((r: GoodsStockRow) => (r.productId === "p-old" ? { ...r, quantity: 0 } : r)) });
    assert.equal(parityRows(g0, [], canon).some((r: VendingParityRow) => r.productId === "p-old"), false);
  });

  it("без склада — no_warehouse у позиций с карточкой, ничего не считается расхождением", () => {
    const rows = parityRows(goods({ warehouseId: null, rows: goods().rows.map((r: GoodsStockRow) => ({ ...r, quantity: null })) }), [{ productName: "Snickers 50gr", productId: "p-snickers", quantity: 40 }], canon);
    assert.equal(rows.find((r: VendingParityRow) => r.productId === "p-snickers")?.status, "no_warehouse");
    assert.equal(rows.some((r: VendingParityRow) => r.isMismatch), false);
  });
});
