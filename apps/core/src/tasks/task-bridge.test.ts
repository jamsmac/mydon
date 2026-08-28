import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { systemConfig, task as taskTable } from "@mydon/db";
import { BRIDGE_EVENT_TYPES, BRIDGE_SOURCES, OVERDUE_MAX_EVENTS, TaskBridgeService, nextMorning } from "./task-bridge.service";

type Row = Record<string, unknown>;
const NOW = new Date("2026-08-26T06:15:00+05:00");
const SERIAL = "2508160376";
const OTHER = "2508160359";
const CARD = "44444444-4444-4444-8444-444444444444";
const MANAGER = "55555555-5555-4555-8555-555555555555";

function event(type: string, payload: Row, at = "2026-08-26T05:00:00+05:00"): Row {
  return { id: `e-${type}-${String(payload.serial ?? "sys")}-${at}`, source: "system", type, payload, occurredAt: new Date(at) };
}

function fixture(opts: { events: Row[]; settings?: Row[]; people?: Row[]; conflicts?: Set<string> }) {
  const created: Row[] = [];
  const recorded: Row[] = [];
  const warnings: string[] = [];
  const db = { select: () => ({ from: async () => opts.settings ?? [] }) } as never;
  const tasks = {
    ensureForDay: async (input: Row) => {
      const key = `${String(input.source)}:${String(input.dayKey)}`;
      if (opts.conflicts?.has(key)) return null;
      const row = { id: `t-${created.length + 1}`, ...input, source: key };
      created.push(row);
      return row;
    },
  } as never;
  const events = {
    list: async () => opts.events,
    record: async (row: Row) => { recorded.push(row); return row; },
  } as never;
  const vending = {
    machineIndex: async () => ({
      idBySerial: new Map([[SERIAL, CARD]]),
      nameBySerial: new Map([[SERIAL, "Olma"]]),
      firstIdBySerial: new Map([[SERIAL, CARD]]),
    }),
  } as never;
  const service = new TaskBridgeService(db, tasks, events, vending, { claim: async () => true } as never);
  (service as unknown as { людиСПравом: () => Promise<Row[]> }).людиСПравом = async () => opts.people ?? [];
  (service as unknown as { logger: { warn: (message: string) => void; log: () => void } }).logger = {
    warn: (message) => warnings.push(message),
    log: () => undefined,
  };
  return { service, created, recorded, warnings };
}

describe("Мост событие → задача (П7)", () => {
  it("агрегирует несколько товаров одного автомата за сутки в одну задачу", async () => {
    const f = fixture({ events: [
      event("machine.low_stock", { serial: SERIAL, product: "Fanta", left: 1 }),
      event("machine.low_stock", { serial: SERIAL, product: "Cola", left: 2 }),
      event("machine.low_stock", { serial: SERIAL, product: "Snickers", left: 0 }),
    ] });
    const result = await f.service.run(NOW);
    assert.equal(result.created, 1);
    assert.equal(f.created[0]!.source, `low_stock:${SERIAL}:2026-08-26`);
    assert.match(String(f.created[0]!.title), /Пополнить Olma/);
    assert.match(String(f.created[0]!.description), /Fanta/);
    assert.match(String(f.created[0]!.description), /Snickers/);
  });

  it("два автомата дают две задачи, повтор по ключу — skipped", async () => {
    const two = fixture({ events: [
      event("machine.low_stock", { serial: SERIAL, product: "Fanta", left: 1 }),
      event("machine.low_stock", { serial: OTHER, product: "Cola", left: 2 }),
    ] });
    assert.equal((await two.service.run(NOW)).created, 2);

    const duplicate = fixture({
      events: [event("machine.low_stock", { serial: SERIAL, product: "Fanta", left: 1 })],
      conflicts: new Set([`low_stock:${SERIAL}:2026-08-26`]),
    });
    const result = await duplicate.service.run(NOW);
    assert.equal(result.created, 0);
    assert.equal(result.skipped, 1);
    assert.deepEqual(duplicate.recorded, []);
  });

  it("ключ использует ташкентский день самого события", async () => {
    const f = fixture({ events: [
      event("machine.low_stock", { serial: SERIAL, product: "Fanta", left: 1 }, "2026-08-25T23:50:00+05:00"),
    ] });
    await f.service.run(NOW);
    assert.equal(f.created[0]!.source, `low_stock:${SERIAL}:2026-08-25`);
  });

  it("потолок громко режет 21-й ключ", async () => {
    const events = Array.from({ length: 21 }, (_, i) =>
      event("machine.low_stock", { serial: `250816${String(i).padStart(4, "0")}`, product: "Fanta", left: 1 }),
    );
    const f = fixture({ events });
    const result = await f.service.run(NOW);
    assert.equal(result.created, 20);
    assert.equal(result.capped, true);
    assert.match(f.warnings[0]!, /low_stock:2508160020/);
    assert.ok(f.recorded.some((row) => row.type === "task.bridge_run"));
  });

  it("настройка потолка применяется, срочное проходит раньше normal", async () => {
    const f = fixture({
      events: [
        event("vending.refill_detected", { serial: SERIAL, units: 12, windowTo: "2026-08-26T04:00:00Z", recorded: false }),
        event("ourvend.sync_stale", { hoursSinceSuccess: null }),
      ],
      settings: [{ key: "TASK_BRIDGE_MAX_PER_RUN", value: "1" }],
    });
    await f.service.run(NOW);
    assert.equal(f.created[0]!.source, "sync_stale:system:2026-08-26");
    assert.equal(f.created[0]!.priority, "urgent");
  });

  it("выключенный мост не читает события и не создаёт задач", async () => {
    const f = fixture({
      events: [event("machine.low_stock", { serial: SERIAL, product: "Fanta", left: 1 })],
      settings: [{ key: "TASK_BRIDGE_ENABLED", value: "0" }],
    });
    const result = await f.service.run(NOW);
    assert.equal(result.disabled, true);
    assert.deepEqual(f.created, []);
  });

  it("без карточки задача всё равно создаётся, но без entityId", async () => {
    const f = fixture({ events: [event("machine.low_stock", { serial: OTHER, product: "Fanta", left: 1 })] });
    await f.service.run(NOW);
    assert.equal(f.created[0]!.entityId, undefined);
    assert.match(String(f.created[0]!.title), new RegExp(OTHER));
  });

  it("заливка с recorded=true отбрасывается", async () => {
    const f = fixture({ events: [
      event("vending.refill_detected", { serial: SERIAL, units: 12, recorded: false }),
      event("vending.refill_detected", { serial: OTHER, units: 7, recorded: true }),
    ] });
    assert.equal((await f.service.run(NOW)).created, 1);
  });

  it("инфраструктурная задача адресуется менеджеру, а без него идёт в пул с событием", async () => {
    const withManager = fixture({
      events: [event("ourvend.sync_failed_streak", { streak: 4, lastError: "timeout" })],
      people: [{ id: MANAGER }],
    });
    await withManager.service.run(NOW);
    assert.equal(withManager.created[0]!.ownerRef, MANAGER);

    const without = fixture({ events: [event("ourvend.sync_failed_streak", { streak: 4 })] });
    await without.service.run(NOW);
    assert.equal(without.created[0]!.ownerRef, undefined);
    assert.ok(without.recorded.some((row) => row.type === "tasks.no_confirmers"));
    assert.equal(without.warnings.length, 1);
  });

  it("полевая задача остаётся свободной и пишет task.auto_created", async () => {
    const f = fixture({
      events: [event("machine.low_stock", { serial: SERIAL, product: "Fanta", left: 1 })],
      people: [{ id: MANAGER }],
    });
    await f.service.run(NOW);
    assert.equal(f.created[0]!.ownerRef, undefined);
    const recorded = f.recorded.find((row) => row.type === "task.auto_created");
    assert.ok(recorded);
    assert.equal((recorded.payload as Row).key, `low_stock:${SERIAL}:2026-08-26`);
  });

  it("nextMorning даёт 10:00 следующего ташкентского дня", () => {
    assert.equal(nextMorning(NOW).toISOString(), new Date("2026-08-27T10:00:00+05:00").toISOString());
    assert.equal(
      nextMorning(new Date("2026-08-26T23:50:00+05:00")).toISOString(),
      new Date("2026-08-27T10:00:00+05:00").toISOString(),
    );
  });

  it("список типов выводится из единой таблицы пяти источников", () => {
    assert.deepEqual([...BRIDGE_EVENT_TYPES].sort(), BRIDGE_SOURCES.map((source) => source.type).sort());
    assert.deepEqual(BRIDGE_SOURCES.map((source) => source.key).sort(), [
      "low_stock", "refill_unconfirmed", "shrinkage", "sync_failed", "sync_stale",
    ]);
  });
});

describe("Эмитент просрочки (П7, R-P7-5, T7)", () => {
  const СЕЙЧАС = new Date("2026-08-26T06:15:00+05:00");

  function стендПросрочки(opts: { задачи: Row[]; занятые?: Set<string>; settings?: Row[] }) {
    const записанные: Row[] = [];
    const заявки: string[] = [];
    const параметры = { limit: 0 };
    const условия: unknown[] = [];
    const db = {
      select: () => ({
        from: (t: unknown) => {
          // settingValue() зовёт select().from(systemConfig) БЕЗ .where() —
          // тот же стенд обязан отвечать и на этот запрос, и на выборку
          // просроченных задач, иначе тест выключенного эмитента не собрать.
          if (t === systemConfig) return Promise.resolve(opts.settings ?? []);
          if (t !== taskTable) throw new Error("стенд не знает эту таблицу");
          return {
            where: (condition: unknown) => {
              условия.push(condition);
              return {
              orderBy: () => ({ limit: async (value: number) => { параметры.limit = value; return opts.задачи; } }),
              };
            },
          };
        },
      }),
    } as never;
    const events = { record: async (value: Row) => { записанные.push(value); return value; } } as never;
    const rules = {
      claim: async (key: string) => {
        заявки.push(key);
        return !(opts.занятые?.has(key) ?? false);
      },
    } as never;
    const service = new TaskBridgeService(db, {} as never, events, {} as never, rules);
    return { service, записанные, заявки, параметры, условия };
  }

  const просрочка = (id: string, due: string, over: Row = {}): Row => ({
    id,
    title: `Задача ${id}`,
    due: new Date(due),
    ownerRef: null,
    status: "todo",
    ...over,
  });

  it("задача, просроченная сегодня, события не даёт — первый день за ботом", async () => {
    const st = стендПросрочки({ задачи: [просрочка("t1", "2026-08-26T09:00:00+05:00")] });
    assert.equal((await st.service.emitOverdue(СЕЙЧАС)).emitted, 0);
    assert.deepEqual(st.записанные, []);
  });

  it("TASK_BRIDGE_ENABLED=0 гасит и эмитент просрочки — DEPLOY.md обещает откат ОБЕИХ работ", async () => {
    // Найдено adversarial-ревью PR #220: run() уже проверял тумблер, emitOverdue()
    // — нет, и рунбук откатa молчал бы наполовину при аварийном стопе.
    const st = стендПросрочки({
      задачи: [просрочка("t1", "2026-08-20T09:00:00+05:00")],
      settings: [{ key: "TASK_BRIDGE_ENABLED", value: "0" }],
    });
    const result = await st.service.emitOverdue(СЕЙЧАС);
    assert.equal(result.emitted, 0);
    assert.equal(result.capped, false);
    assert.deepEqual(st.записанные, []);
    assert.deepEqual(st.заявки, [], "выключенный эмитент не должен даже пытаться занять ключ дедупа");
  });

  it("задача, просроченная вчера, даёт событие один раз в сутки", async () => {
    const st = стендПросрочки({ задачи: [просрочка("t1", "2026-08-25T18:00:00+05:00")] });
    assert.equal((await st.service.emitOverdue(СЕЙЧАС)).emitted, 1);
    assert.deepEqual(st.заявки, ["task-overdue:2026-08-26:t1"]);
    const payload = st.записанные[0]!.payload as Row;
    assert.equal(payload.title, "Задача t1");
    assert.equal(payload.daysOverdue, 1);
  });

  it("повторный прогон в те же сутки события не даёт — ключ занят", async () => {
    const key = "task-overdue:2026-08-26:t1";
    const st = стендПросрочки({
      задачи: [просрочка("t1", "2026-08-25T18:00:00+05:00")],
      занятые: new Set([key]),
    });
    assert.equal((await st.service.emitOverdue(СЕЙЧАС)).emitted, 0);
    assert.deepEqual(st.записанные, []);
  });

  it("двадцать первая просрочка не эмитится, capped=true", async () => {
    const rows = Array.from({ length: OVERDUE_MAX_EVENTS + 1 }, (_, i) =>
      просрочка(`t${i}`, "2026-08-20T18:00:00+05:00"),
    );
    const st = стендПросрочки({ задачи: rows });
    const result = await st.service.emitOverdue(СЕЙЧАС);
    assert.equal(result.emitted, OVERDUE_MAX_EVENTS);
    assert.equal(result.capped, true);
    assert.equal(st.параметры.limit, OVERDUE_MAX_EVENTS + 1);
  });

  it("ровно двадцать просрочек — не обрезка", async () => {
    const rows = Array.from({ length: OVERDUE_MAX_EVENTS }, (_, i) =>
      просрочка(`t${i}`, "2026-08-20T18:00:00+05:00"),
    );
    const result = await стендПросрочки({ задачи: rows }).service.emitOverdue(СЕЙЧАС);
    assert.equal(result.emitted, OVERDUE_MAX_EVENTS);
    assert.equal(result.capped, false);
  });

  it("закрытые статусы отсекает сам SQL-запрос", async () => {
    const st = стендПросрочки({ задачи: [] });
    await st.service.emitOverdue(СЕЙЧАС);
    const query = new PgDialect().sqlToQuery(st.условия[0] as Parameters<PgDialect["sqlToQuery"]>[0]);
    assert.match(query.sql, /due/);
    assert.match(query.sql, /status/);
    assert.deepEqual(query.params.slice(-2), ["done", "cancelled"]);
  });
});
