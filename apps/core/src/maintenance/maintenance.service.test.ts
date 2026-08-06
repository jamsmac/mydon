import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addDays } from "@mydon/shared";
import { MaintenanceService, todayInTz } from "./maintenance.service";

type Row = Record<string, unknown>;

interface StubOpts {
  /** Что вернёт select: очередь ответов по порядку вызовов. */
  selects?: Row[][];
  /**
   * Строка ДО обновления. Настоящий RETURNING отдаёт всю строку целиком,
   * а не только изменённые поля, — заглушка обязана делать так же, иначе
   * тест на «поле не перетёрлось» пройдёт по недоразумению.
   */
  updateResult?: Row;
  /** Куда складывать вставленное — для проверки журнала аудита. */
  inserted?: Row[];
  /** Что удалили. */
  deleted?: string[];
  /** Патчи, ушедшие в update — чтобы проверить сдвиг якоря. */
  updated?: Row[];
}

/**
 * Заглушка БД. Ответы select выдаются по очереди: сервис делает несколько
 * выборок подряд, и подменять их одним значением значит не проверить порядок.
 */
function stubDb(opts: StubOpts) {
  const queue = [...(opts.selects ?? [])];
  const next = () => queue.shift() ?? [];

  const selectChain = () => {
    const rows = async () => next();
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.innerJoin = () => chain;
    chain.groupBy = () => chain;
    chain.orderBy = () => chain;
    chain.limit = rows;
    chain.then = (res: (v: unknown) => unknown) => rows().then(res);
    return chain;
  };

  const tx = {
    select: selectChain,
    insert: () => ({
      values: (v: Row) => {
        const row = { id: "m1", createdAt: new Date(), ...v };
        opts.inserted?.push(row);
        return {
          returning: async () => [row],
          then: (res: (x: unknown) => unknown) => Promise.resolve([row]).then(res),
        };
      },
    }),
    update: () => ({
      set: (patch: Row) => {
        opts.updated?.push(patch);
        const done = { returning: async () => [{ id: "m1", ...(opts.updateResult ?? {}), ...patch }] };
        return {
          // update(...).set(...).where(...) — и с returning, и без него.
          where: () => Object.assign(Promise.resolve([]), done),
        };
      },
    }),
    delete: () => ({
      where: async () => {
        opts.deleted?.push("m1");
        return [];
      },
    }),
  };

  return {
    select: selectChain,
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
}

const PERSON = "11111111-1111-4111-8111-111111111111";
const MACHINE = "22222222-2222-4222-8222-222222222222";

describe("Календарный день работ", () => {
  it("считается по Ташкенту, а не по зоне процесса", () => {
    // 2026-08-06T19:30Z — уже 7 августа в Ташкенте (UTC+5). Работа в 00:30
    // должна попасть в новый день, иначе сроки следующих работ сдвинутся.
    assert.equal(todayInTz(new Date("2026-08-06T19:30:00.000Z")), "2026-08-07");
    assert.equal(todayInTz(new Date("2026-08-06T18:59:00.000Z")), "2026-08-06");
  });
});

describe("Журнал обслуживания", () => {
  it("запись без результата допустима — работа начата и не закрыта", async () => {
    const inserted: Row[] = [];
    const s = new MaintenanceService(stubDb({ inserted }));
    const row = await s.createLog({ entityId: MACHINE, kind: "cleaning", personId: PERSON });
    assert.equal(row.outcome, null, "техник отметился на точке, а закончит через час");
    assert.ok(inserted.some((r) => r.action === "maintenance.log_created"));
  });

  it("день по умолчанию — сегодняшний по Ташкенту", async () => {
    const inserted: Row[] = [];
    const s = new MaintenanceService(stubDb({ inserted }));
    await s.createLog({ entityId: MACHINE, kind: "service" });
    assert.equal(inserted[0]?.performedOn, todayInTz());
  });

  it("закрытие проставляет результат и пишет в журнал аудита", async () => {
    const inserted: Row[] = [];
    const s = new MaintenanceService(
      stubDb({ selects: [[{ id: "m1", outcome: null }]], inserted }),
    );
    const closed = await s.closeLog("m1", { outcome: "done", note: "промыл" }, "person:x");
    assert.equal(closed.outcome, "done");
    assert.ok(inserted.some((r) => r.action === "maintenance.log_closed"));
  });

  it("закрыть несуществующую запись нельзя", async () => {
    const s = new MaintenanceService(stubDb({ selects: [[]] }));
    await assert.rejects(() => s.closeLog("нет", { outcome: "done" }), /нет/i);
  });
});

describe("Удаление своей записи", () => {
  const fresh = (over: Row = {}) => ({
    id: "m1",
    personId: PERSON,
    createdAt: new Date(Date.now() - 5 * 60_000),
    ...over,
  });

  it("автор может убрать свежую запись", async () => {
    const inserted: Row[] = [];
    const deleted: string[] = [];
    const s = new MaintenanceService(stubDb({ selects: [[fresh()], []], inserted, deleted }));
    await s.removeLog("m1", PERSON, `person:${PERSON}`);
    assert.deepEqual(deleted, ["m1"]);
    assert.ok(inserted.some((r) => r.action === "maintenance.log_removed"));
  });

  it("чужую запись не тронуть", async () => {
    const s = new MaintenanceService(stubDb({ selects: [[fresh({ personId: "другой" })]] }));
    await assert.rejects(() => s.removeLog("m1", PERSON, "x"), /не твоя/i);
  });

  it("старше часа не удаляется — по ней уже посчитаны сроки", async () => {
    const old = fresh({ createdAt: new Date(Date.now() - 2 * 60 * 60_000) });
    const s = new MaintenanceService(stubDb({ selects: [[old]] }));
    await assert.rejects(() => s.removeLog("m1", PERSON, "x"), /старше часа/i);
  });

  it("запись, на которой держится замена узла, не удаляется", async () => {
    // Иначе период жизни детали осиротеет: узел стоит, а откуда взялся — нет.
    const s = new MaintenanceService(stubDb({ selects: [[fresh()], [{ id: "p1" }]] }));
    await assert.rejects(() => s.removeLog("m1", PERSON, "x"), /замена узла/i);
  });
});

describe("Замена узла", () => {
  it("закрывает старый период и открывает новый одной транзакцией", async () => {
    const inserted: Row[] = [];
    const s = new MaintenanceService(
      stubDb({
        selects: [[{ id: "p-old", serialNumber: "SN-111" }]],
        updateResult: { id: "p-old", serialNumber: "SN-111" },
        inserted,
      }),
    );
    const res = await s.swapPart({
      machineId: MACHINE,
      partKind: "bill_acceptor",
      newSerial: "SN-222",
      reason: "failure",
      personId: PERSON,
      performedOn: "2026-08-06",
    });

    assert.equal(res.log.kind, "part_replace");
    assert.equal(res.log.outcome, "done", "замена — всегда свершившийся факт");
    assert.equal(res.removed?.removedOn, "2026-08-06", "старый узел должен закрыться той же датой");
    assert.equal(res.installed.serialNumber, "SN-222");
    assert.equal(res.installed.installedOn, "2026-08-06");
    assert.ok(inserted.some((r) => r.action === "maintenance.part_swapped"));
  });

  it("первая установка работает без старого узла", async () => {
    const s = new MaintenanceService(stubDb({ selects: [[]] }));
    const res = await s.swapPart({ machineId: MACHINE, partKind: "grinder", newSerial: "G-1" });
    assert.equal(res.removed, null);
    assert.equal(res.installed.serialNumber, "G-1");
  });

  it("серийник старого узла дописывается, если его не знали при установке", async () => {
    // Техник переписывает номер, снимая деталь. Дописываем, а не затираем:
    // пустое значение — не то же самое, что «другое».
    const s = new MaintenanceService(
      stubDb({
        selects: [[{ id: "p-old", serialNumber: null }]],
        updateResult: { id: "p-old", serialNumber: null },
      }),
    );
    const res = await s.swapPart({
      machineId: MACHINE,
      partKind: "coin_acceptor",
      oldSerial: "OLD-9",
      newSerial: "NEW-9",
    });
    assert.equal(res.removed?.serialNumber, "OLD-9");
  });

  it("известный серийник старого узла не перетирается", async () => {
    const s = new MaintenanceService(
      stubDb({
        selects: [[{ id: "p-old", serialNumber: "REAL" }]],
        updateResult: { id: "p-old", serialNumber: "REAL" },
      }),
    );
    const res = await s.swapPart({
      machineId: MACHINE,
      partKind: "coin_acceptor",
      oldSerial: "ОШИБКА",
      newSerial: "NEW",
    });
    assert.equal(res.removed?.serialNumber, "REAL");
  });

  it("замена без указания даты идёт сегодняшним днём по Ташкенту", async () => {
    const s = new MaintenanceService(stubDb({ selects: [[]] }));
    const res = await s.swapPart({ machineId: MACHINE, partKind: "water_filter" });
    assert.equal(res.installed.installedOn, todayInTz());
  });
});

describe("Нормативы и сроки", () => {
  const PLAN = { id: "pl-1", dueOn: "2026-03-01", everyDays: 30, everyMonths: null, everyCount: null };

  it("закрытие работы сдвигает якорь от плановой даты, а не от фактической", async () => {
    // Иначе график ползёт: срок 1 марта, сделали 5-го — следующий должен быть
    // 31 марта, и «ежемесячная» работа не превращается в «раз в 35 дней».
    const updates: Row[] = [];
    const s = new MaintenanceService(
      stubDb({
        selects: [[{ id: "m1", outcome: null }], [PLAN]],
        updateResult: { id: "m1", planId: "pl-1", outcome: "done", performedOn: "2026-03-05" },
        updated: updates,
      }),
    );
    await s.closeLog("m1", { outcome: "done" });
    assert.ok(
      updates.some((u) => u.dueOn === "2026-03-31"),
      `якорь должен уехать на 31 марта, а не на дату факта: ${JSON.stringify(updates)}`,
    );
  });

  it("незакрытая работа якорь не двигает", async () => {
    // «Начал и не доделал» не является выполнением норматива.
    const updates: Row[] = [];
    const s = new MaintenanceService(
      stubDb({
        selects: [[{ id: "m1", outcome: null }], [PLAN]],
        updateResult: { id: "m1", planId: "pl-1", outcome: "failed", performedOn: "2026-03-05" },
        updated: updates,
      }),
    );
    await s.closeLog("m1", { outcome: "failed" });
    assert.ok(!updates.some((u) => u.dueOn), "срок не должен сдвинуться");
  });

  it("работа без норматива никуда не сдвигает срок", async () => {
    const updates: Row[] = [];
    const s = new MaintenanceService(
      stubDb({
        selects: [[{ id: "m1", outcome: null }]],
        updateResult: { id: "m1", planId: null, outcome: "done", performedOn: "2026-03-05" },
        updated: updates,
      }),
    );
    await s.closeLog("m1", { outcome: "done" });
    assert.ok(!updates.some((u) => u.dueOn));
  });

  it("новый норматив получает первый срок от сегодня, а не задним числом", async () => {
    // Норматив заводят, когда решили следить. Требовать работу за период,
    // за который никто не отвечал, значит начать с красного экрана.
    const inserted: Row[] = [];
    const s = new MaintenanceService(stubDb({ inserted }));
    await s.upsertPlan({ entityId: MACHINE, kind: "cleaning", everyDays: 14 });
    const plan = inserted.find((r) => r.entityId === MACHINE)!;
    assert.equal(plan.dueOn, addDays(todayInTz(), 14), "ровно период от сегодня");
  });

  it("выключение норматива не удаляет его", async () => {
    // Исключение «этот моем реже» выражается выключением: удаление унесло бы
    // историю, по которой видно, что раньше следили.
    const inserted: Row[] = [];
    const s = new MaintenanceService(
      stubDb({ selects: [[{ id: "pl-1", isActive: true }]], updateResult: { id: "pl-1" }, inserted }),
    );
    const res = await s.deactivatePlan("pl-1");
    assert.equal(res.isActive, false);
    assert.ok(inserted.some((r) => r.action === "maintenance.plan_deactivated"));
  });
});
