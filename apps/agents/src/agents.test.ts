import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { autonomyThreshold, explainPolicy, requiresApproval, tierRank } from "./policy";
import { loadAgents } from "./registry";
import { runSkill } from "./runner";
import { SKILLS } from "./skills";
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
    // Проверяем САМ разбор на временном паспорте: привязка к статусу живого
    // агента ломала бы тест при каждом включении/выключении агента владельцем.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mydon-agents-"));
    try {
      const dir = path.join(tmp, "sample");
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, "config.yaml"),
        "name: sample\nbusiness: shared\nstatus: active   # active | paused | draft\nautonomy_default: T1\n",
      );
      const res = loadAgents(tmp);
      assert.deepEqual(res.errors, []);
      assert.equal(res.agents[0]?.status, "active");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("статусы боевых паспортов — только из допустимого набора", () => {
    for (const a of agents) {
      assert.ok(["active", "paused", "draft", "deprecated"].includes(a.status), `${a.name}: ${a.status}`);
    }
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
    skills: ["watch-receivables"],
    dir: "/tmp",
  };

  const EMPTY_BRIEFING = {
    overdueMoney: 0,
    idleMachines: 0,
    pendingApprovals: 0,
    contractsDueSoon: 0,
    contractsBadDate: 0,
    overdueTasks: 0,
  };

  /** Заглушка Core: по умолчанию данных нет — как на пустой базе владельца. */
  function stubCore(over: Record<string, unknown> = {}) {
    const calls: string[] = [];
    const captured: { action?: string; payload?: Record<string, unknown> } = {};
    return {
      calls,
      captured,
      client: {
        recordEvent: async () => {
          calls.push("event");
        },
        requestApproval: async (input: { action: string; payload?: Record<string, unknown> }) => {
          calls.push("approval");
          captured.action = input.action;
          if (input.payload) captured.payload = input.payload;
          return { id: "appr-1" };
        },
        briefing: async () => EMPTY_BRIEFING,
        obligations: async () => ({
          domain: "globerent",
          totals: [],
          overdue: [],
          overdueTotal: 0,
          overdueTruncated: false,
        }),
        entities: async () => [],
        ...over,
      } as never,
    };
  }

  it("нет повода в данных — согласование НЕ создаётся (очередь остаётся сигналом)", async () => {
    const { client, calls } = stubCore();
    const res = await runSkill(base, "watch-receivables", client, "T0");
    assert.equal(res.outcome, "skipped");
    assert.match(res.reason, /повода нет/);
    assert.deepEqual(calls, ["event"], "событие о прогоне есть, а пустого согласования быть не должно");
  });

  it("есть просрочка — при T0 выносит ПРЕДМЕТНОЕ предложение с фактами", async () => {
    const { client, calls, captured } = stubCore({
      obligations: async () => ({
        domain: "globerent",
        totals: [],
        overdue: [{ id: "m1", amount: "5000000", currency: "UZS", date: "2026-05-01", direction: "in", status: "plan" }],
        overdueTotal: 3,
        overdueTruncated: false,
      }),
    });
    const res = await runSkill(base, "watch-receivables", client, "T0");
    assert.equal(res.outcome, "approval_requested");
    assert.equal(res.approvalId, "appr-1");
    // event(agent.run) → approval → event(agent.action, для дневного потолка)
    assert.deepEqual(calls, ["event", "approval", "event"]);
    assert.match(captured.action ?? "", /дебиторк/i, "формулировка должна быть по делу, а не именем навыка");
    assert.match(captured.action ?? "", /3 позиц/, "владельцу нужна конкретика: сколько позиций");
    assert.equal((captured.payload?.facts as Record<string, unknown>)?.overdueTotal, 3, "факты кладутся для проверки по следам");
  });

  it("нереализованный навык честно помечается, а не изображает работу", async () => {
    const { client, calls } = stubCore();
    const res = await runSkill(base, "draft-reminder", client, "T0");
    assert.equal(res.outcome, "skipped");
    assert.match(res.reason, /не подключён/);
    assert.deepEqual(calls, ["event"]);
  });

  it("агент на паузе не запускается вовсе", async () => {
    const { client, calls } = stubCore();
    const res = await runSkill({ ...base, status: "paused" }, "watch-receivables", client, "T4");
    assert.equal(res.outcome, "skipped");
    assert.deepEqual(calls, [], "у остановленного агента не должно быть ни событий, ни запросов");
  });

  it("при поднятом пороге исполняет без согласования (когда повод есть)", async () => {
    const { client, calls } = stubCore({
      obligations: async () => ({
        domain: "globerent",
        totals: [],
        overdue: [{ id: "m1", amount: "1000", currency: "UZS", date: "2026-05-01", direction: "in", status: "plan" }],
        overdueTotal: 1,
        overdueTruncated: false,
      }),
    });
    const res = await runSkill(base, "watch-receivables", client, "T2");
    assert.equal(res.outcome, "executed");
    // event(agent.run) → event(agent.action): исполнение тоже считается действием.
    assert.deepEqual(calls, ["event", "event"]);
  });

  it("дневной потолок исчерпан — предложение НЕ выносится", async () => {
    const prev = process.env.AGENT_DAILY_ACTION_CAP;
    process.env.AGENT_DAILY_ACTION_CAP = "3";
    try {
      const { client, calls } = stubCore({
        obligations: async () => ({
          domain: "globerent",
          totals: [],
          overdue: [{ id: "m1", amount: "5000000", currency: "UZS", date: "2026-05-01", direction: "in", status: "plan" }],
          overdueTotal: 3,
          overdueTruncated: false,
        }),
        // За сутки агент уже сделал 3 действия при потолке 3 — исчерпано.
        countAgentActions: async () => 3,
      });
      const res = await runSkill(base, "watch-receivables", client, "T0");
      assert.equal(res.outcome, "skipped");
      assert.match(res.reason, /потолок действий исчерпан/);
      // Событие о прогоне есть; согласования и записи действия — нет.
      assert.deepEqual(calls, ["event"]);
    } finally {
      if (prev === undefined) delete process.env.AGENT_DAILY_ACTION_CAP;
      else process.env.AGENT_DAILY_ACTION_CAP = prev;
    }
  });

  it("под потолком — действие проходит и считается", async () => {
    const prev = process.env.AGENT_DAILY_ACTION_CAP;
    process.env.AGENT_DAILY_ACTION_CAP = "5";
    try {
      const { client, calls } = stubCore({
        obligations: async () => ({
          domain: "globerent",
          totals: [],
          overdue: [{ id: "m1", amount: "5000000", currency: "UZS", date: "2026-05-01", direction: "in", status: "plan" }],
          overdueTotal: 2,
          overdueTruncated: false,
        }),
        countAgentActions: async () => 2, // 2 из 5 — ещё можно
      });
      const res = await runSkill(base, "watch-receivables", client, "T0");
      assert.equal(res.outcome, "approval_requested");
      assert.deepEqual(calls, ["event", "approval", "event"]);
    } finally {
      if (prev === undefined) delete process.env.AGENT_DAILY_ACTION_CAP;
      else process.env.AGENT_DAILY_ACTION_CAP = prev;
    }
  });
});

describe("Навыки агентов, подключённые к Core", () => {
  const agent: AgentDefinition = {
    name: "a", business: "vendhub", status: "active", autonomyDefault: "T1",
    schedule: [], skills: [], dir: "/tmp",
  };
  const briefing = {
    overdueMoney: 0, idleMachines: 0, pendingApprovals: 0,
    contractsDueSoon: 0, contractsBadDate: 0, overdueTasks: 0,
  };

  it("monitor-stock молчит, когда все автоматы работают", async () => {
    const core = { briefing: async () => briefing } as never;
    assert.equal(await SKILLS["monitor-stock"](agent, core), null);
  });

  it("monitor-stock предлагает проверку, когда есть простой", async () => {
    const core = { briefing: async () => ({ ...briefing, idleMachines: 4 }) } as never;
    const p = await SKILLS["monitor-stock"](agent, core);
    assert.ok(p, "должно быть предложение");
    assert.match(p.action, /4/);
    assert.equal(p.facts.idleMachines, 4);
  });

  it("morning-digest молчит при полном штиле и не дёргает владельца", async () => {
    const core = { briefing: async () => briefing } as never;
    assert.equal(await SKILLS["morning-digest"](agent, core), null);
  });

  it("morning-digest сообщает и о нераспознанных датах (известная неизвестность)", async () => {
    const core = { briefing: async () => ({ ...briefing, contractsBadDate: 7 }) } as never;
    const p = await SKILLS["morning-digest"](agent, core);
    assert.ok(p);
    assert.match(p.action, /нераспознанной датой: 7/);
  });

  it("watch-receivables показывает сумму и что список урезан", async () => {
    const core = {
      obligations: async () => ({
        domain: "globerent", totals: [],
        overdue: [
          { id: "1", amount: "1500000", currency: "UZS", date: "2026-01-10", direction: "in", status: "plan" },
          { id: "2", amount: "500000", currency: "UZS", date: "2026-02-10", direction: "in", status: "plan" },
        ],
        overdueTotal: 250, overdueTruncated: true,
      }),
    } as never;
    const p = await SKILLS["watch-receivables"]({ ...agent, business: "globerent" }, core);
    assert.ok(p);
    assert.match(p.action, /250 позиций/);
    assert.match(p.action, /показаны первые 2/, "нельзя выдавать урезанный список за полный");
    assert.equal(p.facts.sum, 2000000);
  });
});
