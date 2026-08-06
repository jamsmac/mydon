import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { firstDue } from "./maintenance-due";
import { MAINTENANCE_KINDS, PART_KINDS } from "./maintenance";
import { normKey, STANDARD_NORMS } from "./maintenance-norms";

describe("стандартные нормативы", () => {
  it("хранит числа, названные владельцем", () => {
    const byTitle = new Map(STANDARD_NORMS.map((n) => [n.title, n.everyDays]));
    assert.equal(byTitle.get("Мойка миксера"), 10);
    assert.equal(byTitle.get("Замена фильтра воды"), 45);
    assert.equal(byTitle.get("Плановое ТО"), 90);
  });

  it("виды работ и узлы существуют в справочниках", () => {
    for (const n of STANDARD_NORMS) {
      assert.ok(MAINTENANCE_KINDS.includes(n.kind), `неизвестный вид работ: ${n.kind}`);
      if (n.partKind !== null) {
        assert.ok(PART_KINDS.includes(n.partKind), `неизвестный узел: ${n.partKind}`);
      }
    }
  });

  it("ключи не повторяются — иначе второй норматив упрётся в уникальный индекс", () => {
    const keys = STANDARD_NORMS.map((n) => normKey("e1", n.kind, n.partKind));
    assert.equal(new Set(keys).size, keys.length);
  });

  it("периодичность положительная: нулевой шаг не даст посчитать срок", () => {
    for (const n of STANDARD_NORMS) assert.ok(n.everyDays > 0, n.title);
  });

  it("каждый норматив даёт первый срок в будущем", () => {
    for (const n of STANDARD_NORMS) {
      const due = firstDue("2026-08-06", { everyDays: n.everyDays });
      assert.ok(due !== null && due > "2026-08-06", `${n.title}: ${due}`);
    }
  });

  it("отсутствующий узел и пустая строка дают один ключ — как coalesce в индексе", () => {
    assert.equal(normKey("e1", "service", null), normKey("e1", "service", undefined));
    assert.equal(normKey("e1", "service", null), "e1|service|");
  });
});
