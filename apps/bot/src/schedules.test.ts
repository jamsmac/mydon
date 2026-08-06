import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MaintenanceDueRow } from "./core-client";
import { parseSchedulesCallback, selectDue } from "./schedules";

function due(over: Partial<MaintenanceDueRow> = {}): MaintenanceDueRow {
  return {
    planId: "p1",
    targetId: "22222222-2222-4222-8222-222222222222",
    targetName: "KIMYO",
    kind: "cleaning",
    kindLabel: "Чистка",
    partKind: "mixer",
    partLabel: "Миксер",
    title: null,
    nextDueOn: "2026-08-16",
    lastDoneOn: null,
    taskLeadDays: 3,
    daysLeft: 2,
    countLeft: null,
    status: "soon",
    assigneeId: null,
    autoTask: true,
    ...over,
  };
}

describe("Отбор строк в раздел «Графики»", () => {
  it("показывает только то, что горит: ok и unknown — забота владельца", () => {
    const rows = [
      due({ planId: "a", status: "overdue", daysLeft: -3 }),
      due({ planId: "b", status: "due", daysLeft: 0 }),
      due({ planId: "c", status: "soon", daysLeft: 2 }),
      due({ planId: "d", status: "ok", daysLeft: 40 }),
      due({ planId: "e", status: "unknown", daysLeft: null }),
    ];
    assert.deepEqual(selectDue(rows, 14).map((r) => r.planId), ["a", "b", "c"]);
  });

  it("горизонт отсекает дальнее", () => {
    const rows = [due({ planId: "близко", daysLeft: 3 }), due({ planId: "далеко", daysLeft: 20 })];
    assert.deepEqual(selectDue(rows, 14).map((r) => r.planId), ["близко"]);
  });
});

describe("Автомат вне эксплуатации в график техника не попадает", () => {
  it("строка автомата в ремонте не показывается", () => {
    // Иначе техник поедет к аппарату, которого на точке нет, и нажмёт
    // «✅ Сделал сейчас» — срок уехал бы вперёд на весь период по работе,
    // которой не было. Владелец такие строки в панели видит, техник — нет.
    const rows = [
      due({ planId: "p1", targetName: "KIMYO", operational: true }),
      due({ planId: "p2", targetName: "Olma склад", operational: false }),
    ];
    assert.deepEqual(selectDue(rows, 14).map((r) => r.targetName), ["KIMYO"]);
  });

  it("автомат на складе тоже скрыт", () => {
    const rows = [due({ targetName: "OFFice", operational: false })];
    assert.equal(selectDue(rows, 14).length, 0);
  });

  it("без признака строка показывается — старый Core не гасит график целиком", () => {
    assert.equal(selectDue([due()], 14).length, 1);
  });
});

describe("Разбор callback-данных", () => {
  it("узнаёт горизонт, страницу и «сделал»", () => {
    assert.deepEqual(parseSchedulesCallback("sc:d:14"), { kind: "horizon", days: 14 });
    assert.deepEqual(parseSchedulesCallback("sc:p:2"), { kind: "page", page: 2 });
    const id = "5daac236-59d6-42de-8c51-6b658546eb5b";
    assert.deepEqual(parseSchedulesCallback(`sc:do:${id}`), { kind: "do", planId: id });
  });

  it("чужое и битое отвергает", () => {
    assert.equal(parseSchedulesCallback("sc:d:99"), null);
    assert.equal(parseSchedulesCallback("sc:do:не-uuid"), null);
    assert.equal(parseSchedulesCallback("другое"), null);
  });
});
