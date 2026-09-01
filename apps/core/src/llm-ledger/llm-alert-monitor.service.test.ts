import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { event } from "@mydon/db";
import type { LlmLedgerMonitoring } from "@mydon/shared";
import type { RecordEventInput } from "../events/events.service";
import {
  LLM_ALERT_EVENTS,
  LlmAlertMonitorService,
  llmAlertFingerprint,
  llmBudgetAlertState,
  type LlmAlertSnapshot,
} from "./llm-alert-monitor.service";

interface StoredEvent extends RecordEventInput {
  id: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
}

function stand() {
  const rows: StoredEvent[] = [];
  const events = {
    record: async (input: RecordEventInput) => {
      const existing = input.clientKey
        ? rows.find((row) => row.clientKey === input.clientKey)
        : undefined;
      if (existing) return existing;
      const row: StoredEvent = {
        ...input,
        id: `event-${rows.length + 1}`,
        payload: input.payload ?? {},
        occurredAt: input.occurredAt ?? new Date(1_000 + rows.length),
      };
      rows.push(row);
      return row;
    },
    latest: async (filter: { source?: string; type?: string }) =>
      [...rows]
        .reverse()
        .find(
          (row) =>
            (!filter.source || row.source === filter.source) &&
            (!filter.type || row.type === filter.type),
        ),
  };
  const db = {
    select: () => ({
      from: (table: unknown) => {
        assert.equal(table, event);
        return {
          where: async () => rows.map((row) => ({ clientKey: row.clientKey ?? null })),
        };
      },
    }),
  };
  const createService = () => new LlmAlertMonitorService(db as never, {} as never, events as never);
  return { service: createService(), createService, rows };
}

function monitoring(overrides: Partial<LlmLedgerMonitoring> = {}): LlmLedgerMonitoring {
  return {
    generatedAt: "2026-08-31T12:00:00.000Z",
    day: "2026-08-31",
    settlementOutbox: {
      available: true,
      pendingCount: 0,
      retryingCount: 0,
      processingCount: 0,
      deadCount: 0,
      fallbackCount: 0,
      exactCount: 0,
      oldestPendingAt: null,
      nextRetryAt: null,
      maxAttempts: 32,
    },
    budget: {
      globalCapUsd: 10,
      knownCostUsd: 0,
      globalExposureUsd: 0,
      reservedUsd: 0,
      remainingUsd: 10,
    },
    latestCompleted: null,
    stuckReservations: {
      thresholdMinutes: 5,
      count: 0,
      reservedUsd: 0,
      oldestReservedAt: null,
    },
    failuresToday: {
      count: 0,
      providerErrorCount: 0,
      unknownCount: 0,
      last: null,
    },
    openCircuits: [],
    catalogPrice: {
      meteredEnabled: false,
      provider: "openai",
      model: "gpt-5.6-sol",
      hasActivePrice: true,
    },
    ...overrides,
  };
}

function snapshot(overrides: Partial<LlmAlertSnapshot> = {}): LlmAlertSnapshot {
  return {
    generatedAt: new Date("2026-08-31T12:00:00.000Z"),
    monitoring: monitoring(),
    unknownJobs: [],
    unknownSpends: [],
    stuckSpends: [],
    deliveries: [],
    settlementSpool: { available: true, complete: true, unresolvedDeadCount: 0, incidents: [] },
    ...overrides,
  };
}

describe("LLM alert monitor", () => {
  it("срабатывает ровно на 80% и fail-closed молчит при invalid/zero cap", () => {
    const base = monitoring().budget;
    assert.equal(llmBudgetAlertState({ ...base, globalExposureUsd: 7.999999999 }), "below");
    assert.equal(llmBudgetAlertState({ ...base, globalExposureUsd: 8 }), "reached");
    assert.equal(llmBudgetAlertState({ ...base, globalExposureUsd: 10 }), "reached");
    assert.equal(llmBudgetAlertState({ ...base, globalCapUsd: 0 }), "unavailable");
    assert.equal(
      llmBudgetAlertState({ ...base, configError: "invalid", globalExposureUsd: 10 }),
      "unavailable",
    );
  });

  it("покрывает unknown/dead/stuck/circuit/budget без секретов и сырых UUID", async () => {
    const { service, createService, rows } = stand();
    const linkedSpendId = "11111111-1111-4111-8111-111111111111";
    const standaloneSpendId = "22222222-2222-4222-8222-222222222222";
    const circuitSpendId = "33333333-3333-4333-8333-333333333333";
    const secret = "sk-never-enters-event";
    const value = snapshot({
      monitoring: monitoring({
        budget: {
          ...monitoring().budget,
          globalExposureUsd: 8,
          remainingUsd: 2,
        },
        openCircuits: [
          {
            provider: "anthropic",
            openedAt: "2026-08-31T10:00:00.000Z",
            resetsAt: "2026-08-31T19:00:00.000Z",
            reason: "safe",
          },
          {
            provider: "openai",
            openedAt: "2026-08-31T11:00:00.000Z",
            resetsAt: "2026-08-31T19:00:00.000Z",
            reason: "safe",
          },
        ],
      }),
      unknownJobs: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          spendId: linkedSpendId,
          provider: "openai",
          model: "gpt-5.6-sol",
          feature: "coach-review",
          unknownAt: new Date("2026-08-31T11:30:00.000Z"),
          createdAt: new Date("2026-08-31T11:29:00.000Z"),
        },
      ],
      unknownSpends: [
        {
          id: linkedSpendId,
          provider: "openai",
          model: "gpt-5.6-sol",
          consumer: "agents",
          feature: "coach-review",
          metadata: { secret },
          failedAt: new Date("2026-08-31T11:30:00.000Z"),
          createdAt: new Date("2026-08-31T11:29:00.000Z"),
        },
        {
          id: standaloneSpendId,
          provider: "openai",
          model: "gpt-5.6-sol",
          consumer: "bot",
          feature: "assistant",
          metadata: { secret },
          failedAt: new Date("2026-08-31T11:31:00.000Z"),
          createdAt: new Date("2026-08-31T11:30:00.000Z"),
        },
        {
          id: circuitSpendId,
          provider: "anthropic",
          model: "claude-opus-5",
          consumer: "documents",
          feature: "render",
          metadata: { secret, _llmLedger: { circuitOpen: true } },
          failedAt: new Date("2026-08-31T11:32:00.000Z"),
          createdAt: new Date("2026-08-31T11:31:00.000Z"),
        },
      ],
      stuckSpends: [
        {
          id: linkedSpendId,
          reservedUsd: "3.000000000",
          reservedAt: new Date("2026-08-31T10:00:00.000Z"),
          createdAt: new Date("2026-08-31T10:00:00.000Z"),
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          reservedUsd: "2.250000001",
          reservedAt: new Date("2026-08-31T10:01:00.000Z"),
          createdAt: new Date("2026-08-31T10:01:00.000Z"),
        },
      ],
      deliveries: [
        {
          id: "55555555-5555-4555-8555-555555555555",
          destination: "notion-report",
          status: "unknown",
          attempts: 1,
          completedAt: new Date("2026-08-31T11:00:00.000Z"),
          updatedAt: new Date("2026-08-31T11:00:00.000Z"),
          createdAt: new Date("2026-08-31T10:59:00.000Z"),
        },
        {
          id: "66666666-6666-4666-8666-666666666666",
          destination: "notion-report",
          status: "dead",
          attempts: 2,
          completedAt: new Date("2026-08-31T11:01:00.000Z"),
          updatedAt: new Date("2026-08-31T11:01:00.000Z"),
          createdAt: new Date("2026-08-31T11:00:00.000Z"),
        },
      ],
      settlementSpool: {
        available: true,
        complete: true,
        unresolvedDeadCount: 1,
        incidents: [
          {
            fingerprint: "7".repeat(64),
            producer: "bot",
            state: "fallback_stuck",
            recordKind: "fallback",
            operation: "fail",
            category: null,
            occurredAt: "2026-08-31T10:00:00.000Z",
          },
          {
            fingerprint: "8".repeat(64),
            producer: "documents",
            state: "dead",
            recordKind: "exact",
            operation: "settle",
            category: "terminal_close",
            occurredAt: "2026-08-31T10:10:00.000Z",
          },
        ],
      },
    });

    await service.reconcile(value);
    const firstCount = rows.length;
    await service.reconcile(value);
    await createService().reconcile(value);

    assert.equal(
      rows.length,
      firstCount,
      "event.clientKey дедуплицирует и повторный тик, и вторую Core replica",
    );
    assert.equal(rows.filter((row) => row.type === LLM_ALERT_EVENTS.unknown).length, 3);
    assert.equal(rows.filter((row) => row.type === LLM_ALERT_EVENTS.dead).length, 2);
    assert.equal(rows.filter((row) => row.type === LLM_ALERT_EVENTS.stuck).length, 2);
    assert.equal(rows.filter((row) => row.type === LLM_ALERT_EVENTS.circuit).length, 1);
    assert.equal(rows.filter((row) => row.type === LLM_ALERT_EVENTS.budget).length, 1);
    const stuck = rows.find(
      (row) => row.type === LLM_ALERT_EVENTS.stuck && row.payload.kind === "stuck_reservations",
    );
    assert.equal(stuck?.payload.count, 1, "linked unknown job подавил свой reserve");
    assert.equal(stuck?.payload.reservedUsd, 2.250000001);
    assert.match(rows[0]?.clientKey ?? "", /^llm-alert:v1:.+:[a-f0-9]{64}$/);
    assert.doesNotMatch(
      JSON.stringify(rows),
      new RegExp(
        [secret, linkedSpendId, standaloneSpendId, circuitSpendId, "aaaaaaaa-aaaa-4aaa"].join("|"),
      ),
    );
  });

  it("держит stable episode для stuck, даёт recovery только при zero", async () => {
    const { service, rows } = stand();
    const first = snapshot({
      stuckSpends: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          reservedUsd: "1",
          reservedAt: new Date("2026-08-31T10:00:00.000Z"),
          createdAt: new Date("2026-08-31T10:00:00.000Z"),
        },
      ],
    });
    await service.reconcile(first);
    await service.reconcile(
      snapshot({
        stuckSpends: [
          {
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            reservedUsd: "2",
            reservedAt: new Date("2026-08-31T10:05:00.000Z"),
            createdAt: new Date("2026-08-31T10:05:00.000Z"),
          },
        ],
      }),
    );
    assert.equal(
      rows.filter(
        (row) => row.type === LLM_ALERT_EVENTS.stuck && row.payload.kind === "stuck_reservations",
      ).length,
      1,
      "смена состава не спамит, пока агрегат не нулевой",
    );

    await service.reconcile(snapshot());
    const recovery = rows.find(
      (row) => row.type === LLM_ALERT_EVENTS.recovered && row.payload.kind === "stuck_reservations",
    );
    assert.ok(recovery);
    assert.match(String(recovery.payload.fingerprint), /^[a-f0-9]{64}$/);
  });

  it("подавляет linked spend/reserve, даже когда unknown job в другой scan-page", async () => {
    const { service, rows } = stand();
    const spendId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    await service.reconcile(
      snapshot({
        linkedUnknownSpendIds: [spendId],
        unknownSpends: [
          {
            id: spendId,
            provider: "openai",
            model: "gpt-5.6-sol",
            consumer: "agents",
            feature: "coach-review",
            metadata: {},
            failedAt: new Date("2026-08-31T11:00:00.000Z"),
            createdAt: new Date("2026-08-31T10:59:00.000Z"),
          },
        ],
        stuckSpends: [
          {
            id: spendId,
            reservedUsd: "3",
            reservedAt: new Date("2026-08-31T10:00:00.000Z"),
            createdAt: new Date("2026-08-31T10:00:00.000Z"),
          },
        ],
      }),
    );
    assert.deepEqual(rows, []);
  });

  it("не теряет historical unknown после закрытия circuit следующего дня", async () => {
    const { service, rows } = stand();
    await service.reconcile(
      snapshot({
        monitoring: monitoring({ day: "2026-09-01", openCircuits: [] }),
        unknownSpends: [
          {
            id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            provider: "openai",
            model: "gpt-5.6-sol",
            consumer: "agents",
            feature: "coach-review",
            metadata: { _llmLedger: { circuitOpen: true } },
            failedAt: new Date("2026-08-31T23:59:00.000Z"),
            createdAt: new Date("2026-08-31T23:58:00.000Z"),
          },
        ],
      }),
    );
    assert.equal(rows.filter((row) => row.type === LLM_ALERT_EVENTS.unknown).length, 1);
  });

  it("бюджет даёт recovery ниже 80%, но не при invalid config", async () => {
    const { service, rows } = stand();
    await service.reconcile(
      snapshot({
        monitoring: monitoring({
          budget: { ...monitoring().budget, globalExposureUsd: 8, remainingUsd: 2 },
        }),
      }),
    );
    await service.reconcile(
      snapshot({
        monitoring: monitoring({
          budget: {
            ...monitoring().budget,
            globalExposureUsd: 8,
            remainingUsd: 0,
            configError: "invalid",
          },
        }),
      }),
    );
    assert.equal(
      rows.filter((row) => row.type === LLM_ALERT_EVENTS.recovered).length,
      0,
      "invalid cap — не здоровье",
    );

    await service.reconcile(
      snapshot({
        monitoring: monitoring({
          budget: { ...monitoring().budget, globalExposureUsd: 7.5, remainingUsd: 2.5 },
        }),
      }),
    );
    assert.ok(
      rows.some((row) => row.type === LLM_ALERT_EVENTS.recovered && row.payload.kind === "budget"),
    );

    await service.reconcile(
      snapshot({
        monitoring: monitoring({
          budget: { ...monitoring().budget, globalExposureUsd: 8.5, remainingUsd: 1.5 },
        }),
      }),
    );
    assert.equal(
      rows.filter((row) => row.type === LLM_ALERT_EVENTS.budget).length,
      1,
      "бюджетный порог уведомляет не чаще одного раза за ташкентские сутки",
    );
  });

  it("новые сутки открывают новый budget episode без промежуточного below-tick", async () => {
    const { service, rows } = stand();
    await service.reconcile(
      snapshot({
        monitoring: monitoring({
          day: "2026-08-31",
          budget: { ...monitoring().budget, globalExposureUsd: 8, remainingUsd: 2 },
        }),
      }),
    );
    await service.reconcile(
      snapshot({
        monitoring: monitoring({
          day: "2026-09-01",
          budget: { ...monitoring().budget, globalExposureUsd: 9, remainingUsd: 1 },
        }),
      }),
    );

    assert.equal(rows.filter((row) => row.type === LLM_ALERT_EVENTS.budget).length, 2);
  });

  it("новый provider в active circuit даёт update, а unavailable spool не подделывает recovery", async () => {
    const { service, rows } = stand();
    const oneCircuit = monitoring({
      openCircuits: [
        {
          provider: "openai",
          openedAt: "2026-08-31T10:00:00.000Z",
          resetsAt: "2026-08-31T19:00:00.000Z",
          reason: null,
        },
      ],
    });
    const stuckSpool = {
      available: true,
      complete: true,
      unresolvedDeadCount: 0,
      incidents: [
        {
          fingerprint: "9".repeat(64),
          producer: "bot",
          state: "fallback_stuck" as const,
          recordKind: "fallback" as const,
          operation: "fail" as const,
          category: null,
          occurredAt: "2026-08-31T10:00:00.000Z",
        },
      ],
    };
    await service.reconcile(snapshot({ monitoring: oneCircuit, settlementSpool: stuckSpool }));
    await service.reconcile(
      snapshot({
        monitoring: {
          ...oneCircuit,
          openCircuits: [
            ...oneCircuit.openCircuits,
            {
              provider: "anthropic",
              openedAt: "2026-08-31T11:00:00.000Z",
              resetsAt: "2026-08-31T19:00:00.000Z",
              reason: null,
            },
          ],
        },
        settlementSpool: {
          available: false,
          complete: false,
          unresolvedDeadCount: 0,
          incidents: [],
        },
      }),
    );
    assert.equal(rows.filter((row) => row.type === LLM_ALERT_EVENTS.circuit).length, 2);
    assert.equal(
      rows.filter(
        (row) => row.type === LLM_ALERT_EVENTS.recovered && row.payload.kind === "settlement_spool",
      ).length,
      0,
    );

    await service.reconcile(
      snapshot({
        monitoring: oneCircuit,
        settlementSpool: {
          available: true,
          complete: false,
          unresolvedDeadCount: 0,
          incidents: [],
        },
      }),
    );
    assert.equal(
      rows.filter(
        (row) => row.type === LLM_ALERT_EVENTS.recovered && row.payload.kind === "settlement_spool",
      ).length,
      0,
      "неполный snapshot — неизвестное состояние, а не recovery",
    );

    await service.reconcile(
      snapshot({
        monitoring: oneCircuit,
        settlementSpool: {
          available: true,
          complete: true,
          unresolvedDeadCount: 1,
          incidents: [
            {
              fingerprint: "a".repeat(64),
              producer: "bot",
              state: "dead",
              recordKind: "fallback",
              operation: "fail",
              category: "attempts_exhausted",
              occurredAt: "2026-08-31T10:10:00.000Z",
            },
          ],
        },
      }),
    );
    assert.equal(
      rows.filter(
        (row) => row.type === LLM_ALERT_EVENTS.recovered && row.payload.kind === "settlement_spool",
      ).length,
      0,
      "dead требует ручной сверки и не является здоровым spool",
    );

    await service.reconcile(
      snapshot({
        monitoring: monitoring(),
        settlementSpool: {
          available: true,
          complete: true,
          unresolvedDeadCount: 0,
          incidents: [],
        },
      }),
    );
    assert.ok(
      rows.some((row) => row.type === LLM_ALERT_EVENTS.recovered && row.payload.kind === "circuit"),
    );
    assert.ok(
      rows.some(
        (row) => row.type === LLM_ALERT_EVENTS.recovered && row.payload.kind === "settlement_spool",
      ),
    );
  });

  it("fingerprint — SHA-256, а не замаскированный UUID", () => {
    const identity = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const fingerprint = llmAlertFingerprint("unknown-job", identity);
    assert.match(fingerprint, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(fingerprint, /aaaaaaaa/);
  });
});
