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
        const done = {
          returning: async () => [row],
          then: (res: (x: unknown) => unknown) => Promise.resolve([row]).then(res),
        };
        // Идемпотентность по clientKey (аудит 18.08): заглушка не исполняет
        // конфликт — «первый раз» всегда вставляется, повтор проверяется
        // отдельным сценарием через select.
        return { ...done, onConflictDoNothing: () => done };
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

describe("Стандартные нормативы на список объектов", () => {
  const M2 = "33333333-3333-4333-8333-333333333333";
  /** Первый select — карточки автоматов с видом, второй — заведённые планы. */
  const stub = (cards: Row[], plans: Row[], inserted: Row[], updated?: Row[]) =>
    stubDb({ selects: [cards, plans], inserted, updated });
  const coffeeCard = (id: string) => ({ entityId: id, kind: "coffee" });

  it("кофейному автомату заводит все три норматива с числами владельца", async () => {
    const inserted: Row[] = [];
    const s = new MaintenanceService(stub([coffeeCard(MACHINE)], [], inserted));
    const res = await s.applyStandardNorms([MACHINE]);

    assert.equal(res.created.length, 3);
    assert.equal(res.skipped, 0);
    assert.equal(res.coffee, 1);
    const days = new Map(inserted.filter((r) => r.entityId).map((p) => [p.title, p.everyDays]));
    assert.equal(days.get("Мойка миксера"), 10);
    assert.equal(days.get("Замена фильтра воды"), 45);
    assert.equal(days.get("Плановое ТО"), 90);
  });

  it("снек-автомату — только плановое ТО", async () => {
    // У снека нет ни миксера, ни фильтра воды. График такой работы краснел бы
    // за работу, которой не существует, — и в раздел перестали бы смотреть.
    const inserted: Row[] = [];
    const s = new MaintenanceService(stub([{ entityId: M2, kind: "snack" }], [], inserted));
    const res = await s.applyStandardNorms([M2]);

    assert.equal(res.created.length, 1);
    assert.equal(res.coffee, 0);
    assert.equal(res.other, 1);
    const titles = inserted.filter((r) => r.entityId).map((r) => r.title);
    assert.deepEqual(titles, ["Плановое ТО"]);
  });

  it("смешанный список: каждому своё", async () => {
    const inserted: Row[] = [];
    const s = new MaintenanceService(
      stub([coffeeCard(MACHINE), { entityId: M2, kind: "snack" }], [], inserted),
    );
    const res = await s.applyStandardNorms([MACHINE, M2]);

    assert.equal(res.created.length, 4, "три кофейному, одно снеку");
    assert.equal(res.coffee, 1);
    assert.equal(res.other, 1);
  });

  it("первый срок — период от сегодня, а не красный экран на старте", async () => {
    const inserted: Row[] = [];
    const s = new MaintenanceService(stub([coffeeCard(MACHINE)], [], inserted));
    await s.applyStandardNorms([MACHINE]);
    const mixer = inserted.find((r) => r.title === "Мойка миксера")!;
    assert.equal(mixer.dueOn, addDays(todayInTz(), 10));
  });

  it("повторный прогон не создаёт дублей и не трогает правки владельца", async () => {
    // Владелец поставил на этом автомате мойку раз в 20 дней. Метод обязан
    // пройти мимо: «привести к норме» здесь означало бы стереть решение.
    const inserted: Row[] = [];
    const updated: Row[] = [];
    const s = new MaintenanceService(
      stub(
        [coffeeCard(MACHINE)],
        [
          { entityId: MACHINE, kind: "cleaning", partKind: "mixer" },
          { entityId: MACHINE, kind: "part_replace", partKind: "water_filter" },
          { entityId: MACHINE, kind: "service", partKind: null },
        ],
        inserted,
        updated,
      ),
    );
    const res = await s.applyStandardNorms([MACHINE]);
    assert.equal(res.created.length, 0);
    assert.equal(res.skipped, 3);
    assert.equal(updated.length, 0, "существующие нормативы не переписываются");
  });

  it("объект в списке дважды получает один комплект", async () => {
    const inserted: Row[] = [];
    const s = new MaintenanceService(stub([coffeeCard(MACHINE)], [], inserted));
    const res = await s.applyStandardNorms([MACHINE, MACHINE]);
    assert.equal(res.created.length, 3, "вызывающий не обязан чистить список");
    assert.equal(res.skipped, 3);
    assert.equal(res.coffee, 1, "тот же объект считается один раз");
  });

  it("недостающий норматив заводится, существующий пропускается", async () => {
    // Кофейному автомату положено три; ТО у него уже есть, значит заведутся
    // два оставшихся, а существующий останется нетронутым.
    const inserted: Row[] = [];
    const s = new MaintenanceService(
      stub([coffeeCard(M2)], [{ entityId: M2, kind: "service", partKind: null }], inserted),
    );
    const res = await s.applyStandardNorms([M2]);
    assert.equal(res.created.length, 2);
    assert.equal(res.skipped, 1);
    assert.ok(!inserted.some((r) => r.title === "Плановое ТО"));
  });

  it("пустой список не открывает транзакцию", async () => {
    const inserted: Row[] = [];
    const s = new MaintenanceService(stubDb({ inserted }));
    const res = await s.applyStandardNorms([]);
    assert.deepEqual(res, { created: [], skipped: 0, coffee: 0, other: 0 });
    assert.equal(inserted.length, 0);
  });
});

describe("Автомат без карточки вида", () => {
  const NOCARD = "44444444-4444-4444-8444-444444444444";

  it("считается неразмеченным и получает только общее ТО", async () => {
    // Раньше «кофейный ли» выводилось из привязки к точке, и автомат без
    // привязки молча признавался прочим. Теперь отсутствие карточки — это
    // честное «не размечен»: даём только то, что применимо к любому автомату.
    const inserted: Row[] = [];
    const s = new MaintenanceService(stubDb({ selects: [[], []], inserted }));
    const res = await s.applyStandardNorms([NOCARD]);
    assert.equal(res.created.length, 1);
    assert.equal(res.coffee, 0);
    assert.equal(res.other, 1);
    assert.deepEqual(
      inserted.filter((r) => r.entityId).map((r) => r.title),
      ["Плановое ТО"],
    );
  });
});

describe("Пауза норматива: снять и вернуть", () => {
  const PLAN = "55555555-5555-4555-8555-555555555555";
  const активный = {
    id: PLAN,
    entityId: MACHINE,
    kind: "cleaning",
    partKind: "mixer",
    everyDays: 10,
    everyMonths: null,
    dueOn: "2026-08-17",
    taskLeadDays: 3,
    autoTask: true,
    isActive: true,
  };

  it("снятие с паузы возвращает норматив в строй", async () => {
    const updated: Row[] = [];
    const inserted: Row[] = [];
    const s = new MaintenanceService(
      stubDb({ selects: [[{ ...активный, isActive: false }]], updated, inserted }),
    );
    await s.upsertPlan(
      { id: PLAN, entityId: MACHINE, kind: "cleaning", partKind: "mixer", everyDays: 10, isActive: true },
      "owner",
    );
    assert.equal(updated[0]!.isActive, true);
  });

  it("вернувшийся из паузы норматив не приходит сразу просроченным", async () => {
    // Пока автомат стоял в ремонте, срок капал впустую. Требовать работу за
    // этот период значит начать с красного экрана — считаем от сегодня.
    const updated: Row[] = [];
    const s = new MaintenanceService(
      stubDb({ selects: [[{ ...активный, isActive: false, dueOn: "2026-01-01" }]], updated }),
    );
    await s.upsertPlan(
      { id: PLAN, entityId: MACHINE, kind: "cleaning", partKind: "mixer", everyDays: 10, isActive: true },
      "owner",
    );
    assert.equal(updated[0]!.dueOn, addDays(todayInTz(), 10));
  });

  it("явный срок при снятии с паузы уважается — решение владельца сильнее пересчёта", async () => {
    const updated: Row[] = [];
    const s = new MaintenanceService(
      stubDb({ selects: [[{ ...активный, isActive: false }]], updated }),
    );
    await s.upsertPlan(
      {
        id: PLAN,
        entityId: MACHINE,
        kind: "cleaning",
        partKind: "mixer",
        everyDays: 10,
        isActive: true,
        dueOn: "2026-12-01",
      },
      "owner",
    );
    assert.equal(updated[0]!.dueOn, "2026-12-01");
  });

  it("обычная правка активного норматива не трогает срок пересчётом «от сегодня»", async () => {
    const updated: Row[] = [];
    const s = new MaintenanceService(stubDb({ selects: [[активный]], updated }));
    await s.upsertPlan(
      { id: PLAN, entityId: MACHINE, kind: "cleaning", partKind: "mixer", everyDays: 10, note: "правка" },
      "owner",
    );
    assert.equal(updated[0]!.dueOn, "2026-08-17", "периодичность та же — срок остаётся");
    assert.equal(updated[0]!.isActive, true, "поле не передано — состояние не меняется");
  });

  it("выключенный норматив виден массовому заведению и не воскресает", async () => {
    // Раньше «уже есть» считалось только по активным: выключенный норматив
    // становился невидимым и заводился заново, то есть пауза не переживала
    // ни одного прогона. Заглушка не исполняет SQL, поэтому тест держит
    // JS-сторону: строку с isActive=false нельзя отфильтровать в коде.
    const inserted: Row[] = [];
    const s = new MaintenanceService(
      stubDb({
        selects: [
          [{ entityId: MACHINE, kind: "coffee" }],
          [
            { entityId: MACHINE, kind: "cleaning", partKind: "mixer", isActive: false },
            { entityId: MACHINE, kind: "part_replace", partKind: "water_filter", isActive: true },
            { entityId: MACHINE, kind: "service", partKind: null, isActive: true },
          ],
        ],
        inserted,
      }),
    );
    const res = await s.applyStandardNorms([MACHINE]);
    assert.equal(res.created.length, 0, "выключенная мойка миксера не заводится заново");
    assert.equal(res.skipped, 3);
    assert.ok(!inserted.some((r) => r.title === "Мойка миксера"));
  });
});

describe("Якорь срока двигается обоими путями записи факта", () => {
  const PLAN = "66666666-6666-4666-8666-666666666666";
  const план = { id: PLAN, dueOn: "2026-08-16", everyDays: 10, everyMonths: null };

  it("createLog сразу закрытым фактом сдвигает срок", async () => {
    // Бот в «🗓 Графики» закрывает работу именно так: createLog c
    // outcome='done' — и пишет сотруднику «Следующий срок пересчитан».
    // Раньше срок не двигался, и сообщение было ложью.
    const updated: Row[] = [];
    const s = new MaintenanceService(stubDb({ selects: [[план]], updated }));
    await s.createLog({
      entityId: MACHINE,
      kind: "cleaning",
      partKind: "mixer",
      planId: PLAN,
      outcome: "done",
      performedOn: "2026-08-16",
    });
    assert.equal(updated.length, 1, "план обязан обновиться");
    assert.equal(updated[0]!.dueOn, addDays("2026-08-16", 10));
  });

  it("незакрытый факт срок не двигает", async () => {
    // Техник отметился на точке, работу не закончил — двигать нечего.
    const updated: Row[] = [];
    const s = new MaintenanceService(stubDb({ selects: [[план]], updated }));
    await s.createLog({ entityId: MACHINE, kind: "cleaning", planId: PLAN });
    assert.equal(updated.length, 0);
  });

  it("факт без норматива срок не двигает", async () => {
    const updated: Row[] = [];
    const s = new MaintenanceService(stubDb({ selects: [[план]], updated }));
    await s.createLog({ entityId: MACHINE, kind: "repair", outcome: "done" });
    assert.equal(updated.length, 0);
  });
});

describe("Установка и снятие узла (периоды вне автомата)", () => {
  it("установка нового узла: журнал part_install + открытый период на автомате", async () => {
    const inserted: Row[] = [];
    // select-очередь: место свободно.
    const s = new MaintenanceService(stubDb({ selects: [[]], inserted }));
    const r = await s.installPart({
      machineId: MACHINE,
      partKind: "grinder",
      serialNumber: "SN-77",
      personId: PERSON,
    });
    assert.equal(r.log.kind, "part_install");
    assert.equal(r.installed.location, "machine");
    assert.equal(r.installed.serialNumber, "SN-77");
    assert.ok(inserted.some((x) => x.action === "maintenance.part_installed"));
  });

  it("занятое место — отказ, а не молчаливая замена", async () => {
    const s = new MaintenanceService(stubDb({ selects: [[{ id: "busy" }]] }));
    await assert.rejects(
      () => s.installPart({ machineId: MACHINE, partKind: "grinder" }),
      /занято/i,
    );
  });

  it("установка со склада закрывает «лежачий» период и наследует паспорт", async () => {
    const inserted: Row[] = [];
    const updated: Row[] = [];
    const склад = {
      id: "33333333-3333-4333-8333-333333333333",
      machineId: null,
      removedOn: null,
      partKind: "grinder",
      serialNumber: "SN-01",
      model: "MK-2",
      warrantyUntil: "2027-01-01",
    };
    // очередь: место свободно → узел со склада найден.
    const s = new MaintenanceService(stubDb({ selects: [[], [склад]], inserted, updated }));
    const r = await s.installPart({
      machineId: MACHINE,
      partKind: "grinder",
      partId: склад.id,
    });
    assert.equal(updated.length, 1, "период на складе обязан закрыться");
    assert.ok(updated[0]!.removedOn, "закрытие — это removedOn, а не удаление строки");
    assert.equal(r.installed.serialNumber, "SN-01", "серийник наследуется со склада");
    assert.equal(r.installed.model, "MK-2");
  });

  it("установка чужого вида со склада — отказ", async () => {
    const склад = { id: "33333333-3333-4333-8333-333333333333", machineId: null, removedOn: null, partKind: "mixer" };
    const s = new MaintenanceService(stubDb({ selects: [[], [склад]] }));
    await assert.rejects(
      () => s.installPart({ machineId: MACHINE, partKind: "grinder", partId: склад.id }),
      /другого вида/,
    );
  });

  it("снятие: период на автомате закрыт, открыт период «в мойке» той же записью журнала", async () => {
    const inserted: Row[] = [];
    const updated: Row[] = [];
    const стоит = {
      partKind: "hopper",
      slot: 3,
      serialNumber: "SN-9",
      model: null,
      warrantyUntil: null,
    };
    const s = new MaintenanceService(
      stubDb({ selects: [[{ id: "p1", ...стоит }]], inserted, updated, updateResult: стоит }),
    );
    const r = await s.removePart({
      machineId: MACHINE,
      partKind: "hopper",
      slot: 3,
      toLocation: "washing",
    });
    assert.equal(r.log.kind, "part_remove");
    assert.equal(updated.length, 1, "период на автомате обязан закрыться");
    assert.equal(r.stored.machineId, null, "снятый узел не исчезает из учёта");
    assert.equal(r.stored.location, "washing");
    assert.equal(r.stored.serialNumber, "SN-9", "паспорт переезжает в «лежачий» период");
    assert.equal(r.stored.installLogId, r.log.id, "оба периода держит одна запись журнала");
    assert.ok(inserted.some((x) => x.action === "maintenance.part_removed"));
  });

  it("снимать нечего — честный отказ", async () => {
    const s = new MaintenanceService(stubDb({ selects: [[]] }));
    await assert.rejects(
      () => s.removePart({ machineId: MACHINE, partKind: "hopper", toLocation: "repair" }),
      /не числится/,
    );
  });
});
