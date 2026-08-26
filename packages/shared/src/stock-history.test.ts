import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  canonicalProductName, decodeHtml, importNote, mapRefill, mapStockCount, placeFromImportNote, productIndex,
  reconcilePurchases, resolveProductName, stripMergedMarker, type DonorPurchaseRow, type PurchaseFacts,
} from "./stock-history";

/** Прайс mydon: канон знает только то, что реально есть в справочнике. */
const ПРАЙС = new Map([
  ["pepsi 0,5", "Pepsi 0,5"],
  ["m&ms", "M&Ms"],
  ["o'zbegim", "O'zbegim"],
  ["tuc sour cream", "TUC Sour cream"],
]);
const canon = (raw: string): string | null => ПРАЙС.get(raw.trim().toLowerCase()) ?? null;

/**
 * Каталог mydon как он есть: карточка + алиас владельца. Через него и проверяем
 * мост `ourvend_name` — на настоящем индексе, а не на подставленной функции.
 */
const КАТАЛОГ = productIndex(
  [
    { id: "p-cola", name: "Coca-Cola Classic CAN 0,25" },
    { id: "p-tuc", name: "TUC Sour cream" },
  ],
  [
    { productId: "p-cola", alias: "CocaCola Classic CAN 250ml" },
    { productId: "p-нет", alias: "Карточку удалили" },
  ],
);

describe("Индекс каталога: одна сборка на два вопроса (productIndex)", () => {
  it("канон по имени карточки и по алиасу — с id той же карточки", () => {
    assert.equal(КАТАЛОГ.canon("TUC Sour cream"), "TUC Sour cream");
    assert.equal(КАТАЛОГ.canon("CocaCola Classic CAN 250ml"), "Coca-Cola Classic CAN 0,25");
    assert.equal(КАТАЛОГ.id("CocaCola Classic CAN 250ml"), "p-cola");
  });
  it("сопоставление точное, но по той же нормализации, что весь вендинг", () => {
    assert.equal(КАТАЛОГ.canon("  tuc   sour cream "), "TUC Sour cream");
    assert.equal(КАТАЛОГ.canon("TUC Sour"), null);
    assert.equal(КАТАЛОГ.id("TUC Sour"), null);
  });
  it("алиас на удалённый товар в индекс не попадает: привязка к чему попало хуже NULL", () => {
    assert.equal(КАТАЛОГ.canon("Карточку удалили"), null);
    assert.equal(КАТАЛОГ.id("Карточку удалили"), null);
  });

  it("объём с запятой и с точкой — одна карточка (R-FW-P1)", () => {
    assert.equal(КАТАЛОГ.canon("Coca-Cola Classic CAN 0.25"), "Coca-Cola Classic CAN 0,25");
    assert.equal(КАТАЛОГ.id("Coca-Cola Classic CAN 0.25"), "p-cola");
  });
});

/**
 * Спор алиаса с именем ЧУЖОЙ карточки: нормализация гасит регистр, пробелы,
 * ё/е и десятичный знак, а уникальность в БД побайтовая — совпасть проще, чем
 * кажется (R-FW-S3).
 */
const СПОРНЫЙ = productIndex(
  [
    { id: "p-a", name: "Cola" },
    { id: "p-b", name: "Fanta CAN 0,25" },
  ],
  // Алиас товара A написан ровно так же, как ИМЯ карточки B.
  [{ productId: "p-a", alias: "Fanta can 0.25" }],
);

describe("Индекс каталога: точное имя карточки главнее алиаса (R-FW-S3)", () => {
  it("имя карточки побеждает чужой алиас с тем же ключом", () => {
    assert.equal(СПОРНЫЙ.canon("Fanta CAN 0,25"), "Fanta CAN 0,25");
    assert.equal(СПОРНЫЙ.id("Fanta CAN 0,25"), "p-b");
  });

  it("`explain` называет спор словами — писать необратимую ссылку по нему нельзя", () => {
    assert.deepEqual(СПОРНЫЙ.explain("Fanta CAN 0,25"), {
      kind: "conflict",
      byName: "Fanta CAN 0,25",
      byAlias: "Cola",
    });
  });

  it("алиас на СВОЮ карточку спором не считается", () => {
    const свой = productIndex([{ id: "p-b", name: "Fanta CAN 0,25" }], [{ productId: "p-b", alias: "fanta can 0.25" }]);
    assert.deepEqual(свой.explain("Fanta CAN 0,25"), {
      kind: "hit",
      canon: "Fanta CAN 0,25",
      id: "p-b",
      source: "name",
    });
  });

  it("`explain` называет ИСТОЧНИК решения: имя карточки или алиас", () => {
    assert.deepEqual(КАТАЛОГ.explain("CocaCola Classic CAN 250ml"), {
      kind: "hit",
      canon: "Coca-Cola Classic CAN 0,25",
      id: "p-cola",
      source: "alias",
    });
    assert.deepEqual(КАТАЛОГ.explain("TUC Sour cream"), {
      kind: "hit",
      canon: "TUC Sour cream",
      id: "p-tuc",
      source: "name",
    });
    assert.deepEqual(КАТАЛОГ.explain("Загадка"), { kind: "miss" });
  });
});

describe("Мост ourvend_name: второй ТОЧНЫЙ ключ (R-FW-P1)", () => {
  it("имени донора карточки нет, а `ourvend_name` ложится на алиас владельца", () => {
    assert.deepEqual(
      resolveProductName("Coca Cola CAN 0.25", "CocaCola Classic CAN 250ml", КАТАЛОГ.canon),
      ["Coca-Cola Classic CAN 0,25", true],
    );
  });
  it("своё имя карточку имеет — мост не спрашивают вовсе", () => {
    assert.deepEqual(resolveProductName("TUC Sour cream", "CocaCola Classic CAN 250ml", КАТАЛОГ.canon), ["TUC Sour cream", true]);
  });
  it("не нашлось ни по одному ключу — едет ДОНОРСКОЕ имя, а не вендорское", () => {
    assert.deepEqual(resolveProductName("Moxito Mango CAN 0.45", "Moxito Mango 450ml", КАТАЛОГ.canon), ["Moxito Mango CAN 0.45", false]);
  });
  it("пустой `ourvend_name` (28 карточек из 62) — не повод искать пустоту в прайсе", () => {
    assert.deepEqual(resolveProductName("Moxito Mango CAN 0.45", "   ", КАТАЛОГ.canon), ["Moxito Mango CAN 0.45", false]);
    assert.deepEqual(resolveProductName("Moxito Mango CAN 0.45", null, КАТАЛОГ.canon), ["Moxito Mango CAN 0.45", false]);
  });
  it("мост работает и в заливе, и в инвентаризации — привязка к карточке одна", () => {
    const залив = mapRefill(
      { id: 1, dt: "2026-07-05", machine_serial: "C2508160376", product: "Coca Cola CAN 0.25", ourvend_name: "CocaCola Classic CAN 250ml", qty: "7" },
      КАТАЛОГ.canon,
    );
    const пересчёт = mapStockCount(
      { id: 2, dt: "2026-07-05", product: "Coca Cola CAN 0.25", ourvend_name: "CocaCola Classic CAN 250ml", qty: "10", counted_at: null },
      КАТАЛОГ.canon,
    );
    assert.ok(залив.ok && залив.row.productName === "Coca-Cola Classic CAN 0,25" && залив.rawName === null);
    assert.ok(пересчёт.ok && пересчёт.row.productName === "Coca-Cola Classic CAN 0,25" && пересчёт.rawName === null);
  });
});

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

describe("Заставы годности донорской строки (R-FW-S2)", () => {
  const залив = (over: Record<string, unknown> = {}) =>
    mapRefill({ id: 412, dt: "2026-04-22", machine_serial: "C2508160376", product: "TUC Sour cream", qty: "6", ...over }, canon);
  const пересчёт = (over: Record<string, unknown> = {}) =>
    mapStockCount({ id: 77, dt: "2026-07-14", product: "TUC Sour cream", qty: "24", counted_at: null, ...over }, canon);

  it("U+0000 в имени — причина, а не «invalid byte sequence» на 500 строк", () => {
    // `decodeHtml` разворачивает `&#0;` честно; Postgres на этот байт роняет пачку.
    assert.deepEqual(пересчёт({ product: "TUC&#0; Sour cream" }), {
      ok: false, reason: "control_chars", extId: "77", product: "TUC Sour cream",
    });
    assert.equal((залив({ product: "TUC&#0;" }) as { product: string }).product, "TUC", "имя в отчёте уже очищено");
  });
  it("qty за пределом INTEGER — это не «негодный qty», а переполнение колонки", () => {
    assert.deepEqual(залив({ qty: "3000000000" }), { ok: false, reason: "out_of_range", extId: "412", product: "TUC Sour cream" });
    assert.ok(залив({ qty: "2147483647" }).ok, "ровно потолок колонки — годится");
  });
  it("пересчёт за пределом numeric(12,2) тоже отказывается диапазоном", () => {
    assert.deepEqual(пересчёт({ qty: "1e10" }), { ok: false, reason: "out_of_range", extId: "77", product: "TUC Sour cream" });
    assert.ok(пересчёт({ qty: "9999999999.99" }).ok, "ровно потолок колонки — годится");
  });
  it("бесконечность отделена от «не числа»: причины разные, обе — отказ", () => {
    assert.equal((залив({ qty: "1e400" }) as { reason: string }).reason, "out_of_range");
    assert.equal((залив({ qty: "не число" }) as { reason: string }).reason, "bad_qty");
    assert.equal((пересчёт({ qty: Number.POSITIVE_INFINITY }) as { reason: string }).reason, "out_of_range");
  });
  it("строка донора без карточки товара названа, а не потеряна по дороге", () => {
    // SELECT тянет товар LEFT JOIN'ом ровно ради этого: `product_name` у нас NOT NULL.
    assert.deepEqual(пересчёт({ product: null }), { ok: false, reason: "no_product", extId: "77", product: "" });
    assert.deepEqual(залив({ product: null }), { ok: false, reason: "no_product", extId: "412", product: "" });
  });
});

describe("Место складской инвентаризации в note (R-FW-P2)", () => {
  const пересчёт = (location_name: string | null) =>
    mapStockCount({ id: 77, dt: "2026-07-05", product: "TUC Sour cream", qty: "7", counted_at: null, location_name }, canon);

  it("три места донора различимы: имя места едет в note", () => {
    const r = пересчёт("Холодильник");
    assert.ok(r.ok && r.row.note === "импорт истории mydon-stock · место: Холодильник");
  });
  it("места нет — пометка прежняя, лишнего разделителя не появляется", () => {
    const r = пересчёт(null);
    assert.ok(r.ok && r.row.note === "импорт истории mydon-stock");
  });
  it("две строки одного дня из разных мест читаются как разные, а не как двойной ввод", () => {
    const основной = пересчёт("Склад (основной)"), холодильник = пересчёт("Oq apparat (склад)");
    assert.ok(основной.ok && холодильник.ok && основной.row.note !== холодильник.row.note);
  });
});

describe("Место из пометки импорта: обратная к importNote (R-H-2)", () => {
  it("круг замыкается: место, уехавшее в note, читается из note обратно", () => {
    // Правило записи и правило разбора стоят рядом ИМЕННО ради этого теста:
    // разъехавшись, они не упали бы нигде — заголовок листа просто перестал бы
    // сокращаться, и заметить это было бы нечем.
    for (const место of ["Холодильник", "Склад (основной)", "Oq apparat (склад)"]) {
      assert.equal(placeFromImportNote(importNote(место)), место, место);
    }
  });

  it("пометка импорта БЕЗ места места не выдаёт: null, а не пустая строка и не «Основной склад»", () => {
    assert.equal(placeFromImportNote(importNote(null)), null);
    assert.equal(placeFromImportNote("импорт истории mydon-stock"), null);
  });

  it("своя пометка местом не притворяется: у `own` в note стоит ЧЕЛОВЕК", () => {
    // Лист различает смыслы по `source`, но и разбор обязан молчать: прочитай
    // он «Рустам» как место — оператор уехал бы в заголовок склада.
    assert.equal(placeFromImportNote("Рустам"), null);
    assert.equal(placeFromImportNote(""), null);
    assert.equal(placeFromImportNote("место: Холодильник"), null);
  });

  it("разбор берёт весь хвост: имя места с разделителем внутри не режется", () => {
    const место = "Склад · место: дальний";
    assert.equal(placeFromImportNote(importNote(место)), место);
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
  it("наши строки без донорского близнеца названы, но не удаляются", () => {
    assert.deepEqual(r.onlyMine, ["9"]);
  });
  it("годные строки донора в отказ не попадают", () => {
    assert.deepEqual(r.rejected, []);
  });
  it("негодная строка донора не дописывается в зеркало, а называется причиной", () => {
    // Зеркало сверка обязана только ДОПОЛНЯТЬ: `?? 0` записал бы настоящий ноль,
    // а негодная дата ушла бы в `date NOT NULL` и уронила пачку (R-FW-S3).
    const r2 = reconcilePurchases([], [
      { id: 10, dt: "позавчера", product: "TUC Sour cream", qty: "6", unit_price: "1" },
      { id: 11, dt: "2026-07-13", product: "TUC Sour cream", qty: "н/д", unit_price: "1" },
      { id: 12, dt: "2026-07-13", product: "TUC Sour cream", qty: "6", unit_price: "бесплатно" },
      { id: 13, dt: "2026-07-13", product: null, qty: "6", unit_price: "1" },
    ]);
    assert.deepEqual(r2.missing, []);
    assert.deepEqual(r2.rejected, [
      { extId: "10", reason: "no_date", value: "позавчера" },
      { extId: "11", reason: "bad_qty", value: "н/д" },
      { extId: "12", reason: "bad_price", value: "бесплатно" },
      { extId: "13", reason: "no_product", value: "" },
    ]);
  });
  it("пустая цена — законное «цены нет» (158 строк 2025), а не мусор", () => {
    const r2 = reconcilePurchases([], [{ id: 14, dt: "2025-08-18", product: "TUC Sour cream", qty: "24", unit_price: null }]);
    assert.deepEqual([r2.rejected, r2.missing], [[], [{ extId: "14", dt: "2025-08-18", product: "TUC Sour cream", qty: 24, unitPrice: null }]]);
  });
  it("мусор в строке, которая у нас ЕСТЬ, — расхождение с СЫРЫМ значением донора", () => {
    // «у донора 0» там, где у него «н/д», было бы нашей выдумкой в отчёте о его данных.
    const r2 = reconcilePurchases(
      [{ extId: "15", dt: "2026-07-13", product: "TUC Sour cream", qty: 6, unitPrice: 100 }],
      [{ id: 15, dt: "2026-07-13", product: "TUC Sour cream", qty: "н/д", unit_price: "100" }],
    );
    assert.deepEqual(r2.differing, [{ extId: "15", field: "qty", mine: 6, donor: "н/д" }]);
    assert.deepEqual([r2.missing, r2.rejected], [[], []]);
  });
  it("копеечная разница numeric против float расхождением не считается", () => {
    const r2 = reconcilePurchases([{ extId: "1", dt: "2025-08-18", product: "Pepsi 0,5", qty: 24, unitPrice: 2600 }],
      [{ id: 1, dt: "2025-08-18", product: "Pepsi 0,5", qty: "24.000", unit_price: "2600.001" }]);
    assert.deepEqual([r2.missing, r2.differing, r2.onlyMine], [[], [], []]);
  });
});
