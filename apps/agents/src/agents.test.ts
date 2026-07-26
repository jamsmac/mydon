import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { autonomyThreshold, explainPolicy, requiresApproval, tierRank } from "./policy";
import { loadAgents } from "./registry";
import { runSkill } from "./runner";
import type { AgentDefinition } from "./registry";

const AGENTS_DIR = path.resolve(__dirname, "../agents");

describe("Политика автономии (ответ владельца Ф6: всё вручную)", () => {
  it("при пороге T0 согласования требует ЛЮБОЕ действие", () => {
    for (const tier of ["T0", "T1", "T2", "T3", "T4"] as const) {
      assert.equal(requiresApproval(tier, "T0"), true, `уровень ${tier} должен требовать согласования`);
    }
  });

  it("при поднятом пороге пропускает только то, что не выше него", () => {
    assert.equal(requiresApproval("T1", "T2"), false);
    assert.equal(requiresApproval("T2", "T2"), false);
    assert.equal(requiresApproval("T3", "T2"), true);
  });

  it("неизвестный уровень считается максимально опасным", () => {
    assert.equal(tierRank("T9" as never), 5);
    assert.equal(requiresApproval("T9" as never, "T4"), true);
  });

  it("порог по умолчанию — T0, мусор в настройке не ослабляет защиту", () => {
    assert.equal(autonomyThreshold(undefined), "T0");
    assert.equal(autonomyThreshold(""), "T0");
    assert.equal(autonomyThreshold("полная свобода"), "T0");
    assert.equal(autonomyThreshold("t3"), "T3");
  });

  it("объясняет решение словами", () => {
    assert.match(explainPolicy("T3", "T0"), /требует согласования/);
  });
});

describe("Паспорта агентов (перенесены как есть)", () => {
  const { agents, errors } = loadAgents(AGENTS_DIR);

  it("читаются без ошибок", () => {
    assert.deepEqual(errors, [], "ни один паспорт не должен быть битым");
  });

  it("перенесены все 12 агентов, шаблон не считается агентом", () => {
    assert.equal(agents.length, 12);
    assert.ok(!agents.some((a) => a.name.startsWith("_")));
  });

  it("у каждого есть имя, статус и уровень автономии", () => {
    for (const a of agents) {
      assert.ok(a.name.length > 0);
      assert.ok(["active", "paused", "draft", "deprecated"].includes(a.status));
      assert.match(a.autonomyDefault, /^T[0-4]$/);
    }
  });

  it("статус разбирается даже с комментарием в строке", () => {
    const byName = Object.fromEntries(agents.map((a) => [a.name, a]));
    assert.equal(byName["call-analyst"].status, "active");
    assert.equal(byName["chief-of-staff"].status, "paused");
  });

  it("несуществующий каталог даёт ошибку, а не падение", () => {
    const res = loadAgents("/нет/такого/пути");
    assert.equal(res.agents.length, 0);
    assert.equal(res.errors.length, 1);
  });
});

describe("Прогон навыка", () => {
  const base: AgentDefinition = {
    name: "test-agent",
    business: "globerent",
    status: "active",
    autonomyDefault: "T1",
    schedule: [],
    skills: ["do-something"],
    dir: "/tmp",
  };

  function stubCore() {
    const calls: string[] = [];
    return {
      calls,
      client: {
        recordEvent: async () => {
          calls.push("event");
        },
        requestApproval: async () => {
          calls.push("approval");
          return { id: "appr-1" };
        },
      } as never,
    };
  }

  it("при пороге T0 запрашивает согласование, а не исполняет", async () => {
    const { client, calls } = stubCore();
    const res = await runSkill(base, "do-something", client, "T0");
    assert.equal(res.outcome, "approval_requested");
    assert.equal(res.approvalId, "appr-1");
    assert.deepEqual(calls, ["event", "approval"], "должно быть записано событие и создан запрос");
  });

  it("агент на паузе не запускается вовсе", async () => {
    const { client, calls } = stubCore();
    const res = await runSkill({ ...base, status: "paused" }, "do-something", client, "T4");
    assert.equal(res.outcome, "skipped");
    assert.deepEqual(calls, [], "у остановленного агента не должно быть ни событий, ни запросов");
  });

  it("при поднятом пороге исполняет без согласования", async () => {
    const { client, calls } = stubCore();
    const res = await runSkill(base, "do-something", client, "T2");
    assert.equal(res.outcome, "executed");
    assert.deepEqual(calls, ["event"]);
  });
});
