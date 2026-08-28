import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BARCODE_DIGITS,
  classifyIkpu,
  fiscalFlaws,
  fiscalReady,
  normalizeFiscalInput,
  PACKAGE_CODES,
  validateFiscalPatch,
  VAT_RATES,
  type ProductFiscal,
} from "./fiscal";

const ПОЛНЫЙ: ProductFiscal = {
  ikpu: "02202003001086002",
  mxik: null,
  vatPct: 12,
  barcode: null,
  packageCode: "796",
  marked: false,
};

describe("Фискальный блок: проверка патча (R-P6-6)", () => {
  it("ИКПУ из 17 цифр принят, из 16 — отвергнут текстом донора", () => {
    assert.deepEqual(validateFiscalPatch({ ikpu: "02202003001086002" }), []);
    assert.deepEqual(validateFiscalPatch({ ikpu: "2202002001010032" }), [
      "ИКПУ должен быть 17 цифр или пусто",
    ]);
  });

  it("пусто законно и для ИКПУ, и для МХИК, и для штрихкода", () => {
    assert.deepEqual(validateFiscalPatch({ ikpu: null, mxik: null, barcode: null }), []);
  });

  it("штрихкод: 8, 12 и 13 цифр приняты, 10 — отвергнут", () => {
    for (const n of BARCODE_DIGITS) {
      assert.deepEqual(validateFiscalPatch({ barcode: "1".repeat(n) }), [], `${n} цифр — законная длина EAN`);
    }
    assert.deepEqual(validateFiscalPatch({ barcode: "1".repeat(10) }), [
      "Штрихкод должен быть 8/12/13 цифр или пусто",
    ]);
  });

  it("пробелы, NBSP, узкий пробел и дефисы в коде разделителями не считаются", () => {
    assert.deepEqual(validateFiscalPatch({ ikpu: "022 0200-3001 086 002" }), []);
    assert.equal(normalizeFiscalInput("022 0200-3001 086 002"), "02202003001086002");
    assert.equal(normalizeFiscalInput("   "), null, "пустая строка — это сброс, а не значение");
    assert.equal(normalizeFiscalInput(undefined), null);
  });

  it("МХИК проверяется тем же правилом, что ИКПУ, — правило донора, не норма", () => {
    assert.deepEqual(validateFiscalPatch({ mxik: "1".repeat(17) }), []);
    assert.deepEqual(validateFiscalPatch({ mxik: "1".repeat(16) }), [
      "МХИК должен быть 17 цифр или пусто",
    ]);
  });

  it("ставка вне набора 12/0/15 отвергнута, а сам набор — донорский", () => {
    assert.deepEqual(
      VAT_RATES.map((r) => r.code),
      ["12", "0", "15"],
    );
    assert.deepEqual(validateFiscalPatch({ vatPct: 0 }), [], "нулевая ставка — законное значение");
    assert.deepEqual(validateFiscalPatch({ vatPct: 7 }), ["Ставка НДС — одно из: 12, 0, 15"]);
  });

  it("`packageCode` вне словаря ОКЕИ отвергнут — 1218841 это не единица (R-P6-7)", () => {
    assert.deepEqual(validateFiscalPatch({ packageCode: "1218841" }), ["Код упаковки — 3 цифры ОКЕИ"]);
    assert.deepEqual(validateFiscalPatch({ packageCode: "796" }), []);
    assert.equal(PACKAGE_CODES.length, 7, "семь значений словаря донора");
    assert.ok(PACKAGE_CODES.every((p) => /^\d{3}$/.test(p.code)));
  });
});

describe("Фискальный блок: готовность и дыры", () => {
  it("`fiscalReady` требует ИКПУ и код упаковки; маркировка на чек не влияет", () => {
    assert.equal(fiscalReady(ПОЛНЫЙ), true);
    assert.equal(fiscalReady({ ...ПОЛНЫЙ, marked: true }), true, "КИЗ — не про сборку чека");
    assert.equal(fiscalReady({ ...ПОЛНЫЙ, ikpu: null }), false);
    assert.equal(fiscalReady({ ...ПОЛНЫЙ, ikpu: "2202002001010032" }), false, "огрызок кода — не готовность");
  });

  it("«нет» и «неверно» — разные беды и называются раздельно", () => {
    assert.deepEqual(fiscalFlaws({ ...ПОЛНЫЙ, ikpu: null }), [
      { field: "ikpu", flaw: "нет", why: "код не выяснен" },
    ]);
    const кривой = fiscalFlaws({ ...ПОЛНЫЙ, ikpu: "2202002001010032" });
    assert.equal(кривой.length, 1);
    assert.equal(кривой[0].flaw, "неверно");
    assert.match(кривой[0].why, /17 цифр, а тут 16/, "владелец должен понять, что именно чинить");
  });

  it("ставка 0 дырой не считается, а маркировка дырой не бывает вовсе", () => {
    assert.deepEqual(fiscalFlaws({ ...ПОЛНЫЙ, vatPct: 0 }), []);
    assert.deepEqual(fiscalFlaws({ ...ПОЛНЫЙ, marked: false }), []);
  });
});

describe("Категорийный ИКПУ решает справочник донора (R-P6-9)", () => {
  const СПРАВОЧНИК = new Map([
    ["02202002001000000", "Газнапитки (категория)"],
    ["01806001001000000", "Шоколадные батончики (категория)"],
    ["02202003001086002", "Lit Energy Blueberry 0,45"],
    ["02202003001086009", "Странный SKU с нулями 000000"],
  ]);

  it("код, подписанный «(категория)», — категорийный", () => {
    assert.deepEqual(classifyIkpu("02202002001000000", СПРАВОЧНИК), { kind: "category" });
  });

  it("код, подписанный именем товара, — SKU", () => {
    assert.deepEqual(classifyIkpu("02202003001086002", СПРАВОЧНИК), { kind: "sku" });
  });

  it("кода нет в справочнике донора → unknown, а не догадка", () => {
    const ответ = classifyIkpu("09999999999999999", СПРАВОЧНИК);
    assert.equal(ответ.kind, "unknown");
    assert.match((ответ as { why: string }).why, /справочник/i);
  });

  it("справочник говорит SKU, а суффикс `000000` — расхождение → unknown", () => {
    const ответ = classifyIkpu("02202003001000000", new Map([["02202003001000000", "Товар без пометки"]]));
    assert.equal(ответ.kind, "unknown");
    assert.match((ответ as { why: string }).why, /суффикс/i);
  });
});
