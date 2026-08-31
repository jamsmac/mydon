import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { auditLog, event, operationalIssue, operationalProjectionState, task } from "@mydon/db";
import { PgDialect } from "drizzle-orm/pg-core";
import type { VendingService } from "../vending/vending.service";
import {
  PARITY_ISSUES_OPENED_EVENT,
  PARITY_ISSUES_RESOLVED_EVENT,
  PARITY_SALES_ISSUE_KIND,
  PARITY_STOCK_ISSUE_KIND,
  ParityIssueService,
  parityIssueDue,
  parityIssueObservations,
  planParityIssues,
  type ExistingParityIssue,
  type ParityIssueObservation,
  type ParityIssueReport,
} from "./parity-issue.service";

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

function rowsMatching(rows: Row[], condition: unknown): Row[] {
  const params = conditionParams(condition);
  const requestedId = params.find((value) => rows.some((row) => row.id === value));
  return requestedId === undefined ? rows : rows.filter((row) => row.id === requestedId);
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
  const selectedIssues = (): Row[] => state.issues.map((issue) => {
    const linked = state.tasks.find((candidate) => candidate.id === issue.taskId);
    if (!linked) throw new Error("orphan operational issue in test fixture");
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
      payload: issue.payload,
    };
  });
  const selectChain = (read: () => Row[]) => {
    let condition: unknown;
    const api = {
      innerJoin: (_table: unknown, _on: unknown) => api,
      where: (value: unknown) => {
        condition = value;
        return api;
      },
      for: (_mode: string) => api,
      then: (resolve: (rows: Row[]) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rowsMatching(read(), condition)).then(resolve, reject),
    };
    return api;
  };
  const tx = {
    execute: async (_query: unknown) => [],
    select: (_selection?: unknown) => ({
      from: (tableRef: unknown) => selectChain(
        tableRef === operationalIssue ? selectedIssues : () => rowsFor(tableRef),
      ),
    }),
    insert: (tableRef: unknown) => ({
      values: (input: Row) => {
        const row: Row = { id: `memory-${++sequence}`, ...input };
        if (tableRef === task) {
          Object.assign(row, {
            completedAt: row.completedAt ?? null,
            closedBy: row.closedBy ?? null,
            confirmedAt: row.confirmedAt ?? null,
            confirmedBy: row.confirmedBy ?? null,
            resultNote: row.resultNote ?? null,
            quality: row.quality ?? null,
            remindedAt: row.remindedAt ?? null,
            redoNotifiedAt: row.redoNotifiedAt ?? null,
            assignNotifiedAt: row.assignNotifiedAt ?? null,
          });
        }
        if (tableRef !== operationalProjectionState) rowsFor(tableRef).push(row);
        return {
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
      },
    }),
    update: (tableRef: unknown) => ({
      set: (patch: Row) => ({
        where: (condition: unknown) => ({
          then: (resolve: (value: undefined) => unknown, reject?: (reason: unknown) => unknown) => {
            for (const row of rowsMatching(rowsFor(tableRef), condition)) Object.assign(row, patch);
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

function vendingIndex(state: { mapped: boolean } = { mapped: true }): VendingService {
  return {
    machineIndex: async () => {
      const ids: [string, string][] = state.mapped ? [["2508160376", "machine-1"]] : [];
      const names: [string, string][] = state.mapped ? [["2508160376", "Kaffit-01"]] : [];
      return {
        idBySerial: new Map(ids),
        firstIdBySerial: new Map(ids),
        nameBySerial: new Map(names),
      };
    },
  } as unknown as VendingService;
}

function report(overrides: Partial<ParityIssueReport> = {}): ParityIssueReport {
  return {
    mismatches: [],
    stock: { mismatches: [] },
    coverage: { salesScopes: [], stockScopes: [] },
    ...overrides,
  };
}

function existing(
  observation: ParityIssueObservation,
  overrides: Partial<ExistingParityIssue> = {},
): ExistingParityIssue {
  return {
    id: `issue-${observation.fingerprint.slice(0, 8)}`,
    taskId: `task-${observation.fingerprint.slice(0, 8)}`,
    taskTitle: "Исправить данные",
    kind: observation.kind,
    fingerprint: observation.fingerprint,
    scopeKey: observation.scopeKey,
    status: "open",
    episode: 1,
    taskStatus: "todo",
    payload: observation.payload,
    ...overrides,
  };
}

describe("ParityIssueService: durable lifecycle", () => {
  it("строит стабильную sales identity по дате и каноническому серийнику", () => {
    const [withPrefix] = parityIssueObservations(report({
      mismatches: [{
        dt: "2026-08-30",
        serial: " C2508160376 ",
        ownQty: 7,
        stockQty: 8,
        ownAmount: 70_000,
        stockAmount: 80_000,
        reason: "суммы расходятся",
      }],
    }));
    const [withoutPrefix] = parityIssueObservations(report({
      mismatches: [{
        dt: "2026-08-30",
        serial: "2508160376",
        ownQty: 9,
        stockQty: 8,
        ownAmount: 90_000,
        stockAmount: 80_000,
        reason: "новые детали",
      }],
    }));

    assert.ok(withPrefix && withoutPrefix);
    assert.equal(withPrefix.kind, PARITY_SALES_ISSUE_KIND);
    assert.equal(withPrefix.scopeKey, "2026-08-30|2508160376");
    assert.equal(withPrefix.fingerprint, withoutPrefix.fingerprint);
  });

  it("схлопывает дубли stock по нормализованному имени товара", () => {
    const observations = parityIssueObservations(report({
      stock: {
        mismatches: [
          { dt: "2026-08-30", serial: "A", product: " Red   Bull ", own: 3, stock: 4, reason: "x" },
          { dt: "2026-08-30", serial: "a", product: "red bull", own: 2, stock: 4, reason: "y" },
        ],
      },
    }));

    assert.equal(observations.length, 1);
    assert.equal(observations[0]?.kind, PARITY_STOCK_ISSUE_KIND);
    assert.equal(observations[0]?.scopeKey, "2026-08-30|a");
    assert.equal(observations[0]?.items[0]?.ownQty, 2, "последнее наблюдение обновляет детали");
  });

  it("группирует все товары одного автомата/дня в одну task", () => {
    const observations = parityIssueObservations(report({
      stock: { mismatches: [
        { dt: "2026-08-30", serial: "A", product: "Water", own: 1, stock: 2, reason: "w" },
        { dt: "2026-08-30", serial: "A", product: "Cola", own: 3, stock: 4, reason: "c" },
      ] },
    }));
    assert.equal(observations.length, 1, "список задач не взрывается по числу SKU");
    assert.deepEqual(observations[0]?.items.map((item) => item.product), ["Cola", "Water"]);
  });

  it("обновляет состав grouped stock task только под авторитетным machine/day coverage", () => {
    const [previous] = parityIssueObservations(report({
      stock: { mismatches: [
        { dt: "2026-08-30", serial: "A", product: "Cola", own: 1, stock: 2, reason: "cola" },
        { dt: "2026-08-30", serial: "A", product: "Water", own: 3, stock: 4, reason: "water-old" },
      ] },
    }));
    const [current] = parityIssueObservations(report({
      stock: { mismatches: [
        { dt: "2026-08-30", serial: "A", product: "Water", own: 2, stock: 4, reason: "water-new" },
      ] },
    }));
    assert.ok(previous && current);
    assert.equal(previous.fingerprint, current.fingerprint, "group identity не зависит от списка SKU");

    const authoritative = planParityIssues([current], [existing(previous)], {
      salesScopes: [],
      stockScopes: [current.scopeKey],
    });
    assert.equal(authoritative.refresh.length, 1);
    assert.equal(authoritative.resolve.length, 0, "оставшийся Water не даёт закрыть task");
    assert.deepEqual(
      authoritative.refresh[0]?.observation.items.map((item) => [item.product, item.reason]),
      [["Water", "water-new"]],
      "Cola, исчезнувшая из обоих full-replace снапшотов, больше не pending",
    );

    const partial = planParityIssues([current], [existing(previous)], {
      salesScopes: [],
      stockScopes: [],
    });
    assert.deepEqual(
      partial.refresh[0]?.observation.items.map((item) => item.product),
      ["Cola", "Water"],
      "без полного machine/day coverage исчезнувшая деталь остаётся pending",
    );
  });

  it("создаёт, обновляет и переоткрывает, но не дублирует одну identity", () => {
    const observations = parityIssueObservations(report({
      mismatches: [
        { dt: "2026-08-29", serial: "A", ownQty: 1, stockQty: 2, ownAmount: 10, stockAmount: 20, reason: "a" },
        { dt: "2026-08-30", serial: "B", ownQty: 1, stockQty: 2, ownAmount: 10, stockAmount: 20, reason: "b" },
        { dt: "2026-08-30", serial: "C", ownQty: 1, stockQty: 2, ownAmount: 10, stockAmount: 20, reason: "c" },
        { dt: "2026-08-30", serial: "D", ownQty: 1, stockQty: 2, ownAmount: 10, stockAmount: 20, reason: "d" },
      ],
    }));
    const [created, refreshed, manuallyClosed, recurred] = observations;
    assert.ok(created && refreshed && manuallyClosed && recurred);

    const plan = planParityIssues(observations, [
      existing(refreshed),
      existing(manuallyClosed, { taskStatus: "done" }),
      existing(recurred, { status: "resolved", taskStatus: "done", episode: 3 }),
    ], { salesScopes: [], stockScopes: [] });

    assert.deepEqual(plan.create.map((item) => item.fingerprint), [created.fingerprint]);
    assert.deepEqual(plan.refresh.map((item) => item.issue.fingerprint), [refreshed.fingerprint]);
    assert.deepEqual(
      plan.reopen.map((item) => [item.issue.fingerprint, item.issue.episode]),
      [[manuallyClosed.fingerprint, 1], [recurred.fingerprint, 3]],
    );
  });

  it("закрывает только отсутствующую open issue внутри авторитетного coverage", () => {
    const [sales] = parityIssueObservations(report({
      mismatches: [{
        dt: "2026-08-30",
        serial: "A",
        ownQty: 1,
        stockQty: 2,
        ownAmount: 10,
        stockAmount: 20,
        reason: "sales",
      }],
    }));
    const [stock] = parityIssueObservations(report({
      stock: { mismatches: [{ dt: "2026-08-30", serial: "B", product: "Water", own: 1, stock: 2, reason: "stock" }] },
    }));
    assert.ok(sales && stock);

    const noCoverage = planParityIssues([], [existing(sales), existing(stock)], {
      salesScopes: [],
      stockScopes: [],
    });
    assert.equal(noCoverage.resolve.length, 0);
    assert.equal(noCoverage.retained.length, 2);

    const completeMachineCoverage = planParityIssues([], [existing(sales), existing(stock)], {
      salesScopes: [sales.scopeKey],
      stockScopes: ["2026-08-30|b"],
    });
    assert.deepEqual(
      new Set(completeMachineCoverage.resolve.map((item) => item.fingerprint)),
      new Set([sales.fingerprint, stock.fingerprint]),
      "обе стороны пишут full-replace machine/day: исчезнувший SKU = согласованное удаление",
    );
    assert.equal(completeMachineCoverage.retained.length, 0);
  });

  it("ставит срок на следующее утро 10:00 Asia/Tashkent", () => {
    const due = parityIssueDue(new Date("2026-08-30T20:30:00.000Z")); // 31.08 01:30 Tashkent
    assert.equal(due.toISOString(), "2026-09-01T05:00:00.000Z");
  });

  it("в реальном reconcile пишет task+issue атомарно, не шумит повторно и закрывается по coverage", async () => {
    const state: MemoryState = { tasks: [], issues: [], events: [], audits: [], projections: [] };
    const registry = { mapped: true };
    const service = new ParityIssueService(memoryDb(state), vendingIndex(registry));
    const firstAt = new Date("2026-08-31T03:45:00.000Z");
    const mismatch = report({
      mismatches: [{
        dt: "2026-08-30",
        serial: "c2508160376",
        ownQty: 7,
        stockQty: 8,
        ownAmount: 70_000,
        stockAmount: 80_000,
        reason: "суммы расходятся",
      }],
      coverage: { salesScopes: ["2026-08-30|2508160376"], stockScopes: [] },
    });

    const created = await service.reconcile(mismatch, firstAt);
    assert.deepEqual(created, {
      observed: 1,
      created: 1,
      reopened: 0,
      resolved: 0,
      unchanged: 0,
      retained: 0,
      staleSkipped: false,
    });
    assert.equal(state.tasks.length, 1);
    assert.equal(state.issues.length, 1);
    assert.equal(state.events.length, 1);
    assert.equal(state.events[0]?.type, PARITY_ISSUES_OPENED_EVENT);
    assert.deepEqual(state.events[0]?.payload, {
      count: 1,
      reopened: 0,
      items: [{
        title: "Исправить продажи OurVend: Kaffit-01, 2026-08-30",
        taskId: state.tasks[0]?.id,
        kind: PARITY_SALES_ISSUE_KIND,
      }],
      omitted: 0,
    });
    assert.equal(state.tasks[0]?.entityId, "machine-1");
    assert.equal(state.tasks[0]?.ownerRef, null);
    assert.equal(state.issues[0]?.taskId, state.tasks[0]?.id);

    registry.mapped = false;
    const unchanged = await service.reconcile(mismatch, new Date("2026-08-31T04:00:00.000Z"));
    assert.equal(unchanged.unchanged, 1);
    assert.equal(state.tasks[0]?.entityId, null, "refresh снимает устаревшую связь с удалённой registry card");
    assert.equal(state.tasks.length, 1, "одна identity не плодит task");
    assert.equal(state.issues.length, 1, "одна identity не плодит issue");
    assert.equal(state.events.length, 1, "неизменная проблема не шлёт новый alert");

    // Человек закрыл задачу, но факт всё ещё расходится: projection обязана её вернуть.
    Object.assign(state.tasks[0]!, {
      status: "done",
      completedAt: firstAt,
      closedBy: "owner",
      confirmedAt: firstAt,
      confirmedBy: "owner",
      resultNote: "готово",
      quality: "excellent",
      remindedAt: firstAt,
      redoNotifiedAt: firstAt,
      assignNotifiedAt: firstAt,
      ownerKind: "agent",
      ownerRef: "data-fixer",
      agentRunId: "run-old",
      agentExecutionAttemptId: "attempt-old",
      agentExecutionRetryAt: firstAt,
      agentExecutionBlockedAt: firstAt,
      agentExecutionBlockedReason: "old",
      agentRunClaimedAt: firstAt,
    });
    const reopened = await service.reconcile(mismatch, new Date("2026-08-31T04:15:00.000Z"));
    assert.equal(reopened.reopened, 1);
    assert.equal(state.issues[0]?.episode, 2);
    assert.equal(state.tasks[0]?.status, "todo");
    assert.equal(state.tasks[0]?.ownerKind, "human");
    assert.equal(state.tasks[0]?.ownerRef, null);
    for (const field of [
      "completedAt",
      "closedBy",
      "confirmedAt",
      "confirmedBy",
      "resultNote",
      "quality",
      "remindedAt",
      "redoNotifiedAt",
      "assignNotifiedAt",
      "agentRunId",
      "agentExecutionAttemptId",
      "agentExecutionRetryAt",
      "agentExecutionBlockedAt",
      "agentExecutionBlockedReason",
      "agentRunClaimedAt",
    ]) assert.equal(state.tasks[0]?.[field], null, `${field} должен очиститься при reopen`);
    assert.equal(state.events.length, 2);
    assert.equal(state.events[1]?.type, PARITY_ISSUES_OPENED_EVENT);
    assert.equal((state.events[1]?.payload as { reopened?: number }).reopened, 1);

    const resolvedAt = new Date("2026-08-31T04:30:00.000Z");
    const resolved = await service.reconcile(report({
      coverage: { salesScopes: ["2026-08-30|2508160376"], stockScopes: [] },
    }), resolvedAt);
    assert.equal(resolved.resolved, 1);
    assert.equal(state.issues[0]?.status, "resolved");
    assert.equal(state.issues[0]?.resolvedAt, resolvedAt);
    assert.equal(state.tasks[0]?.status, "done");
    assert.equal(state.tasks[0]?.confirmedAt, resolvedAt);
    assert.equal(state.tasks[0]?.confirmedBy, "system:ourvend-parity-issue");
    assert.equal(state.tasks[0]?.quality, "accepted");
    assert.equal(state.events.length, 3);
    assert.equal(state.events[2]?.type, PARITY_ISSUES_RESOLVED_EVENT);
    assert.equal(state.audits.length, 3, "create, reopen и resolve имеют audit");
  });

  it("не даёт более старому скану переписать более новый вердикт", async () => {
    const state: MemoryState = { tasks: [], issues: [], events: [], audits: [], projections: [] };
    const service = new ParityIssueService(memoryDb(state), vendingIndex());
    const newer = new Date("2026-08-31T05:00:00.000Z");
    const older = new Date("2026-08-31T04:59:00.000Z");

    const clean = await service.reconcile(report(), newer);
    assert.equal(clean.staleSkipped, false);
    assert.equal(state.projections[0]?.watermark, newer);

    // This identity did not exist when the newer clean scan committed. It is
    // still rejected: the watermark fences the whole report, not only known
    // operational_issue rows.
    const stale = await service.reconcile(report({
      mismatches: [{
        dt: "2026-08-30",
        serial: "2508160376",
        ownQty: 1,
        stockQty: 2,
        ownAmount: 10,
        stockAmount: 20,
        reason: "старый скан",
      }],
    }), older);
    assert.deepEqual(stale, {
      observed: 1,
      created: 0,
      reopened: 0,
      resolved: 0,
      unchanged: 0,
      retained: 0,
      staleSkipped: true,
    });
    assert.equal(state.tasks.length, 0);
    assert.equal(state.issues.length, 0);
    assert.equal(state.events.length, 0);
    assert.equal(state.projections.length, 1);
    assert.equal(state.projections[0]?.watermark, newer);
  });
});
