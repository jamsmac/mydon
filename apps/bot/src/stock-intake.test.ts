import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatStockAck, isStockCommand, parseStockItems } from "./stock-intake";

describe("Ввод остатков склада (§5.4)", () => {
  it("разбирает список через запятую", () => {
    const items = parseStockItems("склад Montella 24, Fanta 12");
    assert.deepEqual(items, [
      { product: "Montella", quantity: 24 },
      { product: "Fanta", quantity: 12 },
    ]);
  });

  it("принимает переводы строк, тире, двоеточие и «шт»", () => {
    const items = parseStockItems("остатки:\nКола - 30\nСникерс: 8 шт\nВода 15ед");
    assert.deepEqual(items, [
      { product: "Кола", quantity: 30 },
      { product: "Сникерс", quantity: 8 },
      { product: "Вода", quantity: 15 },
    ]);
  });

  it("имя из нескольких слов сохраняется, число — последнее", () => {
    assert.deepEqual(parseStockItems("склад Coca Cola 0.5 6"), [{ product: "Coca Cola 0.5", quantity: 6 }]);
  });

  it("отрицательное и дробное количество отбрасывает, кавычки чистит", () => {
    // «-5» → знак не часть числа-группы, возьмётся 5; чтобы точно проверить дробь:
    assert.deepEqual(parseStockItems("склад «Montella» 12,5"), [
      // 12,5 → запятая делит позиции: "«Montella» 12" и "5"; второй — без имени.
      { product: "Montella", quantity: 12 },
    ]);
  });

  it("ноль — валидный остаток (товар кончился)", () => {
    assert.deepEqual(parseStockItems("склад Fanta 0"), [{ product: "Fanta", quantity: 0 }]);
  });

  it("isStockCommand: команда с парами — да, вопрос без числа — нет", () => {
    assert.equal(isStockCommand("склад Montella 24"), true);
    assert.equal(isStockCommand("остаток Montella?"), false); // вопрос → общий разбор
    assert.equal(isStockCommand("что заказать"), false);
    assert.equal(isStockCommand("приход Кола 30, Вода 12"), true);
  });

  it("формат подтверждения перечисляет позиции и подсказывает пересчёт", () => {
    const t = formatStockAck([
      { product: "Montella", quantity: 24 },
      { product: "Fanta", quantity: 12 },
    ]);
    assert.match(t, /Склад обновлён \(2 поз\.\)/);
    assert.match(t, /Montella: 24/);
    assert.match(t, /что заказать/);
  });
});
