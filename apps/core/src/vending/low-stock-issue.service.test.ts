import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditLog, event, operationalIssue, operationalProjectionState, task } from "@mydon/db";
import { PgDialect } from "drizzle-orm/pg-core";
import type { VendingService } from "./vending.service";
import {
  LowStockIssueService,
  VENDING_LOW_STOCK_ISSUE_KIND,
  VENDING_LOW_STOCK_ISSUE_SOURCE,
  VENDING_LOW_STOCK_ISSUES_OPENED_EVENT,
  VENDING_LOW_STOCK_ISSUES_RESOLVED_EVENT,
  lowStockIssueDue,
  lowStockIssueFingerprint,
  lowStockIssueObservations,
  planLowStockIssues,
  type ExistingLowStockIssue,
  type LowStockIssueObservation,
  type LowStockIssueReport,
} from "./low-stock-issue.service";

type Row = Record<string, unknown>;

interface MemoryState {
  tasks: Row[];
  issues: Row[];
  events: Row[];
  audits: Row[];
  projections: Row[];
}

function conditionParams(condition: unknown): unknown[] {
  try {
    return new PgDialect().sqlToQuery(condition as never).params;
  } catch {
    return [];
  }
}

function rowsMatching(rows: Row[], condition: unknown, tableRef?: unknown): Row[] {
  const params = conditionParams(condition);
  let selected = rows;
  if (tableRef === task && params.includes("low_stock:%")) {
    selected = selected.filter(
      (row) =>
        typeof row.source === "string" &&
        row.source.startsWith("low_stock:") &&
        (row.status === "todo" || row.status === "in_progress"),
    );
  }
  const requestedId = params.find((value) => selected.some((row) => row.id === value));
  return requestedId === undefined ? selected : selected.filter((row) => row.id === requestedId);
}

function memoryDb(state: MemoryState) {
  let sequence = 0;
  const rowsFor = (tableRef: unknown): Row[] => {
    if (tableRef === task) return state.tasks;
    if (tableRef === operationalIssue) return state.issues;
    if (tableRef === event) return state.events;
    if (tableRef === auditLog) return state.audits;
    if (tableRef === operationalProjectionState) return state.projections;
    return [];
  };
  const selectedIssues = (): Row[] =>
    state.issues.map((issue) => {
      const linked = state.tasks.find((candidate) => candidate.id === issue.taskId);
      if (!linked) throw new Error("orphan operational issue in fixture");
      return {
        id: issue.id,
        taskId: issue.taskId,
        taskTitle: linked.title,
        kind: issue.kind,
        fingerprint: issue.fingerprint,
        scopeKey: issue.scopeKey,
        status: issue.status,
        episode: issue.episode,
        taskStatus: linked.status,
        taskOwnerKind: linked.ownerKind,
        taskOwnerRef: linked.ownerRef,
        payload: issue.payload,
      };
    });
  const selectChain = (tableRef: unknown, read: () => Row[]) => {
    let condition: unknown;
    const api = {
      innerJoin: (_table: unknown, _on: unknown) => api,
      where: (value: unknown) => {
        condition = value;
        return api;
      },
      for: (_mode: string) => api,
      then: (resolve: (rows: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rowsMatching(read(), condition, tableRef)).then(resolve, reject),
    };
    return api;
  };
  const tx = {
    execute: async (_query: unknown) => [],
    select: (_selection?: unknown) => ({
      from: (tableRef: unknown) =>
        selectChain(
          tableRef,
          tableRef === operationalIssue ? selectedIssues : () => rowsFor(tableRef),
        ),
    }),
    insert: (tableRef: unknown) => ({
      values: (input: Row) => {
        const row: Row = { id: `memory-${++sequence}`, ...input };
        if (tableRef === task) {
          Object.assign(row, {
            description: row.description ?? null,
            ownerRef: row.ownerRef ?? null,
            entityId: row.entityId ?? null,
            status: row.status ?? "todo",
            completedAt: row.completedAt ?? null,
            closedBy: row.closedBy ?? null,
            confirmedAt: row.confirmedAt ?? null,
            confirmedBy: row.confirmedBy ?? null,
            resultNote: row.resultNote ?? null,
            quality: row.quality ?? null,
            remindedAt: row.remindedAt ?? null,
            redoNotifiedAt: row.redoNotifiedAt ?? null,
            assignNotifiedAt: row.assignNotifiedAt ?? null,
            createdAt: row.createdAt ?? new Date(),
          });
        }
        if (tableRef !== operationalProjectionState) rowsFor(tableRef).push(row);
        const api = {
          returning: async (_selection?: unknown) => [row],
          onConflictDoNothing: async (_config?: unknown) => undefined,
          onConflictDoUpdate: async (config: { set?: Row }) => {
            if (tableRef !== operationalProjectionState) return undefined;
            const found = state.projections.find((candidate) => candidate.key === row.key);
            if (found) Object.assign(found, config.set ?? row);
            else state.projections.push(row);
            return undefined;
          },
          then: (resolve: (rows: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
            Promise.resolve([row]).then(resolve, reject),
        };
        return api;
      },
    }),
    update: (tableRef: unknown) => ({
      set: (patch: Row) => ({
        where: (condition: unknown) => ({
          then: (resolve: (value: undefined) => unknown, reject?: (reason: unknown) => unknown) => {
            for (const row of rowsMatching(rowsFor(tableRef), condition, tableRef))
              Object.assign(row, patch);
            return Promise.resolve(undefined).then(resolve, reject);
          },
        }),
      }),
    }),
  };
  return {
    transaction: async <T>(callback: (value: typeof tx) => Promise<T>): Promise<T> => callback(tx),
  } as never;
}

function vendingIndex(mapped = true): VendingService {
  return {
    machineIndex: async () => ({
      idBySerial: new Map(mapped ? [["2508160376", "machine-1"]] : []),
      firstIdBySerial: new Map(mapped ? [["2508160376", "machine-1"]] : []),
      nameBySerial: new Map(mapped ? [["2508160376", "Olma"]] : []),
    }),
  } as unknown as VendingService;
}

function report(overrides: Partial<LowStockIssueReport> = {}): LowStockIssueReport {
  return {
    items: [],
    coverage: { authoritativeSerials: [], inactiveSerials: [] },
    ...overrides,
  };
}

function low(serial = "2508160376", product = "Twix", left = 1, capacity = 10) {
  return { serial, product, productKey: product, left, capacity };
}

function existing(
  observation: LowStockIssueObservation,
  overrides: Partial<ExistingLowStockIssue> = {},
): ExistingLowStockIssue {
  return {
    id: `issue-${observation.fingerprint.slice(0, 8)}`,
    taskId: `task-${observation.fingerprint.slice(0, 8)}`,
    taskTitle: "Пополнить автомат",
    kind: VENDING_LOW_STOCK_ISSUE_KIND,
    fingerprint: observation.fingerprint,
    scopeKey: observation.scopeKey,
    status: "open",
    episode: 1,
    taskStatus: "todo",
    taskOwnerKind: "human",
    taskOwnerRef: null,
    payload: observation.payload,
    ...overrides,
  };
}

describe("LowStockIssueService: stable machine lifecycle", () => {
  it("groups products into one stable machine identity independent of day, left and product set", () => {
    const first = lowStockIssueObservations(
      [low(" C2508160376 ", " Red   Bull ", 1, 10), low("2508160376", "Twix", 0, 20)],
      "2026-08-30",
    )[0];
    const later = lowStockIssueObservations([low("2508160376", "Twix", 1, 20)], "2026-08-31")[0];
    assert.ok(first && later);
    assert.equal(first.scopeKey, "2508160376");
    assert.equal(first.fingerprint, later.fingerprint);
    assert.equal(first.fingerprint, lowStockIssueFingerprint("c2508160376"));
    assert.deepEqual(
      first.items.map((item) => item.productKey),
      ["red bull", "twix"],
    );
    assert.equal(first.items[0]?.coverageKey, "2508160376|red bull");
  });

  it("uses last canonical product observation and rejects unusable identities/numbers", () => {
    const [observation] = lowStockIssueObservations(
      [low("A", "Water", 1, 10), { ...low("a", "WATER", 0, 20), productKey: " water " }],
      "2026-08-31",
    );
    assert.equal(observation?.items.length, 1);
    assert.deepEqual(observation?.items[0], {
      coverageKey: "a|water",
      productKey: "water",
      product: "WATER",
      left: 0,
      capacity: 20,
    });
    assert.throws(() => lowStockIssueObservations([low(" ")], "2026-08-31"), /serial/);
    assert.throws(
      () => lowStockIssueObservations([{ ...low(), left: Number.NaN }], "2026-08-31"),
      /non-finite/,
    );
  });

  it("plans create, refresh, reopen, authoritative resolve, inactive resolve and unknown retain", () => {
    const byScope = new Map(
      lowStockIssueObservations(
        ["A", "B", "C", "D", "E", "F"].map((serial) => low(serial)),
        "2026-08-31",
      ).map((observation) => [observation.scopeKey, observation]),
    );
    const created = byScope.get("a");
    const refreshed = byScope.get("b");
    const manuallyClosed = byScope.get("c");
    const healthy = byScope.get("d");
    const inactive = byScope.get("e");
    const unknown = byScope.get("f");
    assert.ok(created && refreshed && manuallyClosed && healthy && inactive && unknown);
    const plan = planLowStockIssues(
      [created, refreshed, manuallyClosed],
      [
        existing(refreshed),
        existing(manuallyClosed, { taskStatus: "done" }),
        existing(healthy),
        existing(inactive),
        existing(unknown),
      ],
      { authoritativeSerials: ["d"], inactiveSerials: ["E"] },
    );
    assert.deepEqual(
      plan.create.map((item) => item.scopeKey),
      ["a"],
    );
    assert.deepEqual(
      plan.refresh.map((item) => item.issue.scopeKey),
      ["b"],
    );
    assert.deepEqual(
      plan.reopen.map((item) => item.issue.scopeKey),
      ["c"],
    );
    assert.deepEqual(plan.resolve.map((item) => [item.issue.scopeKey, item.reason]).sort(), [
      ["d", "healthy"],
      ["e", "inactive"],
    ]);
    assert.deepEqual(
      plan.retained.map((item) => item.scopeKey),
      ["f"],
    );
  });

  it("inactive registry state wins over a stale positive observation", () => {
    const [observation] = lowStockIssueObservations([low("A")], "2026-08-31");
    assert.ok(observation);
    const plan = planLowStockIssues([observation], [existing(observation)], {
      authoritativeSerials: [],
      inactiveSerials: ["a"],
    });
    assert.equal(plan.refresh.length, 0);
    assert.equal(plan.resolve[0]?.reason, "inactive");
  });

  it("only drops disappeared product details under authoritative machine coverage", () => {
    const [previous] = lowStockIssueObservations(
      [low("A", "Cola"), low("A", "Water")],
      "2026-08-30",
    );
    const [current] = lowStockIssueObservations([low("A", "Water", 0)], "2026-08-31");
    assert.ok(previous && current);
    const partial = planLowStockIssues([current], [existing(previous)], {
      authoritativeSerials: [],
      inactiveSerials: [],
    });
    assert.deepEqual(
      partial.refresh[0]?.observation.items.map((item) => item.productKey),
      ["cola", "water"],
    );
    const full = planLowStockIssues([current], [existing(previous)], {
      authoritativeSerials: ["A"],
      inactiveSerials: [],
    });
    assert.deepEqual(
      full.refresh[0]?.observation.items.map((item) => item.productKey),
      ["water"],
    );
  });

  it("sets due to next 10:00 Asia/Tashkent", () => {
    assert.equal(
      lowStockIssueDue(new Date("2026-08-30T20:30:00.000Z")).toISOString(),
      "2026-09-01T05:00:00.000Z",
    );
  });

  it("timestamps transition events at write time, not at the older scan watermark", async () => {
    const state: MemoryState = { tasks: [], issues: [], events: [], audits: [], projections: [] };
    const service = new LowStockIssueService(memoryDb(state), vendingIndex());
    const current = report({
      items: [low()],
      coverage: { authoritativeSerials: ["2508160376"], inactiveSerials: [] },
    });

    const openedBefore = Date.now();
    await service.reconcile(current, new Date("2000-01-01T00:00:00.000Z"));
    const openedAfter = Date.now();
    const openedAt = state.events[0]?.occurredAt;
    assert.ok(openedAt instanceof Date);
    assert.ok(openedAt.getTime() >= openedBefore && openedAt.getTime() <= openedAfter);

    const resolvedBefore = Date.now();
    await service.reconcile(
      report({ coverage: { authoritativeSerials: ["2508160376"], inactiveSerials: [] } }),
      new Date("2000-01-02T00:00:00.000Z"),
    );
    const resolvedAfter = Date.now();
    const resolvedAt = state.events.at(-1)?.occurredAt;
    assert.ok(resolvedAt instanceof Date);
    assert.ok(resolvedAt.getTime() >= resolvedBefore && resolvedAt.getTime() <= resolvedAfter);
  });

  it("creates, refreshes, reopens, resolves and recurs on the same task", async () => {
    const state: MemoryState = { tasks: [], issues: [], events: [], audits: [], projections: [] };
    const service = new LowStockIssueService(memoryDb(state), vendingIndex());
    const firstAt = new Date("2026-08-31T03:35:00.000Z");
    const current = report({
      items: [low("c2508160376", "Twix", 1, 20), low("2508160376", "Cola", 0, 10)],
      coverage: { authoritativeSerials: ["2508160376"], inactiveSerials: [] },
    });

    assert.deepEqual(await service.reconcile(current, firstAt), {
      observed: 1,
      created: 1,
      adopted: 0,
      consolidated: 0,
      reopened: 0,
      resolved: 0,
      unchanged: 0,
      retained: 0,
      staleSkipped: false,
    });
    assert.equal(state.tasks.length, 1);
    assert.equal(state.issues.length, 1);
    assert.equal(state.tasks[0]?.title, "Пополнить Olma: заканчивается товар");
    assert.equal(state.tasks[0]?.entityId, "machine-1");
    assert.equal(state.tasks[0]?.domain, "vendhub");
    assert.equal(state.tasks[0]?.source, VENDING_LOW_STOCK_ISSUE_SOURCE);
    assert.equal(state.events[0]?.type, VENDING_LOW_STOCK_ISSUES_OPENED_EVENT);

    const changed = report({
      items: [low("2508160376", "Twix", 0, 20)],
      coverage: { authoritativeSerials: ["2508160376"], inactiveSerials: [] },
    });
    const refreshed = await service.reconcile(changed, new Date("2026-08-31T03:40:00.000Z"));
    assert.equal(refreshed.unchanged, 1);
    assert.equal(state.tasks.length, 1);
    assert.match(String(state.tasks[0]?.description), /Twix/);
    assert.doesNotMatch(String(state.tasks[0]?.description), /Cola/);
    assert.equal(state.events.length, 1, "refresh does not emit a new transition alert");

    Object.assign(state.tasks[0]!, {
      status: "done",
      ownerKind: "human",
      ownerRef: "person-1",
      completedAt: firstAt,
      closedBy: "owner",
      confirmedAt: firstAt,
      confirmedBy: "owner",
      resultNote: "done",
      quality: "excellent",
      agentRunId: "stale-run",
    });
    const reopened = await service.reconcile(changed, new Date("2026-08-31T03:45:00.000Z"));
    assert.equal(reopened.reopened, 1);
    assert.equal(state.tasks[0]?.id, state.issues[0]?.taskId);
    assert.equal(state.tasks[0]?.status, "todo");
    assert.equal(state.tasks[0]?.ownerRef, "person-1", "human field assignment survives reopen");
    assert.equal(state.tasks[0]?.completedAt, null);
    assert.equal(state.tasks[0]?.agentRunId, null);
    assert.equal(state.issues[0]?.episode, 2);

    const clean = report({
      coverage: { authoritativeSerials: ["2508160376"], inactiveSerials: [] },
    });
    const resolvedAt = new Date("2026-08-31T03:50:00.000Z");
    const resolved = await service.reconcile(clean, resolvedAt);
    assert.equal(resolved.resolved, 1);
    assert.equal(state.tasks[0]?.status, "done");
    assert.equal(state.tasks[0]?.confirmedAt, resolvedAt);
    assert.equal(state.tasks[0]?.quality, "accepted");
    assert.equal(state.issues[0]?.status, "resolved");
    assert.equal(state.events.at(-1)?.type, VENDING_LOW_STOCK_ISSUES_RESOLVED_EVENT);

    const recurred = await service.reconcile(current, new Date("2026-08-31T03:55:00.000Z"));
    assert.equal(recurred.reopened, 1);
    assert.equal(state.tasks.length, 1);
    assert.equal(state.issues.length, 1);
    assert.equal(state.issues[0]?.episode, 3);
    assert.equal(state.tasks[0]?.status, "todo");
  });

  it("retains an open task when current machine coverage is missing", async () => {
    const state: MemoryState = { tasks: [], issues: [], events: [], audits: [], projections: [] };
    const service = new LowStockIssueService(memoryDb(state), vendingIndex());
    await service.reconcile(report({ items: [low()] }), new Date("2026-08-31T03:35:00.000Z"));
    const retained = await service.reconcile(report(), new Date("2026-08-31T03:40:00.000Z"));
    assert.equal(retained.retained, 1);
    assert.equal(retained.resolved, 0);
    assert.equal(state.tasks[0]?.status, "todo");
    assert.equal(state.issues[0]?.status, "open");
  });

  it("adopts the best legacy task and cancels its duplicates idempotently", async () => {
    const state: MemoryState = {
      tasks: [
        {
          id: "legacy-old",
          title: "Old",
          description: "old",
          ownerKind: "human",
          ownerRef: null,
          domain: "vendhub",
          entityId: "machine-1",
          status: "todo",
          source: "low_stock:2508160376:2026-08-28",
          createdBy: "task-bridge",
          createdAt: new Date("2026-08-28T01:00:00.000Z"),
        },
        {
          id: "legacy-assigned",
          title: "Assigned",
          description: "assigned",
          ownerKind: "human",
          ownerRef: "person-1",
          domain: "vendhub",
          entityId: "machine-1",
          status: "todo",
          source: "low_stock:2508160376:2026-08-29",
          createdBy: "task-bridge",
          createdAt: new Date("2026-08-29T01:00:00.000Z"),
        },
        {
          id: "legacy-progress",
          title: "Progress",
          description: "progress",
          ownerKind: "human",
          ownerRef: "person-2",
          domain: "vendhub",
          entityId: "machine-1",
          status: "in_progress",
          source: "low_stock:2508160376:2026-08-30",
          createdBy: "task-bridge",
          createdAt: new Date("2026-08-30T01:00:00.000Z"),
        },
      ],
      issues: [],
      events: [],
      audits: [],
      projections: [],
    };
    const service = new LowStockIssueService(memoryDb(state), vendingIndex());
    const current = report({
      items: [low()],
      coverage: { authoritativeSerials: ["2508160376"], inactiveSerials: [] },
    });
    const adopted = await service.reconcile(current, new Date("2026-08-31T03:35:00.000Z"));
    assert.equal(adopted.adopted, 1);
    assert.equal(adopted.consolidated, 2);
    assert.equal(adopted.created, 0, "existing user task is reused rather than replaced");
    assert.equal(
      state.issues[0]?.taskId,
      "legacy-progress",
      "in-progress work wins legacy selection",
    );
    assert.equal(
      state.tasks.find((row) => row.id === "legacy-progress")?.source,
      VENDING_LOW_STOCK_ISSUE_SOURCE,
    );
    assert.equal(state.tasks.find((row) => row.id === "legacy-progress")?.status, "in_progress");
    for (const id of ["legacy-old", "legacy-assigned"]) {
      const duplicate = state.tasks.find((row) => row.id === id);
      assert.equal(duplicate?.status, "cancelled");
      assert.match(String(duplicate?.resultNote), /legacy-progress/);
    }
    assert.equal(
      state.audits.filter((row) => row.action === "vending.low_stock_issue.duplicate_cancelled")
        .length,
      2,
    );

    const replay = await service.reconcile(current, new Date("2026-08-31T03:40:00.000Z"));
    assert.equal(replay.adopted, 0);
    assert.equal(replay.consolidated, 0);
    assert.equal(state.issues.length, 1);
    assert.equal(state.tasks.length, 3);
  });

  it("does not adopt user or inconsistent tasks with a legacy-looking source", async () => {
    const state: MemoryState = {
      tasks: [
        {
          id: "manual-lookalike",
          title: "Manual",
          description: null,
          ownerKind: "human",
          ownerRef: null,
          domain: "vendhub",
          entityId: "machine-1",
          status: "todo",
          source: "low_stock:2508160376:2026-08-27",
          createdBy: "owner",
          createdAt: new Date("2026-08-27T01:00:00.000Z"),
        },
        {
          id: "wrong-domain",
          title: "Wrong domain",
          description: null,
          ownerKind: "human",
          ownerRef: null,
          domain: "mydon",
          entityId: "machine-1",
          status: "todo",
          source: "low_stock:2508160376:2026-08-28",
          createdBy: "task-bridge",
          createdAt: new Date("2026-08-28T01:00:00.000Z"),
        },
        {
          id: "wrong-entity",
          title: "Wrong entity",
          description: null,
          ownerKind: "human",
          ownerRef: null,
          domain: "vendhub",
          entityId: "machine-2",
          status: "todo",
          source: "low_stock:2508160376:2026-08-29",
          createdBy: "task-bridge",
          createdAt: new Date("2026-08-29T01:00:00.000Z"),
        },
        {
          id: "agent-owned",
          title: "Agent task",
          description: null,
          ownerKind: "agent",
          ownerRef: "vendhub-ops",
          domain: "vendhub",
          entityId: "machine-1",
          status: "in_progress",
          source: "low_stock:2508160376:2026-08-30",
          createdBy: "task-bridge",
          createdAt: new Date("2026-08-30T01:00:00.000Z"),
        },
      ],
      issues: [],
      events: [],
      audits: [],
      projections: [],
    };
    const service = new LowStockIssueService(memoryDb(state), vendingIndex());

    const result = await service.reconcile(
      report({
        items: [low()],
        coverage: { authoritativeSerials: ["2508160376"], inactiveSerials: [] },
      }),
      new Date("2026-08-31T03:35:00.000Z"),
    );

    assert.equal(result.adopted, 0);
    assert.equal(result.consolidated, 0);
    assert.equal(result.created, 1);
    for (const id of ["manual-lookalike", "wrong-domain", "wrong-entity", "agent-owned"]) {
      const untouched = state.tasks.find((row) => row.id === id);
      assert.ok(untouched);
      assert.match(String(untouched.source), /^low_stock:/);
      assert.notEqual(untouched.status, "cancelled");
    }
    assert.equal(
      state.audits.filter((row) => row.action === "vending.low_stock_issue.duplicate_cancelled")
        .length,
      0,
    );
  });

  it("adopts and resolves a healthy legacy task without creating a replacement", async () => {
    const state: MemoryState = {
      tasks: [
        {
          id: "legacy",
          title: "Legacy",
          description: "low",
          ownerKind: "human",
          ownerRef: null,
          domain: "vendhub",
          entityId: "machine-1",
          status: "todo",
          source: "low_stock:2508160376:2026-08-30",
          createdBy: "task-bridge",
          createdAt: new Date("2026-08-30T01:00:00.000Z"),
        },
      ],
      issues: [],
      events: [],
      audits: [],
      projections: [],
    };
    const service = new LowStockIssueService(memoryDb(state), vendingIndex());
    const result = await service.reconcile(
      report({
        coverage: { authoritativeSerials: ["2508160376"], inactiveSerials: [] },
      }),
      new Date("2026-08-31T03:35:00.000Z"),
    );
    assert.equal(result.adopted, 1);
    assert.equal(result.resolved, 1);
    assert.equal(state.tasks[0]?.status, "done");
    assert.equal(state.issues[0]?.status, "resolved");
    assert.equal(state.events[0]?.type, VENDING_LOW_STOCK_ISSUES_RESOLVED_EVENT);
  });

  it("does not let an older scan overwrite a newer verdict", async () => {
    const state: MemoryState = { tasks: [], issues: [], events: [], audits: [], projections: [] };
    const service = new LowStockIssueService(memoryDb(state), vendingIndex());
    const newer = new Date("2026-08-31T05:00:00.000Z");
    const older = new Date("2026-08-31T04:59:00.000Z");
    await service.reconcile(report(), newer);
    const stale = await service.reconcile(report({ items: [low()] }), older);
    assert.equal(stale.staleSkipped, true);
    assert.equal(stale.observed, 1);
    assert.equal(state.tasks.length, 0);
    assert.equal(state.issues.length, 0);
    assert.equal(state.projections[0]?.watermark, newer);
  });
});
