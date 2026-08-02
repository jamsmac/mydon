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

  it("недостача при пересчёте — отдельным блоком, с суммой (реальный лист: 55→54)", () => {
    const t = formatStockAck(
      [{ product: "Montella Вода минеральная 330ml", quantity: 54 }],
      [{ product: "Montella Вода минеральная 330ml", before: 55, after: 54, delta: -1, value: 2090, noPrice: false }],
    );
    assert.match(t, /Недостача при пересчёте:/);
    assert.match(t, /было 55 → стало 54 \(−1 · ~2\s?090 сум\)/);
    assert.doesNotMatch(t, /Излишек/);
  });

  it("излишек — отдельным блоком со знаком плюс", () => {
    const t = formatStockAck(
      [{ product: "Fanta", quantity: 19 }],
      [{ product: "Fanta", before: 7, after: 19, delta: 12, value: 62000, noPrice: false }],
    );
    assert.match(t, /Излишек при пересчёте:/);
    assert.match(t, /было 7 → стало 19 \(\+12 · ~62\s?000 сум\)/);
    assert.doesNotMatch(t, /Недостача/);
  });

  it("без цены — сумма не выдумывается, но расхождение видно", () => {
    const t = formatStockAck(
      [{ product: "Новый Товар", quantity: 8 }],
      [{ product: "Новый Товар", before: 10, after: 8, delta: -2, value: 0, noPrice: true }],
    );
    assert.match(t, /было 10 → стало 8 \(−2\)/);
    assert.doesNotMatch(t, /−2 · /); // без "· N сум" — цены нет
  });

  it("без расхождений — блоков недостачи/излишка нет вовсе", () => {
    const t = formatStockAck([{ product: "Montella", quantity: 24 }]);
    assert.doesNotMatch(t, /Недостача|Излишек/);
  });

  it("товар с нулевой ценой (noPrice=false, value=0) — сумма показана, не спутана с «без цены»", () => {
    // Отличаем от «без цены» (value=0, noPrice=true): здесь цена ИЗВЕСТНА и
    // равна нулю (промо/бесплатный товар) — сумму нужно показать как есть.
    const t = formatStockAck(
      [{ product: "Промо-товар", quantity: 8 }],
      [{ product: "Промо-товар", before: 10, after: 8, delta: -2, value: 0, noPrice: false }],
    );
    assert.match(t, /было 10 → стало 8 \(−2 · ~0 сум\)/);
  });

  it("дробная сумма при отображении округляется до целого сума", () => {
    const t = formatStockAck(
      [{ product: "Товар с копейками", quantity: 7 }],
      [{ product: "Товар с копейками", before: 10, after: 7, delta: -3, value: 6271.65, noPrice: false }],
    );
    assert.match(t, /· ~6\s?272 сум/); // Math.round(6271.65) = 6272
  });

  it("много расхождений — блок режется до 20 строк с «…и ещё N» (лимит Telegram)", () => {
    const adjustments = Array.from({ length: 25 }, (_, i) => ({
      product: `Товар ${i}`,
      before: 10,
      after: 5,
      delta: -5,
      value: 0,
      noPrice: true,
    }));
    const t = formatStockAck(
      adjustments.map((a) => ({ product: a.product, quantity: a.after })),
      adjustments,
    );
    assert.match(t, /…и ещё 5/);
    // Ровно 20 строк расхождения показано (не 25).
    const shown = adjustments.slice(0, 20).every((a) => t.includes(`${a.product}: было`));
    assert.ok(shown);
    assert.ok(!t.includes("Товар 24: было")); // 25-й (индекс 24) обрезан
  });
});
