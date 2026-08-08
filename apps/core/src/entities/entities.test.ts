import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entity, machineCard, machinePlacement, maintenancePlan, task } from "@mydon/db";
import { EntitiesService, nameMatches } from "./entities.service";

/** Достаёт подставляемые значения из SQL-выражения Drizzle. */
function params(expr: ReturnType<typeof nameMatches>): string[] {
  const chunks = (expr as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.filter((c): c is string => typeof c === "string");
}

/** Собирает статическую часть выражения — для проверки ESCAPE и коллации. */
function sqlText(expr: ReturnType<typeof nameMatches>): string {
  const chunks = (expr as unknown as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((c) => {
      const v = (c as { value?: unknown })?.value;
      return Array.isArray(v) ? v.join("") : "";
    })
    .join("");
}

describe("Поиск по имени", () => {
  it("экранирует % — иначе «АР-100%» возвращал весь реестр", () => {
    const [pattern] = params(nameMatches("АР-100%"));
    assert.equal(pattern, "%АР-100\\%%");
  });

  it("экранирует _ — иначе «ООО _Строй» находило что попало", () => {
    const [pattern] = params(nameMatches("ООО _Строй"));
    assert.equal(pattern, "%ООО \\_Строй%");
  });

  it("экранирует саму обратную косую", () => {
    const [pattern] = params(nameMatches("путь\\файл"));
    assert.equal(pattern, "%путь\\\\файл%");
  });

  it("обычный запрос не портит", () => {
    const [pattern] = params(nameMatches("Глоберент"));
    assert.equal(pattern, "%Глоберент%");
  });

  it("использует явную коллацию — ILIKE не сворачивает кириллицу при локали C", () => {
    const text = sqlText(nameMatches("тест"));
    assert.match(text, /und-x-icu/);
    assert.match(text, /ESCAPE/);
    assert.match(text, /ILIKE/);
  });
});

describe("Удаление записи", () => {
  it("удаляет и оставляет содержимое в журнале (before)", async () => {
    const audit: Record<string, unknown>[] = [];
    const row = { id: "e1", name: "Test1", type: "machine" };
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ for: async () => [row] }) }) }),
      delete: () => ({ where: async () => undefined }),
      insert: () => ({ values: async (v: Record<string, unknown>) => { audit.push(v); } }),
    };
    const db = { transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx) } as never;
    const s = new EntitiesService(db, { record: async () => undefined } as never);
    await s.remove("e1", "owner");
    assert.equal(audit.length, 1);
    assert.equal(audit[0].action, "entity.delete");
    assert.deepEqual(audit[0].before, row);
  });

  it("несуществующая запись → понятная ошибка, журнал чист", async () => {
    const audit: unknown[] = [];
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ for: async () => [] }) }) }),
      delete: () => ({ where: async () => undefined }),
      insert: () => ({ values: async (v: unknown) => { audit.push(v); } }),
    };
    const db = { transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx) } as never;
    const s = new EntitiesService(db, { record: async () => undefined } as never);
    await assert.rejects(() => s.remove("нет-такой"), /не найдена/);
    assert.equal(audit.length, 0);
  });
});

describe("История цен товара", () => {
  function priceStub(before: Record<string, unknown>) {
    const updates: Record<string, unknown>[] = [];
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ for: async () => [before] }) }) }),
      update: () => ({
        set: (v: Record<string, unknown>) => {
          updates.push(v);
          return { where: () => ({ returning: async () => [{ ...before, ...v }] }) };
        },
      }),
      insert: () => ({ values: async () => undefined }),
      // Синк типизированной точки: у товаров без координат update чистит geo_point.
      delete: () => ({ where: async () => undefined }),
    };
    const db = { transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx) } as never;
    return { db, updates };
  }

  it("смена цены дописывает старую в «история цен», а не стирает", async () => {
    const { db } = priceStub({ id: "e1", attrs: { цена: 20000 } });
    const s = new EntitiesService(db, { record: async () => undefined } as never);
    const r = await s.update("e1", { attrs: { цена: 22000 } });
    const hist = (r.attrs as Record<string, unknown>)["история цен"];
    assert.ok(typeof hist === "string" && hist.includes("20"), `история не записана: ${hist}`);
    assert.ok(String(hist).includes("(до "), "нет даты, до которой действовала цена");
  });

  it("вторая смена цены добавляется к истории через точку с запятой", async () => {
    const { db } = priceStub({
      id: "e1",
      attrs: { цена: 22000, "история цен": "20 000 сум (до 01.07.2026)" },
    });
    const s = new EntitiesService(db, { record: async () => undefined } as never);
    const r = await s.update("e1", { attrs: { цена: 25000 } });
    const hist = String((r.attrs as Record<string, unknown>)["история цен"]);
    assert.ok(hist.startsWith("20 000 сум (до 01.07.2026); "), `старая история потеряна: ${hist}`);
    assert.ok(hist.includes("22"), "новая запись не добавлена");
  });

  it("цена не менялась — история не трогается", async () => {
    const { db } = priceStub({ id: "e1", attrs: { цена: 20000 } });
    const s = new EntitiesService(db, { record: async () => undefined } as never);
    const r = await s.update("e1", { attrs: { цена: 20000, ИКПУ: "123" } });
    assert.equal((r.attrs as Record<string, unknown>)["история цен"], undefined);
  });
});

describe("Утвердить пачку карточек", () => {
  /** db, у которого select().from().where() отдаёт заготовленные ответы по порядку. */
  function seqDb(responses: Record<string, unknown>[][]) {
    let i = 0;
    return {
      select: () => ({ from: () => ({ where: async () => responses[i++] ?? [] }) }),
    } as never;
  }

  it("утверждает все ждущие, считает пройденные", async () => {
    const s = new EntitiesService(seqDb([[{ approvedAt: null }], [{ approvedAt: null }]]), {
      record: async () => undefined,
    } as never);
    let calls = 0;
    s.approve = (async () => {
      calls += 1;
      return {};
    }) as never;
    const r = await s.approveMany(["a", "b"]);
    assert.deepEqual(r, { approved: 2, skipped: 0 });
    assert.equal(calls, 2);
  });

  it("пропавшую и уже утверждённую пропускает, не роняя остальных", async () => {
    const s = new EntitiesService(seqDb([[], [{ approvedAt: new Date() }]]), {
      record: async () => undefined,
    } as never);
    let calls = 0;
    s.approve = (async () => {
      calls += 1;
      return {};
    }) as never;
    const r = await s.approveMany(["missing", "already"]);
    assert.deepEqual(r, { approved: 0, skipped: 2 });
    assert.equal(calls, 0, "утверждать нечего — approve не звался");
  });

  it("дубликаты в списке не утверждаются дважды", async () => {
    const s = new EntitiesService(seqDb([[{ approvedAt: null }]]), {
      record: async () => undefined,
    } as never);
    let calls = 0;
    s.approve = (async () => {
      calls += 1;
      return {};
    }) as never;
    const r = await s.approveMany(["x", "x"]);
    assert.deepEqual(r, { approved: 1, skipped: 0 });
    assert.equal(calls, 1);
  });

  it("сбой на одной карточке не срывает остальные — она уходит в пропущенные", async () => {
    const s = new EntitiesService(seqDb([[{ approvedAt: null }], [{ approvedAt: null }]]), {
      record: async () => undefined,
    } as never);
    let calls = 0;
    s.approve = (async () => {
      calls += 1;
      if (calls === 1) throw new Error("сбой");
      return {};
    }) as never;
    const r = await s.approveMany(["bad", "good"]);
    assert.deepEqual(r, { approved: 1, skipped: 1 });
  });
});

describe("Координаты карточки", () => {
  function stub(before: Record<string, unknown>) {
    const tx = {
      select: () => ({ from: () => ({ where: () => ({ for: async () => [before] }) }) }),
      update: () => ({
        set: (v: Record<string, unknown>) => ({
          where: () => ({ returning: async () => [{ ...before, ...v }] }),
        }),
      }),
      insert: () => ({ values: async () => undefined }),
      delete: () => ({ where: async () => undefined }),
    };
    return { transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx) } as never;
  }

  it("координаты вне диапазона отклоняются — мусор не сохранить", async () => {
    const s = new EntitiesService(stub({ id: "e1", attrs: {} }), { record: async () => undefined } as never);
    await assert.rejects(
      () => s.update("e1", { attrs: { широта: "999", долгота: "10" } }),
      /диапазон/i,
    );
  });

  it("перепутанные местами (широта 69) вне диапазона — тоже отказ", async () => {
    const s = new EntitiesService(stub({ id: "e1", attrs: {} }), { record: async () => undefined } as never);
    await assert.rejects(
      () => s.update("e1", { attrs: { широта: "69.2", долгота: "200" } }),
      /диапазон/i,
    );
  });
});

/**
 * Заглушка БД для setMachineKind: сервис делает две выборки подряд
 * (карточка объекта, затем текущая карточка автомата) и две вставки
 * (машинная карточка с onConflictDoUpdate, затем журнал аудита).
 */
function kindDb(opts: { entityRow?: Record<string, unknown>; before?: Record<string, unknown> }) {
  const inserts: { values: Record<string, unknown>; conflictSet?: Record<string, unknown> }[] = [];
  const queue = [
    opts.entityRow ? [opts.entityRow] : [],
    opts.before ? [opts.before] : [],
  ];
  const selectChain = () => {
    const rows = async () => queue.shift() ?? [];
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.limit = rows;
    chain.then = (res: (v: unknown) => unknown) => rows().then(res);
    return chain;
  };
  const tx = {
    select: selectChain,
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        const entry: { values: Record<string, unknown>; conflictSet?: Record<string, unknown> } = { values: v };
        inserts.push(entry);
        const result = [{ entityId: v.entityId, kind: v.kind, note: v.note ?? null }];
        const done = {
          returning: async () => result,
          then: (res: (x: unknown) => unknown) => Promise.resolve(result).then(res),
        };
        return Object.assign(done, {
          onConflictDoUpdate: (arg: { set: Record<string, unknown> }) => {
            entry.conflictSet = arg.set;
            return done;
          },
        });
      },
    }),
  };
  const db = {
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
  return { db, inserts };
}

const MACHINE_ENTITY = { id: "e1", type: "machine", name: "Olma office" };

/** AuditService в этих сценариях не задействован — setMachineKind пишет журнал сам. */
const auditStub = () => ({}) as never;

describe("Вид автомата: кто поставил", () => {
  it("новая карточка помнит автора и в created_by, и в updated_by", async () => {
    const { db, inserts } = kindDb({ entityRow: MACHINE_ENTITY });
    const s = new EntitiesService(db, auditStub());
    await s.setMachineKind("e1", "coffee", "owner", "заметка");
    const card = inserts[0]!.values;
    assert.equal(card.createdBy, "owner");
    assert.equal(card.updatedBy, "owner");
  });

  it("смена вида обновляет updated_by, но НЕ created_by", async () => {
    // Иначе карточка вечно выглядит размеченной массовым прогоном — даже там,
    // где вид назвал владелец. Обещание REGISTRY_CLEANUP.md держится на этом.
    const { db, inserts } = kindDb({
      entityRow: MACHINE_ENTITY,
      before: { entityId: "e1", kind: "other", createdBy: "tool:backfill-machine-kinds" },
    });
    const s = new EntitiesService(db, auditStub());
    await s.setMachineKind("e1", "drink", "owner");
    const set = inserts[0]!.conflictSet!;
    assert.equal(set.updatedBy, "owner");
    assert.ok(!("createdBy" in set), "created_by при смене вида не трогаем");
  });

  it("массовый прогон записывается в журнал системой, а не человеком", async () => {
    const { db, inserts } = kindDb({ entityRow: MACHINE_ENTITY });
    const s = new EntitiesService(db, auditStub());
    await s.setMachineKind("e1", "coffee", "tool:backfill-machine-kinds");
    const audit = inserts[1]!.values;
    assert.equal(audit.actorKind, "system");
    assert.equal(audit.actorRef, "tool:backfill-machine-kinds");
    assert.equal(audit.action, "machine.kind_set");
  });

  it("решение владельца записывается человеком и как смена вида", async () => {
    const { db, inserts } = kindDb({
      entityRow: MACHINE_ENTITY,
      before: { entityId: "e1", kind: "other" },
    });
    const s = new EntitiesService(db, auditStub());
    await s.setMachineKind("e1", "coffee", "owner");
    const audit = inserts[1]!.values;
    assert.equal(audit.actorKind, "human");
    assert.equal(audit.action, "machine.kind_changed");
  });

  it("агент записывается агентом", async () => {
    const { db, inserts } = kindDb({ entityRow: MACHINE_ENTITY });
    const s = new EntitiesService(db, auditStub());
    await s.setMachineKind("e1", "snack", "agent:coffee-monitor");
    assert.equal(inserts[1]!.values.actorKind, "agent");
  });
});

/**
 * Заглушка для setMachineStatus. Сервис делает до трёх выборок
 * (объект, карточка автомата, активные нормативы), апсерт карточки,
 * обновления нормативов или задач и запись в журнал.
 */
function statusDb(opts: {
  entityRow?: Record<string, unknown>;
  before?: Record<string, unknown>;
  plans?: Record<string, unknown>[];
  /** Место, куда переставляют автомат (ответ на выборку по placeId). */
  place?: Record<string, unknown>;
}) {
  const inserts: { values: Record<string, unknown>; conflictSet?: Record<string, unknown> }[] = [];
  // Пишем таблицу, а не только патч: у смены состояния теперь два разных
  // update (отмена задач и закрытие размещения), и «сколько всего update»
  // перестало быть проверкой хоть чего-нибудь.
  const updates: { table: string; patch: Record<string, unknown> }[] = [];
  const имяТаблицы = (t: unknown): string =>
    t === task ? "task" : t === machinePlacement ? "machine_placement" : t === maintenancePlan ? "maintenance_plan" : "?";
  // Ответы разложены ПО ТАБЛИЦАМ, а не в общую очередь по порядку вызовов.
  // Очередь ломалась от любой ветки: запрос планов идёт только при возврате в
  // строй, и при уходе в ремонт третьим по счёту оказывался уже запрос места —
  // тест получал чужой ответ и «доказывал» то, чего не проверял.
  const пулы = new Map<unknown, Record<string, unknown>[][]>([
    // Две выборки из entity подряд: сперва карточка автомата, потом место.
    [entity, [opts.entityRow ? [opts.entityRow] : [], opts.place ? [opts.place] : []]],
    [machineCard, [opts.before ? [opts.before] : []]],
    [maintenancePlan, [opts.plans ?? []]],
  ]);
  const selectChain = () => {
    let table: unknown = null;
    const rows = async () => пулы.get(table)?.shift() ?? [];
    const chain: Record<string, unknown> = {};
    chain.from = (t: unknown) => {
      table = t;
      return chain;
    };
    chain.where = () => chain;
    chain.limit = rows;
    chain.then = (res: (v: unknown) => unknown) => rows().then(res);
    return chain;
  };
  const tx = {
    select: selectChain,
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        const entry: { values: Record<string, unknown>; conflictSet?: Record<string, unknown> } = { values: v };
        inserts.push(entry);
        const result = [{ ...v }];
        const done = {
          returning: async () => result,
          then: (res: (x: unknown) => unknown) => Promise.resolve(result).then(res),
        };
        return Object.assign(done, {
          onConflictDoUpdate: (arg: { set: Record<string, unknown> }) => {
            entry.conflictSet = arg.set;
            return done;
          },
        });
      },
    }),
    update: (t: unknown) => ({
      set: (patch: Record<string, unknown>) => {
        updates.push({ table: имяТаблицы(t), patch });
        const rows = [{ id: "t-1" }];
        const done = {
          returning: async () => rows,
          then: (res: (x: unknown) => unknown) => Promise.resolve(rows).then(res),
        };
        return { where: () => done };
      },
    }),
  };
  const db = {
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
  return { db, inserts, updates };
}

describe("Состояние автомата", () => {
  const МАШИНА = { id: "e1", type: "machine", name: "Olma склад" };

  it("отправка в ремонт пишет состояние, причину и дату", async () => {
    const { db, inserts } = statusDb({ entityRow: МАШИНА, before: { entityId: "e1", status: "in_service" } });
    const s = new EntitiesService(db, auditStub());
    await s.setMachineStatus("e1", "repair", "owner", "заявка №12");
    const set = inserts[0]!.conflictSet!;
    assert.equal(set.status, "repair");
    assert.equal(set.statusNote, "заявка №12");
    assert.ok(set.statusChangedAt instanceof Date, "дата смены проставлена");
    assert.equal(set.updatedBy, "owner");
  });

  it("правка примечания без смены состояния не двигает дату", async () => {
    // Иначе «в ремонте с …» врёт при каждом уточнении текста.
    const было = new Date("2026-08-05T00:00:00+05:00");
    const { db, inserts } = statusDb({
      entityRow: МАШИНА,
      before: { entityId: "e1", status: "repair", statusChangedAt: было },
    });
    const s = new EntitiesService(db, auditStub());
    await s.setMachineStatus("e1", "repair", "owner", "заявка №12, уточнение");
    assert.equal(inserts[0]!.conflictSet!.statusChangedAt, было);
  });

  it("возврат в строй пересчитывает сроки нормативов от сегодня", async () => {
    // Пока автомат стоял, срок капал впустую: без пересчёта он придёт красным
    // на весь простой, с задачей, датированной прошлым, и без уведомления.
    const { db, updates } = statusDb({
      entityRow: МАШИНА,
      before: { entityId: "e1", status: "repair" },
      plans: [
        { id: "p1", dueOn: "2026-05-01", everyDays: 10, everyMonths: null },
        { id: "p2", dueOn: "2026-05-01", everyDays: 90, everyMonths: null },
      ],
    });
    const s = new EntitiesService(db, auditStub());
    await s.setMachineStatus("e1", "in_service", "owner");
    assert.equal(updates.length, 2, "оба норматива пересчитаны");
    for (const u of updates) assert.ok(String(u.patch.dueOn) > "2026-05-01");
  });

  it("уход из эксплуатации закрывает висящие задачи обслуживания", async () => {
    // Выполнить их некому: автомата нет на месте. А закрыть их тоже некому —
    // бот умеет только «сделал», отмена есть лишь в панели по одной.
    const { db, updates } = statusDb({
      entityRow: МАШИНА,
      before: { entityId: "e1", status: "in_service" },
    });
    const s = new EntitiesService(db, auditStub());
    await s.setMachineStatus("e1", "warehouse", "owner");
    const отменены = updates.filter((u) => u.table === "task");
    assert.equal(отменены.length, 1);
    assert.equal(отменены[0]!.patch.status, "cancelled");
  });

  it("уход из эксплуатации снимает автомат с точки, даже если куда — не сказали", async () => {
    // «В ремонте» и «стоит на точке продаж» — взаимоисключающие утверждения.
    // Оставить открытое размещение значило бы показывать автомат там, где его
    // нет; выдумать новое место — врать точнее. Поэтому период закрывается, а
    // нового не открывается.
    const { db, updates } = statusDb({
      entityRow: МАШИНА,
      before: { entityId: "e1", status: "in_service" },
    });
    const s = new EntitiesService(db, auditStub());
    await s.setMachineStatus("e1", "repair", "owner");
    const снятия = updates.filter((u) => u.table === "machine_placement");
    assert.equal(снятия.length, 1, "размещение должно закрыться");
    assert.match(String(снятия[0]!.patch.endDate), /^\d{4}-\d{2}-\d{2}$/);
  });

  it("указали мастерскую — автомат переставлен туда", async () => {
    // Слово владельца: «места ремонта могут быть разные — как наш склад, так и
    // мастерская». Поэтому место спрашивают, а не выводят из состояния.
    const { db, inserts, updates } = statusDb({
      entityRow: МАШИНА,
      before: { entityId: "e1", status: "in_service" },
      place: { id: "w1", type: "workshop", name: "Мастерская на Чиланзаре" },
    });
    const s = new EntitiesService(db, auditStub());
    await s.setMachineStatus("e1", "repair", "owner", undefined, "w1");
    const открыто = inserts.find((i) => i.values.locationId === "w1");
    assert.ok(открыто, "должно открыться размещение в мастерской");
    assert.equal(открыто.values.entityId, "e1");
    assert.match(String(открыто.values.startDate), /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(
      updates.some((u) => u.table === "machine_placement" && u.patch.endDate),
      "старое размещение должно закрыться",
    );
  });

  it("ремонт разрешён на любом месте — и на складе, и на точке", async () => {
    // Чинят и в мастерской, и на складе, и прямо на точке. Сверять состояние с
    // видом места здесь не с чем, и запрет был бы выдумкой про чужую работу.
    const { db, inserts } = statusDb({
      entityRow: МАШИНА,
      before: { entityId: "e1", status: "in_service" },
      place: { id: "l1", type: "location", name: "Olma office" },
    });
    const s = new EntitiesService(db, auditStub());
    await s.setMachineStatus("e1", "repair", "owner", undefined, "l1");
    assert.ok(inserts.find((i) => i.values.locationId === "l1"));
  });

  it("«на складе» требует склада — точка продаж отвергается", async () => {
    // Здесь состояние ПРЯМО называет вид места, и расхождение — не нюанс, а
    // противоречие: «на складе» и «стоит на точке продаж» разом не бывает.
    const { db } = statusDb({
      entityRow: МАШИНА,
      before: { entityId: "e1", status: "in_service" },
      place: { id: "l1", type: "location", name: "Olma office" },
    });
    const s = new EntitiesService(db, auditStub());
    await assert.rejects(
      () => s.setMachineStatus("e1", "warehouse", "owner", undefined, "l1"),
      /требует склада/,
    );
  });

  it("в эксплуатацию — только на точку продаж", async () => {
    const { db } = statusDb({
      entityRow: МАШИНА,
      before: { entityId: "e1", status: "repair" },
      place: { id: "w1", type: "workshop", name: "Мастерская" },
    });
    const s = new EntitiesService(db, auditStub());
    await assert.rejects(
      () => s.setMachineStatus("e1", "in_service", "owner", undefined, "w1"),
      /стоит на точке продаж/,
    );
  });

  it("поставить автомат на не-место нельзя", async () => {
    const { db } = statusDb({
      entityRow: МАШИНА,
      before: { entityId: "e1", status: "in_service" },
      place: { id: "c1", type: "contractor", name: "ООО Ромашка" },
    });
    const s = new EntitiesService(db, auditStub());
    await assert.rejects(
      () => s.setMachineStatus("e1", "repair", "owner", undefined, "c1"),
      /только на место/,
    );
  });

  it("возврат в строй — отдельное событие журнала", async () => {
    const { db, inserts } = statusDb({ entityRow: МАШИНА, before: { entityId: "e1", status: "repair" } });
    const s = new EntitiesService(db, auditStub());
    await s.setMachineStatus("e1", "in_service", "owner");
    assert.equal(inserts[1]!.values.action, "machine.status_restored");
  });

  it("неизвестное состояние отвергается", async () => {
    const { db } = statusDb({ entityRow: МАШИНА });
    const s = new EntitiesService(db, auditStub());
    await assert.rejects(
      () => s.setMachineStatus("e1", "сломан" as never, "owner"),
      /Неизвестное состояние/,
    );
  });

  it("состояние задаётся только автоматам", async () => {
    const { db } = statusDb({ entityRow: { id: "e1", type: "contractor", name: "ООО Ромашка" } });
    const s = new EntitiesService(db, auditStub());
    await assert.rejects(() => s.setMachineStatus("e1", "repair", "owner"), /только автоматам/);
  });
});
