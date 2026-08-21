import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { matchContractorByName, normalizeContractorName } from "./contractor-name";

/**
 * Все пары ниже сняты с живых данных 21.08.2026: слева — как владелец написал
 * поставщика на карточке сырья, справа — как контрагент пришёл из Didox.
 * Точное сравнение строк сходилось ровно в одном случае из восьми.
 */
const ЖИВЫЕ_КОНТРАГЕНТЫ = [
  { id: "k1", name: 'ООО "KMS ROASTING TRADING"' },
  { id: "k2", name: "REGISTON HOLDING MCHJ" },
  { id: "k3", name: '"NEXT ARTIFICIAL SOLUTIONS" MCHJ' },
  { id: "k4", name: "ANGLESEY FOOD MCHJ XK" },
  { id: "k5", name: "DENIZ RETAIL" },
  { id: "k6", name: '"AURATRADE 18" MCHJ' },
];

describe("Поставщик с карточки сырья → карточка контрагента", () => {
  it("восемь живых поставщиков находят свою карточку", () => {
    const пары: [string, string][] = [
      ["KMS ROASTING TRADING", "k1"],
      ["REGISTON HOLDING", "k2"],
      ["NEXT ARTIFICIAL SOLUTIONS", "k3"],
      ["ANGLESEY FOOD (розница, корпоративная карта)", "k4"],
      ["DENIZ RETAIL", "k5"],
      ["AURATRADE 18", "k6"],
    ];
    for (const [поставщик, ожидаемый] of пары) {
      const found = matchContractorByName(поставщик, ЖИВЫЕ_КОНТРАГЕНТЫ);
      assert.equal(found?.id, ожидаемый, `«${поставщик}» должен найти ${ожидаемый}`);
    }
  });

  it("номер в имени — часть имени, а не юридическая форма", () => {
    // «AURATRADE 18» и гипотетическая «AURATRADE 19» — разные поставщики.
    const два = [...ЖИВЫЕ_КОНТРАГЕНТЫ, { id: "k7", name: '"AURATRADE 19" MCHJ' }];
    assert.equal(matchContractorByName("AURATRADE 18", два)?.id, "k6");
    assert.equal(matchContractorByName("AURATRADE 19", два)?.id, "k7");
  });

  it("одноимённые карточки не разводятся угадыванием", () => {
    // Два контрагента с одинаковым нормализованным именем — честное null,
    // иначе история закупок молча уехала бы на чужую карточку.
    const дубли = [
      { id: "a", name: 'ООО "DENIZ RETAIL"' },
      { id: "b", name: "DENIZ RETAIL MCHJ" },
    ];
    assert.equal(matchContractorByName("DENIZ RETAIL", дубли), null);
  });

  it("чужого не находит", () => {
    assert.equal(matchContractorByName("НЕИЗВЕСТНЫЙ ПОСТАВЩИК", ЖИВЫЕ_КОНТРАГЕНТЫ), null);
    assert.equal(matchContractorByName("", ЖИВЫЕ_КОНТРАГЕНТЫ), null);
    assert.equal(matchContractorByName(null, ЖИВЫЕ_КОНТРАГЕНТЫ), null);
    assert.equal(matchContractorByName(undefined, ЖИВЫЕ_КОНТРАГЕНТЫ), null);
  });

  it("одни юридические формы без имени — не имя", () => {
    // «ООО» само по себе не должно совпасть ни с чем: после нормализации
    // строка пуста, а пустое равенство связало бы всё со всем.
    assert.equal(normalizeContractorName("ООО"), "");
    assert.equal(matchContractorByName("ООО", [{ id: "x", name: "MCHJ" }]), null);
  });

  it("нормализация снимает кавычки, форму, скобки и регистр", () => {
    assert.equal(normalizeContractorName('ООО "KMS ROASTING TRADING"'), "kms roasting trading");
    assert.equal(normalizeContractorName("ANGLESEY FOOD (розница, корпоративная карта)"), "anglesey food");
    assert.equal(normalizeContractorName("  Deniz   Retail  "), "deniz retail");
  });
});
