import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  LlmBudgetDeniedError,
  LlmLedgerUnavailableError,
  LlmReplayBlockedError,
} from "@mydon/shared";
import { autonomyThreshold, explainPolicy, requiresApproval, tierRank } from "./policy";
import { loadAgents } from "./registry";
import { runSkill } from "./runner";
import { signature } from "./memory";
import { EXECUTORS } from "./executors";
import { runAgentTasks } from "./task-worker";
import { TaskLlmWorkflowChangedError } from "./task-llm-session";
import { SKILLS } from "./skills";
import { LlmSkillFailedError, LlmSkillInvalidOutputError } from "./llm-skill";
import type { AgentDefinition } from "./registry";

const AGENTS_DIR = path.resolve(__dirname, "../agents");

describe("Политика автономии (ответ владельца Ф6: всё вручную)", () => {
  it("при пороге T0 согласования требует ЛЮБОЕ действие", () => {
    for (const tier of ["T0", "T1", "T2", "T3", "T4"] as const) {
      assert.equal(
        requiresApproval(tier, "T0"),
        true,
        `уровень ${tier} должен требовать согласования`,
      );
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
      assert.ok(
        ["active", "paused", "draft", "deprecated"].includes(a.status),
        `${a.name}: ${a.status}`,
      );
    }
  });

  it("solution-scout active и его первый task-навык подключён к runtime", () => {
    const scout = agents.find((agent) => agent.name === "solution-scout");
    assert.equal(scout?.status, "active");
    assert.deepEqual(scout?.skills, ["find-solution"]);
    assert.equal(typeof SKILLS["find-solution"], "function");
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
    const captured: {
      action?: string;
      payload?: Record<string, unknown>;
      clientKey?: string;
    } = {};
    return {
      calls,
      captured,
      client: {
        recordEvent: async () => {
          calls.push("event");
        },
        requestApproval: async (input: {
          action: string;
          payload?: Record<string, unknown>;
          clientKey?: string;
        }) => {
          calls.push("approval");
          captured.action = input.action;
          if (input.payload) captured.payload = input.payload;
          if (input.clientKey) captured.clientKey = input.clientKey;
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
        // Дельта-память по умолчанию пуста → повод считается новым (как раньше).
        recallMemory: async () => null,
        rememberMemory: async () => undefined,
        ...over,
      } as never,
    };
  }

  it("нет повода в данных — согласование НЕ создаётся (очередь остаётся сигналом)", async () => {
    const { client, calls } = stubCore();
    const res = await runSkill(base, "watch-receivables", client, "T0");
    assert.equal(res.outcome, "skipped");
    assert.match(res.reason, /повода нет/);
    assert.deepEqual(
      calls,
      ["event"],
      "событие о прогоне есть, а пустого согласования быть не должно",
    );
  });

  it("есть просрочка — при T0 выносит ПРЕДМЕТНОЕ предложение с фактами", async () => {
    const { client, calls, captured } = stubCore({
      obligations: async () => ({
        domain: "globerent",
        totals: [],
        overdue: [
          {
            id: "m1",
            amount: "5000000",
            currency: "UZS",
            date: "2026-05-01",
            direction: "in",
            status: "plan",
          },
        ],
        overdueTotal: 3,
        overdueTruncated: false,
      }),
    });
    const res = await runSkill(base, "watch-receivables", client, "T0");
    assert.equal(res.outcome, "approval_requested");
    assert.equal(res.approvalId, "appr-1");
    // event(agent.run) → approval → event(agent.action, для дневного потолка)
    assert.deepEqual(calls, ["event", "approval", "event"]);
    assert.match(
      captured.action ?? "",
      /дебиторк/i,
      "формулировка должна быть по делу, а не именем навыка",
    );
    assert.match(captured.action ?? "", /3 позиц/, "владельцу нужна конкретика: сколько позиций");
    assert.equal(
      (captured.payload?.facts as Record<string, unknown>)?.overdueTotal,
      3,
      "факты кладутся для проверки по следам",
    );
  });

  it("две cron-реплики передают Core один stable clientKey согласования", async () => {
    const approvalKeys: string[] = [];
    const { client } = stubCore({
      obligations: async () => ({
        domain: "globerent",
        totals: [],
        overdue: [
          {
            id: "m1",
            amount: "5000000",
            currency: "UZS",
            date: "2026-05-01",
            direction: "in",
            status: "plan",
          },
        ],
        overdueTotal: 1,
        overdueTruncated: false,
      }),
      requestApproval: async (input: { clientKey?: string }) => {
        approvalKeys.push(input.clientKey ?? "");
        return { id: "appr-shared" };
      },
    });
    const occurrence = {
      requestKey: "cron:test-agent:watch-receivables:0 8 * * *:2026-08-29T03:00:00.000Z",
      traceKey: "cron:test-agent:watch-receivables:0 8 * * *",
    };

    await Promise.all([
      runSkill(base, "watch-receivables", client, "T0", undefined, occurrence),
      runSkill(base, "watch-receivables", client, "T0", undefined, occurrence),
    ]);

    assert.equal(approvalKeys.length, 2);
    assert.ok(approvalKeys[0]?.startsWith("agent-approval:"));
    assert.equal(approvalKeys[0], approvalKeys[1]);
  });

  it("lease потерян после ответа навыка — stale generation не создаёт approval/event/memory", async () => {
    const { client, calls } = stubCore({
      obligations: async () => ({
        domain: "globerent",
        totals: [],
        overdue: [
          {
            id: "m1",
            amount: "5000000",
            currency: "UZS",
            date: "2026-05-01",
            direction: "in",
            status: "plan",
          },
        ],
        overdueTotal: 1,
        overdueTruncated: false,
      }),
    });
    let checks = 0;
    const res = await runSkill(base, "watch-receivables", client, "T0", undefined, {
      requestKey: "run-lease-lost",
      assertLease: async () => {
        checks += 1;
        if (checks === 2) throw new LlmLedgerUnavailableError("task lease lost");
      },
    });

    assert.equal(res.outcome, "skipped");
    assert.equal(res.skipReason, "ledger_unavailable");
    assert.deepEqual(calls, ["event"], "после takeover нет побочных записей");
  });

  it("morning-digest: волатильные поля брифинга не ломают дельта-память — повтор той же сводки молчит", async () => {
    // Прод-регрессия (20–23.08): ответ /registry/briefing несёт поля вне типа
    // AgentsBriefing — generatedAt (новый каждый запуск) и pendingApprovals
    // (растёт из-за самих согласований). Пока facts собирались как `{ ...b }`,
    // сигнатура дельта-памяти не совпадала никогда, и владелец получал
    // одинаковое согласование каждый день заново.
    const memory = new Map<string, string>();
    let runNo = 0;
    const { client } = stubCore({
      briefing: async () => {
        runNo += 1;
        return {
          ...EMPTY_BRIEFING,
          overdueMoney: 2,
          idleMachines: 10,
          // Волатильная часть рантайм-ответа: меняется при каждом запуске.
          generatedAt: `2026-08-2${runNo}T02:30:00.000Z`,
          tz: "Asia/Tashkent",
          pendingApprovals: runNo,
        };
      },
      recallMemory: async (source: string, skill: string) =>
        memory.get(`${source}:${skill}`) ?? null,
      rememberMemory: async (source: string, skill: string, sig: string) => {
        memory.set(`${source}:${skill}`, sig);
      },
    });

    const first = await runSkill(base, "morning-digest", client, "T0");
    assert.equal(first.outcome, "approval_requested");
    assert.ok(first.facts, "у предложения должны быть факты");
    assert.equal("generatedAt" in first.facts, false, "волатильное поле не должно попадать в факты");
    assert.equal("pendingApprovals" in first.facts, false, "счётчик согласований растёт из-за самого бага");

    const second = await runSkill(base, "morning-digest", client, "T0");
    assert.equal(second.outcome, "skipped");
    assert.equal(second.skipReason, "no_change", "та же сводка не подаётся повторно");
  });

  it("morning-digest: содержательное изменение (idleMachines 10 → 11) подаётся заново", async () => {
    const memory = new Map<string, string>();
    let idleMachines = 10;
    let runNo = 0;
    const { client } = stubCore({
      briefing: async () => {
        runNo += 1;
        return {
          ...EMPTY_BRIEFING,
          idleMachines,
          generatedAt: `2026-08-2${runNo}T02:30:00.000Z`,
          pendingApprovals: runNo,
        };
      },
      recallMemory: async (source: string, skill: string) =>
        memory.get(`${source}:${skill}`) ?? null,
      rememberMemory: async (source: string, skill: string, sig: string) => {
        memory.set(`${source}:${skill}`, sig);
      },
    });

    const first = await runSkill(base, "morning-digest", client, "T0");
    assert.equal(first.outcome, "approval_requested");

    idleMachines = 11; // повод реально изменился — молчать нельзя
    const changed = await runSkill(base, "morning-digest", client, "T0");
    assert.equal(changed.outcome, "approval_requested");
    assert.equal(changed.facts?.idleMachines, 11);
  });

  it("morning-digest: повод исчез и вернулся — подаётся заново, а не глотается старой памятью", async () => {
    // День 1: автомат X простаивает → согласование, сигнатура запомнена.
    // День 2: всё починено → no_signal; сигнатура подачи обязана затереться.
    // День 5: встал ДРУГОЙ автомат — счётчики совпали со днём 1. Без сброса
    // памяти при no_signal это глоталось бы как no_change (TTL у памяти нет),
    // и владелец не узнал бы о новом инциденте из канала согласований.
    const memory = new Map<string, string>();
    let rememberCount = 0;
    let idleMachines = 1;
    const { client } = stubCore({
      briefing: async () => ({ ...EMPTY_BRIEFING, idleMachines }),
      recallMemory: async (source: string, skill: string) =>
        memory.get(`${source}:${skill}`) ?? null,
      rememberMemory: async (source: string, skill: string, sig: string) => {
        rememberCount += 1;
        memory.set(`${source}:${skill}`, sig);
      },
    });

    const day1 = await runSkill(base, "morning-digest", client, "T0");
    assert.equal(day1.outcome, "approval_requested");
    assert.equal(rememberCount, 1, "после подачи сигнатура запомнена");

    idleMachines = 0; // всё починили — тревог нет
    const day2 = await runSkill(base, "morning-digest", client, "T0");
    assert.equal(day2.skipReason, "no_signal");
    assert.equal(rememberCount, 2, "исчезнувший повод затирает сигнатуру подачи");

    const day3 = await runSkill(base, "morning-digest", client, "T0");
    assert.equal(day3.skipReason, "no_signal");
    assert.equal(rememberCount, 2, "повторная тишина не пишет в журнал заново");

    idleMachines = 1; // сломался ДРУГОЙ автомат — счётчик тот же, что в день 1
    const day5 = await runSkill(base, "morning-digest", client, "T0");
    assert.equal(
      day5.outcome,
      "approval_requested",
      "новый инцидент не должен глотаться устаревшей сигнатурой",
    );
  });

  it("morning-digest: РОТАЦИЯ состава при том же числе (без обнуления) подаётся заново — П1", async () => {
    // Ключевой сценарий #242-хвоста: автомат A починен, ВСТАЛ B — idleMachines
    // ВСЁ ВРЕМЯ 1 (обнуления, что сбросило бы память через no_signal, НЕТ).
    // Без различителя состава сигнатура по счётчику совпала бы → no_change →
    // владелец не узнал бы о новом простое. alarmComposition ловит смену состава.
    const memory = new Map<string, string>();
    let composition = "hash-machine-A";
    const { client } = stubCore({
      briefing: async () => ({
        ...EMPTY_BRIEFING,
        idleMachines: 1,
        // Волатильные поля рантайма — не должны влиять на дедуп.
        generatedAt: `2026-08-3${memory.size}T02:30:00.000Z`,
        pendingApprovals: memory.size,
        alarmComposition: {
          overdueMoney: "",
          idleMachines: composition,
          contractsDueSoon: "",
          overdueTasks: "",
        },
      }),
      recallMemory: async (source: string, skill: string) =>
        memory.get(`${source}:${skill}`) ?? null,
      rememberMemory: async (source: string, skill: string, sig: string) => {
        memory.set(`${source}:${skill}`, sig);
      },
    });

    const first = await runSkill(base, "morning-digest", client, "T0");
    assert.equal(first.outcome, "approval_requested", "первый простой — подаётся");
    // Различитель состава НЕ течёт в отображаемые владельцу facts.
    assert.equal("composition" in (first.facts ?? {}), false, "хеш состава не показываем владельцу");
    assert.equal(first.facts?.idleMachines, 1);

    // Тот же автомат A всё ещё стоит — состав не менялся: молчим.
    const again = await runSkill(base, "morning-digest", client, "T0");
    assert.equal(again.skipReason, "no_change", "тот же состав дважды — дубль подавлен");

    // A починен, встал B: число прежнее (1), но СОСТАВ иной → подаём заново.
    composition = "hash-machine-B";
    const rotated = await runSkill(base, "morning-digest", client, "T0");
    assert.equal(
      rotated.outcome,
      "approval_requested",
      "ротация состава при том же числе обязана подаваться заново",
    );
  });

  it("no_signal без прежней памяти ничего не пишет — тихие дни не плодят события", async () => {
    let rememberCount = 0;
    const { client } = stubCore({
      rememberMemory: async () => {
        rememberCount += 1;
      },
    });
    const first = await runSkill(base, "morning-digest", client, "T0");
    assert.equal(first.skipReason, "no_signal");
    const second = await runSkill(base, "morning-digest", client, "T0");
    assert.equal(second.skipReason, "no_signal");
    assert.equal(rememberCount, 0, "затирать нечего — журнал Core не растёт");
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

  it("поднятый порог НЕ исполняет сам — исполнителя навыка нет, идёт через согласование", async () => {
    // Раньше при T2+ навык возвращал «executed» без реального исполнителя — ложь
    // (аудит P1). Пока исполнителя и проверки результата нет, любое действие —
    // только предложение владельцу, независимо от порога.
    const { client, calls } = stubCore({
      obligations: async () => ({
        domain: "globerent",
        totals: [],
        overdue: [
          {
            id: "m1",
            amount: "1000",
            currency: "UZS",
            date: "2026-05-01",
            direction: "in",
            status: "plan",
          },
        ],
        overdueTotal: 1,
        overdueTruncated: false,
      }),
    });
    const res = await runSkill(base, "watch-receivables", client, "T2");
    assert.equal(res.outcome, "approval_requested");
    assert.match(res.reason, /исполнителя навыка ещё нет/);
    // event(agent.run) → approval → event(agent.action): всё через согласование.
    assert.deepEqual(calls, ["event", "approval", "event"]);
  });

  const OVERDUE = {
    domain: "globerent",
    totals: [],
    overdue: [
      {
        id: "m1",
        amount: "5000000",
        currency: "UZS",
        date: "2026-05-01",
        direction: "in",
        status: "plan",
      },
    ],
    overdueTotal: 1,
    overdueTruncated: false,
  };

  it("исполнитель есть и порог позволяет — исполняет и проверяет, без согласования", async () => {
    const { client, calls } = stubCore({ obligations: async () => OVERDUE });
    // Регистрируем временный исполнитель, подтверждающий результат.
    EXECUTORS["watch-receivables"] = async () => ({
      ok: true,
      detail: "напоминание создано и перечитано",
    });
    try {
      const res = await runSkill(base, "watch-receivables", client, "T2");
      assert.equal(res.outcome, "executed");
      assert.match(res.reason, /исполнено и проверено/);
      // event(agent.run) → event(agent.action): согласования нет — реально исполнено.
      assert.deepEqual(calls, ["event", "event"]);
    } finally {
      delete EXECUTORS["watch-receivables"];
    }
  });

  it("исполнитель не подтвердил результат — не врём, выносим на согласование", async () => {
    const { client, calls } = stubCore({ obligations: async () => OVERDUE });
    EXECUTORS["watch-receivables"] = async () => ({
      ok: false,
      detail: "перечитка эффекта не нашла",
    });
    try {
      const res = await runSkill(base, "watch-receivables", client, "T2");
      assert.equal(res.outcome, "approval_requested");
      // Провал проверки → согласование: run → approval → action.
      assert.deepEqual(calls, ["event", "approval", "event"]);
    } finally {
      delete EXECUTORS["watch-receivables"];
    }
  });

  it("дневной потолок исчерпан — предложение НЕ выносится", async () => {
    const prev = process.env.AGENT_DAILY_ACTION_CAP;
    process.env.AGENT_DAILY_ACTION_CAP = "3";
    try {
      const { client, calls } = stubCore({
        obligations: async () => ({
          domain: "globerent",
          totals: [],
          overdue: [
            {
              id: "m1",
              amount: "5000000",
              currency: "UZS",
              date: "2026-05-01",
              direction: "in",
              status: "plan",
            },
          ],
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
          overdue: [
            {
              id: "m1",
              amount: "5000000",
              currency: "UZS",
              date: "2026-05-01",
              direction: "in",
              status: "plan",
            },
          ],
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

  it("task-mode сохраняет checkpoint до effects и не запускает non-durable executor", async () => {
    const { client, calls } = stubCore({ obligations: async () => OVERDUE });
    const order: string[] = [];
    let executorCalls = 0;
    EXECUTORS["watch-receivables"] = async () => {
      executorCalls += 1;
      order.push("executor");
      return { ok: true, detail: "effect" };
    };
    try {
      const res = await runSkill(base, "watch-receivables", client, "T2", undefined, {
        requestKey: "task:t1:execution:e1",
        traceKey: "task:t1:test",
        assertLease: async () => undefined,
        task: {
          saveCheckpoint: async (checkpoint) => {
            order.push("checkpoint");
            return { id: "cp-1", ...checkpoint };
          },
        },
      });
      assert.deepEqual(order, ["checkpoint"]);
      assert.equal(executorCalls, 0, "executor ждёт отдельного durable outbox");
      assert.deepEqual(calls, [], "approval/event/memory делает только Core commit");
      assert.equal(res.commit?.outcome, "approval_requested");
    } finally {
      delete EXECUTORS["watch-receivables"];
    }
  });

  it("task-mode puts a bounded ownerReport into the visible task result note", async () => {
    const original = SKILLS["watch-receivables"];
    const ownerReport = `Найдено решение\nhttps://github.com/example/repository\n${"x".repeat(2100)}`;
    SKILLS["watch-receivables"] = async () => ({
      action: "Проверить найденное решение",
      facts: { ownerReport },
    });
    try {
      const { client } = stubCore();
      const result = await runSkill(base, "watch-receivables", client, "T0", undefined, {
        requestKey: "task:t1:execution:e1",
        task: {
          saveCheckpoint: async (checkpoint) => ({ id: "cp-report", ...checkpoint }),
        },
      });

      assert.equal(result.commit?.note.length, 2000);
      assert.match(result.commit?.note ?? "", /https:\/\/github\.com\/example\/repository/);
      assert.doesNotMatch(result.commit?.note ?? "", /Вынес на твоё решение/);
    } finally {
      SKILLS["watch-receivables"] = original;
    }
  });

  it("task resume читает durable proposal и не вызывает skill/LLM", async () => {
    const original = SKILLS["watch-receivables"];
    let skillCalls = 0;
    let checkpointWrites = 0;
    SKILLS["watch-receivables"] = async () => {
      skillCalls += 1;
      return null;
    };
    try {
      const { client, calls } = stubCore();
      const res = await runSkill(base, "watch-receivables", client, "T0", undefined, {
        requestKey: "task:t1:execution:e1",
        task: {
          checkpoint: {
            id: "cp-1",
            skill: "watch-receivables",
            kind: "proposal",
            action: "Разобрать долг",
            facts: { overdue: 1 },
          },
          saveCheckpoint: async () => {
            checkpointWrites += 1;
            throw new Error("resume не должен перезаписывать checkpoint");
          },
        },
      });
      assert.equal(skillCalls, 0);
      assert.equal(checkpointWrites, 0);
      assert.deepEqual(calls, []);
      assert.equal(res.commit?.outcome, "approval_requested");
      assert.equal(res.commit?.action, "Разобрать долг");
    } finally {
      SKILLS["watch-receivables"] = original;
    }
  });
});

describe("Навыки агентов, подключённые к Core", () => {
  const agent: AgentDefinition = {
    name: "a",
    business: "vendhub",
    status: "active",
    autonomyDefault: "T1",
    schedule: [],
    skills: [],
    dir: "/tmp",
  };
  const briefing = {
    overdueMoney: 0,
    idleMachines: 0,
    pendingApprovals: 0,
    contractsDueSoon: 0,
    contractsBadDate: 0,
    overdueTasks: 0,
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

  it("monitor-stock: РОТАЦИЯ состава при том же числе меняет ключ дедупа — П1", async () => {
    // A починен, встал B: idleMachines всё время 1 (обнуления, что сбросило бы
    // память через no_signal, нет). Без различителя состава сигнатура совпала бы
    // → no_change → владелец через этот навык не узнал бы о новом простое.
    const coreA = {
      briefing: async () => ({
        ...briefing,
        idleMachines: 1,
        alarmComposition: {
          overdueMoney: "",
          idleMachines: "hash-machine-A",
          contractsDueSoon: "",
          overdueTasks: "",
        },
      }),
    } as never;
    const coreB = {
      briefing: async () => ({
        ...briefing,
        idleMachines: 1,
        alarmComposition: {
          overdueMoney: "",
          idleMachines: "hash-machine-B",
          contractsDueSoon: "",
          overdueTasks: "",
        },
      }),
    } as never;
    const pA = await SKILLS["monitor-stock"](agent, coreA);
    const pB = await SKILLS["monitor-stock"](agent, coreB);
    assert.ok(pA && pB);
    // Хеш состава не течёт в отображаемые владельцу facts.
    assert.equal("composition" in (pA.facts ?? {}), false, "хеш состава не показываем");
    assert.equal(pA.facts.idleMachines, 1);
    // Ключ дедупа меняется при смене состава на том же счётчике.
    assert.notEqual(
      signature(pA.signatureFacts!),
      signature(pB.signatureFacts!),
      "ротация состава при том же числе обязана менять сигнатуру",
    );
  });

  it("monitor-stock: тот же состав → та же сигнатура (дубль подавлен)", async () => {
    const core = {
      briefing: async () => ({
        ...briefing,
        idleMachines: 1,
        alarmComposition: {
          overdueMoney: "",
          idleMachines: "hash-machine-A",
          contractsDueSoon: "",
          overdueTasks: "",
        },
      }),
    } as never;
    const p1 = await SKILLS["monitor-stock"](agent, core);
    const p2 = await SKILLS["monitor-stock"](agent, core);
    assert.ok(p1 && p2);
    assert.equal(signature(p1.signatureFacts!), signature(p2.signatureFacts!));
  });

  it("monitor-stock: старое ядро без alarmComposition → сигнатура по счётчику", async () => {
    const core = { briefing: async () => ({ ...briefing, idleMachines: 2 }) } as never;
    const p = await SKILLS["monitor-stock"](agent, core);
    assert.ok(p);
    // Без alarmComposition signatureFacts откатывается к facts (прежнее поведение).
    assert.equal(signature(p.signatureFacts!), signature({ idleMachines: 2 }));
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
        domain: "globerent",
        totals: [],
        overdue: [
          {
            id: "1",
            amount: "1500000",
            currency: "UZS",
            date: "2026-01-10",
            direction: "in",
            status: "plan",
          },
          {
            id: "2",
            amount: "500000",
            currency: "UZS",
            date: "2026-02-10",
            direction: "in",
            status: "plan",
          },
        ],
        overdueTotal: 250,
        overdueTruncated: true,
      }),
    } as never;
    const p = await SKILLS["watch-receivables"]({ ...agent, business: "globerent" }, core);
    assert.ok(p);
    assert.match(p.action, /250 позиций/);
    assert.match(p.action, /показаны первые 2/, "нельзя выдавать урезанный список за полный");
    assert.equal(p.facts.sum, 2000000);
  });
});

describe("Задачи агента и дневной потолок", () => {
  const agent: AgentDefinition = {
    name: "receivables",
    business: "globerent",
    status: "active",
    autonomyDefault: "T0",
    schedule: [],
    skills: ["watch-receivables"],
    dir: "/tmp",
  };

  /** Обязательство с просрочкой — чтобы навык вынес предложение (proposal ≠ null). */
  const overdue = {
    domain: "globerent",
    totals: [],
    overdue: [
      {
        id: "m1",
        amount: "5000000",
        currency: "UZS",
        date: "2026-05-01",
        direction: "in",
        status: "plan",
      },
    ],
    overdueTotal: 1,
    overdueTruncated: false,
  };

  /** Заглушка Core под durable checkpoint/commit задачи. */
  function stub(over: Record<string, unknown> = {}) {
    const statuses: { id: string; status: string; runId?: string }[] = [];
    const comments: string[] = [];
    const starts: { id: string; input: Record<string, unknown> }[] = [];
    const checkpoints: { id: string; input: Record<string, unknown> }[] = [];
    const commits: { id: string; input: Record<string, unknown> }[] = [];
    const releases: {
      id: string;
      agentName: string;
      runId: string;
      executionAttemptId: string;
      reason?:
        | "budget_denied"
        | "execution_unknown"
        | "workflow_changed"
        | "route_unavailable"
        | "unsupported"
        | "skill_failed";
      detail?: string;
    }[] = [];
    const claims: { id: string; agentName: string; runId: string }[] = [];
    let generation = 0;
    let storedCheckpoint:
      | {
          id: string;
          skill: string;
          kind: "no_signal" | "proposal";
          action?: string;
          facts?: Record<string, unknown>;
          next?: string[];
        }
      | undefined;
    return {
      statuses,
      comments,
      starts,
      checkpoints,
      commits,
      releases,
      claims,
      client: {
        myTasks: async () => [
          { id: "t1", title: "проверь дебиторку", status: "todo", ownerRef: "receivables" },
        ],
        claimAgentTask: async (id: string, agentName: string) => {
          generation += 1;
          const runId = `00000000-0000-4000-8000-${String(generation).padStart(12, "0")}`;
          claims.push({ id, agentName, runId });
          return {
            runId,
            executionAttemptId: "99999999-9999-4999-8999-999999999999",
            generation,
            claimedAt: new Date().toISOString(),
            taskInputHash: "task-input-hash",
            taskInput: { title: "проверь дебиторку" },
            ...(storedCheckpoint ? { checkpoint: storedCheckpoint } : {}),
          };
        },
        startAgentTaskExecution: async (id: string, input: Record<string, unknown>) => {
          starts.push({ id, input });
          return {
            started: true as const,
            replay: generation > 1,
            execution: {
              id: "88888888-8888-4888-8888-888888888888",
              status: storedCheckpoint ? ("ready" as const) : ("active" as const),
              skill: String(input.skill),
              workflowVersion: Number(input.workflowVersion),
              plan: input.plan,
              planHash: "plan-hash",
              ...(storedCheckpoint ? { checkpoint: storedCheckpoint } : {}),
            },
          };
        },
        checkpointAgentTask: async (id: string, input: Record<string, unknown>) => {
          checkpoints.push({ id, input });
          storedCheckpoint = {
            id: "33333333-3333-4333-8333-333333333333",
            skill: String(input.skill),
            kind: input.kind as "no_signal" | "proposal",
            ...(typeof input.action === "string" ? { action: input.action } : {}),
            ...(input.facts && typeof input.facts === "object"
              ? { facts: input.facts as Record<string, unknown> }
              : {}),
            ...(Array.isArray(input.next) ? { next: input.next as string[] } : {}),
          };
          return storedCheckpoint;
        },
        commitAgentTaskOutcome: async (id: string, input: Record<string, unknown>) => {
          commits.push({ id, input });
          return { status: "committed" as const, approvalId: "appr-1", replay: false };
        },
        releaseAgentTask: async (
          id: string,
          agentName: string,
          runId: string,
          executionAttemptId: string,
          reason?:
            | "budget_denied"
            | "execution_unknown"
            | "workflow_changed"
            | "route_unavailable"
            | "unsupported"
            | "skill_failed",
          detail?: string,
        ) => {
          releases.push({
            id,
            agentName,
            runId,
            executionAttemptId,
            ...(reason ? { reason } : {}),
            ...(detail ? { detail } : {}),
          });
          return true;
        },
        heartbeatAgentTask: async () => true,
        setTaskStatus: async (
          id: string,
          status: string,
          _actor: string,
          _note?: string,
          runId?: string,
        ) => {
          statuses.push({ id, status, ...(runId ? { runId } : {}) });
        },
        addTaskComment: async (_id: string, body: string) => {
          comments.push(body);
        },
        recordEvent: async () => undefined,
        requestApproval: async () => ({ id: "appr-1" }),
        countAgentActions: async () => 0,
        obligations: async () => overdue,
        recallMemory: async () => null,
        rememberMemory: async () => undefined,
        ...over,
      } as never,
    };
  }

  it("атомарный Core cap сохраняет checkpoint и не делает второй release", async () => {
    const prev = process.env.AGENT_DAILY_ACTION_CAP;
    process.env.AGENT_DAILY_ACTION_CAP = "3";
    try {
      const { client, statuses, releases, checkpoints } = stub({
        commitAgentTaskOutcome: async () => ({ status: "capped" as const, replay: false }),
      });
      const res = await runAgentTasks(agent, client, "T0");
      assert.equal(res.length, 1);
      assert.equal(res[0].outcome, "skipped");
      assert.match(res[0].note, /потолок действий исчерпан/);
      assert.deepEqual(statuses, [], "worker не меняет task status вне commit");
      assert.equal(checkpoints.length, 1, "proposal должен пережить перенос на новый день");
      assert.equal(releases.length, 0, "Core уже атомарно снял lease и назначил retryAt");
    } finally {
      if (prev === undefined) delete process.env.AGENT_DAILY_ACTION_CAP;
      else process.env.AGENT_DAILY_ACTION_CAP = prev;
    }
  });

  it("пауза после текущей задачи запрещает следующий claim того же poll", async () => {
    let paused = false;
    const { client, claims } = stub({
      myTasks: async () => [
        { id: "t1", title: "проверь дебиторку", status: "todo", ownerRef: "receivables" },
        { id: "t2", title: "проверь дебиторку", status: "todo", ownerRef: "receivables" },
      ],
      commitAgentTaskOutcome: async () => {
        paused = true;
        return { status: "committed" as const, approvalId: "appr-1", replay: false };
      },
    });

    const res = await runAgentTasks(agent, client, "T0", undefined, {
      canClaim: () => !paused,
    });

    assert.deepEqual(
      claims.map((claim) => claim.id),
      ["t1"],
      "после включения паузы worker не должен claim-ить вторую задачу",
    );
    assert.deepEqual(
      res.map((result) => result.taskId),
      ["t1"],
      "уже claim-нутая задача завершилась, новая не началась",
    );
  });

  it("задача без навыка durable-блокируется один раз и не плодит comment/release на poll", async () => {
    const unsupportedAgent = { ...agent, skills: [] };
    const releases: {
      reason?: string;
      detail?: string;
    }[] = [];
    let blocked = false;
    let claimCalls = 0;
    const { client, comments, checkpoints, commits } = stub({
      claimAgentTask: async () => {
        claimCalls += 1;
        if (blocked) return null;
        return {
          runId: "11111111-1111-4111-8111-111111111111",
          executionAttemptId: "22222222-2222-4222-8222-222222222222",
          generation: 1,
          claimedAt: "2026-08-29T10:00:00.000Z",
          taskInput: { title: "проверь дебиторку" },
        };
      },
      releaseAgentTask: async (
        _id: string,
        _agentName: string,
        _runId: string,
        _executionAttemptId: string,
        reason?: string,
        detail?: string,
      ) => {
        releases.push({ ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) });
        blocked = reason === "unsupported";
        return true;
      },
    });

    const first = await runAgentTasks(unsupportedAgent, client, "T0");
    const second = await runAgentTasks(unsupportedAgent, client, "T0");

    assert.equal(first[0]?.outcome, "returned");
    assert.match(first[0]?.note ?? "", /Не умею/);
    assert.equal(second[0]?.outcome, "skipped");
    assert.equal(claimCalls, 2, "список open может содержать blocked задачу");
    assert.deepEqual(releases, [
      {
        reason: "unsupported",
        detail:
          "Не умею это делать. Мои навыки: нет. Уточни или переназначь задачу, затем запусти owner retry.",
      },
    ]);
    assert.deepEqual(comments, [], "отдельный неидемпотентный comment не нужен");
    assert.deepEqual(checkpoints, []);
    assert.deepEqual(commits, []);
  });

  it("явный нереализованный навык — блок с честной причиной, а не подмена подбором (Р-6)", async () => {
    // Заголовок нарочно попадает в HINTS кодового watch-receivables: раньше
    // подбор молча увёл бы задачу в ДРУГОЙ навык, а `task.agent_skill` и deck
    // продолжали бы показывать нажатое имя — отказ был бы невидим.
    const releases: { reason?: string; detail?: string }[] = [];
    let blocked = false;
    const { client, commits } = stub({
      claimAgentTask: async () => {
        if (blocked) return null;
        return {
          runId: "11111111-1111-4111-8111-111111111111",
          executionAttemptId: "22222222-2222-4222-8222-222222222222",
          generation: 1,
          claimedAt: "2026-09-05T10:00:00.000Z",
          taskInput: { title: "проверь дебиторку", agentSkill: "draft-reminder" },
        };
      },
      releaseAgentTask: async (
        _id: string,
        _agentName: string,
        _runId: string,
        _executionAttemptId: string,
        reason?: string,
        detail?: string,
      ) => {
        releases.push({ ...(reason ? { reason } : {}), ...(detail ? { detail } : {}) });
        blocked = reason === "unsupported";
        return true;
      },
    });

    const res = await runAgentTasks(agent, client, "T0");

    assert.equal(res[0]?.outcome, "returned");
    assert.equal(releases[0]?.reason, "unsupported");
    assert.equal(
      releases[0]?.detail,
      "Навык «draft-reminder» задан явно, но не реализован — угадывать не буду. " +
        "Реализованные навыки: watch-receivables. " +
        "Уточни или переназначь задачу, затем запусти owner retry.",
    );
    assert.deepEqual(commits, [], "ни один другой навык не выполнялся");
  });

  it("под потолком — задача проходит: предложение владельцу, задача закрыта", async () => {
    const prev = process.env.AGENT_DAILY_ACTION_CAP;
    process.env.AGENT_DAILY_ACTION_CAP = "5";
    try {
      const { client, statuses, starts, checkpoints, commits } = stub();
      const res = await runAgentTasks(agent, client, "T0");
      assert.equal(res[0].outcome, "proposed");
      assert.deepEqual(statuses, []);
      assert.equal(starts.length, 1, "execution starts before skill checkpoint");
      assert.equal(starts[0]?.input.claimedTaskInputHash, "task-input-hash");
      assert.deepEqual(starts[0]?.input.plan, { version: 1, steps: [] });
      assert.equal(checkpoints.length, 1);
      assert.equal(commits.length, 1);
      assert.equal(commits[0]?.input.outcome, "approval_requested");
    } finally {
      if (prev === undefined) delete process.env.AGENT_DAILY_ACTION_CAP;
      else process.env.AGENT_DAILY_ACTION_CAP = prev;
    }
  });

  it("skill matching uses the atomic claim title, never the stale list title", async () => {
    const watch = SKILLS["watch-receivables"];
    const stock = SKILLS["monitor-stock"];
    const calls: string[] = [];
    SKILLS["watch-receivables"] = async () => {
      calls.push("watch-receivables");
      return null;
    };
    SKILLS["monitor-stock"] = async () => {
      calls.push("monitor-stock");
      return null;
    };
    try {
      const { client, starts } = stub({
        myTasks: async () => [
          { id: "t1", title: "проверь дебиторку", status: "todo", ownerRef: "receivables" },
        ],
        claimAgentTask: async () => ({
          runId: "11111111-1111-4111-8111-111111111111",
          executionAttemptId: "22222222-2222-4222-8222-222222222222",
          generation: 1,
          claimedAt: "2026-08-29T10:00:00.000Z",
          taskInputHash: "current-task-input-hash",
          taskInput: { title: "проверь остатки автоматов" },
        }),
      });
      const dualSkillAgent = {
        ...agent,
        skills: ["watch-receivables", "monitor-stock"],
      };

      await runAgentTasks(dualSkillAgent, client, "T0");

      assert.deepEqual(calls, ["monitor-stock"]);
      assert.equal(starts[0]?.input.skill, "monitor-stock");
    } finally {
      SKILLS["watch-receivables"] = watch;
      SKILLS["monitor-stock"] = stock;
    }
  });

  it("find-solution получает atomic description/domain и immutable snapshot из execution", async () => {
    const original = SKILLS["find-solution"];
    const snapshot = {
      kind: "solution-search-v1",
      payload: { version: 1 },
      hash: "a".repeat(64),
    };
    let calls = 0;
    SKILLS["find-solution"] = async (_agent, _core, context) => {
      calls += 1;
      assert.equal(context?.taskInput?.description, "Найди готовое решение для CRM");
      assert.equal(context?.taskInput?.domain, "vendhub");
      assert.deepEqual(context?.task?.inputSnapshot, snapshot);
      assert.equal(typeof context?.task?.saveInputSnapshot, "function");
      return null;
    };
    try {
      const { client } = stub({
        claimAgentTask: async () => ({
          runId: "11111111-1111-4111-8111-111111111111",
          executionAttemptId: "22222222-2222-4222-8222-222222222222",
          generation: 1,
          claimedAt: "2026-08-29T10:00:00.000Z",
          taskInputHash: "current-task-input-hash",
          taskInput: {
            title: "проверь варианты",
            description: "Найди готовое решение для CRM",
            domain: "vendhub",
          },
          execution: {
            id: "88888888-8888-4888-8888-888888888888",
            status: "active" as const,
            skill: "find-solution",
            workflowVersion: 1,
            plan: {
              version: 1 as const,
              steps: [
                {
                  stepKey: "find-solution:rank",
                  kind: "chat" as const,
                  feature: "find-solution:rank",
                  adapter: "openai-compatible",
                  adapterVersion: 1,
                  endpointProfile: "openai-chat-completions:sha256:test",
                  provider: "openai",
                  models: ["gpt-5.6-sol"],
                },
              ],
            },
            planHash: "plan-hash",
            inputSnapshot: snapshot,
          },
        }),
        startAgentTaskExecution: async (_id: string, input: Record<string, unknown>) => ({
          started: true as const,
          replay: true,
          execution: {
            id: "88888888-8888-4888-8888-888888888888",
            status: "active" as const,
            skill: String(input.skill),
            workflowVersion: Number(input.workflowVersion),
            plan: input.plan,
            planHash: "plan-hash",
            inputSnapshot: snapshot,
          },
        }),
      });
      const solutionScout = { ...agent, name: "solution-scout", skills: ["find-solution"] };

      const result = await runAgentTasks(solutionScout, client, "T0");

      assert.equal(calls, 1);
      assert.equal(result[0]?.outcome, "done");
    } finally {
      if (original === undefined) delete SKILLS["find-solution"];
      else SKILLS["find-solution"] = original;
    }
  });

  it("find-solution off→backoff→on создаёт первый plan без owner retry и workflow_changed", async () => {
    const originalSkill = SKILLS["find-solution"];
    const envKeys = [
      "LLM_ENABLED",
      "LLM_ROUTE",
      "LLM_PROVIDER",
      "LLM_BASE_URL",
      "LLM_API_KEY",
      "LLM_MODEL",
      "LLM_FALLBACK_MODELS",
      "LLM_HTTP_BILLING_MODE",
      "LLM_PRICE_PROVIDER_ID",
    ] as const;
    const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
    const attemptId = "99999999-9999-4999-8999-999999999999";
    const releaseReasons: string[] = [];
    const started: Record<string, unknown>[] = [];
    let clockMs = 0;
    let retryAtMs = 0;
    let generation = 0;

    SKILLS["find-solution"] = async () => null;
    try {
      process.env.LLM_ENABLED = "0";
      const { client } = stub({
        myTasks: async () => [
          {
            id: "t1",
            title: "Найди готовое решение",
            status: "todo",
            ownerRef: "solution-scout",
          },
        ],
        claimAgentTask: async () => {
          if (clockMs < retryAtMs) return null;
          generation += 1;
          return {
            runId: `00000000-0000-4000-8000-${String(generation).padStart(12, "0")}`,
            executionAttemptId: attemptId,
            generation,
            claimedAt: new Date(clockMs).toISOString(),
            taskInputHash: "solution-input-hash",
            taskInput: { title: "Найди готовое решение" },
          };
        },
        releaseAgentTask: async (
          _id: string,
          _agentName: string,
          _runId: string,
          executionAttemptId: string,
          reason?: string,
        ) => {
          assert.equal(executionAttemptId, attemptId);
          if (reason) releaseReasons.push(reason);
          if (reason === "route_unavailable") retryAtMs = clockMs + 60_000;
          return true;
        },
        startAgentTaskExecution: async (_id: string, input: Record<string, unknown>) => {
          started.push(input);
          return {
            started: true as const,
            replay: false,
            execution: {
              id: "88888888-8888-4888-8888-888888888888",
              status: "active" as const,
              skill: String(input.skill),
              workflowVersion: Number(input.workflowVersion),
              plan: input.plan,
              planHash: "plan-hash",
            },
          };
        },
      });
      const scout = { ...agent, name: "solution-scout", skills: ["find-solution"] };

      const routeOff = await runAgentTasks(scout, client, "T0");
      assert.match(routeOff[0]?.note ?? "", /60 секунд/);
      assert.deepEqual(releaseReasons, ["route_unavailable"]);
      assert.equal(started.length, 0, "route off не создаёт empty execution");

      const beforeRetryAt = await runAgentTasks(scout, client, "T0");
      assert.equal(beforeRetryAt[0]?.outcome, "skipped");
      assert.deepEqual(releaseReasons, ["route_unavailable"], "backoff не poll-thrash");

      clockMs = 60_000;
      process.env.LLM_ENABLED = "1";
      process.env.LLM_ROUTE = "openai-api";
      process.env.LLM_PROVIDER = "openai";
      process.env.LLM_BASE_URL = "https://api.openai.com/v1";
      process.env.LLM_API_KEY = "test-key";
      process.env.LLM_MODEL = "gpt-5.6-sol";
      process.env.LLM_FALLBACK_MODELS = "";
      process.env.LLM_HTTP_BILLING_MODE = "metered";
      process.env.LLM_PRICE_PROVIDER_ID = "openai";

      const routeOn = await runAgentTasks(scout, client, "T0");

      assert.equal(routeOn[0]?.outcome, "done");
      assert.equal(started.length, 1);
      assert.equal(started[0]?.executionAttemptId, attemptId, "attempt не ротирован");
      assert.deepEqual(
        (started[0]?.plan as { steps: { stepKey: string }[] }).steps.map((step) => step.stepKey),
        ["find-solution:rank"],
      );
      assert.ok(!releaseReasons.includes("workflow_changed"));
    } finally {
      if (originalSkill === undefined) delete SKILLS["find-solution"];
      else SKILLS["find-solution"] = originalSkill;
      for (const key of envKeys) {
        const value = originalEnv.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("input-hash mismatch блокирует attempt без release stale lease", async () => {
    const { client, statuses, releases, checkpoints } = stub({
      commitAgentTaskOutcome: async () => ({ status: "blocked" as const, replay: false }),
    });
    const res = await runAgentTasks(agent, client, "T0");
    assert.equal(res[0].outcome, "skipped");
    assert.match(res[0].note, /задача изменилась/i);
    assert.equal(checkpoints.length, 1);
    assert.deepEqual(statuses, []);
    assert.deepEqual(releases, []);
  });

  it("LLM budget denial отличается от no_signal и не закрывает поручение", async () => {
    const original = SKILLS["watch-receivables"];
    SKILLS["watch-receivables"] = async () => {
      throw new LlmBudgetDeniedError("pause", "дневной лимит исчерпан", {
        day: "2026-08-29",
        globalCapUsd: 5,
        globalExposureUsd: 5,
        remainingUsd: 0,
      });
    };
    try {
      const { client, statuses, releases } = stub();
      const res = await runAgentTasks(agent, client, "T0");
      assert.equal(res[0].outcome, "skipped");
      assert.match(res[0].note, /LLM-бюджет/);
      assert.ok(!statuses.some((s) => s.status === "done"), "budget denial не равен «повода нет»");
      assert.equal(releases.length, 1, "budget_denied освобождает claim");
      assert.equal(releases[0]?.reason, "budget_denied");
    } finally {
      SKILLS["watch-receivables"] = original;
    }
  });

  it("llm-навык: ответ не по контракту блокирует задачу (skill_failed) до owner retry, а не крутит poll", async () => {
    const original = SKILLS["watch-receivables"];
    SKILLS["watch-receivables"] = async () => {
      throw new LlmSkillInvalidOutputError("ответ модели не по контракту: нет JSON", "Лид горячий, звоните.");
    };
    try {
      const { client, statuses, releases, commits } = stub();
      const res = await runAgentTasks(agent, client, "T0");
      assert.equal(res[0].outcome, "skipped");
      assert.match(res[0].note, /начало ответа: Лид горячий/);
      assert.deepEqual(statuses, [], "задача не закрывается как done — результата нет");
      assert.deepEqual(commits, []);
      assert.equal(releases.length, 1);
      assert.equal(releases[0]?.reason, "skill_failed", "терминальный durable результат воспроизводится — нужен block");
      assert.match(releases[0]?.detail ?? "", /не по контракту/);
    } finally {
      SKILLS["watch-receivables"] = original;
    }
  });

  it("llm-навык: provider rejection тоже skill_failed — без block replay давал бы тот же отказ на каждом poll", async () => {
    const original = SKILLS["watch-receivables"];
    SKILLS["watch-receivables"] = async () => {
      throw new LlmSkillFailedError("провайдер отклонил вызов: 503");
    };
    try {
      const { client, releases } = stub();
      const res = await runAgentTasks(agent, client, "T0");
      assert.equal(res[0].outcome, "skipped");
      assert.equal(releases[0]?.reason, "skill_failed");
      assert.match(releases[0]?.detail ?? "", /503/);
    } finally {
      SKILLS["watch-receivables"] = original;
    }
  });

  it("LLM-ledger unavailable освобождает claim и не закрывает задачу", async () => {
    const original = SKILLS["watch-receivables"];
    SKILLS["watch-receivables"] = async () => {
      throw new LlmLedgerUnavailableError("Core ledger unavailable");
    };
    try {
      const { client, statuses, releases } = stub();
      const res = await runAgentTasks(agent, client, "T0");
      assert.equal(res[0].outcome, "skipped");
      assert.match(res[0].note, /LLM-ledger/);
      assert.deepEqual(statuses, []);
      assert.equal(releases.length, 1);
    } finally {
      SKILLS["watch-receivables"] = original;
    }
  });

  it("закрытый LLM replay блокирует execution attempt до решения владельца", async () => {
    const original = SKILLS["watch-receivables"];
    SKILLS["watch-receivables"] = async () => {
      throw new LlmReplayBlockedError("task:t1:execution:attempt-1");
    };
    try {
      const { client, statuses, releases } = stub();
      const res = await runAgentTasks(agent, client, "T0");
      assert.equal(res[0].outcome, "skipped");
      assert.match(res[0].note, /повтор.*заблокирован/i);
      assert.deepEqual(statuses, []);
      assert.equal(releases.length, 1);
      assert.equal(releases[0]?.reason, "execution_unknown");
    } finally {
      SKILLS["watch-receivables"] = original;
    }
  });

  it("immutable LLM route change blocks with workflow_changed instead of replay loop", async () => {
    const original = SKILLS["watch-receivables"];
    SKILLS["watch-receivables"] = async () => {
      throw new TaskLlmWorkflowChangedError("provider endpoint changed");
    };
    try {
      const { client, statuses, releases } = stub();
      const res = await runAgentTasks(agent, client, "T0");
      assert.equal(res[0].outcome, "skipped");
      assert.match(res[0].note, /workflow.*изменился/i);
      assert.deepEqual(statuses, []);
      assert.equal(releases.length, 1);
      assert.equal(releases[0]?.reason, "workflow_changed");
    } finally {
      SKILLS["watch-receivables"] = original;
    }
  });

  it("проигравший claim не доходит до навыка и LLM", async () => {
    const original = SKILLS["watch-receivables"];
    let skillCalls = 0;
    SKILLS["watch-receivables"] = async () => {
      skillCalls += 1;
      return null;
    };
    try {
      const { client, statuses, releases } = stub({ claimAgentTask: async () => null });
      const res = await runAgentTasks(agent, client, "T0");
      assert.equal(res[0].outcome, "skipped");
      assert.match(res[0].note, /другой worker/);
      assert.equal(skillCalls, 0);
      assert.deepEqual(statuses, []);
      assert.deepEqual(releases, []);
    } finally {
      SKILLS["watch-receivables"] = original;
    }
  });

  it("stale takeover берёт large checkpoint и commit-ит bounded signature без второго вызова навыка/LLM", async () => {
    const original = SKILLS["watch-receivables"];
    const contexts: { requestKey: string; traceKey?: string }[] = [];
    SKILLS["watch-receivables"] = async (_agent, _core, context) => {
      assert.ok(context);
      contexts.push(context);
      return {
        action: "Вынести большой отчёт на решение владельца",
        facts: { ownerReport: "x".repeat(1_000), evidence: { candidates: [1, 2, 3] } },
      };
    };
    try {
      let commitCalls = 0;
      const commitSignatures: string[] = [];
      const { client, checkpoints } = stub({
        commitAgentTaskOutcome: async (_id: string, input: Record<string, unknown>) => {
          commitCalls += 1;
          commitSignatures.push(String(input.memorySignature));
          if (commitCalls === 1) throw new Error("commit response lost");
          return { status: "committed" as const, replay: true };
        },
      });
      await assert.rejects(runAgentTasks(agent, client, "T0"), /commit response lost/);
      const resumed = await runAgentTasks(agent, client, "T0");
      assert.equal(resumed[0]?.outcome, "proposed");
      assert.equal(contexts.length, 1, "resume не вызывает skill implementation");
      assert.equal(
        contexts[0].requestKey,
        "task:t1:execution:99999999-9999-4999-8999-999999999999",
      );
      assert.equal(contexts[0].traceKey, "task:t1:receivables:watch-receivables");
      assert.equal(checkpoints.length, 1, "takeover не перезаписывает checkpoint");
      assert.equal(commitCalls, 2, "потеря commit response разрешает exact replay commit");
      assert.equal(commitSignatures.length, 2);
      assert.equal(commitSignatures[0], commitSignatures[1]);
      assert.match(commitSignatures[0] ?? "", /^sha256:[0-9a-f]{64}$/);
      assert.ok((commitSignatures[0]?.length ?? Infinity) <= 512);
    } finally {
      SKILLS["watch-receivables"] = original;
    }
  });

  it("без потолка (cap=0) задачи идут как раньше", async () => {
    const prev = process.env.AGENT_DAILY_ACTION_CAP;
    delete process.env.AGENT_DAILY_ACTION_CAP;
    try {
      const { client, statuses, commits } = stub();
      const res = await runAgentTasks(agent, client, "T0");
      assert.equal(res[0].outcome, "proposed");
      assert.deepEqual(statuses, []);
      assert.equal(commits.length, 1);
    } finally {
      if (prev !== undefined) process.env.AGENT_DAILY_ACTION_CAP = prev;
    }
  });
});

describe("Дельта-память: не повторяем то же самое предложение", () => {
  const base: AgentDefinition = {
    name: "mem",
    business: "globerent",
    status: "active",
    autonomyDefault: "T0",
    schedule: [],
    skills: ["watch-receivables"],
    dir: "/tmp",
  };
  const OVERDUE = {
    domain: "globerent",
    totals: [],
    overdue: [
      {
        id: "m1",
        amount: "5000000",
        currency: "UZS",
        date: "2026-05-01",
        direction: "in",
        status: "plan",
      },
    ],
    overdueTotal: 1,
    overdueTruncated: false,
  };

  /** Core с управляемой прошлой сигнатурой; ловим, что запомнили и какие вызовы были. */
  function memCore(lastSig: string | null) {
    const remembered: string[] = [];
    const calls: string[] = [];
    return {
      remembered,
      calls,
      client: {
        recordEvent: async () => {
          calls.push("event");
        },
        requestApproval: async () => {
          calls.push("approval");
          return { id: "a1" };
        },
        obligations: async () => OVERDUE,
        countAgentActions: async () => 0,
        recallMemory: async () => lastSig,
        rememberMemory: async (_s: string, _k: string, sig: string) => {
          remembered.push(sig);
        },
      } as never,
    };
  }

  it("первый раз повод новый → подача владельцу + запоминание сигнатуры", async () => {
    const { client, remembered, calls } = memCore(null);
    const res = await runSkill(base, "watch-receivables", client, "T0");
    assert.equal(res.outcome, "approval_requested");
    assert.equal(remembered.length, 1, "после подачи сигнатуру запомнили");
    assert.deepEqual(calls, ["event", "approval", "event"]);
  });

  it("тот же повод второй раз → молчим (no_change), без подачи и без повторного запоминания", async () => {
    // Сигнатуру берём из первого прогона и подаём как «прошлую».
    const first = memCore(null);
    await runSkill(base, "watch-receivables", first.client, "T0");
    const sig = first.remembered[0];

    const second = memCore(sig);
    const res = await runSkill(base, "watch-receivables", second.client, "T0");
    assert.equal(res.outcome, "skipped");
    assert.equal(res.skipReason, "no_change");
    assert.equal(second.remembered.length, 0, "повторно не запоминаем");
    assert.deepEqual(second.calls, ["event"], "только событие о прогоне; ни approval, ни action");
  });

  it("повод изменился → снова подача", async () => {
    const { client } = memCore("СИГНАТУРА-НЕ-СОВПАДАЕТ");
    const res = await runSkill(base, "watch-receivables", client, "T0");
    assert.equal(res.outcome, "approval_requested");
  });

  it("старая raw-сигнатура >512 читается как тот же повод без повторного approval", async () => {
    const original = SKILLS["watch-receivables"];
    const facts = { a: "x".repeat(1_000), b: 2 };
    SKILLS["watch-receivables"] = async () => ({ action: "Проверить", facts });
    try {
      const legacyRaw = JSON.stringify(facts);
      const { client, remembered, calls } = memCore(legacyRaw);
      const res = await runSkill(base, "watch-receivables", client, "T0");

      assert.ok(legacyRaw.length > 512);
      assert.equal(res.outcome, "skipped");
      assert.equal(res.skipReason, "no_change");
      assert.deepEqual(calls, ["event"]);
      assert.deepEqual(remembered, []);
    } finally {
      SKILLS["watch-receivables"] = original;
    }
  });
});

describe("Break-glass — навык всегда через согласование", () => {
  const base: AgentDefinition = {
    name: "bg",
    business: "globerent",
    status: "active",
    autonomyDefault: "T4",
    schedule: [],
    skills: ["watch-receivables"],
    breakGlass: ["watch-receivables"],
    dir: "/tmp",
  };
  const OVERDUE = {
    domain: "globerent",
    totals: [],
    overdue: [
      {
        id: "m1",
        amount: "5000000",
        currency: "UZS",
        date: "2026-05-01",
        direction: "in",
        status: "plan",
      },
    ],
    overdueTotal: 1,
    overdueTruncated: false,
  };
  function core() {
    const calls: string[] = [];
    return {
      calls,
      client: {
        recordEvent: async () => {
          calls.push("event");
        },
        requestApproval: async () => {
          calls.push("approval");
          return { id: "a1" };
        },
        obligations: async () => OVERDUE,
        countAgentActions: async () => 0,
        recallMemory: async () => null,
        rememberMemory: async () => undefined,
      } as never,
    };
  }

  it("даже с исполнителем и разрешающим порогом — идёт на согласование, не исполняется", async () => {
    EXECUTORS["watch-receivables"] = async () => ({ ok: true, detail: "не должно вызваться" });
    try {
      const { client, calls } = core();
      // Порог T4 разрешил бы исполнение, но навык в break-glass.
      const res = await runSkill(base, "watch-receivables", client, "T4");
      assert.equal(res.outcome, "approval_requested");
      assert.match(res.reason, /break-glass/);
      assert.deepEqual(calls, ["event", "approval", "event"]);
    } finally {
      delete EXECUTORS["watch-receivables"];
    }
  });

  it("без break-glass тот же навык исполнился бы", async () => {
    EXECUTORS["watch-receivables"] = async () => ({ ok: true, detail: "исполнено" });
    try {
      const { client } = core();
      const res = await runSkill({ ...base, breakGlass: [] }, "watch-receivables", client, "T4");
      assert.equal(res.outcome, "executed");
    } finally {
      delete EXECUTORS["watch-receivables"];
    }
  });
});
