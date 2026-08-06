import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { firstDue } from "./maintenance-due";
import { MAINTENANCE_KINDS, PART_KINDS } from "./maintenance";
import { normKey, normsFor, STANDARD_NORMS } from "./maintenance-norms";

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

  it("кофейные нормативы не уходят на снек-автомат", () => {
    // У снека нет ни миксера, ни фильтра воды: график такой работы краснел бы
    // за работу, которой не существует.
    const other = normsFor("snack").map((n) => n.title);
    assert.deepEqual(other, ["Плановое ТО"]);
  });

  it("кофейный автомат получает все три", () => {
    assert.equal(normsFor("coffee").length, STANDARD_NORMS.length);
  });

  it("плановое ТО применимо к любому автомату", () => {
    const service = STANDARD_NORMS.find((n) => n.kind === "service")!;
    assert.equal(service.scope, "any");
  });

  it("незаполненный вид не получает кофейных нормативов", () => {
    // Автомат, которому карточку ещё не завели. Лучше не дать норматив, чем
    // дать невыполнимый: пустой график чинится одной командой, красный —
    // потерянным доверием к разделу.
    assert.deepEqual(normsFor(undefined).map((n) => n.title), ["Плановое ТО"]);
    assert.deepEqual(normsFor("other").map((n) => n.title), ["Плановое ТО"]);
  });

  it("снек, напитки и комбо — тоже только ТО", () => {
    for (const k of ["snack", "drink", "combo"] as const) {
      assert.deepEqual(normsFor(k).map((n) => n.title), ["Плановое ТО"], k);
    }
  });

  it("узловые нормативы помечены как кофейные", () => {
    for (const n of STANDARD_NORMS.filter((x) => x.partKind !== null)) {
      assert.equal(n.scope, "coffee", n.title);
    }
  });
});
