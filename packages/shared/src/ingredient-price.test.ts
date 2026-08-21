import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cardPrice, pricePerGram } from "./ingredient-price";

describe("Цена ингредиента из карточки", () => {
  it("кг переводится в граммы", () => {
    // Кофе: 260 000 сум/кг с НДС → 260 сум/г
    assert.equal(pricePerGram({ "цена покупки": 260000, "единица": "кг" }), 260);
  });

  it("цена уже за грамм остаётся собой", () => {
    // MacCoffee: пакетик 20 г за 1600 → 80 сум/г
    assert.equal(pricePerGram({ "цена покупки": 80, "единица": "г" }), 80);
    // Сахар: дробная цена за грамм не округляется
    assert.equal(pricePerGram({ "цена покупки": 13.495, "единица": "г" }), 13.495);
  });

  it("штучная карточка не имеет цены за грамм", () => {
    // Стакан+крышка: 3600 сум/шт — вес тут смысла не имеет
    assert.equal(pricePerGram({ "цена покупки": 3600, "единица": "шт" }), null);
    assert.deepEqual(cardPrice({ "цена покупки": 3600, "единица": "шт" }), { price: 3600, unit: "шт" });
  });

  it("нет цены или единицы — null, а не ноль", () => {
    assert.equal(pricePerGram({ "единица": "кг" }), null);
    assert.equal(pricePerGram({ "цена покупки": 100000 }), null, "единица обязательна: 100 000 за кг и за грамм — разные деньги");
    assert.equal(pricePerGram(null), null);
    assert.equal(pricePerGram({ "цена покупки": "не число", "единица": "кг" }), null);
  });

  it("цена из строки с пробелами читается (карточки заводились руками)", () => {
    assert.equal(pricePerGram({ "цена покупки": "260 000", "единица": "кг" }), 260);
  });
});
