import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ScheduledOccurrenceRetryQueue } from "./scheduled-occurrence-queue";

const job = { agent: "coach-agent", skill: "coach-review", cron: "0 10 * * 1" };
const scheduledAt = new Date("2026-08-31T05:00:00.000Z");

describe("scheduled occurrence retry queue", () => {
  it("удерживает occurrence после transient Core failure и удаляет только после успеха", async () => {
    const queue = new ScheduledOccurrenceRetryQueue();
    queue.enqueue(job, scheduledAt);
    const first = await queue.flush(async () => {
      throw new Error("Core unavailable");
    });
    assert.equal(first.failed.length, 1);
    assert.equal(queue.size, 1);

    const delivered: string[] = [];
    const second = await queue.flush(async (occurrence) => {
      delivered.push(occurrence.scheduledAt.toISOString());
    });
    assert.equal(second.completed.length, 1);
    assert.equal(queue.size, 0);
    assert.deepEqual(delivered, [scheduledAt.toISOString()]);
  });

  it("дедуплицирует один fire time до обращения к Core", async () => {
    const queue = new ScheduledOccurrenceRetryQueue();
    queue.enqueue(job, scheduledAt);
    queue.enqueue(job, new Date(scheduledAt));
    assert.equal(queue.size, 1);
  });
});
