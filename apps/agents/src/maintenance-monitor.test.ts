import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  priorityOf,
  runMaintenanceMonitor,
  taskTitle,
  type EnsureTaskInput,
  type MaintenanceDueRow,
} from "./maintenance-monitor";

function row(over: Partial<MaintenanceDueRow> = {}): MaintenanceDueRow {
  return {
    planId: "pl-1",
    targetId: "22222222-2222-4222-8222-222222222222",
    targetName: "Kaffit-04",
    kind: "cleaning",
    kindLabel: "Чистка",
    partKind: "mixer",
    partLabel: "Миксер",
    title: null,
    nextDueOn: "2026-08-06",
    lastDoneOn: "2026-07-07",
    taskLeadDays: 3,
    daysLeft: 0,
    countLeft: null,
    status: "due",
    assigneeId: null,
    autoTask: true,
    ...over,
  };
}

/** Заглушка Core, копящая вызовы. */
function stubCore(rows: MaintenanceDueRow[], over: Record<string, unknown> = {}) {
  const tasks: EnsureTaskInput[] = [];
  const events: { type: string; payload: Record<string, unknown> }[] = [];
  const core = {
    maintenanceDue: async () => rows,
    ensureTaskForDay: async (input: EnsureTaskInput) => {
      tasks.push(input);
      return { created: true, taskId: "t-1" };
    },
    recordEvent: async (e: { type: string; payload?: Record<string, unknown> }) => {
      events.push({ type: e.type, payload: e.payload ?? {} });
      return {};
    },
    ...over,
  } as never;
  return { core, tasks, events };
}

const NOW = () => new Date("2026-08-06T03:00:00.000Z"); // 08:00 в Ташкенте

describe("Заголовок и приоритет задачи", () => {
  it("собирается из вида работ и узла, своё название побеждает", () => {
    assert.equal(taskTitle(row()), "Чистка: Миксер — Kaffit-04");
    assert.equal(taskTitle(row({ partLabel: null })), "Чистка — Kaffit-04");
    assert.equal(taskTitle(row({ title: "Мойка перед проверкой" })), "Мойка перед проверкой — Kaffit-04");
  });

  it("просрочка поднимает приоритет, срок сегодня — нет", () => {
    assert.equal(priorityOf("overdue"), "high");
    assert.equal(priorityOf("due"), "normal");
    assert.equal(priorityOf("soon"), "normal");
  });
});

describe("Монитор графиков", () => {
  it("ставит задачу на то, что подходит к сроку", async () => {
    const { core, tasks } = stubCore([row({ status: "soon", daysLeft: 2 })]);
    const r = await runMaintenanceMonitor(core, { now: NOW });
    assert.equal(r.tasks, 1);
    assert.equal(tasks[0].source, "maint:pl-1");
    assert.equal(tasks[0].dayKey, "2026-08-06");
    assert.equal(tasks[0].entityId, row().targetId);
  });

  it("«норматив не задан» не порождает ни задачи, ни события", async () => {
    // Это дефект настройки. Владелец увидит его на экране, а не пушем в 6 утра.
    const { core, tasks, events } = stubCore([row({ status: "unknown", daysLeft: null })]);
    const r = await runMaintenanceMonitor(core, { now: NOW });
    assert.equal(r.tasks, 0);
    assert.deepEqual(tasks, []);
    assert.deepEqual(events, []);
  });

  it("норматив в норме не трогается вовсе", async () => {
    const { core, tasks } = stubCore([row({ status: "ok", daysLeft: 20 })]);
    await runMaintenanceMonitor(core, { now: NOW });
    assert.deepEqual(tasks, []);
  });

  it("задача свободна, если у норматива нет именного исполнителя", async () => {
    // Закрепления за объектами нет — назначить наугад хуже, чем оставить
    // в пуле: назначенная наугад работа выглядит как взятая.
    const { core, tasks } = stubCore([row()]);
    await runMaintenanceMonitor(core, { now: NOW });
    assert.equal(tasks[0].ownerRef, undefined);
  });

  it("именной график назначает конкретного человека", async () => {
    const { core, tasks } = stubCore([row({ assigneeId: "person-1" })]);
    await runMaintenanceMonitor(core, { now: NOW });
    assert.equal(tasks[0].ownerRef, "person-1");
  });

  it("autoTask=false отключает постановку, но не наблюдение", async () => {
    const { core, tasks, events } = stubCore([
      row({ autoTask: false, status: "overdue", daysLeft: -3 }),
    ]);
    await runMaintenanceMonitor(core, { now: NOW });
    assert.deepEqual(tasks, [], "задачу не ставим");
    assert.equal(events[0].type, "maintenance.overdue", "но владельцу сообщаем");
  });

  it("просрочка сообщается ступенями 1/3/7, а не каждый день", async () => {
    // После третьего одинакового сообщения их перестают читать.
    for (const [days, expected] of [
      [1, 1],
      [2, 0],
      [3, 1],
      [4, 0],
      [7, 1],
      [8, 0],
      [30, 0],
    ] as const) {
      const { core, events } = stubCore([row({ status: "overdue", daysLeft: -days })]);
      const r = await runMaintenanceMonitor(core, { now: NOW });
      assert.equal(r.overdue, expected, `${days} дн. просрочки`);
      assert.equal(events.filter((e) => e.type === "maintenance.overdue").length, expected);
    }
  });

  it("срок сегодня просрочкой не считается", async () => {
    const { core, events } = stubCore([row({ status: "due", daysLeft: 0 })]);
    const r = await runMaintenanceMonitor(core, { now: NOW });
    assert.equal(r.overdue, 0, "техник закроет вечером");
    assert.ok(!events.some((e) => e.type === "maintenance.overdue"));
  });

  it("свободная задача со сроком сегодня даёт maintenance.unclaimed", async () => {
    const { core, events } = stubCore([row({ status: "due", daysLeft: 0 })]);
    const r = await runMaintenanceMonitor(core, { now: NOW });
    assert.equal(r.unclaimed, 1);
    const e = events.find((x) => x.type === "maintenance.unclaimed")!;
    assert.equal(e.payload.planId, "pl-1");
    assert.equal(e.payload.taskId, "t-1");
  });

  it("именной график невзятым не считается", async () => {
    const { core, events } = stubCore([row({ status: "due", assigneeId: "person-1" })]);
    const r = await runMaintenanceMonitor(core, { now: NOW });
    assert.equal(r.unclaimed, 0);
    assert.ok(!events.some((e) => e.type === "maintenance.unclaimed"));
  });

  it("повторный прогон в тот же день не задваивает ни задачу, ни событие", async () => {
    const { core, events } = stubCore([row({ status: "due" })], {
      ensureTaskForDay: async () => ({ created: false }),
    });
    const r = await runMaintenanceMonitor(core, { now: NOW });
    assert.equal(r.tasks, 0);
    assert.equal(r.unclaimed, 0, "событие привязано к факту создания задачи");
    assert.ok(!events.some((e) => e.type === "maintenance.unclaimed"));
  });

  it("сбой на одном нормативе не роняет остальные", async () => {
    let call = 0;
    const { core, tasks } = stubCore([row({ planId: "bad" }), row({ planId: "good" })], {
      ensureTaskForDay: async (input: EnsureTaskInput) => {
        call += 1;
        if (call === 1) throw new Error("Core недоступен");
        tasks.push(input);
        return { created: true, taskId: "t-2" };
      },
    });
    const r = await runMaintenanceMonitor(core, { now: NOW });
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0], /^bad:/);
    assert.equal(r.tasks, 1, "второй норматив должен быть обработан");
  });

  it("недоступный Core не роняет процесс агентов", async () => {
    const { core } = stubCore([], {
      maintenanceDue: async () => {
        throw new Error("сеть");
      },
    });
    const r = await runMaintenanceMonitor(core, { now: NOW });
    assert.equal(r.errors.length, 1);
    assert.equal(r.tasks, 0);
  });

  it("срок задачи — конец рабочего дня по Ташкенту", async () => {
    // 18:00 в Ташкенте = 13:00 UTC. Ставить полночь значит показать технику
    // «просрочено» в тот же день, когда он ещё едет на точку.
    const { core, tasks } = stubCore([row({ status: "due", nextDueOn: "2026-08-06" })]);
    await runMaintenanceMonitor(core, { now: NOW });
    assert.equal(tasks[0].due, "2026-08-06T13:00:00.000Z");
  });
});

describe("Автомат вне эксплуатации задач не получает", () => {
  it("автомат в ремонте — задача не ставится, причина названа", async () => {
    // Olma склад уехал в ремонт 05.08.2026. Работа подошла к сроку, но
    // выполнить её некому и не на чем.
    const { core, tasks } = stubCore([
      row({ targetName: "Olma склад", operational: false, idleReason: "автомат не в эксплуатации (в ремонте)" }),
    ]);
    const res = await runMaintenanceMonitor(core);

    assert.equal(tasks.length, 0, "задача по автомату в ремонте не создаётся");
    assert.equal(res.tasks, 0);
    assert.equal(res.idle, 1, "пропуск считается отдельно от «работ не подошло»");
    assert.deepEqual(res.idleReasons, ["Olma склад: автомат не в эксплуатации (в ремонте)"]);
  });

  it("автомат на складе — то же самое", async () => {
    const { core, tasks } = stubCore([
      row({ targetName: "OFFice", operational: false, idleReason: "автомат не в эксплуатации (на складе)" }),
    ]);
    const res = await runMaintenanceMonitor(core);
    assert.equal(tasks.length, 0);
    assert.equal(res.idle, 1);
  });

  it("рабочий автомат получает задачу как раньше", async () => {
    const { core, tasks } = stubCore([row({ operational: true })]);
    const res = await runMaintenanceMonitor(core);
    assert.equal(tasks.length, 1);
    assert.equal(res.idle, 0);
  });

  it("старый Core без поля — обслуживание продолжается", async () => {
    // Признака нет → автомат считается рабочим. Отсутствие поля не повод
    // молча прекратить обслуживание всего парка.
    const { core, tasks } = stubCore([row()]);
    const res = await runMaintenanceMonitor(core);
    assert.equal(tasks.length, 1);
    assert.equal(res.idle, 0);
  });

  it("смешанный парк: рабочим задачи, стоящим — счётчик", async () => {
    const { core, tasks } = stubCore([
      row({ planId: "p1", targetName: "KIMYO", operational: true }),
      row({ planId: "p2", targetName: "OFFice", operational: false, idleReason: "автомат не в эксплуатации (на складе)" }),
      row({ planId: "p3", targetName: "Olma склад", operational: false, idleReason: "автомат не в эксплуатации (в ремонте)" }),
    ]);
    const res = await runMaintenanceMonitor(core);
    assert.equal(tasks.length, 1);
    assert.equal(res.idle, 2);
    assert.equal(res.idleReasons.length, 2);
  });
});
