import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BadRequestException } from "@nestjs/common";
import { RefillService } from "./refill.service";
import type { VendingService } from "./vending.service";

type Row = Record<string, unknown>;

interface StubOpts {
  /** Что вернёт INSERT ... RETURNING по заливке. Пустой массив = конфликт ключа. */
  refillInsert?: Row[];
  /** Очередь ответов select — сервис делает их несколько подряд. */
  selects?: Row[][];
  /** Куда складывать вставленное и обновлённое. */
  inserted?: Row[];
  /** Остаток, который вернёт upsert склада. */
  stockAfter?: Row;
}

/**
 * Заглушка БД. Вставки различаются по наличию `onConflictDoNothing`: в заливку
 * идёт она, в склад — `onConflictDoUpdate`. Так одна заглушка обслуживает обе,
 * не угадывая порядок вызовов.
 */
function stubDb(opts: StubOpts) {
  const queue = [...(opts.selects ?? [])];
  const next = () => queue.shift() ?? [];

  const selectChain = () => {
    const rows = async () => next();
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.limit = rows;
    chain.then = (res: (v: unknown) => unknown) => rows().then(res);
    return chain;
  };

  const tx = {
    select: selectChain,
    insert: () => ({
      values: (v: Row) => {
        opts.inserted?.push(v);
        const refillRow = { id: "r1", createdAt: new Date(), ...v };
        return {
          // Заливка: конфликт по client_key → RETURNING пуст.
          onConflictDoNothing: () => ({
            returning: async () => opts.refillInsert ?? [refillRow],
          }),
          // Склад: upsert всегда что-то возвращает.
          onConflictDoUpdate: () => ({
            returning: async () => [opts.stockAfter ?? { quantity: 0 }],
          }),
          returning: async () => [refillRow],
          then: (res: (x: unknown) => unknown) => Promise.resolve([refillRow]).then(res),
        };
      },
    }),
  };

  return {
    select: selectChain,
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
}

/** Справочник: «кола» → канон «Coca-Cola 0.5». */
const vendingStub = {
  resolveProductRef: async (raw: string) =>
    /кола/i.test(raw)
      ? { name: "Coca-Cola 0.5", productId: "p1" }
      : { name: raw.trim(), productId: null },
} as unknown as VendingService;

const PERSON = "11111111-1111-4111-8111-111111111111";

describe("Заливка автомата", () => {
  it("пишет факт и списывает товар со склада", async () => {
    const inserted: Row[] = [];
    const s = new RefillService(stubDb({ inserted, stockAfter: { quantity: 14 } }), vendingStub);

    const res = await s.create({
      machineSerial: "MU-7",
      productName: "кола",
      qty: 6,
      personId: PERSON,
      clientKey: "k1",
    });

    assert.equal(res.duplicate, false);
    assert.equal(res.stockLeft, 14, "остаток после списания возвращается сотруднику");
    const refill = inserted.find((r) => r.clientKey === "k1")!;
    assert.equal(refill.qty, 6);
    assert.equal(refill.machineSerial, "MU-7");
  });

  it("спорное имя — отказ, заливка не пишется (R-G-1)", async () => {
    // Заливка НЕОБРАТИМА для склада: она списывает остаток. Записать её на
    // «одну из двух карточек» значит увести списание не с того товара, и
    // повторный прогон этого не исправит.
    const vending = {
      resolveProductRef: async () => {
        throw new BadRequestException("имя «Fanta CAN 0,25» разрешается двумя путями");
      },
    } as unknown as VendingService;
    const inserted: Row[] = [];
    await assert.rejects(
      () =>
        new RefillService(stubDb({ inserted }), vending).create({
          machineSerial: "2508160376",
          productName: "Fanta CAN 0,25",
          qty: 3,
          clientKey: "k1",
        }),
      /двумя путями/,
    );
    assert.equal(inserted.length, 0, "отказ обязан случиться ДО записи");
  });

  it("имя товара приводится к канону справочника", async () => {
    // Мимо канона запись создала бы вторую строку остатка, которую закуп
    // никогда не сложит с первой.
    const inserted: Row[] = [];
    const s = new RefillService(stubDb({ inserted }), vendingStub);
    await s.create({ machineSerial: "MU-7", productName: "  кола  ", qty: 2, clientKey: "k2" });

    const refill = inserted.find((r) => r.clientKey === "k2")!;
    assert.equal(refill.productName, "Coca-Cola 0.5");
    assert.equal(refill.productId, "p1", "карточка товара подставлена по канону");
  });

  it("повтор мастера не задваивает факт и не списывает склад дважды", async () => {
    // Двойное нажатие «Готово» в подвале — норма, а не дефект ввода.
    const inserted: Row[] = [];
    const s = new RefillService(
      stubDb({
        refillInsert: [], // конфликт по client_key
        selects: [[{ id: "r1", clientKey: "k3", qty: 6 }], [{ quantity: 14 }]],
        inserted,
      }),
      vendingStub,
    );

    const res = await s.create({ machineSerial: "MU-7", productName: "кола", qty: 6, clientKey: "k3" });

    assert.equal(res.duplicate, true);
    assert.equal(res.refill.id, "r1", "возвращается та же запись");
    assert.equal(res.stockLeft, 14, "остаток показывается, хоть склад и не тронут");
    assert.ok(
      !inserted.some((r) => r.quantity !== undefined),
      "склад второй раз не трогали",
    );
  });

  it("склада по товару ещё нет — заводим строку сразу в минус", async () => {
    // Отрицательный остаток честнее отказа: запрет означал бы потерю факта
    // заливки ради красоты числа.
    const inserted: Row[] = [];
    const s = new RefillService(stubDb({ inserted, stockAfter: { quantity: -6 } }), vendingStub);
    const res = await s.create({
      machineSerial: "MU-7",
      productName: "Новый товар",
      qty: 6,
      clientKey: "k4",
    });

    assert.equal(res.stockLeft, -6);
    const stockRow = inserted.find((r) => r.quantity !== undefined)!;
    assert.equal(stockRow.quantity, -6);
  });

  it("аудит помечает человека человеком, а не системой", async () => {
    const inserted: Row[] = [];
    const s = new RefillService(stubDb({ inserted }), vendingStub);
    await s.create({
      machineSerial: "MU-7",
      productName: "кола",
      qty: 1,
      personId: PERSON,
      clientKey: "k5",
      createdBy: `person:${PERSON}`,
    });

    const audit = inserted.find((r) => r.action === "vending.refill_created")!;
    assert.equal(audit.actorKind, "human");
    assert.equal(audit.actorRef, `person:${PERSON}`);
  });

  it("факт заливки идёт в ленту событий ТОЙ ЖЕ транзакцией", async () => {
    // Событие вне транзакции пережило бы откат вставки: лента показала бы
    // заливку, которой в журнале нет, и склад разошёлся бы с ней навсегда.
    const inserted: Row[] = [];
    const s = new RefillService(stubDb({ inserted }), vendingStub);
    await s.create({
      // Бот пишет серийник с приставкой, Ourvend присылает голый — в ленте
      // должен быть ОДИН автомат, а не два написания одного.
      machineSerial: "c2508160376",
      productName: "кола",
      qty: 4,
      personId: PERSON,
      clientKey: "k7",
    });

    const ev = inserted.find((r) => r.type === "vending.refill_recorded");
    assert.ok(ev, "заливка обязана попасть в ленту");
    assert.equal(ev.source, "human", "записал человек — не система");
    assert.deepEqual(ev.payload, {
      serial: "2508160376",
      product: "Coca-Cola 0.5",
      qty: 4,
      personId: PERSON,
    });
  });

  it("заливка без человека помечается системой", async () => {
    const inserted: Row[] = [];
    const s = new RefillService(stubDb({ inserted }), vendingStub);
    await s.create({ machineSerial: "MU-7", productName: "кола", qty: 1, clientKey: "k8" });

    const ev = inserted.find((r) => r.type === "vending.refill_recorded")!;
    assert.equal(ev.source, "system");
    assert.equal((ev.payload as Record<string, unknown>).personId, null);
  });

  it("повтор мастера событие не задваивает", async () => {
    const inserted: Row[] = [];
    const s = new RefillService(
      stubDb({
        refillInsert: [], // конфликт по client_key
        selects: [[{ id: "r1", clientKey: "k9", qty: 6 }], [{ quantity: 3 }]],
        inserted,
      }),
      vendingStub,
    );
    await s.create({ machineSerial: "MU-7", productName: "кола", qty: 6, clientKey: "k9" });

    assert.equal(
      inserted.filter((r) => r.type === "vending.refill_recorded").length,
      0,
      "второе нажатие «Готово» не должно давать вторую строку в ленте",
    );
  });

  it("время заливки по умолчанию — сейчас, а не день без часов", async () => {
    const inserted: Row[] = [];
    const s = new RefillService(stubDb({ inserted }), vendingStub);
    const before = Date.now();
    await s.create({ machineSerial: "MU-7", productName: "кола", qty: 1, clientKey: "k6" });

    const refill = inserted.find((r) => r.clientKey === "k6")!;
    const at = refill.performedAt as Date;
    assert.ok(at instanceof Date, "сверка со снимками зеркала считает часы, не дни");
    assert.ok(at.getTime() >= before);
  });
});

describe("Повтор заливки в режиме ledger — остаток по леджеру, а не по таблице (R-GS-4)", () => {
  it("повтор по clientKey отдаёт остаток леджера и не читает vending_stock", async () => {
    // В очереди select — только сама заливка. Если бы повтор читал таблицу, следующий select
    // отдал бы [] и stockLeft стал бы null; 37 доказывает, что остаток пришёл из леджера.
    const selects: Record<string, unknown>[][] = [[{ id: "r1", clientKey: "rf-1" }]];
    const db = stubDb({ refillInsert: [], selects, inserted: [] });
    const ledger = {
      source: async () => "ledger",
      centralWarehouseId: async () => "wh-1",
      cardIdOf: async () => "c-s",
      qty: async () => 37,
      movement: async () => ({ ok: true }),
    } as never;
    const res = await new RefillService(db, vendingStub, ledger).create({ machineSerial: "M1", productName: "кола", qty: 3, clientKey: "rf-1" });
    assert.equal(res.duplicate, true);
    assert.equal(res.stockLeft, 37);
  });

  it("свежая заливка нерезолвящегося товара в режиме ledger — остаток «неизвестно», не строка тени", async () => {
    // productId null (товар без карточки прайса) — леджер не ищет остаток по
    // карточке, значит «неизвестно», а не число из upsert-а тени vending_stock.
    const inserted: Row[] = [];
    const db = stubDb({ inserted, stockAfter: { quantity: -6 } });
    const ledger = {
      source: async () => "ledger",
      centralWarehouseId: async () => "wh-1",
      cardIdOf: async () => "c-s",
      qty: async () => 99,
      movement: async () => ({ ok: true }),
    } as never;
    const res = await new RefillService(db, vendingStub, ledger).create({
      machineSerial: "M1",
      productName: "Snickers",
      qty: 6,
      clientKey: "rf-2",
    });
    assert.equal(res.duplicate, false);
    assert.equal(res.stockLeft, null, "без карточки товара остаток леджера не подставляется таблицей");
  });
});
