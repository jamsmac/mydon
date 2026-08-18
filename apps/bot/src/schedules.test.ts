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
  it("узнаёт горизонт, страницу, карточку и «сделал»", () => {
    assert.deepEqual(parseSchedulesCallback("sc:d:14"), { kind: "horizon", days: 14 });
    assert.deepEqual(parseSchedulesCallback("sc:p:2"), { kind: "page", page: 2 });
    const id = "5daac236-59d6-42de-8c51-6b658546eb5b";
    // sc:do теперь ОТКРЫВАЕТ карточку (старые кнопки в чатах обезврежены);
    // запись — только явное sc:done с карточки.
    assert.deepEqual(parseSchedulesCallback(`sc:do:${id}`), { kind: "open", planId: id });
    assert.deepEqual(parseSchedulesCallback(`sc:done:${id}`), { kind: "done", planId: id });
    assert.deepEqual(parseSchedulesCallback("sc:back"), { kind: "back" });
  });

  it("чужое и битое отвергает", () => {
    assert.equal(parseSchedulesCallback("sc:d:99"), null);
    assert.equal(parseSchedulesCallback("sc:do:не-uuid"), null);
    assert.equal(parseSchedulesCallback("другое"), null);
  });
});

describe("Аудит 18.08: карточка вместо мгновенной записи + барьер слота", () => {
  const PLAN_ID = "5daac236-59d6-42de-8c51-6b658546eb5b";
  const PERSON = { id: "11111111-1111-4111-8111-111111111111", name: "Рустам" } as never;

  function schedDeps() {
    const logs: Record<string, unknown>[] = [];
    const { Conversations } = require("./conversation") as typeof import("./conversation");
    const conversations = new Conversations();
    const core = {
      maintenanceDue: async () => [due({ planId: PLAN_ID })],
      createMaintenanceLog: async (i: Record<string, unknown>) => {
        logs.push(i);
        return { id: "log-1" };
      },
    } as never;
    return { deps: { core, conversations }, conversations, logs };
  }

  it("строка списка (sc:do) открывает карточку и НИЧЕГО не пишет", async () => {
    const { handleSchedulesCallback, startSchedules } = await import("./schedules");
    const { deps, logs } = schedDeps();
    await startSchedules(5, deps);
    const res = await handleSchedulesCallback(5, parseSchedulesCallback(`sc:do:${PLAN_ID}`)!, PERSON, deps);
    const kb = JSON.stringify(res.message!.keyboard);
    assert.match(kb, /Сделал сейчас — записать/, "запись — отдельной явной кнопкой");
    assert.match(kb, new RegExp(`sc:done:${PLAN_ID}`));
    assert.match(res.message!.text, /сдвинет следующий срок/i, "цена действия названа");
    assert.equal(logs.length, 0, "тап «посмотреть» не создал запись ТО");
  });

  it("запись — только sc:done, с ключом идемпотентности план+день", async () => {
    const { handleSchedulesCallback, startSchedules } = await import("./schedules");
    const { deps, logs } = schedDeps();
    await startSchedules(5, deps);
    const res = await handleSchedulesCallback(5, parseSchedulesCallback(`sc:done:${PLAN_ID}`)!, PERSON, deps);
    assert.equal(logs.length, 1);
    assert.match(String(logs[0].clientKey), new RegExp(`^sc:${PLAN_ID}:\\d{4}-\\d{2}-\\d{2}$`));
    assert.match(res.message!.text, /Записал/);
  });

  it("старая кнопка графиков не трогает чужой мастер — ни start, ни advance", async () => {
    const { handleSchedulesCallback } = await import("./schedules");
    const { deps, conversations } = schedDeps();
    conversations.start(5, "task-done", "report", { taskId: "t1", draft: "полдня писал отчёт" });
    const res = await handleSchedulesCallback(5, parseSchedulesCallback("sc:p:1")!, PERSON, deps);
    assert.equal(res.answer, "Кнопка устарела");
    const conv = conversations.get(5);
    assert.equal(conv?.flow, "task-done", "мастер не перетёрт");
    assert.equal(conv?.step, "report", "шаг не подменён — заливка не «окирпичивается»");
  });
});
