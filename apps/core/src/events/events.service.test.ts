import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EventsService } from "./events.service";

type Row = Record<string, unknown>;

function eventDb(options: { created?: Row; existing?: Row }) {
  const inserted: Row[] = [];
  const tx = {
    insert: () => ({
      values: (value: Row) => {
        inserted.push(value);
        return {
          onConflictDoNothing: () => ({
            returning: async () => (options.created ? [options.created] : []),
          }),
        };
      },
    }),
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (options.existing ? [options.existing] : []) }),
      }),
    }),
  };
  return {
    inserted,
    db: {
      transaction: async <T>(callback: (value: typeof tx) => Promise<T>): Promise<T> =>
        callback(tx),
    } as never,
  };
}

describe("EventsService idempotency", () => {
  it("пишет clientKey вместе с первым событием", async () => {
    const created = {
      id: "e1",
      source: "agent:a",
      type: "agent.action",
      payload: { action: "x" },
      clientKey: "task:t:effect:action",
    };
    const { db, inserted } = eventDb({ created });
    const row = await new EventsService(db).record({
      source: "agent:a",
      type: "agent.action",
      payload: { action: "x" },
      clientKey: "task:t:effect:action",
    });
    assert.equal(row.id, "e1");
    assert.equal(inserted[0]?.clientKey, "task:t:effect:action");
  });

  it("exact retry возвращает прежнюю строку, другой payload получает conflict", async () => {
    const existing = {
      id: "e1",
      source: "agent:a",
      type: "agent.action",
      payload: { action: "x" },
      clientKey: "task:t:effect:action",
    };
    const exact = new EventsService(eventDb({ existing }).db);
    assert.equal(
      (
        await exact.record({
          source: "agent:a",
          type: "agent.action",
          payload: { action: "x" },
          clientKey: "task:t:effect:action",
        })
      ).id,
      "e1",
    );

    const mismatch = new EventsService(eventDb({ existing }).db);
    await assert.rejects(
      () =>
        mismatch.record({
          source: "agent:a",
          type: "agent.action",
          payload: { action: "другое" },
          clientKey: "task:t:effect:action",
        }),
      /уже использован другим payload/,
    );
  });
});
