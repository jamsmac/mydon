import { createHash } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { auditLog, event, operationalIssue, operationalProjectionState, task } from "@mydon/db";
import {
  normalizeMachineSerial,
  normalizeProductName,
  tashkentDay,
  tashkentDayStartOf,
} from "@mydon/shared";
import { and, eq, inArray, like, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { VendingService, type MachineIndex } from "./vending.service";
import {
  VENDING_LOW_STOCK_ISSUE_KIND,
  VENDING_LOW_STOCK_ISSUE_SOURCE,
  VENDING_LOW_STOCK_ISSUES_OPENED_EVENT,
  VENDING_LOW_STOCK_ISSUES_RESOLVED_EVENT,
  lowStockIssueProductScope,
  lowStockIssueScope,
  lowStockIssueTaskClientKey,
} from "./low-stock-issue-identity";

export {
  VENDING_LOW_STOCK_ISSUE_KIND,
  VENDING_LOW_STOCK_ISSUE_SOURCE,
  VENDING_LOW_STOCK_ISSUES_FAILED_EVENT,
  VENDING_LOW_STOCK_ISSUES_OPENED_EVENT,
  VENDING_LOW_STOCK_ISSUES_RESOLVED_EVENT,
} from "./low-stock-issue-identity";

export const VENDING_LOW_STOCK_ISSUE_PROJECTION_KEY = "vending-low-stock-issues";
export const VENDING_LOW_STOCK_ISSUE_EVENT_SAMPLE_LIMIT = 20;

type TaskStatus = "todo" | "in_progress" | "done" | "cancelled";
type OwnerKind = "human" | "agent";

/** One already-aggregated low product from the current machine planogram. */
export interface LowStockIssueInput {
  serial: string;
  product: string;
  /** Canonical product key chosen by the same resolver as the low-stock alert. */
  productKey: string;
  left: number;
  capacity: number;
}

export interface LowStockIssueCoverage {
  /** Machines whose current full planogram is fresh and every assigned slot is valid. */
  authoritativeSerials: readonly string[];
  /** Explicit registry state: no refill work remains while a machine is out of service. */
  inactiveSerials: readonly string[];
}

export interface LowStockIssueReport {
  items: readonly LowStockIssueInput[];
  coverage: LowStockIssueCoverage;
}

export interface LowStockIssueItem {
  coverageKey: string;
  productKey: string;
  product: string;
  left: number;
  capacity: number;
}

export interface LowStockIssueObservation {
  kind: typeof VENDING_LOW_STOCK_ISSUE_KIND;
  fingerprint: string;
  scopeDate: string;
  scopeKey: string;
  serial: string;
  items: LowStockIssueItem[];
  payload: Record<string, unknown>;
}

export interface ExistingLowStockIssue {
  id: string;
  taskId: string;
  taskTitle: string;
  kind: typeof VENDING_LOW_STOCK_ISSUE_KIND;
  fingerprint: string;
  scopeKey: string;
  status: "open" | "resolved";
  episode: number;
  taskStatus: TaskStatus;
  taskOwnerKind: OwnerKind;
  taskOwnerRef: string | null;
  payload: unknown;
}

export interface LowStockIssueTransition {
  issue: ExistingLowStockIssue;
  observation: LowStockIssueObservation;
}

export interface LowStockIssueResolution {
  issue: ExistingLowStockIssue;
  reason: "healthy" | "inactive";
}

export interface LowStockIssuePlan {
  create: LowStockIssueObservation[];
  refresh: LowStockIssueTransition[];
  reopen: LowStockIssueTransition[];
  resolve: LowStockIssueResolution[];
  /** Open issues outside authoritative coverage are deliberately kept alive. */
  retained: ExistingLowStockIssue[];
}

export interface LowStockIssueReconcileResult {
  observed: number;
  created: number;
  adopted: number;
  consolidated: number;
  reopened: number;
  resolved: number;
  unchanged: number;
  retained: number;
  staleSkipped: boolean;
}

interface TransitionEventItem {
  title: string;
  taskId: string;
  fingerprint: string;
  episode: number;
}

interface LegacyTask {
  id: string;
  title: string;
  description: string | null;
  ownerKind: OwnerKind;
  ownerRef: string | null;
  domain: string | null;
  entityId: string | null;
  status: "todo" | "in_progress";
  source: string;
  createdBy: string | null;
  createdAt: Date;
  serial: string;
  day: string;
}

function isLowStockIssueKind(value: string): value is typeof VENDING_LOW_STOCK_ISSUE_KIND {
  return value === VENDING_LOW_STOCK_ISSUE_KIND;
}

/** SHA-256 matches the fixed-width generic operational_issue invariant. */
export function lowStockIssueFingerprint(serial: string): string {
  const scope = lowStockIssueScope(serial);
  if (!scope) throw new Error("Low-stock issue without a machine serial");
  return createHash("sha256").update(`${VENDING_LOW_STOCK_ISSUE_KIND}|${scope}`).digest("hex");
}

function observationKey(value: { fingerprint: string }): string {
  return value.fingerprint;
}

function observationWithItems(
  serial: string,
  scopeDate: string,
  items: readonly LowStockIssueItem[],
): LowStockIssueObservation {
  const sorted = [...items].sort((a, b) => a.coverageKey.localeCompare(b.coverageKey));
  return {
    kind: VENDING_LOW_STOCK_ISSUE_KIND,
    fingerprint: lowStockIssueFingerprint(serial),
    scopeDate,
    scopeKey: serial,
    serial,
    items: sorted,
    payload: { surface: "low_stock", serial, observedDay: scopeDate, items: sorted },
  };
}

/** Current low products -> one stable observation per machine. */
export function lowStockIssueObservations(
  inputs: readonly LowStockIssueInput[],
  scopeDate: string,
): LowStockIssueObservation[] {
  const byMachine = new Map<string, Map<string, LowStockIssueItem>>();
  for (const input of inputs) {
    const serial = lowStockIssueScope(input.serial);
    if (!serial) throw new Error("Low-stock input without a machine serial");
    const productKey = normalizeProductName(input.productKey || input.product);
    if (!productKey) throw new Error(`Low-stock input ${serial} without a product key`);
    if (!Number.isFinite(input.left) || !Number.isFinite(input.capacity)) {
      throw new Error(`Low-stock input ${serial}|${productKey} has a non-finite quantity`);
    }
    const products = byMachine.get(serial) ?? new Map<string, LowStockIssueItem>();
    products.set(productKey, {
      coverageKey: lowStockIssueProductScope(serial, productKey),
      productKey,
      product: input.product.trim() || productKey,
      left: input.left,
      capacity: input.capacity,
    });
    byMachine.set(serial, products);
  }
  return [...byMachine.entries()]
    .map(([serial, items]) => observationWithItems(serial, scopeDate, [...items.values()]))
    .sort((a, b) => observationKey(a).localeCompare(observationKey(b)));
}

function itemsFromPayload(payload: unknown): LowStockIssueItem[] {
  if (payload === null || typeof payload !== "object") return [];
  const items = (payload as { items?: unknown }).items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item): LowStockIssueItem[] => {
    if (item === null || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    if (
      typeof value.coverageKey !== "string" ||
      typeof value.productKey !== "string" ||
      typeof value.product !== "string" ||
      typeof value.left !== "number" ||
      typeof value.capacity !== "number"
    )
      return [];
    return [
      {
        coverageKey: value.coverageKey,
        productKey: value.productKey,
        product: value.product,
        left: value.left,
        capacity: value.capacity,
      },
    ];
  });
}

function mergeUnobservedItems(
  observation: LowStockIssueObservation,
  issue: ExistingLowStockIssue,
  authoritative: ReadonlySet<string>,
): LowStockIssueObservation {
  if (authoritative.has(issue.scopeKey) || issue.status !== "open") return observation;
  const pending = new Map(observation.items.map((item) => [item.productKey, item]));
  for (const previous of itemsFromPayload(issue.payload)) {
    if (!pending.has(previous.productKey)) pending.set(previous.productKey, previous);
  }
  return observationWithItems(observation.serial, observation.scopeDate, [...pending.values()]);
}

/** Pure deterministic lifecycle planner; persistence below only applies this plan. */
export function planLowStockIssues(
  observations: readonly LowStockIssueObservation[],
  existing: readonly ExistingLowStockIssue[],
  coverage: LowStockIssueCoverage,
): LowStockIssuePlan {
  const authoritative = new Set(
    coverage.authoritativeSerials.map(normalizeMachineSerial).filter(Boolean),
  );
  const inactive = new Set(coverage.inactiveSerials.map(normalizeMachineSerial).filter(Boolean));
  const current = new Map<string, LowStockIssueObservation>();
  for (const observation of observations) {
    // Registry state wins over a stale positive planogram observation.
    if (!inactive.has(observation.scopeKey)) current.set(observationKey(observation), observation);
  }
  const previous = new Map(existing.map((issue) => [observationKey(issue), issue]));
  const plan: LowStockIssuePlan = {
    create: [],
    refresh: [],
    reopen: [],
    resolve: [],
    retained: [],
  };

  for (const observation of [...current.values()].sort((a, b) =>
    observationKey(a).localeCompare(observationKey(b)),
  )) {
    const issue = previous.get(observationKey(observation));
    if (!issue) {
      plan.create.push(observation);
      continue;
    }
    previous.delete(observationKey(observation));
    const effective = mergeUnobservedItems(observation, issue, authoritative);
    if (
      issue.status === "resolved" ||
      issue.taskStatus === "done" ||
      issue.taskStatus === "cancelled"
    ) {
      plan.reopen.push({ issue, observation: effective });
    } else {
      plan.refresh.push({ issue, observation: effective });
    }
  }

  for (const issue of [...previous.values()].sort((a, b) =>
    observationKey(a).localeCompare(observationKey(b)),
  )) {
    if (issue.status !== "open") continue;
    if (inactive.has(issue.scopeKey)) plan.resolve.push({ issue, reason: "inactive" });
    else if (authoritative.has(issue.scopeKey)) plan.resolve.push({ issue, reason: "healthy" });
    else plan.retained.push(issue);
  }
  return plan;
}

/** Next Tashkent morning at 10:00, matching other generated field tasks. */
export function lowStockIssueDue(now: Date): Date {
  return new Date(tashkentDayStartOf(now).getTime() + 34 * 3_600_000);
}

function taskPresentation(
  observation: LowStockIssueObservation,
  registry: MachineIndex,
): { title: string; description: string; entityId: string | null } {
  const machine = registry.nameBySerial.get(observation.serial) ?? observation.serial;
  const entityId = registry.firstIdBySerial.get(observation.serial) ?? null;
  const shown = observation.items
    .slice(0, 20)
    .map((item) => `${item.product} — остаток ${item.left} из ${item.capacity}`);
  const omitted = Math.max(0, observation.items.length - shown.length);
  return {
    title: `Пополнить ${machine}: заканчивается товар`,
    description:
      `Заканчивается: ${shown.join("; ")}` +
      (omitted > 0 ? `; и ещё ${omitted}.` : ".") +
      " Задача закроется сама, когда свежая валидная планограмма покажет, что дефицита больше нет.",
    entityId,
  };
}

function transitionEventKey(type: string, items: readonly TransitionEventItem[]): string {
  const identity = items
    .map((item) => `${item.fingerprint}:${item.episode}`)
    .sort()
    .join("|");
  return `${VENDING_LOW_STOCK_ISSUE_SOURCE}:${type}:${createHash("sha256").update(identity).digest("hex")}`;
}

function transitionEventPayload(
  items: readonly TransitionEventItem[],
  reopened?: number,
): Record<string, unknown> {
  const sorted = [...items].sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  return {
    count: sorted.length,
    ...(reopened === undefined ? {} : { reopened }),
    items: sorted
      .slice(0, VENDING_LOW_STOCK_ISSUE_EVENT_SAMPLE_LIMIT)
      .map(({ title, taskId }) => ({ title, taskId })),
    omitted: Math.max(0, sorted.length - VENDING_LOW_STOCK_ISSUE_EVENT_SAMPLE_LIMIT),
  };
}

const LEGACY_SOURCE = /^low_stock:(.+):(\d{4}-\d{2}-\d{2})$/;

function legacyTask(row: Omit<LegacyTask, "serial" | "day">): LegacyTask | null {
  const match = LEGACY_SOURCE.exec(row.source);
  if (!match) return null;
  const serial = normalizeMachineSerial(match[1]);
  const day = match[2];
  return serial && day ? { ...row, serial, day } : null;
}

function legacyRank(left: LegacyTask, right: LegacyTask): number {
  const status = (value: LegacyTask): number => (value.status === "in_progress" ? 0 : 1);
  const assigned = (value: LegacyTask): number =>
    value.ownerKind === "human" && value.ownerRef ? 0 : 1;
  return (
    status(left) - status(right) ||
    assigned(left) - assigned(right) ||
    right.createdAt.getTime() - left.createdAt.getTime() ||
    left.id.localeCompare(right.id)
  );
}

@Injectable()
export class LowStockIssueService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly vending: VendingService,
  ) {}

  async reconcile(
    report: LowStockIssueReport,
    now = new Date(),
  ): Promise<LowStockIssueReconcileResult> {
    const scopeDate = tashkentDay(now);
    const observations = lowStockIssueObservations(report.items, scopeDate);
    const normalizedCoverage: LowStockIssueCoverage = {
      authoritativeSerials: [
        ...new Set(
          report.coverage.authoritativeSerials.map(normalizeMachineSerial).filter(Boolean),
        ),
      ],
      inactiveSerials: [
        ...new Set(report.coverage.inactiveSerials.map(normalizeMachineSerial).filter(Boolean)),
      ],
    };
    const registry = await this.vending.machineIndex();

    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(1879969282)`);

      const [projection] = await tx
        .select({ watermark: operationalProjectionState.watermark })
        .from(operationalProjectionState)
        .where(eq(operationalProjectionState.key, VENDING_LOW_STOCK_ISSUE_PROJECTION_KEY))
        .for("update");
      if (projection && projection.watermark.getTime() >= now.getTime()) {
        return {
          observed: observations.length,
          created: 0,
          adopted: 0,
          consolidated: 0,
          reopened: 0,
          resolved: 0,
          unchanged: 0,
          retained: 0,
          staleSkipped: true,
        };
      }

      const issueRows = await tx
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
          taskOwnerKind: task.ownerKind,
          taskOwnerRef: task.ownerRef,
          payload: operationalIssue.payload,
        })
        .from(operationalIssue)
        .innerJoin(task, eq(task.id, operationalIssue.taskId))
        // Unlike historical parity facts, low-stock identities are bounded by
        // fleet size, so loading resolved rows also makes legacy adoption safe.
        .where(eq(operationalIssue.kind, VENDING_LOW_STOCK_ISSUE_KIND))
        .for("update");
      const existing: ExistingLowStockIssue[] = issueRows.flatMap((row) =>
        isLowStockIssueKind(row.kind) ? [{ ...row, kind: row.kind }] : [],
      );
      const existingByScope = new Map(existing.map((issue) => [issue.scopeKey, issue]));

      const legacyRows = await tx
        .select({
          id: task.id,
          title: task.title,
          description: task.description,
          ownerKind: task.ownerKind,
          ownerRef: task.ownerRef,
          domain: task.domain,
          entityId: task.entityId,
          status: task.status,
          source: task.source,
          createdBy: task.createdBy,
          createdAt: task.createdAt,
        })
        .from(task)
        .where(and(like(task.source, "low_stock:%"), inArray(task.status, ["todo", "in_progress"])))
        .for("update");
      const legacy = legacyRows.flatMap((row): LegacyTask[] => {
        if (
          row.source === null ||
          row.ownerKind !== "human" ||
          row.createdBy !== "task-bridge" ||
          row.domain !== "vendhub" ||
          (row.status !== "todo" && row.status !== "in_progress")
        )
          return [];
        const parsed = legacyTask({
          ...row,
          source: row.source,
          ownerKind: row.ownerKind,
          status: row.status,
        });
        if (!parsed) return [];
        const expectedEntityId = registry.firstIdBySerial.get(parsed.serial) ?? null;
        return parsed.entityId === expectedEntityId ? [parsed] : [];
      });
      const legacyByScope = new Map<string, LegacyTask[]>();
      for (const row of legacy) {
        const group = legacyByScope.get(row.serial) ?? [];
        group.push(row);
        legacyByScope.set(row.serial, group);
      }

      const observationByScope = new Map(observations.map((item) => [item.scopeKey, item]));
      const authoritative = new Set(normalizedCoverage.authoritativeSerials);
      const inactive = new Set(normalizedCoverage.inactiveSerials);
      let adopted = 0;
      let consolidated = 0;
      let adoptedResolved = 0;
      const resolvedItems: TransitionEventItem[] = [];

      for (const [serial, rows] of [...legacyByScope.entries()].sort(([a], [b]) =>
        a.localeCompare(b),
      )) {
        rows.sort(legacyRank);
        const already = existingByScope.get(serial);
        const survivor = already ? null : (rows.shift() ?? null);
        // A partially migrated database may already link a task whose source
        // still has the old day suffix. Never cancel that task as its own
        // duplicate; normalize its metadata and consolidate only the others.
        const linkedLegacy = already ? rows.find((row) => row.id === already.taskId) : undefined;
        const duplicates = already ? rows.filter((row) => row.id !== already.taskId) : rows;
        if (already && linkedLegacy) {
          await tx
            .update(task)
            .set({
              ownerKind: "human",
              ownerRef: linkedLegacy.ownerKind === "human" ? linkedLegacy.ownerRef : null,
              domain: "vendhub",
              source: VENDING_LOW_STOCK_ISSUE_SOURCE,
              createdBy: VENDING_LOW_STOCK_ISSUE_SOURCE,
              clientKey: lowStockIssueTaskClientKey(already.fingerprint),
            })
            .where(eq(task.id, linkedLegacy.id));
        }

        if (survivor) {
          const observation = inactive.has(serial) ? undefined : observationByScope.get(serial);
          const resolved = !observation && (inactive.has(serial) || authoritative.has(serial));
          const fingerprint = lowStockIssueFingerprint(serial);
          const presentation = observation ? taskPresentation(observation, registry) : null;
          const payload = observation?.payload ?? {
            surface: "low_stock",
            serial,
            observedDay: survivor.day,
            items: [],
            legacy: true,
          };
          const resolutionNote = inactive.has(serial)
            ? "Автомат больше не в строю — задача пополнения закрыта автоматически."
            : "Свежая валидная планограмма больше не показывает низкий остаток — закрыто автоматически.";

          await tx
            .update(task)
            .set({
              ...(presentation
                ? {
                    title: presentation.title,
                    description: presentation.description,
                    entityId: presentation.entityId,
                  }
                : {}),
              domain: "vendhub",
              ownerKind: "human",
              ownerRef: survivor.ownerKind === "human" ? survivor.ownerRef : null,
              source: VENDING_LOW_STOCK_ISSUE_SOURCE,
              createdBy: VENDING_LOW_STOCK_ISSUE_SOURCE,
              clientKey: lowStockIssueTaskClientKey(fingerprint),
              priority: "high",
              ...(resolved
                ? {
                    status: "done" as const,
                    completedAt: now,
                    closedBy: `system:${VENDING_LOW_STOCK_ISSUE_SOURCE}`,
                    confirmedAt: now,
                    confirmedBy: `system:${VENDING_LOW_STOCK_ISSUE_SOURCE}`,
                    resultNote: resolutionNote,
                    quality: "accepted" as const,
                  }
                : {}),
            })
            .where(eq(task.id, survivor.id));

          const [createdIssue] = await tx
            .insert(operationalIssue)
            .values({
              domain: "vendhub",
              kind: VENDING_LOW_STOCK_ISSUE_KIND,
              fingerprint,
              scopeDate: observation?.scopeDate ?? survivor.day,
              scopeKey: serial,
              status: resolved ? "resolved" : "open",
              episode: 1,
              taskId: survivor.id,
              payload,
              firstSeenAt: survivor.createdAt,
              lastSeenAt: observation ? now : survivor.createdAt,
              resolvedAt: resolved ? now : null,
              updatedAt: now,
            })
            .returning({ id: operationalIssue.id });
          if (!createdIssue) throw new Error("DB did not return adopted low-stock issue");

          const adoptedIssue: ExistingLowStockIssue = {
            id: createdIssue.id,
            taskId: survivor.id,
            taskTitle: presentation?.title ?? survivor.title,
            kind: VENDING_LOW_STOCK_ISSUE_KIND,
            fingerprint,
            scopeKey: serial,
            status: resolved ? "resolved" : "open",
            episode: 1,
            taskStatus: resolved ? "done" : survivor.status,
            taskOwnerKind: "human",
            taskOwnerRef: survivor.ownerKind === "human" ? survivor.ownerRef : null,
            payload,
          };
          existing.push(adoptedIssue);
          existingByScope.set(serial, adoptedIssue);
          adopted += 1;
          if (resolved) {
            adoptedResolved += 1;
            resolvedItems.push({
              title: adoptedIssue.taskTitle,
              taskId: survivor.id,
              fingerprint,
              episode: 1,
            });
          }
          await tx.insert(auditLog).values({
            actorKind: "system",
            actorRef: VENDING_LOW_STOCK_ISSUE_SOURCE,
            action: "vending.low_stock_issue.adopted",
            target: createdIssue.id,
            before: { taskId: survivor.id, source: survivor.source, status: survivor.status },
            after: {
              taskId: survivor.id,
              status: resolved ? "resolved" : "open",
              fingerprint,
              payload,
            },
          });
        }

        const targetTaskId = already?.taskId ?? survivor?.id ?? null;
        for (const duplicate of duplicates) {
          await tx
            .update(task)
            .set({
              status: "cancelled",
              completedAt: now,
              closedBy: `system:${VENDING_LOW_STOCK_ISSUE_SOURCE}`,
              confirmedAt: now,
              confirmedBy: `system:${VENDING_LOW_STOCK_ISSUE_SOURCE}`,
              resultNote: targetTaskId
                ? `Дубль объединён с единой живой задачей ${targetTaskId}.`
                : "Устаревший дубль low-stock закрыт проекцией.",
            })
            .where(eq(task.id, duplicate.id));
          await tx.insert(auditLog).values({
            actorKind: "system",
            actorRef: VENDING_LOW_STOCK_ISSUE_SOURCE,
            action: "vending.low_stock_issue.duplicate_cancelled",
            target: duplicate.id,
            before: { status: duplicate.status, source: duplicate.source },
            after: { status: "cancelled", survivorTaskId: targetTaskId },
          });
          consolidated += 1;
        }
      }

      const plan = planLowStockIssues(observations, existing, normalizedCoverage);
      const openedItems: TransitionEventItem[] = [];
      const due = lowStockIssueDue(now);

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
            source: VENDING_LOW_STOCK_ISSUE_SOURCE,
            createdBy: VENDING_LOW_STOCK_ISSUE_SOURCE,
            clientKey: lowStockIssueTaskClientKey(observation.fingerprint),
          })
          .returning({ id: task.id });
        if (!createdTask) throw new Error("DB did not return created low-stock task");

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
        if (!createdIssue) throw new Error("DB did not return created low-stock issue");

        await tx.insert(auditLog).values({
          actorKind: "system",
          actorRef: VENDING_LOW_STOCK_ISSUE_SOURCE,
          action: "vending.low_stock_issue.created",
          target: createdIssue.id,
          after: { taskId: createdTask.id, episode: 1, payload: observation.payload },
        });
        openedItems.push({
          title: presentation.title,
          taskId: createdTask.id,
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
            source: VENDING_LOW_STOCK_ISSUE_SOURCE,
            createdBy: VENDING_LOW_STOCK_ISSUE_SOURCE,
            clientKey: lowStockIssueTaskClientKey(observation.fingerprint),
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
            // Field work stays with its human assignee; an accidental agent
            // assignment is fenced and returned to the common human pool.
            ownerRef: issue.taskOwnerKind === "human" ? issue.taskOwnerRef : null,
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
            source: VENDING_LOW_STOCK_ISSUE_SOURCE,
            createdBy: VENDING_LOW_STOCK_ISSUE_SOURCE,
            clientKey: lowStockIssueTaskClientKey(observation.fingerprint),
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
          actorRef: VENDING_LOW_STOCK_ISSUE_SOURCE,
          action: "vending.low_stock_issue.reopened",
          target: issue.id,
          before: { status: issue.status, taskStatus: issue.taskStatus, episode: issue.episode },
          after: { status: "open", taskStatus: "todo", episode, payload: observation.payload },
        });
        openedItems.push({
          title: presentation.title,
          taskId: issue.taskId,
          fingerprint: issue.fingerprint,
          episode,
        });
      }

      for (const { issue, reason } of plan.resolve) {
        const resultNote =
          reason === "inactive"
            ? "Автомат больше не в строю — задача пополнения закрыта автоматически."
            : "Свежая валидная планограмма больше не показывает низкий остаток — закрыто автоматически.";
        await tx
          .update(operationalIssue)
          .set({ status: "resolved", resolvedAt: now, updatedAt: now })
          .where(eq(operationalIssue.id, issue.id));
        await tx
          .update(task)
          .set({
            status: "done",
            completedAt: now,
            closedBy: `system:${VENDING_LOW_STOCK_ISSUE_SOURCE}`,
            confirmedAt: now,
            confirmedBy: `system:${VENDING_LOW_STOCK_ISSUE_SOURCE}`,
            resultNote,
            quality: "accepted",
          })
          .where(eq(task.id, issue.taskId));
        await tx.insert(auditLog).values({
          actorKind: "system",
          actorRef: VENDING_LOW_STOCK_ISSUE_SOURCE,
          action: "vending.low_stock_issue.resolved",
          target: issue.id,
          before: { status: issue.status, taskStatus: issue.taskStatus, episode: issue.episode },
          after: {
            status: "resolved",
            taskStatus: "done",
            episode: issue.episode,
            reason,
            resolvedAt: now.toISOString(),
          },
        });
        resolvedItems.push({
          title: issue.taskTitle,
          taskId: issue.taskId,
          fingerprint: issue.fingerprint,
          episode: issue.episode,
        });
      }

      if (openedItems.length > 0) {
        await tx
          .insert(event)
          .values({
            source: VENDING_LOW_STOCK_ISSUE_SOURCE,
            type: VENDING_LOW_STOCK_ISSUES_OPENED_EVENT,
            clientKey: transitionEventKey(VENDING_LOW_STOCK_ISSUES_OPENED_EVENT, openedItems),
            // Delivery cursors track event time. `now` is the scan watermark
            // captured before the heavy report, so backdating to it can place a
            // newly committed event behind the bot's five-second overlap.
            occurredAt: new Date(),
            payload: transitionEventPayload(openedItems, plan.reopen.length),
          })
          .onConflictDoNothing({ target: event.clientKey });
      }
      if (resolvedItems.length > 0) {
        await tx
          .insert(event)
          .values({
            source: VENDING_LOW_STOCK_ISSUE_SOURCE,
            type: VENDING_LOW_STOCK_ISSUES_RESOLVED_EVENT,
            clientKey: transitionEventKey(VENDING_LOW_STOCK_ISSUES_RESOLVED_EVENT, resolvedItems),
            occurredAt: new Date(),
            payload: transitionEventPayload(resolvedItems),
          })
          .onConflictDoNothing({ target: event.clientKey });
      }

      await tx
        .insert(operationalProjectionState)
        .values({
          key: VENDING_LOW_STOCK_ISSUE_PROJECTION_KEY,
          watermark: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: operationalProjectionState.key,
          set: { watermark: now, updatedAt: now },
        });

      return {
        observed: observations.length,
        created: plan.create.length,
        adopted,
        consolidated,
        reopened: plan.reopen.length,
        resolved: plan.resolve.length + adoptedResolved,
        unchanged: plan.refresh.length,
        retained: plan.retained.length,
        staleSkipped: false,
      };
    });
  }
}
