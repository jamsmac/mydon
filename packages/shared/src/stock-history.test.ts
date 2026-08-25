import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalProductName, decodeHtml, mapRefill, mapStockCount, reconcilePurchases,
  stripMergedMarker, type DonorPurchaseRow, type PurchaseFacts,
} from "./stock-history";

/** Прайс mydon: канон знает только то, что реально есть в справочнике. */
const ПРАЙС = new Map([
  ["pepsi 0,5", "Pepsi 0,5"],
  ["m&ms", "M&Ms"],
  ["o'zbegim", "O'zbegim"],
  ["tuc sour cream", "TUC Sour cream"],
]);
const canon = (raw: string): string | null => ПРАЙС.get(raw.trim().toLowerCase()) ?? null;

describe("HTML-мусор панели склада (R-P8a-7)", () => {
  it("энтити декодируются до нормализации", () => {
    assert.equal(decodeHtml("M&amp;Ms"), "M&Ms");
    assert.equal(decodeHtml("O&#39;zbegim"), "O'zbegim");
  });
  it("один проход: двойное кодирование не разворачивается до конца", () => {
    // `&amp;amp;` — это закодированное `&amp;`, а не `&`. Второй проход соврал бы.
    assert.equal(decodeHtml("M&amp;amp;Ms"), "M&amp;Ms");
  });
  it("после декода имя ложится на карточку прайса", () => {
    assert.deepEqual(canonicalProductName("M&amp;Ms", canon), ["M&Ms", true]);
    assert.deepEqual(canonicalProductName("O&#39;zbegim", canon), ["O'zbegim", true]);
  });
});

describe("Донорская пометка слияния карточек", () => {
  it("[слит→N] снимается, товар ложится на канон", () => {
    assert.equal(stripMergedMarker("Pepsi 0,5 [слит→23]"), "Pepsi 0,5");
    assert.deepEqual(canonicalProductName("Pepsi 0,5 [слит→23]", canon), ["Pepsi 0,5", true]);
  });
  it("канона нет — сырое имя и признак «не разрешено», а не подстановка похожего", () => {
    // «Moxito Mango CAN 0.45» — одно из 14 имён без ourvend_name. Нечёткое
    // сопоставление склеило бы 330ml с 450ml, поэтому его здесь нет вовсе.
    assert.deepEqual(canonicalProductName("Moxito Mango CAN 0.45", canon), ["Moxito Mango CAN 0.45", false]);
  });
});

describe("Заливы: 107 по живым автоматам, 348 «общих» — мимо (R-P8a-2)", () => {
  const строка = (over: Partial<Parameters<typeof mapRefill>[0]> = {}) =>
    mapRefill({ id: 412, dt: "2026-04-22", machine_serial: "C2508160376", product: "TUC Sour cream", qty: "6", ...over }, canon);

  it("серийник приведён к канону, момент — полдень Ташкента", () => {
    const r = строка();
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.row.machineSerial, "2508160376");
    assert.equal(r.row.performedAt, "2026-04-22T07:00:00.000Z"); // 12:00 +05
    assert.deepEqual([r.row.clientKey, r.row.source, r.row.personId, r.row.qty], ["stock:refill:412", "stock-import", null, 6]);
    assert.equal(r.rawName, null);
  });
  it("виртуальный «общий» аппарат без серийника не импортируется", () => {
    const r = строка({ machine_serial: null });
    assert.deepEqual(r, { ok: false, reason: "no_serial", extId: "412", product: "TUC Sour cream" });
  });
  it("дубль по естественному ключу остаётся дублем: ключ идёт от id", () => {
    // 7 групп дублей у донора — законные повторные заливки, а не ошибка ввода.
    const a = строка({ id: 500 }), b = строка({ id: 501 });
    assert.ok(a.ok && b.ok && a.row.clientKey !== b.row.clientKey);
  });
  it("имя без канона едет сырым и называется в отчёте", () => {
    const r = строка({ product: "Moxito Mango CAN 0.45" });
    assert.ok(r.ok && r.row.productName === "Moxito Mango CAN 0.45" && r.rawName === "Moxito Mango CAN 0.45");
  });
});

describe("Инвентаризации склада: 460 строк (R-P8a-3, R-P8a-7)", () => {
  it("dt, qty и counted_at донора едут как есть, ключ — ext_id", () => {
    const r = mapStockCount({ id: 77, dt: "2025-08-17", product: "Pepsi 0,5 [слит→23]", qty: "24.00", counted_at: "2025-08-17T09:00:00+05:00" }, canon);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.deepEqual([r.row.dt, r.row.qty, r.row.extId, r.row.productName], ["2025-08-17", 24, "77", "Pepsi 0,5"]);
    assert.equal(r.row.countedAt, "2025-08-17T04:00:00.000Z");
  });
  it("counted_at пустой → полдень тех же ташкентских суток, а не полночь UTC", () => {
    const r = mapStockCount({ id: 78, dt: "2025-08-17", product: "TUC Sour cream", qty: 3, counted_at: null }, canon);
    assert.ok(r.ok && r.row.countedAt === "2025-08-17T07:00:00.000Z");
  });
  it("«Недостача (Рустам)» — служебная строка, в историю не идёт", () => {
    const r = mapStockCount({ id: 79, dt: "2026-07-14", product: "Недостача (Рустам)", qty: 1, counted_at: null }, canon);
    assert.deepEqual(r, { ok: false, reason: "service_row", extId: "79", product: "Недостача (Рустам)" });
  });
});

describe("Сверка закупок по ext_id: дописать, но не править (R-P8a-1)", () => {
  const мои: PurchaseFacts[] = [
    { extId: "1", dt: "2025-08-18", product: "Pepsi 0,5", qty: 24, unitPrice: 0 },
    { extId: "2", dt: "2026-07-13", product: "TUC Sour cream", qty: 10, unitPrice: 2600 },
    { extId: "9", dt: "2026-07-13", product: "Удалённый у донора", qty: 1, unitPrice: 100 },
  ];
  const донор: DonorPurchaseRow[] = [
    { id: 1, dt: "2025-08-18", product: "Pepsi 0,5", qty: "24", unit_price: "0" },
    { id: 2, dt: "2026-07-13", product: "TUC Sour cream", qty: "12", unit_price: "2600" },
    { id: 3, dt: "2026-07-13", product: "M&amp;Ms", qty: "6", unit_price: "8000" },
  ];
  const r = reconcilePurchases(мои, донор);

  it("недостающая строка донора попадает в missing с декодированным именем", () => {
    assert.deepEqual(r.missing, [{ extId: "3", dt: "2026-07-13", product: "M&Ms", qty: 6, unitPrice: 8000 }]);
  });
  it("расхождение названо, но правкой не становится", () => {
    assert.deepEqual(r.differing, [{ extId: "2", field: "qty", mine: 10, donor: 12 }]);
  });
  it("наши строки без донорского близнеца — 39 удалённых id, их не удаляем", () => {
    assert.deepEqual(r.onlyMine, ["9"]);
  });
  it("копеечная разница numeric против float расхождением не считается", () => {
    const r2 = reconcilePurchases([{ extId: "1", dt: "2025-08-18", product: "Pepsi 0,5", qty: 24, unitPrice: 2600 }],
      [{ id: 1, dt: "2025-08-18", product: "Pepsi 0,5", qty: "24.000", unit_price: "2600.001" }]);
    assert.deepEqual([r2.missing, r2.differing, r2.onlyMine], [[], [], []]);
  });
});
