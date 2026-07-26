import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
          return { returning: async () => [{ id: "new-1", ...(v as Row) }] };
        },
      }),
    };
    const db = {
      transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
    } as never;

    const service = new ApprovalsService(db, noopAudit, noopEvents);
    const created = await service.request({ agent: "test", action: "действие", tier: "T3" });
    assert.equal(created.id, "new-1");
    assert.equal(inserts.length, 3, "должны быть запрос, событие и запись журнала — все в одной транзакции");
  });
});
