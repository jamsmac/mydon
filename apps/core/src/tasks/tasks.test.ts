import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { TasksService } from "./tasks.service";

type Row = Record<string, unknown>;

function stubDb(opts: { existing?: Row; updateResult?: Row; selectResult?: Row[] }) {
  const tx = {
    select: () => ({
      from: () => ({ where: async () => opts.selectResult ?? (opts.existing ? [opts.existing] : []) }),
    }),
    update: () => ({
      set: () => ({ where: () => ({ returning: async () => (opts.updateResult ? [opts.updateResult] : []) }) }),
    }),
    insert: () => ({ values: (v: unknown) => ({ returning: async () => [{ id: "t1", ...(v as Row) }] }) }),
  };
  return {
    select: tx.select,
    transaction: async <T>(cb: (t: typeof tx) => Promise<T>): Promise<T> => cb(tx),
  } as never;
}

describe("Задачи", () => {
  it("создаётся вместе с записью в журнал", async () => {
    const s = new TasksService(stubDb({}));
    const t = await s.create({ title: "Снять показания", ownerKind: "human" });
    assert.equal(t.id, "t1");
  });

  it("повторное «Готово» не ошибка — возвращает ту же задачу", async () => {
    // UPDATE ничего не вернул (статус уже такой), строка существует
    const s = new TasksService(stubDb({ existing: { id: "t1", status: "done" } }));
    const t = await s.setStatus("t1", "done");
    assert.equal(t.status, "done");
  });

  it("сообщает, что задачи нет", async () => {
    const s = new TasksService(stubDb({}));
    await assert.rejects(() => s.setStatus("нет", "done"), /не найдена/);
  });

  it("повторяющаяся задача не дублируется в тот же день", async () => {
    // такая задача на сегодня уже есть
    const s = new TasksService(stubDb({ selectResult: [{ id: "t1" }] }));
    const again = await s.ensureForDay({
      title: "Инвентаризация",
      ownerKind: "human",
      source: "recurring:inventory",
      dayKey: "2026-07-28",
    });
    assert.equal(again, null, "иначе владелец получал бы по три одинаковых задачи в день");
  });

  it("в новый день задача заводится заново", async () => {
    const s = new TasksService(stubDb({ selectResult: [] }));
    const created = await s.ensureForDay({
      title: "Инвентаризация",
      ownerKind: "human",
      source: "recurring:inventory",
      dayKey: "2026-07-29",
    });
    assert.ok(created, "на новый день задача должна появиться");
    assert.match(String(created?.source), /2026-07-29/);
  });
});
