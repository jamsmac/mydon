import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { desiredJobs, jobKey } from "./schedule";
import type { AgentDefinition } from "./registry";

const agent = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({
  name: "kass",
  business: "vendhub",
  status: "active",
  autonomyDefault: "T0",
  skills: ["watch-receivables"],
  schedule: [{ cron: "0 9 * * *", skill: "watch-receivables" }],
  dir: "(тест)",
  ...over,
});

const wiredAll = (): boolean => true;

describe("Планирование заданий агентов", () => {
  it("активный агент с реализованным навыком даёт задание", () => {
    const { jobs, notWired } = desiredJobs([agent()], wiredAll);
    assert.equal(jobs.length, 1);
    assert.deepEqual(jobs[0], { agent: "kass", skill: "watch-receivables", cron: "0 9 * * *" });
    assert.equal(notWired.length, 0);
  });

  it("агент на паузе не планируется — правку статуса уважаем сразу", () => {
    const { jobs } = desiredJobs([agent({ status: "paused" })], wiredAll);
    assert.equal(jobs.length, 0);
  });

  it("нереализованный навык не планируется, а попадает в notWired", () => {
    const { jobs, notWired } = desiredJobs([agent()], (s) => s !== "watch-receivables");
    assert.equal(jobs.length, 0);
    assert.deepEqual(notWired, ["kass/watch-receivables"]);
  });

  it("дубль расписания не заводится дважды", () => {
    const a = agent({
      schedule: [
        { cron: "0 9 * * *", skill: "watch-receivables" },
        { cron: "0 9 * * *", skill: "watch-receivables" },
      ],
    });
    assert.equal(desiredJobs([a], wiredAll).jobs.length, 1);
  });

  it("ключ различает агента, навык и расписание", () => {
    assert.notEqual(
      jobKey({ agent: "a", skill: "s", cron: "0 9 * * *" }),
      jobKey({ agent: "a", skill: "s", cron: "0 10 * * *" }),
    );
  });

  it("смена статуса меняет желаемый набор (основа перечитки)", () => {
    const before = desiredJobs([agent()], wiredAll).jobs.map(jobKey);
    const after = desiredJobs([agent({ status: "paused" })], wiredAll).jobs.map(jobKey);
    assert.notDeepEqual(before, after);
    assert.equal(after.length, 0);
  });
});
