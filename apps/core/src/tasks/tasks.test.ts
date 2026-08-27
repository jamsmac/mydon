import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PgDialect } from "drizzle-orm/pg-core";
import { task, TASK_SOURCE_DAY_PREDICATE } from "@mydon/db";
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
  /**
   * Очередь ответов select по порядку вызовов — для сценариев с несколькими
   * выборками подряд (хук ТО: план → «сегодня уже отмечено?»). Не задана —
   * работает прежний одиночный selectResult/existing.
   */
  selects?: Row[][];
  /** Куда складывать аргумент `onConflictDoNothing` — иначе фикс регрессирует так же незаметно. */
  conflicts?: { target?: unknown; where?: unknown }[];
}

/**
 * Заглушка БД. Поддерживает ровно те цепочки Drizzle, которыми пользуется
 * сервис: select().from().where()[.limit()], update().set().where().returning(),
 * insert().values()[.onConflictDoNothing()].returning() и голый await у вставки.
 */
function stubDb(opts: StubOpts) {
  const queue = opts.selects ? [...opts.selects] : null;
  const rowsOf = () =>
    queue ? (queue.shift() ?? []) : (opts.selectResult ?? (opts.existing ? [opts.existing] : []));

  // where() и awaitable, и с .limit() — сервис использует оба варианта.
  // Ответ мемоизируется на цепочку: и await, и .limit() видят ОДИН элемент
  // очереди, иначе каждая цепочка съедала бы два.
  const whereChain = () => {
    let memo: Row[] | null = null;
    const result = async () => (memo ??= rowsOf());
    return Object.assign(result(), { limit: result });
  };

  const insert = () => ({
    values: (v: unknown) => {
      const row = { id: "t1", ...(v as Row) };
      opts.inserted?.push(row);
      const returning = async () => (opts.insertConflict ? [] : [row]);
      return {
        onConflictDoNothing: (cfg?: { target?: unknown; where?: unknown }) => {
          opts.conflicts?.push({ target: cfg?.target, where: cfg?.where });
          return { returning };
        },
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

/**
 * MaintenanceService нужен сервису задач только ради хука «закрыл задачу ТО».
 * В этих тестах source задач не maint:* — хук до createLog не доходит, а если
 * дойдёт (регресс), заглушка уронит тест громко, а не молча съест вызов.
 */
const stubMaintenance = {
  createLog: async () => {
    throw new Error("createLog вызван вне сценария ТО — регресс хука");
  },
} as never;

const makeTasks = (db: never) => new TasksService(db, stubMaintenance);

describe("Задачи", () => {
  it("создаётся вместе с записью в журнал", async () => {
    const s = makeTasks(stubDb({}));
    const t = await s.create({ title: "Снять показания", ownerKind: "human" });
    assert.equal(t.id, "t1");
  });

  it("повторное «Готово» не ошибка — возвращает ту же задачу", async () => {
    // UPDATE ничего не вернул (статус уже такой), строка существует
    const s = makeTasks(stubDb({ existing: { id: "t1", status: "done" } }));
    const t = await s.setStatus("t1", "done");
    assert.equal(t.status, "done");
  });

  it("сообщает, что задачи нет", async () => {
    const s = makeTasks(stubDb({}));
    await assert.rejects(() => s.setStatus("нет", "done"), /не найдена/);
  });

  it("повторяющаяся задача не дублируется в тот же день", async () => {
    // Дубль отсекает БД (частичный уникальный индекс task_source_key), а не
    // предварительный select: два тика монитора в одну секунду проходили
    // проверку оба и создавали две задачи.
    const s = makeTasks(stubDb({ insertConflict: true }));
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
    const s = makeTasks(stubDb({ inserted }));
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
    await makeTasks(stubDb({ insertConflict: true, inserted })).ensureForDay({
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
    const s = makeTasks(stubDb({ inserted }));
    await s.create({
      title: "Помыть миксер",
      ownerKind: "human",
      entityId: "33333333-3333-4333-8333-333333333333",
    });
    assert.equal(inserted[0]?.entityId, "33333333-3333-4333-8333-333333333333");
  });
});

describe("Дедуп задач на день держится ЧАСТИЧНЫМ индексом (R-G-2)", () => {
  it("вставка называет и колонку, и ПРЕДИКАТ индекса — иначе Postgres отвечает 42P10", async () => {
    // Без `where` drizzle печатает `on conflict ("source") do nothing`, и
    // частичный индекс `task_source_key` из такой спецификации не выводится.
    // Прод 26.08: задач от монитора 0 за всё время при 19 попытках в сутки.
    const conflicts: { target?: unknown; where?: unknown }[] = [];
    await makeTasks(stubDb({ conflicts })).ensureForDay({
      title: "Мойка миксера",
      ownerKind: "human",
      source: "maint:pl-1",
      dayKey: "2026-08-26",
    });
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.target, task.source, "конфликт объявлен по той же колонке, что индекс");
    assert.equal(
      conflicts[0]!.where,
      TASK_SOURCE_DAY_PREDICATE,
      "предикат — ТО ЖЕ значение, что у индекса в схеме, а не его копия строкой",
    );
  });

  it("предикат рендерится литералом, без единого параметра", () => {
    // `index_predicate` в `ON CONFLICT` сравнивается с предикатом индекса, а
    // не исполняется как фильтр: `$1` вместо литерала снова дал бы 42P10.
    const { sql: текст, params } = new PgDialect().sqlToQuery(TASK_SOURCE_DAY_PREDICATE);
    assert.equal(текст, "source ~ ':[0-9]{4}-[0-9]{2}-[0-9]{2}$'");
    assert.deepEqual(params, [], "параметр в предикате ломает вывод частичного индекса");
  });
});

describe("Общий пул свободных задач", () => {
  const PERSON = "11111111-1111-4111-8111-111111111111";

  it("взять свободную задачу — исполнителем становится нажавший", async () => {
    const inserted: Row[] = [];
    const s = makeTasks(
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
    const s = makeTasks(stubDb({ updateResult: undefined }));
    assert.equal(await s.claim("t1", PERSON), null);
  });

  it("вернуть в пул можно только свою задачу", async () => {
    const s = makeTasks(stubDb({ existing: { id: "t1", ownerRef: "чужой", status: "todo" } }));
    assert.equal(
      await s.release("t1", PERSON),
      null,
      "иначе один сотрудник снимает задачу с другого",
    );
  });

  it("возврат в пул снимает исполнителя и выводит из работы", async () => {
    const inserted: Row[] = [];
    const s = makeTasks(
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
    const s = makeTasks(stubDb({}));
    await assert.rejects(() => makeTasks(stubDb({})).release("нет", PERSON), /не найдена/);
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

    const s = makeTasks(db);
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

    const s = makeTasks(db);
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

    const s = makeTasks(db);
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
    const t = await makeTasks(db).edit("t1", {
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
    await makeTasks(db).edit("t1", { description: "  ", ownerRef: "" });
    assert.equal(captured[0].description, null);
    assert.equal(captured[0].ownerRef, null);
  });

  it("пустой заголовок отклоняется", async () => {
    const { db } = editStub({ id: "t1" });
    await assert.rejects(() => makeTasks(db).edit("t1", { title: "   " }), /пустым/);
  });

  it("пустой патч не трогает базу и возвращает задачу", async () => {
    const { db, captured } = editStub({ id: "t1", title: "Как есть" });
    const t = await makeTasks(db).edit("t1", {});
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
    await assert.rejects(() => makeTasks(db).edit("нет", { priority: "high" }), /не найдена/);
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
    const s = makeTasks(stubDb({ selectResult: [{ status: "repair" }], inserted }));
    const res = await s.ensureForDay(общее);
    assert.equal(res, null);
    assert.equal(inserted.length, 0, "ни задачи, ни записи в журнале");
  });

  it("автомат на складе — то же самое", async () => {
    const s = makeTasks(stubDb({ selectResult: [{ status: "warehouse" }] }));
    assert.equal(await s.ensureForDay(общее), null);
  });

  it("рабочий автомат задачу получает", async () => {
    const s = makeTasks(stubDb({ selectResult: [{ status: "in_service" }] }));
    assert.ok(await s.ensureForDay(общее));
  });

  it("объект без карточки автомата считается рабочим", async () => {
    // Признак заводился для парка, а не для всего реестра: техника,
    // помещения и договоры не должны молча остаться без задач.
    const s = makeTasks(stubDb({ selectResult: [] }));
    assert.ok(await s.ensureForDay(общее));
  });

  it("задача без объекта проверку не проходит вовсе", async () => {
    const s = makeTasks(stubDb({}));
    assert.ok(await s.ensureForDay({ title: "Инвентаризация", ownerKind: "human", dayKey: "2026-08-08" }));
  });
});

describe("Хук «закрыл задачу ТО → факт в журнале обслуживания»", () => {
  const PLAN = "44444444-4444-4444-8444-444444444444";
  const ENTITY = "55555555-5555-4555-8555-555555555555";
  const план = { id: PLAN, entityId: ENTITY, kind: "cleaning", partKind: "mixer" };

  /** Maintenance-заглушка, записывающая вызовы createLog. */
  function maintSpy(calls: Row[]) {
    return {
      createLog: async (input: Row, tx: unknown) => {
        calls.push({ ...input, txPassed: tx !== undefined });
        return {};
      },
    } as never;
  }

  it("закрытие maint-задачи пишет факт с идемпотентным ключом в той же транзакции", async () => {
    const calls: Row[] = [];
    const s = new TasksService(
      stubDb({
        updateResult: {
          id: "t1",
          status: "done",
          source: `maint:${PLAN}:2026-08-01`,
          resultNote: "промыл",
          entityId: ENTITY,
        },
        // очередь: план найден → сегодня ещё не отмечено.
        selects: [[план], []],
      }),
      maintSpy(calls),
    );
    await s.setStatus("t1", "done", "person:x", "промыл");

    assert.equal(calls.length, 1, "факт обязан записаться");
    const call = calls[0]!;
    assert.equal(call.planId, PLAN);
    assert.equal(call.kind, "cleaning");
    assert.equal(call.partKind, "mixer");
    assert.equal(call.outcome, "done");
    assert.equal(call.clientKey, "task:t1", "ретрай закрытия не должен дать вторую запись");
    assert.equal(call.note, "промыл", "отчёт из задачи становится заметкой факта");
    assert.equal(call.txPassed, true, "факт и статус коммитятся вместе");
  });

  it("«Сделал» в Графиках уже нажат сегодня — второй записи нет", async () => {
    const calls: Row[] = [];
    const s = new TasksService(
      stubDb({
        updateResult: { id: "t1", status: "done", source: `maint:${PLAN}:2026-08-01`, resultNote: null },
        selects: [[план], [{ id: "уже" }]],
      }),
      maintSpy(calls),
    );
    await s.setStatus("t1", "done");
    assert.equal(calls.length, 0, "двойной счёт одного факта запрещён");
  });

  it("план удалён — закрытие задачи не падает и факт не пишется", async () => {
    const calls: Row[] = [];
    const s = new TasksService(
      stubDb({
        updateResult: { id: "t1", status: "done", source: `maint:${PLAN}:2026-08-01`, resultNote: null },
        selects: [[]],
      }),
      maintSpy(calls),
    );
    const t = await s.setStatus("t1", "done");
    assert.equal(t.status, "done");
    assert.equal(calls.length, 0);
  });

  it("обычная задача (source не maint:*) журнал обслуживания не трогает", async () => {
    // makeTasks с бросающей заглушкой: дойди хук до createLog — тест упал бы.
    const s = makeTasks(stubDb({ updateResult: { id: "t1", status: "done", source: "manual", resultNote: null } }));
    const t = await s.setStatus("t1", "done");
    assert.equal(t.status, "done");
  });
});
