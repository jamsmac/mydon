import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentsService } from "./agents.service";

type Row = Record<string, unknown>;

/** Стаб базы: копит values из insert/update, чтобы проверить, что кладём. */
function stub(opts: { existing?: Row; selectRows?: Row[] }) {
  const captured = { insert: [] as Row[], update: [] as Row[] };
  const tx = {
    insert: () => ({
      values: (v: Row) => {
        captured.insert.push(v);
        return { returning: async () => [{ id: "a1", ...v }] };
      },
    }),
    update: () => ({
      set: (v: Row) => {
        captured.update.push(v);
        return { where: () => ({ returning: async () => [{ ...(opts.existing ?? {}), ...v }] }) };
      },
    }),
  };
  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => opts.selectRows ?? (opts.existing ? [opts.existing] : []) }) }),
    }),
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
  return { db, captured };
}

describe("Настройки агента: конфиг-поля навыков в базе", () => {
  it("create кладёт пустые конфиг-поля по умолчанию (не теряются при загрузке из базы)", async () => {
    const { db, captured } = stub({ selectRows: [] });
    await new AgentsService(db).create({ name: "knowledge-curator" });
    const v = captured.insert[0]; // первый insert — сам агент (второй — аудит)
    assert.deepEqual(v.webSources, []);
    assert.deepEqual(v.breakGlass, []);
    assert.deepEqual(v.ideaChannels, []);
    assert.equal(v.budgetOnExceeded, null);
  });

  it("update переносит каналы идей, break-glass и стратегию бюджета", async () => {
    const { db, captured } = stub({ existing: { id: "a1", name: "knowledge-curator" } });
    await new AgentsService(db).update("knowledge-curator", {
      ideaChannels: ["promtjam"],
      breakGlass: ["read-sources"],
      budgetOnExceeded: "pause",
    });
    const v = captured.update[0];
    assert.deepEqual(v.ideaChannels, ["promtjam"]);
    assert.deepEqual(v.breakGlass, ["read-sources"]);
    assert.equal(v.budgetOnExceeded, "pause");
    assert.equal("webSources" in v, false, "непереданные поля не трогаем");
  });

  it("update пишет веб-источники", async () => {
    const { db, captured } = stub({ existing: { id: "a1", name: "market-analyst" } });
    await new AgentsService(db).update("market-analyst", {
      webSources: [{ name: "cbu", url: "https://cbu.uz" }],
    });
    assert.deepEqual(captured.update[0].webSources, [{ name: "cbu", url: "https://cbu.uz" }]);
  });
});
