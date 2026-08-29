import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  coffeeConsumable,
  coffeeContainerReturn,
  entity,
  coffeeRefill,
  org,
  vendingPurchaseOrder,
} from "@mydon/db";
import { ApprovalsService } from "./approvals.service";

type Row = Record<string, unknown>;

/**
 * Заглушка Drizzle: повторяет только используемую цепочку вызовов.
 *
 * Решение теперь идёт одной транзакцией с атомарным UPDATE
 * (условие decision='pending' внутри WHERE), поэтому заглушка
 * имитирует именно это: `updateResult` — то, что вернул бы UPDATE.
 */
function stubDb(opts: { existing?: Row; updateResult?: Row }) {
  const tx = {
    select: () => ({ from: () => ({ where: async () => (opts.existing ? [opts.existing] : []) }) }),
    update: () => ({
      set: () => ({
        where: () => ({ returning: async () => (opts.updateResult ? [opts.updateResult] : []) }),
      }),
    }),
    insert: () => ({ values: async () => undefined }),
  };
  return {
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
}

const noopAudit = { record: async () => undefined } as never;
const noopEvents = { record: async () => undefined } as never;

describe("ApprovalsService.decide", () => {
  it("проводит решение по ожидающему запросу", async () => {
    const service = new ApprovalsService(
      stubDb({ updateResult: { id: "a1", decision: "approved" } }),
      noopAudit,
      noopEvents,
    );
    const result = await service.decide("a1", "approved", "owner");
    assert.equal(result.decision, "approved");
  });

  it("отклоняет повторное решение по уже закрытому запросу", async () => {
    // UPDATE ничего не вернул (условие pending не выполнено), строка существует
    const service = new ApprovalsService(
      stubDb({ existing: { id: "a1", decision: "approved" } }),
      noopAudit,
      noopEvents,
    );
    await assert.rejects(
      () => service.decide("a1", "rejected", "owner"),
      /уже закрыт решением/,
      "иначе согласование можно переиграть задним числом",
    );
  });

  it("сообщает, что запрос не найден", async () => {
    const service = new ApprovalsService(stubDb({}), noopAudit, noopEvents);
    await assert.rejects(() => service.decide("нет-такого", "approved", "owner"), /не найден/);
  });

  it("запрос агента создаётся вместе с событием и записью в журнал", async () => {
    const inserts: number[] = [];
    const tx = {
      insert: () => ({
        values: (v: unknown) => {
          inserts.push(1);
          const returning = async () => [{ id: "new-1", ...(v as Row) }];
          return {
            returning,
            onConflictDoNothing: () => ({ returning }),
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(undefined).then(resolve),
          };
        },
      }),
    };
    const db = {
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never;

    const service = new ApprovalsService(db, noopAudit, noopEvents);
    const created = await service.request({ agent: "test", action: "действие", tier: "T3" });
    assert.equal(created.id, "new-1");
    assert.equal(
      inserts.length,
      3,
      "должны быть запрос, событие и запись журнала — все в одной транзакции",
    );
  });

  it("returns the existing approval for clientKey and rejects a different payload", async () => {
    const existing = {
      id: "a-existing",
      agent: "test",
      action: "действие",
      tier: "T3",
      payload: { x: 1 },
      clientKey: "task:t:approval",
    };
    const tx = {
      insert: () => ({
        values: () => ({
          onConflictDoNothing: () => ({ returning: async () => [] }),
        }),
      }),
      select: () => ({
        from: () => ({ where: () => ({ limit: async () => [existing] }) }),
      }),
    };
    const db = {
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never;
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    const replay = await service.request({
      agent: "test",
      action: "действие",
      tier: "T3",
      payload: { x: 1 },
      clientKey: "task:t:approval",
    });
    assert.equal(replay.id, "a-existing");
    await assert.rejects(
      () =>
        service.request({
          agent: "test",
          action: "другое",
          tier: "T3",
          payload: { x: 1 },
          clientKey: "task:t:approval",
        }),
      /уже использован другим payload/,
    );
  });
});

describe("Одобренный импорт данных → карточки в реестре", () => {
  // Заглушка с поддержкой .limit() и вставок: считаем, что легло в entity.
  function importStub(payload: Row, entityLookup: Row[] = []) {
    const inserted: Row[] = [];
    const withLimit = (rows: Row[]) =>
      Object.assign(Promise.resolve(rows), { limit: async () => rows });
    const tx = {
      select: () => ({
        from: (table: unknown) => ({
          where: () =>
            withLimit(table === org ? [{ id: "org-1", code: "globerent" }] : entityLookup),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [
              { id: "a1", agent: "test-agent", decision: "approved", payload },
            ],
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (v: Row) => {
          if (table === entity) inserted.push(v);
          return Object.assign(Promise.resolve(undefined), {
            returning: async () => [{ id: `e${inserted.length}`, ...v }],
          });
        },
      }),
    };
    const db = {
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never;
    return { db, inserted };
  }

  it("«одобрить» заводит карточки из payload.import — записи без имени пропускаются", async () => {
    const { db, inserted } = importStub({
      import: {
        domain: "globerent",
        type: "contractor",
        records: [
          { name: "Olma Cafe", externalRef: "ИНН 123" },
          { name: "  " },
          { name: "Chinor" },
        ],
      },
    });
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(inserted.length, 2, "должны появиться две карточки: пустое имя — мимо");
    assert.equal(inserted[0].name, "Olma Cafe");
    assert.equal(inserted[0].externalRef, "ИНН 123");
    assert.ok(
      inserted[0].approvedAt instanceof Date,
      "решение владельца сразу утверждает карточку",
    );
    assert.equal(inserted[0].approvedBy, "owner");
    assert.equal(inserted[0].createdFrom, "approval:test-agent");
  });

  it("дубль по имени и типу внутри направления не плодится", async () => {
    const { db, inserted } = importStub(
      { import: { domain: "globerent", type: "contractor", records: [{ name: "Olma Cafe" }] } },
      [{ id: "существующая" }],
    );
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(inserted.length, 0, "существующая карточка не должна дублироваться");
  });

  it("одобрение без import-полезной нагрузки ничего не заводит (обычные согласования)", async () => {
    const { db, inserted } = importStub({ facts: { сумма: 1 } });
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(inserted.length, 0);
  });

  it("кривое направление в import — импорт пропускается, решение остаётся", async () => {
    const { db, inserted } = importStub({
      import: { domain: "марс", type: "contractor", records: [{ name: "X" }] },
    });
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    const row = await service.decide("a1", "approved", "owner");
    assert.equal(row.decision, "approved");
    assert.equal(inserted.length, 0);
  });
  it("две машины в одной точке (одно имя, разные серийники) — обе заводятся", async () => {
    const { db, inserted } = importStub({
      import: {
        domain: "globerent",
        type: "machine",
        records: [
          { name: "American hospital", externalRef: "3266181f0000" },
          { name: "American hospital", externalRef: "9999181f0000" },
        ],
      },
    });
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(inserted.length, 2, "разные серийники = разные машины, имя точки не важно");
  });
});

describe("Одобренная заявка закупа → накладная (§5.7)", () => {
  function orderStub(payload: Row) {
    const orders: Row[] = [];
    const tx = {
      select: () => ({ from: () => ({ where: async () => [] }) }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [
              { id: "a1", agent: "test-agent", decision: "approved", payload },
            ],
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (v: Row) => {
          if (table === vendingPurchaseOrder) orders.push(v);
          return Object.assign(Promise.resolve(undefined), {
            returning: async () => [{ id: `o${orders.length}`, ...v }],
          });
        },
      }),
    };
    const db = {
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never;
    return { db, orders };
  }

  it("«одобрить» материализует накладную со снимком сумм из payload", async () => {
    const { db, orders } = orderStub({
      purchaseOrder: {
        positions: [{ product: "Montella", order: 12, buy: 4 }],
        totalBuy: 4,
        totalOrder: 12,
        costExact: 20000,
        costRounded: 60000,
        createdBy: "owner",
      },
    });
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(orders.length, 1);
    assert.equal(orders[0].approvalId, "a1");
    assert.equal(orders[0].totalOrder, 12);
    assert.equal(orders[0].costRounded, "60000.00"); // numeric → строка
    assert.equal((orders[0].positions as unknown[]).length, 1);
  });

  it("одобрение без purchaseOrder — накладную не создаёт", async () => {
    const { db, orders } = orderStub({ facts: { сумма: 1 } });
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(orders.length, 0);
  });

  it("пустые позиции — накладную не создаёт", async () => {
    const { db, orders } = orderStub({ purchaseOrder: { positions: [], totalOrder: 0 } });
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(orders.length, 0);
  });
});

describe("Одобренный исторический импорт кофе-бункеров (payload.coffeeImport)", () => {
  function coffeeImportStub(
    payload: Row,
    opts: { locations?: Row[]; existingRefills?: Row[]; existingReturns?: Row[] } = {},
  ) {
    const inserted: Row[] = [];
    const insertedReturns: Row[] = [];
    const upsertedConsumables: Row[] = [];
    const insertedLocations: Row[] = [];
    const withLimit = (rows: Row[]) =>
      Object.assign(Promise.resolve(rows), { limit: async () => rows });
    const tx = {
      select: () => ({
        from: (table: unknown) => {
          // Сервис читает и id, и name (резолв исторических точек по имени).
          // Места теперь карточки реестра, поэтому выборка идёт с where(type).
          if (table === entity) {
            const rows = opts.locations ?? [{ id: "loc-1", name: "AH" }];
            return Object.assign(Promise.resolve(rows), { where: () => Promise.resolve(rows) });
          }
          if (table === coffeeContainerReturn)
            return { where: () => withLimit(opts.existingReturns ?? []) };
          return { where: () => withLimit(opts.existingRefills ?? []) };
        },
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [
              { id: "a1", agent: "test-agent", decision: "approved", payload },
            ],
          }),
        }),
      }),
      insert: (table: unknown) => ({
        // Исполнение теперь пакетное: values() приходит и одной строкой,
        // и массивом (куски по 500) — раскладываем в плоский список.
        values: (v: Row | Row[]) => {
          const rows = Array.isArray(v) ? v : [v];
          if (table === coffeeRefill) inserted.push(...rows);
          if (table === coffeeContainerReturn) insertedReturns.push(...rows);
          if (table === coffeeConsumable) upsertedConsumables.push(...rows);
          if (table === entity) insertedLocations.push(...rows);
          return Object.assign(Promise.resolve(undefined), {
            onConflictDoUpdate: async () => undefined,
            returning: async () => [{ id: `loc-new-${insertedLocations.length}` }],
          });
        },
      }),
    };
    const db = {
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never;
    return { db, inserted, insertedReturns, upsertedConsumables, insertedLocations };
  }

  const validRecord = {
    locationId: "loc-1",
    position: 7,
    filledWeight: 1200,
    enteredDate: "2026-07-01",
  };

  it("«одобрить» заносит валидные записи как coffee_refill с меткой источника", async () => {
    const { db, inserted } = coffeeImportStub({ coffeeImport: { records: [validRecord] } });
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].locationId, "loc-1");
    assert.equal(inserted[0].position, 7);
    assert.equal(inserted[0].filledWeight, 1200);
    assert.equal(inserted[0].packageCount, 1, "по умолчанию 1 упаковка");
    assert.equal(inserted[0].createdBy, "import:telegram-history");
  });

  it("locationId не из справочника (модель могла выдумать точку) — запись пропускается", async () => {
    const { db, inserted } = coffeeImportStub(
      { coffeeImport: { records: [{ ...validRecord, locationId: "выдуманная-точка" }] } },
      { locations: [{ id: "loc-1", name: "AH" }] },
    );
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    const row = await service.decide("a1", "approved", "owner");
    assert.equal(inserted.length, 0);
    assert.equal(row.decision, "approved", "решение остаётся даже если импорт ничего не занёс");
  });

  it("позиция вне 1–8 или неположительный вес — запись пропускается", async () => {
    const { db, inserted } = coffeeImportStub({
      coffeeImport: {
        records: [
          { ...validRecord, position: 9 },
          { ...validRecord, filledWeight: 0 },
          { ...validRecord, enteredDate: "не дата" },
        ],
      },
    });
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(inserted.length, 0);
  });

  it("точно такая же запись уже есть (точка/позиция/дата/вес/упаковки) — не дублирует", async () => {
    const { db, inserted } = coffeeImportStub(
      { coffeeImport: { records: [validRecord] } },
      // Дедуп теперь сверяет составной ключ по колонкам, а не наличие строки.
      {
        existingRefills: [
          {
            locationId: "loc-1",
            position: 7,
            enteredDate: "2026-07-01",
            filledWeight: 1200,
            packageCount: 1,
          },
        ],
      },
    );
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(inserted.length, 0, "повторное одобрение/ретрай импорта не плодит дубли");
  });

  it("необязательные поля (набор, вес до досыпки) переносятся, если валидны", async () => {
    const { db, inserted } = coffeeImportStub({
      coffeeImport: { records: [{ ...validRecord, containerNumber: 7, measuredBefore: 200 }] },
    });
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(inserted[0].containerNumber, 7);
    assert.equal(inserted[0].measuredBefore, 200);
  });

  it("набор вне 1–27 — молча отбрасывается (не вся запись, только поле)", async () => {
    const { db, inserted } = coffeeImportStub({
      coffeeImport: { records: [{ ...validRecord, containerNumber: 99 }] },
    });
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(inserted.length, 1, "запись всё равно заносится");
    assert.equal(inserted[0].containerNumber, null);
  });

  it("одобрение без coffeeImport-нагрузки ничего не заносит (обычные согласования)", async () => {
    const { db, inserted } = coffeeImportStub({ facts: { сумма: 1 } });
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(inserted.length, 0);
  });

  // ── Возвраты наборов (payload.coffeeImport.returns) ────────────────────────

  const validReturn = { position: 1, containerNumber: 27, weight: 787, returnedDate: "2026-07-30" };

  it("возврат «позиция. набор. вес» заносится с меткой источника", async () => {
    const { db, insertedReturns } = coffeeImportStub({ coffeeImport: { returns: [validReturn] } });
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(insertedReturns.length, 1);
    assert.equal(insertedReturns[0].position, 1);
    assert.equal(insertedReturns[0].containerNumber, 27);
    assert.equal(insertedReturns[0].weight, 787);
    assert.equal(insertedReturns[0].createdBy, "import:telegram-history");
  });

  it("возврат с кривыми полями (позиция 9, набор 28, вес −1, не дата) — пропускается", async () => {
    const { db, insertedReturns } = coffeeImportStub({
      coffeeImport: {
        returns: [
          { ...validReturn, position: 9 },
          { ...validReturn, containerNumber: 28 },
          { ...validReturn, weight: -1 },
          { ...validReturn, returnedDate: "июль" },
        ],
      },
    });
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(insertedReturns.length, 0);
  });

  it("точно такой же возврат уже есть — не дублируется", async () => {
    const { db, insertedReturns } = coffeeImportStub(
      { coffeeImport: { returns: [validReturn] } },
      {
        existingReturns: [
          { position: 1, containerNumber: 27, returnedDate: "2026-07-30", weight: 787 },
        ],
      },
    );
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(insertedReturns.length, 0);
  });

  it("подсказка точки из заголовка сообщения сохраняется как примечание", async () => {
    const { db, insertedReturns } = coffeeImportStub({
      coffeeImport: { returns: [{ ...validReturn, locationNote: "  Кпп остатки  " }] },
    });
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(insertedReturns[0].locationNote, "Кпп остатки");
  });

  // ── Расходники из фото-таблиц (payload.coffeeImport.consumables) ──────────

  it("расходники по точке/дате заносятся upsert-ом; чужая точка пропускается", async () => {
    const { db, upsertedConsumables } = coffeeImportStub({
      coffeeImport: {
        consumables: [
          { locationId: "loc-1", loggedDate: "2026-08-03", water: 1, cups: 0, lids: 0 },
          { locationId: "не-точка", loggedDate: "2026-08-03", water: 5 },
        ],
      },
    });
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(upsertedConsumables.length, 1);
    assert.equal(upsertedConsumables[0].locationId, "loc-1");
    assert.equal(upsertedConsumables[0].water, 1);
    assert.equal(upsertedConsumables[0].createdBy, "import:telegram-history");
  });

  // ── Исторические точки (payload.coffeeImport.newLocations) ────────────────

  it("новая точка создаётся, заливка с locationName попадает на её id", async () => {
    const { db, inserted, insertedLocations } = coffeeImportStub({
      coffeeImport: {
        newLocations: ["кардиология 1 корпус"],
        records: [
          {
            locationName: "Кардиология 1 корпус",
            position: 3,
            filledWeight: 1145,
            enteredDate: "2025-12-10",
          },
        ],
      },
    });
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(insertedLocations.length, 1);
    assert.equal(insertedLocations[0].name, "кардиология 1 корпус");
    assert.ok(insertedLocations[0].approvedAt instanceof Date);
    assert.equal(insertedLocations[0].approvedBy, "owner");
    assert.equal(inserted.length, 1);
    // Имя резолвится без учёта регистра — на id только что созданной точки.
    assert.equal(inserted[0].locationId, "loc-new-1");
  });

  it("locationName существующей точки резолвится без создания дубля", async () => {
    const { db, inserted, insertedLocations } = coffeeImportStub({
      coffeeImport: {
        newLocations: ["ah"],
        records: [
          { locationName: "ah", position: 1, filledWeight: 900, enteredDate: "2025-12-11" },
        ],
      },
    });
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(insertedLocations.length, 0, "точка «AH» уже есть — дубль не создаётся");
    assert.equal(inserted[0].locationId, "loc-1");
  });

  it("locationName вне списка newLocations — строка пропускается, точка не создаётся", async () => {
    const { db, inserted, insertedLocations } = coffeeImportStub({
      coffeeImport: {
        records: [
          {
            locationName: "выдуманная точка",
            position: 2,
            filledWeight: 800,
            enteredDate: "2025-12-12",
          },
        ],
      },
    });
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(insertedLocations.length, 0);
    assert.equal(inserted.length, 0);
  });

  it("расходники исторической точки тоже резолвятся по имени", async () => {
    const { db, upsertedConsumables, insertedLocations } = coffeeImportStub({
      coffeeImport: {
        newLocations: ["Soliq Yashnobod"],
        consumables: [
          { locationName: "soliq yashnobod", loggedDate: "2025-12-12", water: 2, cups: 1, lids: 1 },
        ],
      },
    });
    const service = new ApprovalsService(db, noopAudit, noopEvents);
    await service.decide("a1", "approved", "owner");
    assert.equal(insertedLocations.length, 1);
    assert.equal(upsertedConsumables.length, 1);
    assert.equal(upsertedConsumables[0].locationId, "loc-new-1");
  });
});
