import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MACHINE_SERIES,
  formatMachineNo,
  machineDisplayName,
  machineNoProblem,
  planMachineNumbers,
  suggestMachineNo,
} from "./machine-number";
import { INVENTORY_SERIES } from "./parts";

describe("номер автомата (М-6…М-8, М-12)", () => {
  it("серии по виду: K кофе, S снек, D напитки, C комбо; «прочее» без номера", () => {
    assert.equal(formatMachineNo("coffee", 14), "K-014");
    assert.equal(formatMachineNo("snack", 1), "S-001");
    assert.equal(formatMachineNo("drink", 1), "D-001");
    assert.equal(formatMachineNo("combo", 3), "C-003");
    assert.equal(formatMachineNo("other", 1), null);
  });

  it("серии автоматов не совпадают ни с одной серией узлов — иначе две наклейки с одним текстом", () => {
    const parts = new Set(Object.values(INVENTORY_SERIES));
    for (const s of Object.values(MACHINE_SERIES)) assert.equal(parts.has(s), false, `серия ${s} занята узлами`);
  });

  it("следующий свободный — после максимума, дыры не переиспользуются", () => {
    assert.equal(suggestMachineNo("coffee", ["K-001", "K-004", "S-009"]), "K-005");
    assert.equal(suggestMachineNo("snack", []), "S-001");
  });

  it("вписанный руками номер: своя серия, латиница; кириллица и чужая серия — отказ словами", () => {
    assert.equal(machineNoProblem("coffee", " k-014 "), null);
    assert.match(machineNoProblem("coffee", "К-014") ?? "", /кириллические/);
    assert.match(machineNoProblem("coffee", "S-003") ?? "", /серии K/);
    assert.match(machineNoProblem("other", "X-001") ?? "", /«прочее»/);
  });

  it("первоначальное присвоение: по виду, по дате заведения, при совпадении — по серийнику; занятые не трогаем", () => {
    const plan = planMachineNumbers([
      { id: "c2", kind: "coffee", createdAt: "2026-07-01T00:00:00Z", serial: "B", inventoryNo: null },
      { id: "c1", kind: "coffee", createdAt: "2026-07-01T00:00:00Z", serial: "A", inventoryNo: null },
      { id: "c0", kind: "coffee", createdAt: "2026-06-01T00:00:00Z", serial: "Z", inventoryNo: null },
      { id: "cx", kind: "coffee", createdAt: "2026-05-01T00:00:00Z", serial: null, inventoryNo: "K-007" },
      { id: "s1", kind: "snack", createdAt: "2026-08-01T00:00:00Z", serial: null, inventoryNo: null },
      { id: "o1", kind: "other", createdAt: "2026-08-01T00:00:00Z", serial: null, inventoryNo: null },
      { id: "n1", kind: null, createdAt: "2026-08-01T00:00:00Z", serial: null, inventoryNo: null },
    ]);
    assert.deepEqual(plan, [
      { id: "c0", inventoryNo: "K-008" },
      { id: "c1", inventoryNo: "K-009" },
      { id: "c2", inventoryNo: "K-010" },
      { id: "s1", inventoryNo: "S-001" },
    ]);
  });

  it("имя на показ: номер · место из «Где стоит»; без номера — имя карточки; без места — только номер", () => {
    assert.equal(machineDisplayName({ name: "KARDIO Life", inventoryNo: "K-014" }, "CardioLife"), "K-014 · CardioLife");
    assert.equal(machineDisplayName({ name: "KARDIO Life", inventoryNo: null }, "CardioLife"), "KARDIO Life");
    assert.equal(machineDisplayName({ name: "SKLAD 6S", inventoryNo: "S-004" }, null), "S-004");
  });
});

describe("каноническая форма номера автомата", () => {
  it("«k-14» и «K-014» — один номер в одной форме; чужая серия — null", async () => {
    const { canonicalMachineNo } = await import("./machine-number");
    assert.equal(canonicalMachineNo("coffee", "k-14"), "K-014");
    assert.equal(canonicalMachineNo("coffee", " K-014 "), "K-014");
    assert.equal(canonicalMachineNo("coffee", "K-1000"), "K-1000");
    assert.equal(canonicalMachineNo("coffee", "S-014"), null);
  });
});
