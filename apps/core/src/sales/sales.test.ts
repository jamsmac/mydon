import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildUpserts, daysAgoLocal, todayLocal, type StockSaleRow } from "./sales.service";

describe("Продажи: подготовка строк из mydon-stock", () => {
  const map = new Map([["72ac181f0000", "ent-1"]]);

  it("серийник узнан → строка привязана к автомату реестра", () => {
    const rows: StockSaleRow[] = [
      { dt: "2026-07-28", machine_serial: "72AC181F0000", ourvend_name: "Americano", qty: 3, amount: 60000, fetched_at: "2026-07-29T07:50:03+05:00" },
    ];
    const [v] = buildUpserts(rows, map).values;
    assert.equal(v.machineId, "ent-1", "регистр серийника не должен мешать сопоставлению");
    assert.equal(v.machineSerial, "72ac181f0000");
    assert.equal(v.qty, "3");
    assert.equal(v.amount, "60000");
  });

  it("неизвестный серийник → строка сохраняется без привязки, не теряется", () => {
    const rows: StockSaleRow[] = [
      { dt: "2026-07-28", machine_serial: "C2508160376", ourvend_name: "Вода 330ml", qty: 1, amount: 3000, fetched_at: new Date() },
    ];
    const [v] = buildUpserts(rows, map).values;
    assert.equal(v.machineId, null);
    assert.equal(v.machineSerial, "c2508160376");
  });

  it("битые строки (пустой серийник или товар) отбрасываются", () => {
    const rows = [
      { dt: "2026-07-28", machine_serial: "", ourvend_name: "X", qty: 1, amount: 1, fetched_at: new Date() },
      { dt: "", machine_serial: "abc", ourvend_name: "X", qty: 1, amount: 1, fetched_at: new Date() },
    ] as StockSaleRow[];
    assert.equal(buildUpserts(rows, map).values.length, 0);
  });

  it("нечисловые qty/amount — в карантин, а не нулём в выручку", () => {
    const rows = [
      { dt: "2026-07-28", machine_serial: "72AC181F0000", ourvend_name: "Americano", qty: "н/д", amount: 60000, fetched_at: new Date() },
      { dt: "2026-07-28", machine_serial: "72AC181F0000", ourvend_name: "Latte", qty: 2, amount: "", fetched_at: new Date() },
      { dt: "2026-07-28", machine_serial: "72AC181F0000", ourvend_name: "Tea", qty: 1, amount: 5000, fetched_at: new Date() },
    ] as StockSaleRow[];
    const { values, quarantined } = buildUpserts(rows, map);
    assert.equal(values.length, 1, "проходит только строка с обоими числами");
    assert.equal(values[0].product, "Tea");
    assert.equal(quarantined.length, 2);
    assert.equal(quarantined[0].field, "qty");
    assert.equal(quarantined[1].field, "amount");
  });

  it("ноль — законное число, не карантин", () => {
    const rows = [
      { dt: "2026-07-28", machine_serial: "72AC181F0000", ourvend_name: "Free", qty: 0, amount: 0, fetched_at: new Date() },
    ] as StockSaleRow[];
    const { values, quarantined } = buildUpserts(rows, map);
    assert.equal(values.length, 1);
    assert.equal(values[0].qty, "0");
    assert.equal(quarantined.length, 0);
  });

  it("todayLocal отдаёт дату YYYY-MM-DD по локальному времени контейнера", () => {
    const d = new Date(2026, 6, 29, 23, 59); // 29 июля, поздний вечер
    assert.equal(todayLocal(d), "2026-07-29");
  });

  it("daysAgoLocal(30) от 03.08 — это 05.07, ровно 30 календарных дат 05.07–03.08 (найдено внешним аудитом, P2)", () => {
    const now = new Date(2026, 7, 3); // 3 августа
    assert.equal(daysAgoLocal(30, now), "2026-07-05");
    // Проверка счётом: 03.08 − 05.07 включительно с обеих сторон = 30 дат.
    const from = new Date(2026, 6, 5);
    const to = new Date(2026, 7, 3);
    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    assert.equal(days, 30);
  });

  it("daysAgoLocal(7) от 03.08 — это 28.07, не 27.07 (старая граница today−N давала 8 дат вместо 7)", () => {
    const now = new Date(2026, 7, 3);
    assert.equal(daysAgoLocal(7, now), "2026-07-28");
  });

  it("daysAgoLocal(1) — граница «сегодня» (N=1 значит только сегодняшняя дата)", () => {
    const now = new Date(2026, 7, 3);
    assert.equal(daysAgoLocal(1, now), todayLocal(now));
  });
});

// ── Алиасы имён продаж (склейка «имя источника → карточка») ──────────────────

import { SalesService } from "./sales.service";

type Row = Record<string, unknown>;

interface AliasStubOpts {
  /** Очередь ответов select по порядку вызовов. */
  selects?: Row[][];
  /** true — уникальный индекс имени отсёк вставку: алиас уже существует. */
  insertConflict?: boolean;
  inserted?: Row[];
}

/** Заглушка БД под цепочки addAlias/removeAlias — по образцу tasks.test.ts. */
function aliasStubDb(opts: AliasStubOpts) {
  const queue = [...(opts.selects ?? [])];
  const selectChain = () => {
    let memo: Row[] | null = null;
    const rows = async () => (memo ??= queue.shift() ?? []);
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.leftJoin = () => chain;
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
        const row = { id: "al-1", ...v };
        opts.inserted?.push(row);
        const returning = async () => (opts.insertConflict ? [] : [row]);
        return {
          onConflictDoNothing: () => ({ returning }),
          returning,
          then: (res: (x: unknown) => unknown) => Promise.resolve([row]).then(res),
        };
      },
    }),
    delete: () => ({ where: async () => [] }),
  };
  return {
    select: selectChain,
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
}

const CARD = "66666666-6666-4666-8666-666666666666";

describe("Алиасы имён продаж", () => {
  it("привязка пишет алиас и след в аудите", async () => {
    const inserted: Row[] = [];
    // очередь: карточка найдена (product) → тени-карточки с таким именем нет.
    const s = new SalesService(aliasStubDb({
      selects: [[{ id: CARD, type: "product" }], []],
      inserted,
    }));
    const r = await s.addAlias("Moxito Fresh Lime CAN 450ml", CARD);
    assert.equal(r.name, "Moxito Fresh Lime CAN 450ml");
    assert.ok(inserted.some((x) => x.action === "sales.alias_added"));
  });

  it("имя, совпадающее с другой карточкой, не принимается — продажа засчиталась бы дважды", async () => {
    const s = new SalesService(aliasStubDb({
      selects: [[{ id: CARD, type: "product" }], [{ id: "другая" }]],
    }));
    await assert.rejects(() => s.addAlias("Plus 18 Energy 330ml", CARD), /дважды/);
  });

  it("занятый алиас не перепривязывается молча", async () => {
    const s = new SalesService(aliasStubDb({
      selects: [[{ id: CARD, type: "product" }], [], [{ id: "al-9", entityId: "чужая", name: "X" }]],
      insertConflict: true,
    }));
    await assert.rejects(() => s.addAlias("X", CARD), /другой карточке/);
  });

  it("повторная привязка того же имени к той же карточке — идемпотентна", async () => {
    const s = new SalesService(aliasStubDb({
      selects: [[{ id: CARD, type: "product" }], [], [{ id: "al-9", entityId: CARD, name: "X" }]],
      insertConflict: true,
    }));
    const r = await s.addAlias("X", CARD);
    assert.equal(r.id, "al-9");
  });

  it("алиас к не-товару и пустое имя — отказ", async () => {
    const s1 = new SalesService(aliasStubDb({ selects: [[{ id: CARD, type: "machine" }]] }));
    await assert.rejects(() => s1.addAlias("X", CARD), /только к товарам/);
    const s2 = new SalesService(aliasStubDb({}));
    await assert.rejects(() => s2.addAlias("   ", CARD), /Пустое имя/);
  });
});
