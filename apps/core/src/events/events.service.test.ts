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
  it("stores clientKey with the first event", async () => {
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

  it("returns the existing row for an exact retry and rejects a different payload", async () => {
    const occurredAt = new Date("2026-08-29T07:00:00.000Z");
    const existing = {
      id: "e1",
      source: "agent:a",
      type: "agent.action",
      payload: { action: "x" },
      clientKey: "task:t:effect:action",
      occurredAt,
    };
    const exact = new EventsService(eventDb({ existing }).db);
    assert.equal(
      (
        await exact.record({
          source: "agent:a",
          type: "agent.action",
          payload: { action: "x" },
          occurredAt,
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
          occurredAt,
          clientKey: "task:t:effect:action",
        }),
      /уже использован другим payload/,
    );
  });

  it("rejects an explicit occurredAt mismatch for the same clientKey", async () => {
    const existing = {
      id: "e1",
      source: "agent:a",
      type: "agent.action",
      payload: { action: "x" },
      clientKey: "task:t:effect:action",
      occurredAt: new Date("2026-08-29T07:00:00.000Z"),
    };
    const service = new EventsService(eventDb({ existing }).db);

    await assert.rejects(
      () =>
        service.record({
          source: "agent:a",
          type: "agent.action",
          payload: { action: "x" },
          occurredAt: new Date("2026-08-29T07:01:00.000Z"),
          clientKey: "task:t:effect:action",
        }),
      /уже использован/,
    );
  });

  it("accepts the stored timestamp when an exact retry omits occurredAt", async () => {
    const existing = {
      id: "e1",
      source: "agent:a",
      type: "agent.action",
      payload: { action: "x" },
      clientKey: "task:t:effect:action",
      occurredAt: new Date("2026-08-29T07:00:00.000Z"),
    };
    const service = new EventsService(eventDb({ existing }).db);

    const replay = await service.record({
      source: "agent:a",
      type: "agent.action",
      payload: { action: "x" },
      clientKey: "task:t:effect:action",
    });
    assert.equal(replay.id, "e1");
  });
});
