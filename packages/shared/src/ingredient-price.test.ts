import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cardPrice, pricePerGram, resolveIngredientPrice } from "./ingredient-price";

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

  it("ноль — настоящая цена, а не «данных нет»", () => {
    // Бесплатное сырьё (образец, бонус поставщика) бывает; подменить его на
    // null значило бы потерять товар из расчёта себестоимости целиком.
    assert.equal(pricePerGram({ "цена покупки": 0, "единица": "кг" }), 0);
    assert.deepEqual(cardPrice({ "цена покупки": 0, "единица": "шт" }), { price: 0, unit: "шт" });
  });

  it("отрицательная цена — опечатка, а не скидка", () => {
    // «-100» в карточке дало бы отрицательную себестоимость: чашка
    // «зарабатывала» бы на сырье, и маржа стала бы больше 100%.
    assert.equal(pricePerGram({ "цена покупки": -100, "единица": "кг" }), null);
    assert.equal(pricePerGram({ "цена покупки": "-13,495", "единица": "г" }), null);
    assert.equal(cardPrice({ "цена покупки": -3600, "единица": "шт" }), null);
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

describe("resolveIngredientPrice — выбор цены: карточка приоритетнее реестра", () => {
  it("карточка даёт цену — источник «карточка», реестр не смотрим вовсе", () => {
    const r = resolveIngredientPrice({ "цена покупки": 260000, "единица": "кг" }, 999);
    assert.equal(r.pricePerGram, 260);
    assert.equal(r.source, "карточка");
  });

  it("карточки нет — запасной путь: purchase_price реестра, источник «реестр»", () => {
    const r = resolveIngredientPrice(null, 80);
    assert.equal(r.pricePerGram, 80);
    assert.equal(r.source, "реестр");
  });

  it("карточка привязана, но без цены/единицы веса — тоже падаем на реестр", () => {
    // Стакан+крышка: карточка есть, но «шт» не переводится в цену за грамм.
    const r = resolveIngredientPrice({ "цена покупки": 3600, "единица": "шт" }, 80);
    assert.equal(r.pricePerGram, 80);
    assert.equal(r.source, "реестр");
  });

  it("ни карточки, ни реестра — null, а не 0, source null", () => {
    const r = resolveIngredientPrice(null, null);
    assert.equal(r.pricePerGram, null);
    assert.equal(r.source, null);
  });
});
