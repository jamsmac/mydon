import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { AgentsCoreClient } from "./core-client";

/**
 * Таймаут приёма вендинга — отдельный от обычного.
 *
 * 24.08.2026 сбор Ourvend начал падать каждые три часа: `This operation was
 * aborted`, `machines_ok=0`, 16–20 секунд на прогон. Приём слотов у Core —
 * одна транзакция на сотни строк, и после перевода базы на внешний Postgres
 * по TLS (`verify-full`) он перестал укладываться в 10 секунд. Клиент рвал
 * соединение, сбор помечался `failed`, продажи и детектор заливок не
 * запускались вовсе — а Core транзакцию всё же дописывал, и снимки слотов
 * появлялись в базе «сами по себе».
 *
 * Проверяем не «код читает env», а именно СРОК: сколько живёт AbortSignal
 * конкретного вызова. Таймеры подменены — иначе тест ждал бы минуту.
 */

const настоящийFetch = globalThis.fetch;

/**
 * Подмена fetch: запоминает signal и НЕ отвечает никогда — ровно как база,
 * которая ещё пишет транзакцию. Судьбу запроса решает только таймер клиента.
 */
function зависшийFetch(): { сигналы: AbortSignal[] } {
  const сигналы: AbortSignal[] = [];
  globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
    if (init?.signal) сигналы.push(init.signal);
    return new Promise<Response>(() => {});
  }) as typeof globalThis.fetch;
  return { сигналы };
}

afterEach(() => {
  globalThis.fetch = настоящийFetch;
  mock.timers.reset();
});

describe("Клиент агентов к Core: срок ожидания приёма", () => {
  it("обычный вызов по-прежнему обрывается через 10 секунд", async () => {
    // Ослаблять общий таймаут не собирались: зависший «/health» должен
    // отваливаться быстро, иначе агент простаивает на пустом месте.
    const { сигналы } = зависшийFetch();
    mock.timers.enable({ apis: ["setTimeout"] });
    const core = new AgentsCoreClient("http://core");
    void core.health().catch(() => {});
    await Promise.resolve();
    const signal = сигналы[0]!;
    mock.timers.tick(9_999);
    assert.equal(signal.aborted, false);
    mock.timers.tick(1);
    assert.equal(signal.aborted, true, "обычный запрос — 10 секунд, как было");
  });

  it("приём слотов живёт минуту, а не десять секунд (дефолт)", async () => {
    const { сигналы } = зависшийFetch();
    mock.timers.enable({ apis: ["setTimeout"] });
    const core = new AgentsCoreClient("http://core");
    void core.ingestVendingSlots({ machines: [] }).catch(() => {});
    await Promise.resolve();
    const signal = сигналы[0]!;
    mock.timers.tick(10_000);
    assert.equal(
      signal.aborted,
      false,
      "на десятой секунде приём обрывался — из-за этого и падал сбор",
    );
    mock.timers.tick(49_999);
    assert.equal(signal.aborted, false);
    mock.timers.tick(1);
    assert.equal(signal.aborted, true, "но и вечно ждать нельзя: минута — потолок");
  });

  it("приём продаж и детектор заливок ждут столько же", async () => {
    // Оба идут после слотов в том же прогоне и упираются в ту же базу.
    const { сигналы } = зависшийFetch();
    mock.timers.enable({ apis: ["setTimeout"] });
    const core = new AgentsCoreClient("http://core");
    void core
      .ingestVendingSales({
        periodStart: "2026-08-24T00:00:00Z",
        periodEnd: "2026-08-24T04:00:00Z",
        productSales: [],
        machineSales: [],
      })
      .catch(() => {});
    void core.detectRefillEvents(2).catch(() => {});
    await Promise.resolve();
    assert.equal(сигналы.length, 2);
    mock.timers.tick(10_000);
    for (const s of сигналы) assert.equal(s.aborted, false);
    mock.timers.tick(50_000);
    for (const s of сигналы) assert.equal(s.aborted, true);
  });

  it("учётный снапшот П2 ждёт столько же: та же база, перезапись сутками", async () => {
    // `/ourvend/snapshot` кладёт пачку суток, и каждые сутки — это удаление
    // прежних строк по (день, автомат) и запись новых. Догон до 14 дней по
    // всему парку упирается в ту же базу, что и приём слотов; обрыв здесь
    // молча оставляет учётный поток без суток, а паритет — без зелёного дня.
    const { сигналы } = зависшийFetch();
    mock.timers.enable({ apis: ["setTimeout"] });
    const core = new AgentsCoreClient("http://core");
    void core.pushOurvendSnapshot({ sales: [] }).catch(() => {});
    await Promise.resolve();
    const signal = сигналы[0]!;
    mock.timers.tick(10_000);
    assert.equal(signal.aborted, false);
    mock.timers.tick(50_000);
    assert.equal(signal.aborted, true);
  });

  it("срок приёма настраивается: конструктор берёт его четвёртым аргументом (CORE_INGEST_TIMEOUT_MS)", async () => {
    // Парк растёт, а вместе с ним и транзакция приёма. Чинить это выкаткой
    // нового образа — плохой план для аварии в три часа ночи.
    const { сигналы } = зависшийFetch();
    mock.timers.enable({ apis: ["setTimeout"] });
    const core = new AgentsCoreClient("http://core", 10_000, "", 120_000);
    void core.ingestVendingSlots({ machines: [] }).catch(() => {});
    await Promise.resolve();
    const signal = сигналы[0]!;
    mock.timers.tick(60_000);
    assert.equal(signal.aborted, false);
    mock.timers.tick(60_000);
    assert.equal(signal.aborted, true);
  });
});

describe("Клиент durable agent-run", () => {
  it("разделяет assigned/scheduled queues и materialize payload без client key", async () => {
    const requests: { url: URL; body: unknown }[] = [];
    const responses: unknown[] = [[], [], {
      taskId: "task-1",
      clientKey: `agent-schedule:v1:${"a".repeat(64)}`,
      scheduledAt: "2026-08-31T05:00:00.000Z",
      created: true,
      replay: false,
    }];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      requests.push({
        url: new URL(String(url)),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const core = new AgentsCoreClient("http://core");
    await core.myTasks("coach-agent");
    await core.myTasks("coach-agent", "scheduled");
    const ensured = await core.ensureScheduledAgentTask({
      agentName: "coach-agent",
      skill: "coach-review",
      cron: "0 10 * * 1",
      scheduledAt: "2026-08-31T05:00:00.000Z",
    });

    assert.equal(requests[0]!.url.searchParams.get("agentInvocation"), "assigned");
    assert.equal(requests[1]!.url.searchParams.get("agentInvocation"), "scheduled");
    assert.equal(requests[2]!.url.pathname, "/tasks/agent-schedule/ensure");
    assert.deepEqual(requests[2]!.body, {
      agentName: "coach-agent",
      skill: "coach-review",
      cron: "0 10 * * 1",
      scheduledAt: "2026-08-31T05:00:00.000Z",
    });
    assert.equal(ensured.created, true);
  });

  it("claim/release/heartbeat передают Core exact runId", async () => {
    const RUN_ID = "11111111-1111-4111-8111-111111111111";
    const EXECUTION_ID = "22222222-2222-4222-8222-222222222222";
    const requests: { path: string; body: unknown }[] = [];
    const responses = [
      {
        claimed: true,
        runId: RUN_ID,
        executionAttemptId: EXECUTION_ID,
        generation: 3,
        claimedAt: "2026-08-29T10:00:00.000Z",
        taskInput: {
          title: "Найди готовое решение",
          description: "Telegram-бот для квалификации лидов в Узбекистане",
          domain: "mydon",
        },
      },
      { renewed: true },
      { released: true },
      { released: true },
    ];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      requests.push({
        path: new URL(String(url)).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const core = new AgentsCoreClient("http://core");
    assert.deepEqual(await core.claimAgentTask("t1", "receivables"), {
      runId: RUN_ID,
      executionAttemptId: EXECUTION_ID,
      generation: 3,
      claimedAt: "2026-08-29T10:00:00.000Z",
      taskInput: {
        title: "Найди готовое решение",
        description: "Telegram-бот для квалификации лидов в Узбекистане",
        domain: "mydon",
      },
    });
    assert.equal(await core.heartbeatAgentTask("t1", "receivables", RUN_ID), true);
    assert.equal(
      await core.releaseAgentTask(
        "t1",
        "receivables",
        RUN_ID,
        EXECUTION_ID,
        "unsupported",
        "нет навыка",
      ),
      true,
    );
    assert.equal(
      await core.releaseAgentTask(
        "t1",
        "receivables",
        RUN_ID,
        EXECUTION_ID,
        "route_unavailable",
        "find-solution:rank is not configured",
      ),
      true,
    );
    assert.deepEqual(requests, [
      {
        path: "/tasks/t1/agent-run/claim",
        body: { agentName: "receivables", invocation: "assigned" },
      },
      {
        path: "/tasks/t1/agent-run/heartbeat",
        body: { agentName: "receivables", runId: RUN_ID },
      },
      {
        path: "/tasks/t1/agent-run/release",
        body: {
          agentName: "receivables",
          runId: RUN_ID,
          executionAttemptId: EXECUTION_ID,
          reason: "unsupported",
          detail: "нет навыка",
        },
      },
      {
        path: "/tasks/t1/agent-run/release",
        body: {
          agentName: "receivables",
          runId: RUN_ID,
          executionAttemptId: EXECUTION_ID,
          reason: "route_unavailable",
          detail: "find-solution:rank is not configured",
        },
      },
    ]);
  });

  it("fail-closed отклоняет неизвестный domain в atomic task input", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          claimed: true,
          runId: "run-1",
          executionAttemptId: "attempt-1",
          generation: 1,
          claimedAt: "2026-08-29T10:00:00.000Z",
          taskInput: { title: "Найди решение", domain: "external" },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof globalThis.fetch;

    const core = new AgentsCoreClient("http://core");
    await assert.rejects(
      core.claimAgentTask("t1", "solution-scout"),
      /невалидный taskInput\.domain/,
    );
  });

  it("unwrap checkpoint, маппит commit outcomes и обслуживает outbox lease", async () => {
    const RUN_ID = "11111111-1111-4111-8111-111111111111";
    const EXECUTION_ID = "22222222-2222-4222-8222-222222222222";
    const CHECKPOINT_ID = "33333333-3333-4333-8333-333333333333";
    const DELIVERY_ID = "44444444-4444-4444-8444-444444444444";
    const checkpoint = {
      id: CHECKPOINT_ID,
      skill: "watch-receivables",
      kind: "proposal" as const,
      action: "Разобрать долг",
      facts: { overdue: 1 },
    };
    const delivery = {
      id: DELIVERY_ID,
      key: "task:t1:notion",
      destination: "notion-report",
      payload: { report: {} },
      leaseToken: "lease-1",
    };
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const responses: unknown[] = [
      { checkpointed: true, replay: false, checkpoint },
      { committed: true, capped: false, replay: false, status: "done", approvalId: "appr-1" },
      { committed: false, capped: true, replay: false, status: "todo" },
      { committed: false, capped: false, replay: false, status: "blocked" },
      { delivery },
      { id: DELIVERY_ID, status: "sent" },
    ];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      requests.push({
        path: new URL(String(url)).pathname,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      });
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const core = new AgentsCoreClient("http://core");
    assert.deepEqual(
      await core.checkpointAgentTask("t1", {
        agentName: "receivables",
        runId: RUN_ID,
        executionAttemptId: EXECUTION_ID,
        skill: checkpoint.skill,
        kind: checkpoint.kind,
        action: checkpoint.action,
        facts: checkpoint.facts,
      }),
      checkpoint,
    );
    const commitInput = {
      agentName: "receivables",
      runId: RUN_ID,
      executionAttemptId: EXECUTION_ID,
      outcome: "approval_requested" as const,
      note: "Вынес на решение",
      action: checkpoint.action,
      facts: checkpoint.facts,
    };
    assert.deepEqual(await core.commitAgentTaskOutcome("t1", commitInput), {
      status: "committed",
      replay: false,
      approvalId: "appr-1",
    });
    assert.deepEqual(await core.commitAgentTaskOutcome("t1", commitInput), {
      status: "capped",
      replay: false,
    });
    assert.deepEqual(await core.commitAgentTaskOutcome("t1", commitInput), {
      status: "blocked",
      replay: false,
    });
    assert.deepEqual(await core.claimOutbox("notion-report", "agents:test"), delivery);
    await core.completeOutbox(DELIVERY_ID, "lease-1", "sent", { providerRef: "page-1" });

    assert.equal(requests[0]?.path, "/tasks/t1/agent-run/checkpoint");
    assert.equal(requests[1]?.path, "/tasks/t1/agent-run/commit");
    assert.equal(requests[1]?.body.kind, "approval_requested");
    assert.equal("outcome" in (requests[1]?.body ?? {}), false, "wire contract uses kind");
    assert.deepEqual(requests[4], {
      path: "/outbox/claim",
      body: { destination: "notion-report", workerRef: "agents:test" },
    });
    assert.deepEqual(requests[5], {
      path: `/outbox/${DELIVERY_ID}/complete`,
      body: { leaseToken: "lease-1", status: "sent", providerRef: "page-1" },
    });
  });

  it("v3 start/snapshot/ensure/claim/complete передают exact durable provider wire", async () => {
    const plan = {
      version: 1 as const,
      steps: [
        {
          stepKey: "coach-review:eval",
          kind: "chat" as const,
          feature: "coach-review:eval",
          adapter: "openai-compatible",
          adapterVersion: 1,
          endpointProfile: "openai-chat-completions",
          provider: "openai",
          models: ["m1"],
        },
      ],
    };
    const requestPayload = { model: "m1", messages: [{ role: "user", content: "p" }] };
    const requests: { path: string; body: Record<string, unknown> }[] = [];
    const result = {
      kind: "success" as const,
      payload: { text: "done", resolvedModel: "m1" },
      resultHash: "result-hash",
    };
    const inputSnapshot = {
      kind: "solution-search-v1",
      payload: { queries: ["telegram crm language:TypeScript"] },
      hash: "snapshot-hash",
    };
    const responses: unknown[] = [
      {
        started: true,
        replay: false,
        execution: {
          id: "execution-1",
          status: "active",
          skill: "coach-review",
          workflowVersion: 1,
          plan,
          planHash: "plan-hash",
        },
      },
      { snapshotted: true, replay: false, snapshot: inputSnapshot },
      { jobId: "job-1", status: "ready", operationHash: "operation-hash" },
      {
        granted: true,
        replay: false,
        status: "dispatching",
        operationHash: "operation-hash",
        requestPayload,
      },
      { status: "succeeded", replay: false, result },
    ];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      requests.push({
        path: new URL(String(url)).pathname,
        body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
      });
      return new Response(JSON.stringify(responses.shift()), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const core = new AgentsCoreClient("http://core");
    await core.startAgentTaskExecution("t1", {
      agentName: "coach",
      runId: "run-1",
      executionAttemptId: "attempt-1",
      claimedTaskInputHash: "input-hash",
      skill: "coach-review",
      workflowVersion: 1,
      plan,
    });
    assert.deepEqual(
      await core.ensureAgentTaskInputSnapshot("t1", {
        agentName: "coach",
        runId: "run-1",
        executionAttemptId: "attempt-1",
        kind: inputSnapshot.kind,
        payload: inputSnapshot.payload,
      }),
      inputSnapshot,
    );
    await core.ensureAgentTaskLlmJob("t1", {
      agentName: "coach",
      runId: "run-1",
      executionAttemptId: "attempt-1",
      stepKey: "coach-review:eval",
      providerAttemptNo: 1,
      kind: "chat",
      feature: "coach-review:eval",
      adapter: "openai-compatible",
      adapterVersion: 1,
      endpointProfile: "openai-chat-completions",
      provider: "openai",
      model: "m1",
      inputTokenCeiling: 100,
      outputTokenCeiling: 20,
      requestPayload,
    });
    await core.claimAgentTaskLlmDispatch("t1", "job-1", {
      agentName: "coach",
      runId: "run-1",
      executionAttemptId: "attempt-1",
      dispatchToken: "dispatch-1",
    });
    await core.completeAgentTaskLlmJob("t1", "job-1", {
      dispatchToken: "dispatch-1",
      outcome: "success",
      result: { text: "done", resolvedModel: "m1" },
    });

    assert.deepEqual(
      requests.map((request) => request.path),
      [
        "/tasks/t1/agent-run/start",
        "/tasks/t1/agent-run/input-snapshot",
        "/tasks/t1/agent-run/llm-jobs/ensure",
        "/tasks/t1/agent-run/llm-jobs/job-1/claim-dispatch",
        "/tasks/t1/agent-run/llm-jobs/job-1/complete",
      ],
    );
    assert.deepEqual(requests[1]?.body, {
      agentName: "coach",
      runId: "run-1",
      executionAttemptId: "attempt-1",
      kind: "solution-search-v1",
      payload: inputSnapshot.payload,
    });
    assert.deepEqual(requests[3]?.body, {
      agentName: "coach",
      runId: "run-1",
      executionAttemptId: "attempt-1",
      dispatchToken: "dispatch-1",
    });
    assert.deepEqual(requests[4]?.body, {
      dispatchToken: "dispatch-1",
      outcome: "success",
      result: { text: "done", resolvedModel: "m1" },
    });
  });
});

/**
 * Контракт /tasks/ensure-for-day — разбор терпит ОБЕ версии Core.
 *
 * Прод 28.08–02.09.2026: повтор дня старый Core отвечал 201 с ПУСТЫМ телом
 * (`return null` контроллера Nest), `res.json()` падал с «Unexpected end of
 * JSON input», и монитор графиков ТО валился каждый день на всех 19 планах.
 * Выкатка не атомарна, поэтому клиент обязан понимать и старую форму
 * (строка задачи / пустое тело), и новую ({ created, id, task }).
 */
describe("ensureTaskForDay: совместимость со старым и новым Core", () => {
  const ввод = {
    title: "ТО: фильтр — Olma",
    ownerKind: "human" as const,
    domain: "vendhub" as const,
    entityId: "e1",
    due: "2026-08-26T13:00:00.000Z",
    priority: "normal" as const,
    source: "maint:p1",
    dayKey: "2026-08-26",
    createdBy: "agent:maintenance-monitor",
  };

  function ответCore(body: string | null): void {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(body, {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
      )) as typeof globalThis.fetch;
  }

  it("новый Core, повтор дня: { created: false } — монитор считает 0, не падает", async () => {
    ответCore(JSON.stringify({ created: false }));
    const core = new AgentsCoreClient("http://core");
    assert.deepEqual(await core.ensureTaskForDay(ввод), { created: false });
  });

  it("новый Core, первый прогон: { created: true, id, task } → created + taskId", async () => {
    ответCore(JSON.stringify({ created: true, id: "t-1", task: { id: "t-1" } }));
    const core = new AgentsCoreClient("http://core");
    assert.deepEqual(await core.ensureTaskForDay(ввод), { created: true, taskId: "t-1" });
  });

  it("СТАРЫЙ Core, повтор дня: пустое тело НЕ роняет агента — это { created: false }", async () => {
    ответCore(""); // ровно то, что Nest шлёт на return null
    const core = new AgentsCoreClient("http://core");
    assert.deepEqual(await core.ensureTaskForDay(ввод), { created: false });
  });

  it("старый Core, первый прогон: тело — строка задачи → created + taskId", async () => {
    ответCore(JSON.stringify({ id: "t-2", title: "ТО: фильтр — Olma" }));
    const core = new AgentsCoreClient("http://core");
    assert.deepEqual(await core.ensureTaskForDay(ввод), { created: true, taskId: "t-2" });
  });

  it("литеральный null в теле — тоже { created: false }, а не TypeError", async () => {
    ответCore("null");
    const core = new AgentsCoreClient("http://core");
    assert.deepEqual(await core.ensureTaskForDay(ввод), { created: false });
  });
});
