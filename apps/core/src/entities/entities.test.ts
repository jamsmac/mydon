import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
