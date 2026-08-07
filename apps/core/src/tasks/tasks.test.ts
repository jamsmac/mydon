import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TasksService } from "./tasks.service";

type Row = Record<string, unknown>;

interface StubOpts {
  existing?: Row;
  updateResult?: Row;
  selectResult?: Row[];
  /** true — уникальный индекс отсёк вставку: задача на этот день уже есть. */
  insertConflict?: boolean;
  /** Куда складывать вставленные строки — чтобы проверить журнал аудита. */
  inserted?: Row[];
}

/**
 * Заглушка БД. Поддерживает ровно те цепочки Drizzle, которыми пользуется
 * сервис: select().from().where()[.limit()], update().set().where().returning(),
 * insert().values()[.onConflictDoNothing()].returning() и голый await у вставки.
 */
function stubDb(opts: StubOpts) {
  const rowsOf = () => opts.selectResult ?? (opts.existing ? [opts.existing] : []);

  // where() и awaitable, и с .limit() — сервис использует оба варианта.
  const whereChain = () => {
    const result = async () => rowsOf();
    return Object.assign(result(), { limit: result });
  };

  const insert = () => ({
    values: (v: unknown) => {
      const row = { id: "t1", ...(v as Row) };
      opts.inserted?.push(row);
      const returning = async () => (opts.insertConflict ? [] : [row]);
      return {
        onConflictDoNothing: () => ({ returning }),
        returning,
        // `await db.insert(x).values(y)` без returning — запись в журнал.
        then: (res: (v: unknown) => unknown) => Promise.resolve([row]).then(res),
      };
    },
  });

  const tx = {
    select: () => ({ from: () => ({ where: whereChain }) }),
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => (opts.updateResult ? [opts.updateResult] : []) }) }),
    }),
    insert,
  };
  return {
    select: tx.select,
    insert,
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
}

describe("Задачи", () => {
  it("создаётся вместе с записью в журнал", async () => {
    const s = new TasksService(stubDb({}));
    const t = await s.create({ title: "Снять показания", ownerKind: "human" });
    assert.equal(t.id, "t1");
  });

  it("повторное «Готово» не ошибка — возвращает ту же задачу", async () => {
    // UPDATE ничего не вернул (статус уже такой), строка существует
    const s = new TasksService(stubDb({ existing: { id: "t1", status: "done" } }));
    const t = await s.setStatus("t1", "done");
    assert.equal(t.status, "done");
  });

  it("сообщает, что задачи нет", async () => {
    const s = new TasksService(stubDb({}));
    await assert.rejects(() => s.setStatus("нет", "done"), /не найдена/);
  });

  it("повторяющаяся задача не дублируется в тот же день", async () => {
    // Дубль отсекает БД (частичный уникальный индекс task_source_key), а не
    // предварительный select: два тика монитора в одну секунду проходили
    // проверку оба и создавали две задачи.
    const s = new TasksService(stubDb({ insertConflict: true }));
    const again = await s.ensureForDay({
      title: "Инвентаризация",
      ownerKind: "human",
      source: "recurring:inventory",
      dayKey: "2026-07-28",
    });
    assert.equal(again, null, "иначе владелец получал бы по три одинаковых задачи в день");
  });

  it("в новый день задача заводится заново", async () => {
    const inserted: Row[] = [];
    const s = new TasksService(stubDb({ inserted }));
    const created = await s.ensureForDay({
      title: "Инвентаризация",
      ownerKind: "human",
      source: "recurring:inventory",
      dayKey: "2026-07-29",
    });
    assert.ok(created, "на новый день задача должна появиться");
    assert.match(String(created?.source), /2026-07-29/);
    assert.ok(
      inserted.some((r) => r.action === "task.create"),
      "создание должно оставлять след в журнале аудита",
    );
  });

  it("проигранная гонка не пишет в журнал аудита", async () => {
    const inserted: Row[] = [];
    await new TasksService(stubDb({ insertConflict: true, inserted })).ensureForDay({
      title: "Инвентаризация",
      ownerKind: "human",
      source: "recurring:inventory",
      dayKey: "2026-07-28",
    });
    assert.ok(
      !inserted.some((r) => r.action === "task.create"),
      "иначе журнал показывал бы созданные задачи, которых нет",
    );
  });

  it("объект работы сохраняется вместе с задачей", async () => {
    const inserted: Row[] = [];
    const s = new TasksService(stubDb({ inserted }));
    await s.create({
      title: "Помыть миксер",
      ownerKind: "human",
      entityId: "33333333-3333-4333-8333-333333333333",
    });
    assert.equal(inserted[0]?.entityId, "33333333-3333-4333-8333-333333333333");
  });
});

describe("Общий пул свободных задач", () => {
  const PERSON = "11111111-1111-4111-8111-111111111111";

  it("взять свободную задачу — исполнителем становится нажавший", async () => {
    const inserted: Row[] = [];
    const s = new TasksService(
      stubDb({ updateResult: { id: "t1", ownerRef: PERSON }, inserted }),
    );
    const claimed = await s.claim("t1", PERSON);
    assert.equal(claimed?.ownerRef, PERSON);
    assert.ok(
      inserted.some((r) => r.action === "task.claimed"),
      "взятие задачи должно быть видно в журнале",
    );
  });

  it("второй нажавший получает null, а не ошибку и не чужую задачу", async () => {
    // UPDATE ... WHERE owner_ref IS NULL не вернул строк: успел другой.
    // Гонку разрешает БД — при двух техниках и одном дайджесте это обычное утро.
    const s = new TasksService(stubDb({ updateResult: undefined }));
    assert.equal(await s.claim("t1", PERSON), null);
  });

  it("вернуть в пул можно только свою задачу", async () => {
    const s = new TasksService(stubDb({ existing: { id: "t1", ownerRef: "чужой", status: "todo" } }));
    assert.equal(
      await s.release("t1", PERSON),
      null,
      "иначе один сотрудник снимает задачу с другого",
    );
  });

  it("возврат в пул снимает исполнителя и выводит из работы", async () => {
    const inserted: Row[] = [];
    const s = new TasksService(
      stubDb({
        existing: { id: "t1", ownerRef: PERSON, status: "in_progress" },
        updateResult: { id: "t1", ownerRef: null, status: "todo" },
        inserted,
      }),
    );
    const freed = await s.release("t1", PERSON);
    assert.equal(freed?.ownerRef, null);
    assert.equal(freed?.status, "todo", "брошенная задача не должна висеть «в работе»");
    assert.ok(inserted.some((r) => r.action === "task.released"));
  });

  it("несуществующую задачу вернуть нельзя — это ошибка, а не отказ", async () => {
    const s = new TasksService(stubDb({}));
    await assert.rejects(() => new TasksService(stubDb({})).release("нет", PERSON), /не найдена/);
    assert.ok(s);
  });
});

describe("Оценка сделанной задачи", () => {
  it("«переделать» возвращает задачу в работу и включает напоминания заново", async () => {
    const captured: Record<string, unknown>[] = [];
    const done = { id: "t1", status: "done", resultNote: "готово", quality: null };
    const tx = {
      select: () => ({ from: () => ({ where: async () => [done] }) }),
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          captured.push(patch);
          return { where: () => ({ returning: async () => [{ ...done, ...patch }] }) };
        },
      }),
      insert: () => ({ values: async () => [] }),
    };
    const db = { transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx) } as never;

    const s = new TasksService(db);
    const updated = await s.rate("t1", "redo");
    assert.equal(updated.status, "in_progress");
    assert.equal(captured[0].completedAt, null, "время закрытия должно сброситься");
    assert.equal(captured[0].remindedAt, null, "напоминания должны включиться заново");
  });

  it("«отлично» не меняет статус — только отметка качества", async () => {
    const captured: Record<string, unknown>[] = [];
    const done = { id: "t1", status: "done", resultNote: "готово", quality: null };
    const tx = {
      select: () => ({ from: () => ({ where: async () => [done] }) }),
      update: () => ({
        set: (patch: Record<string, unknown>) => {
          captured.push(patch);
          return { where: () => ({ returning: async () => [{ ...done, ...patch }] }) };
        },
      }),
      insert: () => ({ values: async () => [] }),
    };
    const db = { transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx) } as never;

    const s = new TasksService(db);
    const updated = await s.rate("t1", "excellent");
    assert.equal(updated.status, "done");
    assert.equal(captured[0].quality, "excellent");
    assert.equal("completedAt" in captured[0], false, "время закрытия трогать нельзя");
  });

  it("несделанную задачу оценить нельзя — понятная ошибка", async () => {
    const open = { id: "t1", status: "in_progress" };
    const tx = {
      select: () => ({ from: () => ({ where: async () => [open] }) }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      insert: () => ({ values: async () => [] }),
    };
    const db = { transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx) } as never;

    const s = new TasksService(db);
    await assert.rejects(() => s.rate("t1", "excellent"), /только сделанную/);
  });
});

describe("Правка полей задачи (edit)", () => {
  function editStub(existing: Row) {
    const captured: Record<string, unknown>[] = [];
    const tx = {
      update: () => ({
        set: (p: Record<string, unknown>) => {
          captured.push(p);
          return { where: () => ({ returning: async () => [{ ...existing, ...p }] }) };
        },
      }),
      insert: () => ({ values: async () => [] }),
      select: () => ({ from: () => ({ where: async () => [existing] }) }),
    };
    const db = {
      // byId использует .limit(1) — where возвращает объект с limit.
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [existing] }) }) }),
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never;
    return { db, captured };
  }

  it("переназначает исполнителя и меняет приоритет — трогает только эти поля", async () => {
    const { db, captured } = editStub({ id: "t1", ownerKind: "human", ownerRef: null, priority: "normal" });
    const t = await new TasksService(db).edit("t1", {
      ownerKind: "agent",
      ownerRef: "vendhub-ops",
      priority: "high",
    });
    assert.equal(t.ownerKind, "agent");
    assert.equal(captured[0].ownerRef, "vendhub-ops");
    assert.equal(captured[0].priority, "high");
    assert.equal("status" in captured[0], false, "статус правкой полей не трогаем");
  });

  it("пустое описание/исполнитель → снятие (null)", async () => {
    const { db, captured } = editStub({ id: "t1" });
    await new TasksService(db).edit("t1", { description: "  ", ownerRef: "" });
    assert.equal(captured[0].description, null);
    assert.equal(captured[0].ownerRef, null);
  });

  it("пустой заголовок отклоняется", async () => {
    const { db } = editStub({ id: "t1" });
    await assert.rejects(() => new TasksService(db).edit("t1", { title: "   " }), /пустым/);
  });

  it("пустой патч не трогает базу и возвращает задачу", async () => {
    const { db, captured } = editStub({ id: "t1", title: "Как есть" });
    const t = await new TasksService(db).edit("t1", {});
    assert.equal(t.id, "t1");
    assert.equal(captured.length, 0, "нечего менять — не пишем в журнал");
  });

  it("нет задачи → понятная ошибка", async () => {
    const tx = {
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
      insert: () => ({ values: async () => [] }),
      select: () => ({ from: () => ({ where: async () => [] }) }),
    };
    const db = { transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx) } as never;
    await assert.rejects(() => new TasksService(db).edit("нет", { priority: "high" }), /не найдена/);
  });
});

describe("Страховка: автомату вне эксплуатации задач не ставим", () => {
  const общее = {
    title: "Плановое ТО — Olma склад",
    ownerKind: "human" as const,
    source: "maint:plan-1",
    dayKey: "2026-11-04",
    entityId: "22222222-2222-4222-8222-222222222222",
  };

  it("автомат в ремонте задачу не получает", async () => {
    // Правило соблюдает монитор графиков, но POST /tasks/ensure-day открыт:
    // следующий источник повторяющихся задач обошёл бы его молча.
    const inserted: Row[] = [];
    const s = new TasksService(stubDb({ selectResult: [{ status: "repair" }], inserted }));
    const res = await s.ensureForDay(общее);
    assert.equal(res, null);
    assert.equal(inserted.length, 0, "ни задачи, ни записи в журнале");
  });

  it("автомат на складе — то же самое", async () => {
    const s = new TasksService(stubDb({ selectResult: [{ status: "warehouse" }] }));
    assert.equal(await s.ensureForDay(общее), null);
  });

  it("рабочий автомат задачу получает", async () => {
    const s = new TasksService(stubDb({ selectResult: [{ status: "in_service" }] }));
    assert.ok(await s.ensureForDay(общее));
  });

  it("объект без карточки автомата считается рабочим", async () => {
    // Признак заводился для парка, а не для всего реестра: техника,
    // помещения и договоры не должны молча остаться без задач.
    const s = new TasksService(stubDb({ selectResult: [] }));
    assert.ok(await s.ensureForDay(общее));
  });

  it("задача без объекта проверку не проходит вовсе", async () => {
    const s = new TasksService(stubDb({}));
    assert.ok(await s.ensureForDay({ title: "Инвентаризация", ownerKind: "human", dayKey: "2026-08-08" }));
  });
});
