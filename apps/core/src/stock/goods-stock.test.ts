import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { productIndex, resolveCatalogName } from "@mydon/shared";
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
  // Дверь имени — настоящий индекс каталога по позициям фикстуры и то же
  // правило, что у `productIdResolver` (спор/промах → null): у сверки своего
  // правила сопоставления нет, и тесты его не выдумывают.
  const doorOf = (g: GoodsStock) => {
    const index = productIndex(g.rows.map((r: GoodsStockRow) => ({ id: r.productId, name: r.productName })), []);
    return (raw: string): string | null => {
      const r = resolveCatalogName(index, raw);
      return r.kind === "hit" ? r.id : null;
    };
  };
  const resolve = doorOf(goods());

  it("таблица = леджер → ok; расхождение → mismatch с diff = таблица − леджер", () => {
    const rows = parityRows(goods(), [{ productName: "Snickers 50gr", productId: "p-snickers", quantity: 35 }, { productName: "Bounty Coconut 55gr", productId: "p-bounty", quantity: 0 }], resolve);
    const sn = rows.find((r: VendingParityRow) => r.productId === "p-snickers")!;
    assert.equal(sn.status, "mismatch"); assert.equal(sn.diff, -5); assert.equal(sn.isMismatch, true);
    assert.equal(rows.find((r: VendingParityRow) => r.productId === "p-bounty")?.status, "ok");
  });

  it("пустая таблица: все позиции no_row, расхождение — только у тех, где леджер ≠ 0", () => {
    const rows = parityRows(goods(), [], resolve);
    const noRow = rows.filter((r: VendingParityRow) => r.status === "no_row");
    assert.equal(noRow.length, 3, "Snickers, Bounty и неактивный Strobar с остатком; Pulpy без карточки — no_card");
    assert.equal(rows.filter((r: VendingParityRow) => r.isMismatch).length, 2, "Snickers 40 и Strobar 3");
    assert.equal(rows.find((r: VendingParityRow) => r.productId === "p-bounty")?.isMismatch, false, "новый товар с нулём — не расхождение");
  });

  it("строка таблицы без карточки прайса — no_card, ledger null", () => {
    const rows = parityRows(goods(), [{ productName: "Неизвестный", productId: null, quantity: 7 }], resolve);
    const x = rows.find((r: VendingParityRow) => r.productName === "Неизвестный")!;
    assert.equal(x.status, "no_card"); assert.equal(x.ledger, null); assert.equal(x.table, 7); assert.equal(x.isMismatch, false);
  });

  it("строка таблицы без product_id сопоставляется через дверь имени (тот же индекс, что у леджера)", () => {
    const rows = parityRows(goods(), [{ productName: "snickers 50GR", productId: null, quantity: 40 }], resolve);
    assert.equal(rows.find((r: VendingParityRow) => r.productId === "p-snickers")?.status, "ok");
  });

  it("неактивная позиция: с остатком — inactive_with_stock и расхождение; без остатка и без строки — не показывается", () => {
    const rows = parityRows(goods(), [{ productName: "Strobar 40gr", productId: "p-old", quantity: 3 }], resolve);
    assert.equal(rows.find((r: VendingParityRow) => r.productId === "p-old")?.status, "inactive_with_stock");
    const g0 = goods({ rows: goods().rows.map((r: GoodsStockRow) => (r.productId === "p-old" ? { ...r, quantity: 0 } : r)) });
    assert.equal(parityRows(g0, [], resolve).some((r: VendingParityRow) => r.productId === "p-old"), false);
  });

  it("без склада — no_warehouse у позиций с карточкой, ничего не считается расхождением", () => {
    const rows = parityRows(goods({ warehouseId: null, rows: goods().rows.map((r: GoodsStockRow) => ({ ...r, quantity: null })) }), [{ productName: "Snickers 50gr", productId: "p-snickers", quantity: 40 }], resolve);
    assert.equal(rows.find((r: VendingParityRow) => r.productId === "p-snickers")?.status, "no_warehouse");
    assert.equal(rows.some((r: VendingParityRow) => r.isMismatch), false);
  });
  it("коллизия нормализованных имён двух позиций прайса: строка ложится туда, куда дверь кладёт леджер, вторая — no_row; своего правила у сверки нет", () => {
    const g = goods({
      rows: [
        { productName: "Red Bull", productId: "p-rb-1", cardId: "c-rb-1", quantity: 5, countedAt: null, isActive: true },
        { productName: "Red  Bull", productId: "p-rb-2", cardId: "c-rb-2", quantity: 5, countedAt: null, isActive: true },
      ],
    });
    const table = [{ productName: "red bull", productId: null, quantity: 5 }];
    const door = doorOf(g);
    const chosen = door("red bull");
    assert.ok(chosen === "p-rb-1" || chosen === "p-rb-2", "дверь выбрала одну из двух позиций");
    const other = chosen === "p-rb-1" ? "p-rb-2" : "p-rb-1";
    const rows = parityRows(g, table, door);
    assert.equal(rows.find((r) => r.productId === chosen)?.status, "ok", "строка легла на позицию двери");
    assert.equal(rows.find((r) => r.productId === other)?.status, "no_row");
    // Дверь решила иначе — сверка идёт за ней, а не за порядком/коллацией прайса.
    const flipped = parityRows(g, table, () => other);
    assert.equal(flipped.find((r) => r.productId === other)?.status, "ok");
    assert.equal(flipped.find((r) => r.productId === chosen)?.status, "no_row");
  });

  it("совпадение по product_id главнее совпадения по имени: строка с id занимает позицию, строка по имени уходит в сироты", () => {
    const rows = parityRows(
      goods(),
      [
        { productName: "Snickers 50gr", productId: null, quantity: 1 }, // по имени — идёт первой в таблице
        { productName: "старое имя", productId: "p-snickers", quantity: 40 }, // по id — должна выиграть
      ],
      resolve,
    );
    const sn = rows.find((r) => r.productId === "p-snickers")!;
    assert.equal(sn.table, 40, "занята строкой с product_id");
    assert.equal(sn.status, "ok");
    const orphan = rows.find((r) => r.productName === "Snickers 50gr" && r.status === "no_card");
    assert.ok(orphan, "вторая строка на ту же позицию — сирота, а не молчаливая потеря");
  });

  it("сирота с висячим product_id (позиции нет в прайсе) — productId null и не считается позицией прайса", () => {
    const rows = parityRows(goods(), [{ productName: "Удалённый товар", productId: "p-gone", quantity: 3 }], resolve);
    const o = rows.find((r) => r.productName === "Удалённый товар")!;
    assert.equal(o.status, "no_card");
    assert.equal(o.productId, null);
    assert.equal(rows.filter((r) => r.productId !== null).length, 4, "products = только позиции прайса");
  });
});
