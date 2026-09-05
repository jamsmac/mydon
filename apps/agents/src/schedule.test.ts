import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { desiredJobs, jobKey, llmCronAdmitted, scheduledInvocationMode } from "./schedule";
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

  it("coach-review всегда идёт через durable task, даже до проверки route", () => {
    let routeChecked = false;
    assert.equal(
      scheduledInvocationMode("coach-review", () => {
        routeChecked = true;
        return false;
      }),
      "durable-task",
    );
    assert.equal(routeChecked, false);
  });

  it("legacy cron fail-closed, если его workflow стал metered", () => {
    assert.equal(scheduledInvocationMode("morning-digest", () => false), "legacy");
    assert.throws(
      () => scheduledInvocationMode("future-metered-skill", () => true),
      /blocked until it is allowlisted/,
    );
  });

  it("llm-навык на cron идёт durable-задачей и не падает на metered-гейте (R-SD-5)", () => {
    let routeChecked = false;
    assert.equal(
      scheduledInvocationMode(
        "qualify-lead",
        () => {
          routeChecked = true;
          return true;
        },
        () => true,
      ),
      "durable-task",
    );
    assert.equal(routeChecked, false, "llm решается до проверки metered-маршрута");
  });

  it("код-навык с metered-workflow вне allowlist по-прежнему бросает", () => {
    assert.throws(
      () => scheduledInvocationMode("future-metered-skill", () => true, () => false),
      /blocked until it is allowlisted/,
    );
  });

  it("llm-навык планируется: desiredJobs берёт код ∨ llm (R-SD-5)", () => {
    const llm = agent({
      skills: ["qualify-lead"],
      schedule: [{ cron: "0 8 * * 1", skill: "qualify-lead" }],
    });
    const hasSkillLike = (s: string): boolean => s === "qualify-lead";
    const { jobs, notWired } = desiredJobs([llm], hasSkillLike);
    assert.deepEqual(jobs, [{ agent: "kass", skill: "qualify-lead", cron: "0 8 * * 1" }]);
    assert.deepEqual(notWired, []);
  });

  it("llmCronAdmitted: без metered-маршрута llm на cron не ставится (fail-closed)", () => {
    assert.equal(llmCronAdmitted({ billingMode: "metered" }), true);
    assert.equal(llmCronAdmitted({ billingMode: "local" }), false, "локальный маршрут не платный");
    assert.equal(llmCronAdmitted(null), false, "маршрут выключен вовсе");
  });

  it("llm-навык без metered-маршрута уходит в notWired, а не в вечные повторы", () => {
    // Задача создалась бы на каждый тик, worker вернул бы route_unavailable, а
    // Core повторял бы её каждые 60 секунд — навсегда. Не планировать честнее.
    const llm = agent({
      skills: ["qualify-lead"],
      schedule: [{ cron: "0 8 * * 1", skill: "qualify-lead" }],
    });
    const gateway = { billingMode: "local" };
    const { jobs, notWired } = desiredJobs(
      [llm],
      (s) => s === "code-skill" || (s === "qualify-lead" && llmCronAdmitted(gateway)),
    );
    assert.deepEqual(jobs, []);
    assert.deepEqual(notWired, ["kass/qualify-lead"]);
  });
});
