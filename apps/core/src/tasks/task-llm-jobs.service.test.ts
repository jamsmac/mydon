/* eslint-disable @typescript-eslint/no-explicit-any */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  agentTaskLlmAuthorization,
  agentTaskLlmJob,
  agentTaskLlmResult,
  auditLog,
  llmSpend,
  task,
  taskAgentExecution,
} from "@mydon/db";
import { inputTokenCeiling } from "@mydon/shared";
import { PgDialect } from "drizzle-orm/pg-core";
import { canonicalJsonHash } from "./task-llm-contract";
import { TaskLlmJobsService } from "./task-llm-jobs.service";
import { durableTaskInputHash } from "./tasks.service";

type Row = Record<string, any>;

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_ID = "33333333-3333-4333-8333-333333333333";
const EXECUTION_ID = "44444444-4444-4444-8444-444444444444";
const TOKEN_A = "55555555-5555-4555-8555-555555555555";
const TOKEN_B = "66666666-6666-4666-8666-666666666666";
const NOW = new Date("2026-08-29T10:15:00.000Z");
const CHAT_PROFILE = `openai-chat-completions:sha256:${"a".repeat(64)}`;

const SYSTEM = "guard";
const USER = "review this";
const PLAN = {
  version: 1,
  steps: [
    {
      stepKey: "coach-review:eval",
      kind: "chat",
      feature: "coach-review:eval",
      adapter: "openai-compatible",
      adapterVersion: 1,
      endpointProfile: CHAT_PROFILE,
      provider: "openai",
      models: ["primary", "fallback"],
    },
  ],
};

interface MemoryState {
  task: Row;
  execution: Row;
  jobs: Row[];
  authorizations: Row[];
  results: Row[];
  spends: Row[];
  audits: Row[];
}

function baseState(): MemoryState {
  const taskRow: Row = {
    id: TASK_ID,
    title: "Review",
    description: "Check agent output",
    ownerKind: "agent",
    ownerRef: "coach",
    domain: null,
    entityId: null,
    priority: "normal",
    due: null,
    source: null,
    createdBy: "owner",
    status: "in_progress",
    agentRunId: RUN_ID,
    agentExecutionAttemptId: ATTEMPT_ID,
    agentRunClaimedAt: NOW,
    agentExecutionRetryAt: null,
    agentExecutionBlockedAt: null,
    agentExecutionBlockedReason: null,
  };
  return {
    task: taskRow,
    execution: {
      id: EXECUTION_ID,
      taskId: TASK_ID,
      executionAttemptId: ATTEMPT_ID,
      agentName: "coach",
      skill: "coach-review",
      schemaVersion: 2,
      taskInputHash: durableTaskInputHash(taskRow as never),
      workflowVersion: 1,
      executionPlan: PLAN,
      executionPlanHash: canonicalJsonHash(PLAN),
      startedAt: NOW,
      checkpointKind: null,
      checkpointPayload: null,
      checkpointHash: null,
      status: "active",
    },
    jobs: [],
    authorizations: [],
    results: [],
    spends: [],
    audits: [],
  };
}

function queryParams(condition: unknown): unknown[] {
  if (!condition) return [];
  try {
    return new PgDialect().sqlToQuery(condition as never).params;
  } catch {
    return [];
  }
}

function matching(rows: Row[], condition: unknown): Row[] {
  const params = queryParams(condition);
  if (params.length === 0) return rows;
  const requestedDay = params.find(
    (value): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value),
  );
  if (requestedDay && rows.some((row) => row.day !== undefined)) {
    rows = rows.filter((row) => row.day === requestedDay);
  }
  const fields = [
    "id",
    "taskId",
    "executionAttemptId",
    "taskAgentExecutionId",
    "stepKey",
    "providerAttemptNo",
    "jobId",
    "day",
    "spendId",
    "requestKey",
    "status",
  ];
  return rows.filter((row) =>
    fields.every((field) => {
      const candidates = rows.map((item) => item[field]).filter((value) => value !== undefined);
      const requested = params.filter((value) => candidates.includes(value));
      return requested.length === 0 || requested.includes(row[field]);
    }),
  );
}

function memoryDb(state: MemoryState) {
  let sequence = 0;
  const rowsFor = (tableRef: unknown): Row[] => {
    if (tableRef === task) return [state.task];
    if (tableRef === taskAgentExecution) return [state.execution];
    if (tableRef === agentTaskLlmJob) return state.jobs;
    if (tableRef === agentTaskLlmAuthorization) return state.authorizations;
    if (tableRef === agentTaskLlmResult) return state.results;
    if (tableRef === llmSpend) return state.spends;
    if (tableRef === auditLog) return state.audits;
    return [];
  };
  const chain = (read: () => Row[]) => {
    let condition: unknown;
    const api: any = {
      where(value: unknown) {
        condition = value;
        return api;
      },
      limit() {
        return api;
      },
      for() {
        return api;
      },
      then(resolve: (rows: Row[]) => unknown, reject?: (reason: unknown) => unknown) {
        return Promise.resolve(matching(read(), condition)).then(resolve, reject);
      },
    };
    return api;
  };
  const tx = {
    select: (_selection?: unknown) => ({
      from: (tableRef: unknown) => chain(() => rowsFor(tableRef)),
    }),
    insert: (tableRef: unknown) => ({
      values: (input: Row) => {
        const row: Row = { id: `row-${++sequence}`, ...input };
        if (tableRef === agentTaskLlmJob) {
          Object.assign(row, {
            spendId: row.spendId ?? null,
            dispatchCount: row.dispatchCount ?? 0,
            dispatchToken: row.dispatchToken ?? null,
            dispatchRunId: row.dispatchRunId ?? null,
            dispatchGrantedAt: row.dispatchGrantedAt ?? null,
            dispatchDeadlineAt: row.dispatchDeadlineAt ?? null,
            unknownAt: row.unknownAt ?? null,
            completedAt: row.completedAt ?? null,
            cancelledAt: row.cancelledAt ?? null,
            lastError: row.lastError ?? null,
          });
          state.jobs.push(row);
        } else if (tableRef === agentTaskLlmAuthorization) state.authorizations.push(row);
        else if (tableRef === agentTaskLlmResult) state.results.push(row);
        else if (tableRef === auditLog) state.audits.push(row);
        const api: any = {
          returning: async () => [row],
          then: (resolve: (rows: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve([row]).then(resolve, reject),
        };
        return api;
      },
    }),
    update: (tableRef: unknown) => ({
      set: (patch: Row) => ({
        where: (condition: unknown) => ({
          returning: async () => {
            const rows = matching(rowsFor(tableRef), condition);
            for (const row of rows) Object.assign(row, patch);
            return rows.map((row) => ({ ...row }));
          },
          then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
            const rows = matching(rowsFor(tableRef), condition);
            for (const row of rows) Object.assign(row, patch);
            return Promise.resolve(undefined).then(resolve, reject);
          },
        }),
      }),
    }),
  };
  return {
    select: tx.select,
    transaction: async <T>(callback: (value: typeof tx) => Promise<T>): Promise<T> => {
      const snapshot = structuredClone(state);
      try {
        return await callback(tx);
      } catch (error) {
        state.task = snapshot.task;
        state.execution = snapshot.execution;
        state.jobs = snapshot.jobs;
        state.authorizations = snapshot.authorizations;
        state.results = snapshot.results;
        state.spends = snapshot.spends;
        state.audits = snapshot.audits;
        throw error;
      }
    },
  } as never;
}

function ensureInput(user = USER) {
  return {
    agentName: "coach",
    runId: RUN_ID,
    executionAttemptId: ATTEMPT_ID,
    stepKey: "coach-review:eval",
    providerAttemptNo: 1,
    kind: "chat" as const,
    feature: "coach-review:eval",
    adapter: "openai-compatible",
    adapterVersion: 1,
    endpointProfile: CHAT_PROFILE,
    provider: "openai",
    model: "primary",
    inputTokenCeiling: inputTokenCeiling(`${SYSTEM}\n\n${user}`),
    outputTokenCeiling: 512,
    requestPayload: {
      model: "primary",
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      max_tokens: 512,
    },
  };
}

function harness(options: { denied?: boolean; spendDay?: string | (() => string) } = {}) {
  const state = baseState();
  let reserveCalls = 0;
  const ledger = {
    reserveInTx: async (
      _tx: unknown,
      dto: Row,
      ledgerOptions?: { requestKeyForDay?: (day: string) => Promise<string> | string },
    ) => {
      reserveCalls += 1;
      const stableDay =
        typeof options.spendDay === "function"
          ? options.spendDay()
          : (options.spendDay ?? "2026-08-29");
      const requestKey = ledgerOptions?.requestKeyForDay
        ? await ledgerOptions.requestKeyForDay(stableDay)
        : String(dto.requestKey);
      dto = { ...dto, requestKey };
      let spend = state.spends.find((row) => row.requestKey === dto.requestKey);
      if (!spend) {
        spend = {
          id: `spend-${state.spends.length + 1}`,
          requestKey: dto.requestKey,
          day: stableDay,
          status: options.denied ? "denied" : "reserved",
        };
        state.spends.push(spend);
      }
      const budget = { day: spend.day, globalCapUsd: 5, globalExposureUsd: 0, remainingUsd: 5 };
      return options.denied
        ? { allowed: false, status: "denied", action: "pause", reason: "budget", budget }
        : {
            allowed: true,
            status: "reserved",
            action: "pause",
            reservation: {
              id: spend.id,
              requestKey: spend.requestKey,
              day: spend.day,
              reservedUsd: 1,
              replay: reserveCalls > 1,
            },
            budget,
          };
    },
    settlements: [] as Row[],
    settleInTx: async (_tx: unknown, id: string, dto: Row) => {
      ledger.settlements.push({ id, ...dto });
      return { status: dto.outcome === "success" ? "settled" : "failed", replay: false };
    },
  };
  const service = new TaskLlmJobsService(memoryDb(state), ledger as never);
  return { state, ledger, service, reserveCalls: () => reserveCalls };
}

describe("durable task LLM job state machine", () => {
  it("ensures one reservation, restores the same dispatch grant and durably replays completion", async () => {
    const { state, ledger, service } = harness();
    const ensured = await service.ensure(TASK_ID, ensureInput(), NOW);
    assert.equal(ensured.status, "ready");
    assert.equal(state.jobs.length, 1);
    assert.equal(state.spends.length, 1);

    const firstClaim = await service.claimDispatch(
      TASK_ID,
      ensured.jobId,
      { agentName: "coach", runId: RUN_ID, executionAttemptId: ATTEMPT_ID, dispatchToken: TOKEN_A },
      NOW,
    );
    assert.equal(firstClaim.granted, true);
    assert.equal(firstClaim.replay, false);
    const replayClaim = await service.claimDispatch(
      TASK_ID,
      ensured.jobId,
      {
        agentName: "coach",
        runId: RUN_ID,
        executionAttemptId: ATTEMPT_ID,
        dispatchToken: TOKEN_A,
      },
      NOW,
    );
    assert.equal(replayClaim.granted, true);
    assert.equal(replayClaim.replay, true);
    await assert.rejects(
      () =>
        service.claimDispatch(
          TASK_ID,
          ensured.jobId,
          {
            agentName: "coach",
            runId: RUN_ID,
            executionAttemptId: ATTEMPT_ID,
            dispatchToken: TOKEN_B,
          },
          NOW,
        ),
      /another token/,
    );

    const completion = {
      dispatchToken: TOKEN_A,
      outcome: "success" as const,
      result: {
        text: "durable",
        resolvedModel: "primary",
        usage: { inputTokens: 10, outputTokens: 2 },
      },
    };
    const completed = await service.complete(TASK_ID, ensured.jobId, completion, NOW);
    assert.equal(completed.status, "succeeded");
    assert.equal(state.results.length, 1);
    assert.equal(ledger.settlements.length, 1);
    assert.equal(state.jobs[0]!.requestPayload, null);
    const replay = await service.complete(TASK_ID, ensured.jobId, completion, NOW);
    assert.equal(replay.replay, true);
    assert.equal(state.results.length, 1);
    assert.equal(ledger.settlements.length, 1);
    await assert.rejects(
      () =>
        service.claimDispatch(TASK_ID, ensured.jobId, {
          agentName: "coach",
          runId: RUN_ID,
          executionAttemptId: ATTEMPT_ID,
          dispatchToken: TOKEN_B,
        }),
      /another token/,
    );
  });

  it("unknown never redispatches but accepts late evidence under the original token", async () => {
    const { state, service } = harness();
    const ensured = await service.ensure(TASK_ID, ensureInput(), NOW);
    await service.claimDispatch(
      TASK_ID,
      ensured.jobId,
      { agentName: "coach", runId: RUN_ID, executionAttemptId: ATTEMPT_ID, dispatchToken: TOKEN_A },
      NOW,
    );
    assert.equal(
      (
        await service.complete(
          TASK_ID,
          ensured.jobId,
          { dispatchToken: TOKEN_A, outcome: "unknown" },
          NOW,
        )
      ).status,
      "unknown",
    );
    assert.equal(state.jobs[0]!.requestPayload, null);
    const claim = await service.claimDispatch(TASK_ID, ensured.jobId, {
      agentName: "coach",
      runId: RUN_ID,
      executionAttemptId: ATTEMPT_ID,
      dispatchToken: TOKEN_A,
    });
    assert.equal(claim.granted, false);
    assert.equal(claim.status, "unknown");

    const late = await service.complete(
      TASK_ID,
      ensured.jobId,
      { dispatchToken: TOKEN_A, outcome: "success", result: { text: "late" } },
      NOW,
    );
    assert.equal(late.status, "succeeded");
  });

  for (const closedStatus of ["done", "cancelled"] as const) {
    it(`late evidence never resurrects a ${closedStatus} task`, async () => {
      const { state, service } = harness();
      const ensured = await service.ensure(TASK_ID, ensureInput(), NOW);
      await service.claimDispatch(
        TASK_ID,
        ensured.jobId,
        {
          agentName: "coach",
          runId: RUN_ID,
          executionAttemptId: ATTEMPT_ID,
          dispatchToken: TOKEN_A,
        },
        NOW,
      );
      await service.complete(
        TASK_ID,
        ensured.jobId,
        { dispatchToken: TOKEN_A, outcome: "unknown" },
        NOW,
      );
      state.task.status = closedStatus;
      state.task.agentRunId = null;
      state.task.agentRunClaimedAt = null;
      state.task.agentExecutionBlockedAt = NOW;
      state.task.agentExecutionBlockedReason = "execution_unknown: awaiting late evidence";

      const late = await service.complete(
        TASK_ID,
        ensured.jobId,
        { dispatchToken: TOKEN_A, outcome: "success", result: { text: "late" } },
        NOW,
      );

      assert.equal(late.status, "succeeded", "late evidence itself remains durable");
      assert.equal(state.task.status, closedStatus, "owner terminal status is authoritative");
      assert.equal(state.task.agentExecutionBlockedReason, "execution_unknown: awaiting late evidence");
    });
  }

  it("late evidence only clears the current todo execution_unknown fence", async () => {
    const { state, service } = harness();
    const ensured = await service.ensure(TASK_ID, ensureInput(), NOW);
    await service.claimDispatch(
      TASK_ID,
      ensured.jobId,
      { agentName: "coach", runId: RUN_ID, executionAttemptId: ATTEMPT_ID, dispatchToken: TOKEN_A },
      NOW,
    );
    await service.complete(
      TASK_ID,
      ensured.jobId,
      { dispatchToken: TOKEN_A, outcome: "unknown" },
      NOW,
    );
    state.task.status = "todo";
    state.task.agentRunId = null;
    state.task.agentRunClaimedAt = null;
    state.task.agentExecutionBlockedAt = NOW;
    state.task.agentExecutionBlockedReason = "execution_unknown: awaiting late evidence";

    await service.complete(
      TASK_ID,
      ensured.jobId,
      { dispatchToken: TOKEN_A, outcome: "success", result: { text: "late" } },
      NOW,
    );

    assert.equal(state.task.status, "todo");
    assert.equal(state.task.agentExecutionBlockedAt, null);
    assert.equal(state.task.agentExecutionBlockedReason, null);
  });

  it("commits expiry before rejecting a different takeover dispatch token", async () => {
    const { state, service } = harness();
    const ensured = await service.ensure(TASK_ID, ensureInput(), NOW);
    await service.claimDispatch(
      TASK_ID,
      ensured.jobId,
      { agentName: "coach", runId: RUN_ID, executionAttemptId: ATTEMPT_ID, dispatchToken: TOKEN_A },
      NOW,
    );
    await assert.rejects(
      () =>
        service.claimDispatch(
          TASK_ID,
          ensured.jobId,
          {
            agentName: "coach",
            runId: RUN_ID,
            executionAttemptId: ATTEMPT_ID,
            dispatchToken: TOKEN_B,
          },
          new Date(NOW.getTime() + 3 * 60_000),
        ),
      /another token/,
    );
    assert.equal(state.jobs[0]?.status, "unknown");
    assert.equal(state.jobs[0]?.requestPayload, null);
  });

  it("persists task blocking before returning operation-hash conflict", async () => {
    const { state, service } = harness();
    await service.ensure(TASK_ID, ensureInput(), NOW);
    await assert.rejects(() => service.ensure(TASK_ID, ensureInput("changed"), NOW), /differs/);
    assert.equal(state.task.agentRunId, null);
    assert.equal(state.task.agentExecutionBlockedAt, NOW);
    assert.match(String(state.task.agentExecutionBlockedReason), /differs/);
  });

  it("replays the authorization-linked spend after a midnight ledger rollover", async () => {
    const { state, service, reserveCalls } = harness({ denied: true, spendDay: "2026-08-30" });
    const first = await service.ensure(TASK_ID, ensureInput(), NOW);
    assert.equal(first.status, "waiting_budget");
    assert.equal(state.authorizations[0]?.day, "2026-08-30");
    const nextDay = new Date("2026-08-29T20:00:00.000Z");
    const replay = await service.ensure(TASK_ID, ensureInput(), nextDay);
    assert.equal(replay.status, "waiting_budget");
    assert.equal(state.spends.length, 1, "same ledger day cannot mint a second denied spend");
    assert.equal(reserveCalls(), 2, "second call exact-replays the linked spend");
  });

  it("uses the ledger-stabilized day when yesterday already has a denial", async () => {
    let ledgerDay = "2026-08-29";
    const { state, service } = harness({ denied: true, spendDay: () => ledgerDay });
    await service.ensure(TASK_ID, ensureInput(), NOW);
    ledgerDay = "2026-08-30";

    const next = await service.ensure(TASK_ID, ensureInput(), NOW);
    assert.equal(next.status, "waiting_budget");
    assert.deepEqual(
      state.authorizations.map((row) => row.day),
      ["2026-08-29", "2026-08-30"],
    );
    assert.equal(state.spends.length, 2, "new ledger day must not replay yesterday's denial");
    assert.match(String(state.spends[1]?.requestKey), /:day:2026-08-30$/);
  });
});
