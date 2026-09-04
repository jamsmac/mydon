import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_COFFEE_PARTS_TEMPLATE,
  parsePartsTemplate,
  planMissingParts,
  templateSize,
  validatePartsTemplate,
} from "./parts-template";

describe("Состав автомата (R-PU-3)", () => {
  it("кофейный дефолт — слово владельца: 4 миксера, гриндер, варка, 8 бункеров, фильтр = 15 узлов", () => {
    assert.equal(templateSize(DEFAULT_COFFEE_PARTS_TEMPLATE), 15);
    assert.equal(DEFAULT_COFFEE_PARTS_TEMPLATE.find((e) => e.kind === "hopper")?.count, 8, "бункеров всегда 8");
  });

  it("пустому автомату не хватает всего: слоты 1…N у многослотовых, без слота у единичных", () => {
    const missing = planMissingParts(DEFAULT_COFFEE_PARTS_TEMPLATE, []);
    assert.equal(missing.length, 15);
    assert.deepEqual(missing.filter((m) => m.kind === "mixer").map((m) => m.slot), [1, 2, 3, 4]);
    assert.deepEqual(missing.filter((m) => m.kind === "grinder").map((m) => m.slot), [null]);
    assert.deepEqual(missing.filter((m) => m.kind === "hopper").map((m) => m.slot), [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("идемпотентно: занятые слоты пропускаются, полный автомат не даёт ничего", () => {
    const partial = planMissingParts(DEFAULT_COFFEE_PARTS_TEMPLATE, [
      { kind: "mixer", slot: 1 },
      { kind: "mixer", slot: 3 },
      { kind: "grinder", slot: null },
    ]);
    assert.deepEqual(partial.filter((m) => m.kind === "mixer").map((m) => m.slot), [2, 4]);
    assert.equal(partial.some((m) => m.kind === "grinder"), false);
    const full = planMissingParts(DEFAULT_COFFEE_PARTS_TEMPLATE, planMissingParts(DEFAULT_COFFEE_PARTS_TEMPLATE, []));
    assert.deepEqual(full, []);
  });

  it("узел без слота у многослотового вида занимает одно место, слот не бронирует", () => {
    const missing = planMissingParts([{ kind: "mixer", count: 4 }], [
      { kind: "mixer", slot: null },
      { kind: "mixer", slot: 2 },
    ]);
    assert.deepEqual(missing.map((m) => m.slot), [1, 3], "не хватает двух; заняты 2 и «где-то»");
  });

  it("разбор настройки: валидный JSON принимается, мусор и повторы — нет", () => {
    assert.deepEqual(parsePartsTemplate('[{"kind":"mixer","count":2}]'), [{ kind: "mixer", count: 2 }]);
    assert.equal(parsePartsTemplate("не json"), null);
    assert.equal(parsePartsTemplate('[{"kind":"turbo","count":1}]'), null, "неизвестный вид");
    assert.equal(parsePartsTemplate('[{"kind":"mixer","count":-1}]'), null);
    assert.equal(parsePartsTemplate('[{"kind":"mixer","count":1},{"kind":"mixer","count":2}]'), null, "повтор вида");
    assert.equal(validatePartsTemplate(""), null, "пусто — сброс к дефолту");
    assert.match(validatePartsTemplate("[1]") ?? "", /нужен JSON/);
  });
});
