import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import {
  auditLog,
  event,
  operationalIssue,
  operationalProjectionState,
  task,
} from "@mydon/db";
import { normalizeMachineSerial, tashkentDayStartOf } from "@mydon/shared";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { VendingService, type MachineIndex } from "../vending/vending.service";
import type { ParityMismatch, ParityStockMismatch } from "./ourvend-parity.service";
import {
  PARITY_ISSUE_SOURCE,
  PARITY_ISSUES_OPENED_EVENT,
  PARITY_ISSUES_RESOLVED_EVENT,
  parityIssueScope,
  parityStockIssueScope,
} from "./parity-issue-identity";

export {
  PARITY_ISSUE_SOURCE,
  PARITY_ISSUES_FAILED_EVENT,
  PARITY_ISSUES_OPENED_EVENT,
  PARITY_ISSUES_RESOLVED_EVENT,
} from "./parity-issue-identity";
export const PARITY_SALES_ISSUE_KIND = "ourvend.parity.sales";
export const PARITY_STOCK_ISSUE_KIND = "ourvend.parity.stock";
export const PARITY_ISSUE_EVENT_SAMPLE_LIMIT = 20;
export const PARITY_ISSUE_PROJECTION_KEY = "ourvend-parity-issues";

export const PARITY_ISSUE_KINDS = [
  PARITY_SALES_ISSUE_KIND,
  PARITY_STOCK_ISSUE_KIND,
] as const;

export type ParityIssueKind = (typeof PARITY_ISSUE_KINDS)[number];
type TaskStatus = "todo" | "in_progress" | "done" | "cancelled";

export interface ParityIssueReport {
  mismatches: readonly ParityMismatch[];
  stock: { mismatches: readonly ParityStockMismatch[] };
  coverage: {
    salesScopes: readonly string[];
    stockScopes: readonly string[];
  };
}

export interface ParityIssueObservation {
  kind: ParityIssueKind;
  fingerprint: string;
  scopeDate: string;
  scopeKey: string;
  serial: string;
  /** One sales fact, or all mismatching products for this machine/day. */
  items: ParityIssueItem[];
  payload: Record<string, unknown>;
}

export interface ParityIssueItem {
  /** Exact normalized product key used to deduplicate details inside the task. */
  coverageKey: string;
  product: string | null;
  ownQty: number;
  donorQty: number;
  ownAmount: number | null;
  donorAmount: number | null;
  reason: string;
}

export interface ExistingParityIssue {
  id: string;
  taskId: string;
  taskTitle: string;
  kind: ParityIssueKind;
  fingerprint: string;
  scopeKey: string;
  status: "open" | "resolved";
  episode: number;
  taskStatus: TaskStatus;
  payload: unknown;
}

export interface ParityIssueTransition {
  issue: ExistingParityIssue;
  observation: ParityIssueObservation;
}

export interface ParityIssuePlan {
  create: ParityIssueObservation[];
  refresh: ParityIssueTransition[];
  reopen: ParityIssueTransition[];
  resolve: ExistingParityIssue[];
  /** Open issues outside authoritative coverage: deliberately left untouched. */
  retained: ExistingParityIssue[];
}

export interface ParityIssueReconcileResult {
  observed: number;
  created: number;
  reopened: number;
  resolved: number;
  unchanged: number;
  retained: number;
  staleSkipped: boolean;
}

interface TransitionEventItem {
  title: string;
  taskId: string;
  kind: ParityIssueKind;
  fingerprint: string;
  episode: number;
}

function isParityIssueKind(value: string): value is ParityIssueKind {
  return (PARITY_ISSUE_KINDS as readonly string[]).includes(value);
}

/** SHA-256 keeps the unique key fixed-size even when a product title is long. */
export function parityIssueFingerprint(kind: ParityIssueKind, exactIdentity: string): string {
  return createHash("sha256").update(`${kind}|${exactIdentity}`).digest("hex");
}

function observationKey(value: { kind: ParityIssueKind; fingerprint: string }): string {
  return `${value.kind}|${value.fingerprint}`;
}

function observationWithItems(
  base: Omit<ParityIssueObservation, "items" | "payload">,
  items: readonly ParityIssueItem[],
): ParityIssueObservation {
  const sorted = [...items].sort((a, b) => a.coverageKey.localeCompare(b.coverageKey));
  return {
    ...base,
    items: sorted,
    payload: {
      surface: base.kind === PARITY_SALES_ISSUE_KIND ? "sales" : "stock",
      dt: base.scopeDate,
      serial: base.serial,
      items: sorted,
    },
  };
}

function stockItemsFromPayload(payload: unknown): ParityIssueItem[] {
  if (payload === null || typeof payload !== "object") return [];
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item): ParityIssueItem[] => {
    if (item === null || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    if (
      typeof value.coverageKey !== "string" ||
      typeof value.ownQty !== "number" ||
      typeof value.donorQty !== "number" ||
      typeof value.reason !== "string"
    ) return [];
    return [{
      coverageKey: value.coverageKey,
      product: typeof value.product === "string" ? value.product : null,
      ownQty: value.ownQty,
      donorQty: value.donorQty,
      ownAmount: typeof value.ownAmount === "number" ? value.ownAmount : null,
      donorAmount: typeof value.donorAmount === "number" ? value.donorAmount : null,
      reason: value.reason,
    }];
  });
}

/**
 * Full report -> bounded operational identities. Sales is already one fact per
 * machine/day. Stock products are grouped into ONE machine/day task so a first
 * run with hundreds of bad slots cannot push ordinary work past the 300-task
 * board cap; full product detail remains in payload and task description.
 */
export function parityIssueObservations(report: ParityIssueReport): ParityIssueObservation[] {
  const byKey = new Map<string, ParityIssueObservation>();

  for (const mismatch of report.mismatches) {
    const serial = normalizeMachineSerial(mismatch.serial);
    const exactIdentity = parityIssueScope(mismatch.dt, serial);
    const base = {
      kind: PARITY_SALES_ISSUE_KIND,
      fingerprint: parityIssueFingerprint(PARITY_SALES_ISSUE_KIND, exactIdentity),
      scopeDate: mismatch.dt,
      scopeKey: exactIdentity,
      serial,
    } satisfies Omit<ParityIssueObservation, "items" | "payload">;
    const observation = observationWithItems(base, [{
      coverageKey: exactIdentity,
      product: null,
      ownQty: mismatch.ownQty,
      donorQty: mismatch.stockQty,
      ownAmount: mismatch.ownAmount,
      donorAmount: mismatch.stockAmount,
      reason: mismatch.reason,
    }]);
    byKey.set(observationKey(observation), observation);
  }

  const stockGroups = new Map<string, {
    base: Omit<ParityIssueObservation, "items" | "payload">;
    items: Map<string, ParityIssueItem>;
  }>();
  for (const mismatch of report.stock.mismatches) {
    const serial = normalizeMachineSerial(mismatch.serial);
    const product = mismatch.product.trim();
    const machineScope = parityIssueScope(mismatch.dt, serial);
    const coverageKey = parityStockIssueScope(mismatch.dt, serial, product);
    const groupKey = `${PARITY_STOCK_ISSUE_KIND}|${machineScope}`;
    const group = stockGroups.get(groupKey) ?? {
      base: {
        kind: PARITY_STOCK_ISSUE_KIND,
        fingerprint: parityIssueFingerprint(PARITY_STOCK_ISSUE_KIND, machineScope),
        scopeDate: mismatch.dt,
        scopeKey: machineScope,
        serial,
      },
      items: new Map<string, ParityIssueItem>(),
    };
    group.items.set(coverageKey, {
      coverageKey,
      product,
      ownQty: mismatch.own,
      donorQty: mismatch.stock,
      ownAmount: null,
      donorAmount: null,
      reason: mismatch.reason,
    });
    stockGroups.set(groupKey, group);
  }
  for (const group of stockGroups.values()) {
    const observation = observationWithItems(group.base, [...group.items.values()]);
    byKey.set(observationKey(observation), observation);
  }

  return [...byKey.values()].sort((a, b) => observationKey(a).localeCompare(observationKey(b)));
}

function mergeUnobservedStockItems(
  observation: ParityIssueObservation,
  issue: ExistingParityIssue,
  stockCoverage: ReadonlySet<string>,
): ParityIssueObservation {
  if (observation.kind !== PARITY_STOCK_ISSUE_KIND || issue.status !== "open") return observation;
  // A present machine/day is a full-replacement snapshot on both sides. Only
  // outside that authoritative scope must old product details remain pending.
  if (stockCoverage.has(issue.scopeKey)) return observation;
  const pending = new Map(observation.items.map((item) => [item.coverageKey, item]));
  for (const previous of stockItemsFromPayload(issue.payload)) {
    if (!pending.has(previous.coverageKey)) {
      pending.set(previous.coverageKey, previous);
    }
  }
  return observationWithItems(
    {
      kind: observation.kind,
      fingerprint: observation.fingerprint,
      scopeDate: observation.scopeDate,
      scopeKey: observation.scopeKey,
      serial: observation.serial,
    },
    [...pending.values()],
  );
}

/** Pure lifecycle planner; DB code below only applies this deterministic plan. */
export function planParityIssues(
  observations: readonly ParityIssueObservation[],
  existing: readonly ExistingParityIssue[],
  coverage: ParityIssueReport["coverage"],
): ParityIssuePlan {
  const current = new Map<string, ParityIssueObservation>();
  for (const observation of observations) current.set(observationKey(observation), observation);
  const previous = new Map(existing.map((issue) => [observationKey(issue), issue]));
  const salesCoverage = new Set(coverage.salesScopes);
  const stockCoverage = new Set(coverage.stockScopes);

  const plan: ParityIssuePlan = { create: [], refresh: [], reopen: [], resolve: [], retained: [] };
  for (const observation of [...current.values()].sort((a, b) => observationKey(a).localeCompare(observationKey(b)))) {
    const issue = previous.get(observationKey(observation));
    if (!issue) {
      plan.create.push(observation);
      continue;
    }
    previous.delete(observationKey(observation));
    const effective = mergeUnobservedStockItems(observation, issue, stockCoverage);
    if (issue.status === "resolved" || issue.taskStatus === "done" || issue.taskStatus === "cancelled") {
      plan.reopen.push({ issue, observation: effective });
    } else {
      plan.refresh.push({ issue, observation: effective });
    }
  }

  for (const issue of [...previous.values()].sort((a, b) => observationKey(a).localeCompare(observationKey(b)))) {
    if (issue.status !== "open") continue;
    const covered = issue.kind === PARITY_SALES_ISSUE_KIND
      ? salesCoverage.has(issue.scopeKey)
      : stockCoverage.has(issue.scopeKey);
    if (covered) plan.resolve.push(issue);
    else plan.retained.push(issue);
  }
  return plan;
}

/** Следующее ташкентское утро, 10:00 — тот же срок, что у task bridge. */
export function parityIssueDue(now: Date): Date {
  return new Date(tashkentDayStartOf(now).getTime() + 34 * 3_600_000);
}

function taskPresentation(
  observation: ParityIssueObservation,
  registry: MachineIndex | null,
): { title: string; description: string; entityId: string | null } {
  const machine = registry?.nameBySerial.get(observation.serial) ?? observation.serial;
  const entityId = registry?.firstIdBySerial.get(observation.serial) ?? null;
  if (observation.kind === PARITY_SALES_ISSUE_KIND) {
    const item = observation.items[0];
    if (!item) throw new Error("Sales parity issue without a fact");
    return {
      title: `Исправить продажи OurVend: ${machine}, ${observation.scopeDate}`,
      description:
        `Сверка MYDON с mydon-stock за ${observation.scopeDate}. ` +
        `Продано: ${item.ownQty} / ${item.donorQty} шт; ` +
        `сумма: ${item.ownAmount ?? 0} / ${item.donorAmount ?? 0}. ` +
        `Причина: ${item.reason}. Задача закроется сама после совпадения данных.`,
      entityId,
    };
  }
  const shown = observation.items.slice(0, 20).map((item) =>
    `${item.product || "товар"} — ${item.ownQty} / ${item.donorQty} шт (${item.reason})`,
  );
  const omitted = Math.max(0, observation.items.length - shown.length);
  return {
    title: `Исправить остатки OurVend: ${machine}, ${observation.scopeDate} (${observation.items.length})`,
    description:
      `Сверка MYDON с mydon-stock за ${observation.scopeDate}. ` +
      `Позиции: ${shown.join("; ")}` +
      (omitted > 0 ? `; и ещё ${omitted}.` : ".") +
      " Задача закроется сама, когда полные снапшоты этого автомата за день снова совпадут.",
    entityId,
  };
}

function transitionEventKey(type: string, items: readonly TransitionEventItem[]): string {
  const identity = items
    .map((item) => `${item.kind}:${item.fingerprint}:${item.episode}`)
    .sort()
    .join("|");
  return `${PARITY_ISSUE_SOURCE}:${type}:${createHash("sha256").update(identity).digest("hex")}`;
}

function eventPayload(items: readonly TransitionEventItem[], reopened?: number): Record<string, unknown> {
  const sorted = [...items].sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.fingerprint.localeCompare(b.fingerprint),
  );
  return {
    count: sorted.length,
    ...(reopened === undefined ? {} : { reopened }),
    items: sorted.slice(0, PARITY_ISSUE_EVENT_SAMPLE_LIMIT).map(({ title, taskId, kind }) => ({
      title,
      taskId,
      kind,
    })),
    omitted: Math.max(0, sorted.length - PARITY_ISSUE_EVENT_SAMPLE_LIMIT),
  };
}

@Injectable()
export class ParityIssueService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly vending: VendingService,
  ) {}

  async oldestOpenDate(): Promise<string | null> {
    const [row] = await this.db
      .select({ oldest: sql<string | null>`min(${operationalIssue.scopeDate})` })
      .from(operationalIssue)
      .where(
        and(
          inArray(operationalIssue.kind, [...PARITY_ISSUE_KINDS]),
          eq(operationalIssue.status, "open"),
        ),
      );
    return row?.oldest ?? null;
  }

  async reconcile(report: ParityIssueReport, now = new Date()): Promise<ParityIssueReconcileResult> {
    const observations = parityIssueObservations(report);
    const registry = observations.length > 0 ? await this.vending.machineIndex() : null;

    return this.db.transaction(async (tx) => {
      // Serializes two manual/daily reconciliations before they can race on an
      // episode counter or produce two transition events. The unique indexes
      // remain the final invariant; this lock makes the whole projection calm.
      await tx.execute(sql`select pg_advisory_xact_lock(1879969281)`);

      const [projection] = await tx
        .select({ watermark: operationalProjectionState.watermark })
        .from(operationalProjectionState)
        .where(eq(operationalProjectionState.key, PARITY_ISSUE_PROJECTION_KEY))
        .for("update");
      // `daily(now)` passes its scan-start wall-clock instant all the way
      // here. Under the existing single-host cron model those instants are
      // monotonic; persisting one under this lock prevents a slow older scan
      // from committing after a newer one, including when no issue existed.
      if (projection && projection.watermark.getTime() >= now.getTime()) {
        return {
          observed: observations.length,
          created: 0,
          reopened: 0,
          resolved: 0,
          unchanged: 0,
          retained: 0,
          staleSkipped: true,
        };
      }

      const currentFingerprints = [...new Set(observations.map((item) => item.fingerprint))];
      const recurrenceCandidate = currentFingerprints.length > 0
        ? inArray(operationalIssue.fingerprint, currentFingerprints)
        : sql`false`;

      const rows = await tx
        .select({
          id: operationalIssue.id,
          taskId: operationalIssue.taskId,
          taskTitle: task.title,
          kind: operationalIssue.kind,
          fingerprint: operationalIssue.fingerprint,
          scopeKey: operationalIssue.scopeKey,
          status: operationalIssue.status,
          episode: operationalIssue.episode,
          taskStatus: task.status,
          payload: operationalIssue.payload,
        })
        .from(operationalIssue)
        .innerJoin(task, eq(task.id, operationalIssue.taskId))
        // Open rows are needed for resolution/retention. Resolved history is
        // loaded only when a current fingerprint can recur; daily work must
        // not lock every closed episode accumulated over the years.
        .where(and(
          inArray(operationalIssue.kind, [...PARITY_ISSUE_KINDS]),
          or(eq(operationalIssue.status, "open"), recurrenceCandidate),
        ))
        .for("update");

      const existing: ExistingParityIssue[] = rows.flatMap((row) =>
        isParityIssueKind(row.kind) ? [{ ...row, kind: row.kind }] : [],
      );
      const plan = planParityIssues(observations, existing, report.coverage);
      const openedItems: TransitionEventItem[] = [];
      const resolvedItems: TransitionEventItem[] = [];
      const due = parityIssueDue(now);

      for (const observation of plan.create) {
        const presentation = taskPresentation(observation, registry);
        const [createdTask] = await tx
          .insert(task)
          .values({
            title: presentation.title,
            description: presentation.description,
            ownerKind: "human",
            ownerRef: null,
            domain: "vendhub",
            entityId: presentation.entityId,
            status: "todo",
            priority: "high",
            due,
            source: PARITY_ISSUE_SOURCE,
            createdBy: PARITY_ISSUE_SOURCE,
            clientKey: `${PARITY_ISSUE_SOURCE}:${observation.kind}:${observation.fingerprint}`,
          })
          .returning({ id: task.id });
        if (!createdTask) throw new Error("БД не вернула созданную parity task");

        const [createdIssue] = await tx
          .insert(operationalIssue)
          .values({
            domain: "vendhub",
            kind: observation.kind,
            fingerprint: observation.fingerprint,
            scopeDate: observation.scopeDate,
            scopeKey: observation.scopeKey,
            status: "open",
            episode: 1,
            taskId: createdTask.id,
            payload: observation.payload,
            firstSeenAt: now,
            lastSeenAt: now,
            resolvedAt: null,
            updatedAt: now,
          })
          .returning({ id: operationalIssue.id });
        if (!createdIssue) throw new Error("БД не вернула созданную operational issue");

        await tx.insert(auditLog).values({
          actorKind: "system",
          actorRef: PARITY_ISSUE_SOURCE,
          action: "ourvend.parity_issue.created",
          target: createdIssue.id,
          after: { taskId: createdTask.id, kind: observation.kind, episode: 1, payload: observation.payload },
        });
        openedItems.push({
          title: presentation.title,
          taskId: createdTask.id,
          kind: observation.kind,
          fingerprint: observation.fingerprint,
          episode: 1,
        });
      }

      for (const { issue, observation } of plan.refresh) {
        const presentation = taskPresentation(observation, registry);
        await tx
          .update(operationalIssue)
          .set({
            scopeDate: observation.scopeDate,
            scopeKey: observation.scopeKey,
            payload: observation.payload,
            lastSeenAt: now,
            updatedAt: now,
          })
          .where(eq(operationalIssue.id, issue.id));
        await tx
          .update(task)
          .set({
            title: presentation.title,
            description: presentation.description,
            domain: "vendhub",
            entityId: presentation.entityId,
            priority: "high",
            source: PARITY_ISSUE_SOURCE,
            createdBy: PARITY_ISSUE_SOURCE,
          })
          .where(eq(task.id, issue.taskId));
      }

      for (const { issue, observation } of plan.reopen) {
        const presentation = taskPresentation(observation, registry);
        const episode = issue.episode + 1;
        await tx
          .update(operationalIssue)
          .set({
            status: "open",
            episode,
            scopeDate: observation.scopeDate,
            scopeKey: observation.scopeKey,
            payload: observation.payload,
            lastSeenAt: now,
            resolvedAt: null,
            updatedAt: now,
          })
          .where(eq(operationalIssue.id, issue.id));
        await tx
          .update(task)
          .set({
            title: presentation.title,
            description: presentation.description,
            ownerKind: "human",
            ownerRef: null,
            // Operational parity repair is always a human data task. If it
            // was reassigned to an agent before a terminal close, fence every
            // stale worker/admission marker while returning it to the pool.
            agentRunId: null,
            agentExecutionAttemptId: null,
            agentExecutionRetryAt: null,
            agentExecutionBlockedAt: null,
            agentExecutionBlockedReason: null,
            agentRunClaimedAt: null,
            domain: "vendhub",
            entityId: presentation.entityId,
            status: "todo",
            priority: "high",
            due,
            source: PARITY_ISSUE_SOURCE,
            createdBy: PARITY_ISSUE_SOURCE,
            completedAt: null,
            closedBy: null,
            confirmedAt: null,
            confirmedBy: null,
            resultNote: null,
            quality: null,
            remindedAt: null,
            redoNotifiedAt: null,
            assignNotifiedAt: null,
          })
          .where(eq(task.id, issue.taskId));
        await tx.insert(auditLog).values({
          actorKind: "system",
          actorRef: PARITY_ISSUE_SOURCE,
          action: "ourvend.parity_issue.reopened",
          target: issue.id,
          before: { status: issue.status, taskStatus: issue.taskStatus, episode: issue.episode },
          after: { status: "open", taskStatus: "todo", episode, payload: observation.payload },
        });
        openedItems.push({
          title: presentation.title,
          taskId: issue.taskId,
          kind: observation.kind,
          fingerprint: observation.fingerprint,
          episode,
        });
      }

      for (const issue of plan.resolve) {
        await tx
          .update(operationalIssue)
          .set({ status: "resolved", resolvedAt: now, updatedAt: now })
          .where(eq(operationalIssue.id, issue.id));
        await tx
          .update(task)
          .set({
            status: "done",
            completedAt: now,
            closedBy: `system:${PARITY_ISSUE_SOURCE}`,
            confirmedAt: now,
            confirmedBy: `system:${PARITY_ISSUE_SOURCE}`,
            resultNote: "Расхождение больше не воспроизводится в авторитетной сверке — закрыто автоматически.",
            quality: "accepted",
          })
          .where(eq(task.id, issue.taskId));
        await tx.insert(auditLog).values({
          actorKind: "system",
          actorRef: PARITY_ISSUE_SOURCE,
          action: "ourvend.parity_issue.resolved",
          target: issue.id,
          before: { status: issue.status, taskStatus: issue.taskStatus, episode: issue.episode },
          after: { status: "resolved", taskStatus: "done", episode: issue.episode, resolvedAt: now.toISOString() },
        });
        resolvedItems.push({
          title: issue.taskTitle,
          taskId: issue.taskId,
          kind: issue.kind,
          fingerprint: issue.fingerprint,
          episode: issue.episode,
        });
      }

      if (openedItems.length > 0) {
        await tx
          .insert(event)
          .values({
            source: PARITY_ISSUE_SOURCE,
            type: PARITY_ISSUES_OPENED_EVENT,
            clientKey: transitionEventKey(PARITY_ISSUES_OPENED_EVENT, openedItems),
            occurredAt: now,
            payload: eventPayload(openedItems, plan.reopen.length),
          })
          .onConflictDoNothing({ target: event.clientKey });
      }
      if (resolvedItems.length > 0) {
        await tx
          .insert(event)
          .values({
            source: PARITY_ISSUE_SOURCE,
            type: PARITY_ISSUES_RESOLVED_EVENT,
            clientKey: transitionEventKey(PARITY_ISSUES_RESOLVED_EVENT, resolvedItems),
            occurredAt: now,
            payload: eventPayload(resolvedItems),
          })
          .onConflictDoNothing({ target: event.clientKey });
      }

      await tx
        .insert(operationalProjectionState)
        .values({ key: PARITY_ISSUE_PROJECTION_KEY, watermark: now, updatedAt: now })
        .onConflictDoUpdate({
          target: operationalProjectionState.key,
          set: { watermark: now, updatedAt: now },
        });

      return {
        observed: observations.length,
        created: plan.create.length,
        reopened: plan.reopen.length,
        resolved: plan.resolve.length,
        unchanged: plan.refresh.length,
        retained: plan.retained.length,
        staleSkipped: false,
      };
    });
  }
}
