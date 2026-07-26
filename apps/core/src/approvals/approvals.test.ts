import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApprovalsService } from "./approvals.service";

type Row = Record<string, unknown>;

/** Минимальная заглушка Drizzle: повторяет только используемую цепочку вызовов. */
function stubDb(existing: Row | undefined, updated: Row = {}) {
  return {
    select: () => ({ from: () => ({ where: async () => (existing ? [existing] : []) }) }),
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => [updated] }) }),
    }),
    insert: () => ({ values: () => ({ returning: async () => [updated] }) }),
  } as never;
}

const noopAudit = { record: async () => undefined } as never;
const noopEvents = { record: async () => undefined } as never;

describe("ApprovalsService.decide", () => {
  it("проводит решение по ожидающему запросу", async () => {
    const pending = { id: "a1", decision: "pending" };
    const service = new ApprovalsService(
      stubDb(pending, { id: "a1", decision: "approved" }),
      noopAudit,
      noopEvents,
    );

    const result = await service.decide("a1", "approved", "owner");
    assert.equal(result.decision, "approved");
  });

  it("отклоняет повторное решение по уже закрытому запросу", async () => {
    const decided = { id: "a1", decision: "approved" };
    const service = new ApprovalsService(stubDb(decided), noopAudit, noopEvents);

    await assert.rejects(
      () => service.decide("a1", "rejected", "owner"),
      /уже закрыт решением/,
      "повторное решение должно быть отклонено — иначе можно переиграть согласование задним числом",
    );
  });

  it("сообщает, что запрос не найден", async () => {
    const service = new ApprovalsService(stubDb(undefined), noopAudit, noopEvents);
    await assert.rejects(() => service.decide("нет-такого", "approved", "owner"), /не найден/);
  });
});
