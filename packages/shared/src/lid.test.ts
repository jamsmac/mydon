import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lidWeightFromPair, toCanonical, weighDelta } from "./lid";

const LID = 72;

describe("крышка: приведение замеров к одному основанию", () => {
  it("замер без крышки приводится к весу с крышкой, и наоборот", () => {
    assert.equal(toCanonical(640, "without_lid", LID), 712);
    assert.equal(toCanonical(712, "with_lid", LID), 712);
  });

  it("вес крышки неизвестен — привести нельзя, и это null, а не «как есть»", () => {
    assert.equal(toCanonical(640, "without_lid", null), null);
    assert.equal(toCanonical(640, "without_lid", 0), null);
    // то же состояние приводить не надо — вес крышки не нужен
    assert.equal(toCanonical(640, "with_lid", null), 640);
  });
});

describe("сколько добавили: разные состояния «до» и «после» больше не врут", () => {
  it("до — без крышки, после — с крышкой: считается верно", () => {
    const r = weighDelta({ weight: 1300, basis: "with_lid" }, { weight: 628, basis: "without_lid" }, LID);
    assert.deepEqual(r, { delta: 1300 - (628 + LID) });
  });

  it("оба в одном состоянии — вес крышки не нужен вовсе", () => {
    assert.deepEqual(weighDelta({ weight: 1300, basis: "with_lid" }, { weight: 700, basis: "with_lid" }, null), { delta: 600 });
  });

  it("состояния разные, а веса крышки нет — отказ словами, а не тихий сдвиг", () => {
    const r = weighDelta({ weight: 1300, basis: "with_lid" }, { weight: 628, basis: "without_lid" }, null);
    assert.ok("problem" in r);
    assert.match(r.problem, /взвесьте крышку один раз/);
  });
});

describe("вес крышки из пары замеров", () => {
  it("с крышкой минус без крышки", () => {
    assert.deepEqual(lidWeightFromPair(712, 640), { lidWeight: 72 });
  });

  it("перепутанные поля и неправдоподобная разница — отказ", () => {
    assert.match((lidWeightFromPair(640, 712) as { problem: string }).problem, /тяжелее/);
    assert.match((lidWeightFromPair(1712, 640) as { problem: string }).problem, /не похожа на вес крышки/);
  });
});
