import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { suggestCard, type CardRef } from "./batch-import";
import type { RegisterRow } from "./purchase-register";

/** Строка реестра с разумными значениями по умолчанию — тесту важны только name/supplier. */
function row(overrides: Partial<RegisterRow> & Pick<RegisterRow, "name" | "supplier">): RegisterRow {
  return {
    fileRow: 1,
    group: null,
    year: 2025,
    inn: null,
    unit: "шт",
    qty: 1,
    priceGross: null,
    costGross: null,
    invoiceRaw: null,
    invoiceNo: null,
    invoiceDate: null,
    payDate: null,
    receivedOn: null,
    dateProblem: null,
    note: null,
    ...overrides,
  };
}

/**
 * Живые карточки ингредиентов (список владельца, 21.08.2026). Пять несут
 * `attrs["поставщик"]` — ровно те пять поставщиков, у которых в реестре
 * только одно наименование (`register-analysis.md`).
 */
const КАРТОЧКИ: CardRef[] = [
  { id: "ing-coffee", name: "Кофе", type: "ingredient", attrs: { "поставщик": "KMS ROASTING TRADING" } },
  { id: "ing-milk", name: "Сухое молоко", type: "ingredient", attrs: { "поставщик": "AURATRADE 18" } },
  { id: "ing-maccoffee", name: "MacCoffee", type: "ingredient", attrs: { "поставщик": "REGISTON HOLDING" } },
  { id: "ing-matcha", name: "Матча", type: "ingredient", attrs: { "поставщик": "DENIZ RETAIL" } },
  { id: "ing-choco", name: "Шоколад", type: "ingredient" },
  { id: "ing-berry", name: "Ягодный чай", type: "ingredient" },
  { id: "ing-lemon", name: "Лимонный чай", type: "ingredient" },
  { id: "ing-sugar", name: "Сахар", type: "ingredient" },
  { id: "ing-cup", name: "Стакан+крышка", type: "ingredient" },
];

/** Девять живых наименований NEXT ARTIFICIAL SOLUTIONS (register_full.json) — один поставщик, много товаров, решает ключевое слово. */
const ДЕВЯТЬ_СТРОК_NEXT: RegisterRow[] = [
  "Питьевой шоколад VENESSA VDC 15",
  "Питьевой шоколадVENESSA VDC 15",
  "Продукт растворимый 'Topping\" TM \"ALMAFOOD\" 1 кг",
  "Чай VENESSA VL 2.5 Lemon",
  "Чай VENESSA VL 2.5 Lemon 1 кг",
  "Чай VENESSA VLT 2.5 со вкусом лимона",
  "Чай VENESSA VWT 2.5 со вкусом лесных ягод",
  "Чай VENESSA WL 2.5 со вкусом лесные ягоды",
  "Чай VENESSA WL 2.5 со вкусом лесных ягод",
].map((name) => row({ name, supplier: "NEXT ARTIFICIAL SOLUTIONS" }));

describe("Предложение карточки по строке реестра (suggestCard)", () => {
  it("точное совпадение имён — основание exact", () => {
    // Сегодня таких строк 0 (register-analysis.md), но правило первое в порядке.
    const строка = row({ name: "Кофе", supplier: "НЕВАЖНО" });
    const s = suggestCard(строка, КАРТОЧКИ, []);
    assert.equal(s.basis, "exact");
    assert.equal(s.cardId, "ing-coffee");
    assert.match(s.reason, /Кофе/);
  });

  it("поставщик с единственным наименованием — сильное основание", () => {
    // KMS ROASTING TRADING поставляет только кофе, и он записан в карточке «Кофе».
    const строкаKMS = row({ name: "Кофе жареный в зёрнах KMS blend 1 (1кг)", supplier: "KMS ROASTING TRADING" });
    const s = suggestCard(строкаKMS, КАРТОЧКИ, [строкаKMS]);
    assert.equal(s.basis, "supplier");
    assert.equal(s.cardId, "ing-coffee");
    assert.match(s.reason, /KMS ROASTING TRADING/);
  });

  it("остальные поставщики с единственным наименованием", () => {
    const пары: [string, string, string][] = [
      ["AURATRADE 18", "RISTORA сухое молоко", "ing-milk"],
      ["REGISTON HOLDING", "MacCoffee 3 в 1", "ing-maccoffee"],
      ["DENIZ RETAIL", "Matcha latte Зеленая  500 гр,", "ing-matcha"],
    ];
    for (const [supplier, name, cardId] of пары) {
      const строка = row({ name, supplier });
      const s = suggestCard(строка, КАРТОЧКИ, [строка]);
      assert.equal(s.basis, "supplier", `${supplier} → ${cardId}`);
      assert.equal(s.cardId, cardId);
    }
  });

  it("поставщик с единственным наименованием, но карточки нет — честное отсутствие, а не соседняя карточка", () => {
    // BILLUR SUV возит только воду, но карточки воды нет вовсе (register-analysis.md).
    const строка = row({ name: "HYDROLIFE ECO 18.9 л. в капсулах", supplier: "BILLUR SUV" });
    const s = suggestCard(строка, КАРТОЧКИ, [строка]);
    assert.equal(s.cardId, null);
    assert.equal(s.basis, null);
  });

  it("у поставщика много наименований — решает ключевое слово", () => {
    // NEXT ARTIFICIAL SOLUTIONS возит и шоколад, и чаи, и топпинг: одно
    // наименование поставщика не годится основанием (девять разных строк).
    const шоколад = ДЕВЯТЬ_СТРОК_NEXT[0]!;
    const лимонныйЧай = ДЕВЯТЬ_СТРОК_NEXT[5]!; // «...со вкусом лимона»
    const ягодныйЧай = ДЕВЯТЬ_СТРОК_NEXT[6]!; // «...со вкусом лесных ягод»

    assert.equal(suggestCard(шоколад, КАРТОЧКИ, ДЕВЯТЬ_СТРОК_NEXT).cardId, "ing-choco");
    assert.equal(suggestCard(лимонныйЧай, КАРТОЧКИ, ДЕВЯТЬ_СТРОК_NEXT).cardId, "ing-lemon");
    assert.equal(suggestCard(ягодныйЧай, КАРТОЧКИ, ДЕВЯТЬ_СТРОК_NEXT).cardId, "ing-berry");

    const s = suggestCard(шоколад, КАРТОЧКИ, ДЕВЯТЬ_СТРОК_NEXT);
    assert.equal(s.basis, "keyword");
    assert.match(s.reason, /Шоколад/);
  });

  it("топпинг NEXT ARTIFICIAL SOLUTIONS — карточки нет, честное отсутствие", () => {
    const топпинг = ДЕВЯТЬ_СТРОК_NEXT[2]!;
    const s = suggestCard(топпинг, КАРТОЧКИ, ДЕВЯТЬ_СТРОК_NEXT);
    assert.equal(s.cardId, null);
    assert.equal(s.basis, null);
  });

  it("нет оснований — честное отсутствие предложения, а не первая попавшаяся карточка", () => {
    const сироп = row({ name: 'Сироп "Малина" 1л', supplier: "TULYAGANOV DMITRIY GROUP" });
    const s = suggestCard(сироп, КАРТОЧКИ, []);
    assert.equal(s.cardId, null);
    assert.equal(s.basis, null);
  });

  it("два слова-кандидата в одном имени — предложения нет", () => {
    // «Питьевой шоколад ... со вкусом лесных ягод» не должен молча уйти в шоколад
    // (и не должен молча уйти в «Ягодный чай»): имя несёт признаки ДВУХ карточек.
    const двусмысленное = row({
      name: "Питьевой шоколад со вкусом лесных ягод",
      supplier: "NEXT ARTIFICIAL SOLUTIONS",
    });
    const s = suggestCard(двусмысленное, КАРТОЧКИ, []);
    assert.equal(s.cardId, null);
    assert.equal(s.basis, null);
  });

  it("карточка другого типа не предлагается — нужны только ингредиенты (R-D2)", () => {
    const строка = row({ name: "Кофе", supplier: "НЕВАЖНО" });
    const толькоТовар: CardRef[] = [{ id: "prod-x", name: "Кофе", type: "product" }];
    const s = suggestCard(строка, толькоТовар, []);
    assert.equal(s.cardId, null);
    assert.equal(s.basis, null);
  });

  it("пустой набор карточек — честное отсутствие", () => {
    const строка = row({ name: "Кофе", supplier: "НЕВАЖНО" });
    const s = suggestCard(строка, [], []);
    assert.equal(s.cardId, null);
    assert.equal(s.basis, null);
  });
});
