import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  consumptionPeriod,
  formatCoffeeConsumption,
  isCoffeeConsumptionQuery,
  type CoffeeConsumptionReport,
} from "./coffee-report";

const rep = (over: Partial<CoffeeConsumptionReport> = {}): CoffeeConsumptionReport => ({
  from: "2026-07-05",
  to: "2026-08-04",
  locations: [
    { locationId: "l1", locationName: "American Hospital", grams: 12500, cost: 1000000, pairs: 20, unknownPairs: 0 },
    { locationId: "l2", locationName: "Кпп", grams: 8000, cost: null, pairs: 12, unknownPairs: 3 },
  ],
  totalGrams: 20500,
  totalCost: 1000000,
  ...over,
});

describe("Отчёт о расходе кофе в боте", () => {
  it("триггер: «расход кофе», «расход по наборам», «расход бункеров»; не срабатывает на прочее", () => {
    assert.equal(isCoffeeConsumptionQuery("расход кофе"), true);
    assert.equal(isCoffeeConsumptionQuery("покажи расход по наборам"), true);
    assert.equal(isCoffeeConsumptionQuery("Расход бункеров за месяц"), true);
    assert.equal(isCoffeeConsumptionQuery("расход бензина"), false);
    assert.equal(isCoffeeConsumptionQuery("кофе"), false);
  });

  it("сводка: итог в граммах и сумах, точки списком, «не посчитать» честно", () => {
    // toLocaleString(ru-RU) ставит неразрывный пробел в тысячах — нормализуем.
    const text = formatCoffeeConsumption(rep()).replace(/\u00A0/g, " ");
    assert.match(text, /20 500 г/);
    assert.match(text, /1 000 000 сум/);
    assert.match(text, /American Hospital: 12 500 г · 1 000 000 сум/);
    assert.match(text, /Кпп: 8 000 г · не посчитать: 3/);
    assert.match(text, /Пар без тары или с противоречием веса: 3/);
  });

  it("цены не заведены — так и говорим, а не «0 сум»", () => {
    const text = formatCoffeeConsumption(rep({ totalCost: null }));
    assert.match(text, /цены ингредиентов не заведены/);
    assert.doesNotMatch(text, /Всего: .*0 сум/);
  });

  it("пар нет — объясняем, откуда берётся расход, а не пустой ответ", () => {
    const text = formatCoffeeConsumption(rep({ locations: [], totalGrams: 0, totalCost: null }));
    assert.match(text, /пар «заливка → возврат» нет/);
    assert.match(text, /засыпали .* и вернули/);
  });

  it("больше 8 точек — хвост сворачивается со счётчиком", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      locationId: `l${i}`,
      locationName: `Точка ${i}`,
      grams: 100,
      cost: null,
      pairs: 1,
      unknownPairs: 0,
    }));
    const text = formatCoffeeConsumption(rep({ locations: many }));
    assert.match(text, /…и ещё точек: 3/);
  });

  it("consumptionPeriod — 30 дней назад по Ташкенту, ISO-даты", () => {
    const { from, to } = consumptionPeriod(new Date("2026-08-04T12:00:00Z"));
    assert.match(from, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(to, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(from < to);
  });
});
