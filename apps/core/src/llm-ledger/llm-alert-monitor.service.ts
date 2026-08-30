import { createHash } from "node:crypto";
import {
  ConflictException,
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
  type OnModuleInit,
} from "@nestjs/common";
import { agentTaskLlmJob, event, llmSpend, outboxDelivery } from "@mydon/db";
import { readLlmSettlementOutboxAlertMonitoring } from "@mydon/llm-ledger-outbox";
import {
  TZ,
  type LlmLedgerMonitoring,
  type LlmSettlementOutboxAlertMonitoring,
} from "@mydon/shared";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  type SQL,
} from "drizzle-orm";
import { Cron } from "croner";
import { DB, type Db } from "../db/db.module";
import { EventsService, type RecordEventInput } from "../events/events.service";
import { LLM_STUCK_RESERVATION_THRESHOLD_MINUTES, LlmLedgerService } from "./llm-ledger.service";

export const LLM_ALERT_SOURCE = "llm-alert-monitor";

export const LLM_ALERT_EVENTS = {
  unknown: "llm.incident.unknown",
  dead: "llm.incident.dead",
  stuck: "llm.incident.stuck",
  circuit: "llm.incident.circuit_open",
  budget: "llm.incident.budget",
  recovered: "llm.incident.recovered",
} as const;

type AggregateKind = "stuck_reservations" | "settlement_spool" | "circuit" | "budget";

interface UnknownJobObservation {
  id: string;
  spendId: string | null;
  provider: string;
  model: string;
  feature: string;
  unknownAt: Date | null;
  createdAt: Date;
}

interface UnknownSpendObservation {
  id: string;
  provider: string;
  model: string;
  consumer: string;
  feature: string;
  metadata: unknown;
  failedAt: Date | null;
  createdAt: Date;
}

interface StuckSpendObservation {
  id: string;
  reservedUsd: string;
  reservedAt: Date | null;
  createdAt: Date;
}

interface DeliveryObservation {
  id: string;
  destination: string;
  status: "unknown" | "dead";
  attempts: number;
  completedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
}

export interface LlmAlertSnapshot {
  generatedAt: Date;
  monitoring: LlmLedgerMonitoring;
  unknownJobs: UnknownJobObservation[];
  /** Unknown jobs linked to the spend/stuck page even when job paging differs. */
  linkedUnknownSpendIds?: string[];
  unknownSpends: UnknownSpendObservation[];
  stuckSpends: StuckSpendObservation[];
  deliveries: DeliveryObservation[];
  settlementSpool: LlmSettlementOutboxAlertMonitoring;
}

interface AggregateObservation {
  fingerprint: string;
  eventType: (typeof LLM_ALERT_EVENTS)["stuck" | "circuit" | "budget"];
  payload: Record<string, unknown>;
}

interface ImmutableScanState {
  until: Date | null;
  after: { createdAt: Date; id: string } | null;
}

type BudgetAlertState = "reached" | "below" | "unavailable";
type ImmutableEventInput = RecordEventInput & { clientKey: string };

const IMMUTABLE_SCAN_PAGE = 250;
const EVENT_KEY_BATCH = 250;

/**
 * Proactive, read-only safety monitor for the LLM ledger and its durable
 * delivery layers. It only writes idempotent events; it has no provider/LLM
 * dependency and can therefore still alert while provider admission is shut.
 */
@Injectable()
export class LlmAlertMonitorService implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(LlmAlertMonitorService.name);
  private cron: Cron | null = null;
  private readonly immutableScan = {
    jobs: immutableScanState(),
    spends: immutableScanState(),
    deliveries: immutableScanState(),
  };
  private settlementSpoolDeadOffset = 0;

  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly ledger: LlmLedgerService,
    private readonly events: EventsService,
  ) {}

  onModuleInit(): void {
    this.cron = new Cron("* * * * *", { timezone: TZ, protect: true }, async () => {
      await this.tick();
    });
  }

  onApplicationShutdown(): void {
    this.cron?.stop();
    this.cron = null;
  }

  /** A failed observation never affects LLM admission and is retried next minute. */
  async tick(at = new Date()): Promise<void> {
    try {
      await this.evaluate(at);
    } catch (error) {
      this.logger.warn(
        `LLM alert monitor не отработал: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async evaluate(at = new Date()): Promise<void> {
    await this.reconcile(await this.loadSnapshot(at));
  }

  /** Public deterministic seam: tests prove precedence, dedup and recovery. */
  async reconcile(snapshot: LlmAlertSnapshot): Promise<void> {
    const unknownJobSpendIds = new Set([
      ...snapshot.unknownJobs.flatMap((job) => (job.spendId ? [job.spendId] : [])),
      ...(snapshot.linkedUnknownSpendIds ?? []),
    ]);
    const immutable: ImmutableEventInput[] = [];
    const openCircuitProviders = new Set(
      snapshot.monitoring.openCircuits.map((circuit) => circuit.provider),
    );

    for (const job of [...snapshot.unknownJobs].sort((a, b) => a.id.localeCompare(b.id))) {
      const fingerprint = llmAlertFingerprint("unknown-job", job.id);
      immutable.push({
        source: LLM_ALERT_SOURCE,
        type: LLM_ALERT_EVENTS.unknown,
        clientKey: immutableClientKey("unknown-job", fingerprint),
        payload: {
          kind: "provider_job",
          status: "unknown",
          provider: job.provider,
          model: job.model,
          feature: job.feature,
          occurredAt: iso(job.unknownAt ?? job.createdAt),
          fingerprint,
        },
      });
    }

    for (const spend of [...snapshot.unknownSpends].sort((a, b) => a.id.localeCompare(b.id))) {
      // The durable job is the actionable incident for its own spend. A spend
      // that opened the provider circuit is represented by the circuit alert.
      if (
        unknownJobSpendIds.has(spend.id) ||
        (spendOpenedCircuit(spend.metadata) && openCircuitProviders.has(spend.provider))
      ) {
        continue;
      }
      const fingerprint = llmAlertFingerprint("unknown-spend", spend.id);
      immutable.push({
        source: LLM_ALERT_SOURCE,
        type: LLM_ALERT_EVENTS.unknown,
        clientKey: immutableClientKey("unknown-spend", fingerprint),
        payload: {
          kind: "spend",
          status: "unknown",
          provider: spend.provider,
          model: spend.model,
          consumer: spend.consumer,
          feature: spend.feature,
          occurredAt: iso(spend.failedAt ?? spend.createdAt),
          fingerprint,
        },
      });
    }

    for (const delivery of [...snapshot.deliveries].sort((a, b) => a.id.localeCompare(b.id))) {
      const fingerprint = llmAlertFingerprint(`delivery-${delivery.status}`, delivery.id);
      immutable.push({
        source: LLM_ALERT_SOURCE,
        type: delivery.status === "dead" ? LLM_ALERT_EVENTS.dead : LLM_ALERT_EVENTS.unknown,
        clientKey: immutableClientKey(`delivery-${delivery.status}`, fingerprint),
        payload: {
          kind: "delivery",
          status: delivery.status,
          destination: delivery.destination,
          attempts: Math.max(0, delivery.attempts),
          occurredAt: iso(delivery.completedAt ?? delivery.updatedAt ?? delivery.createdAt),
          fingerprint,
        },
      });
    }

    for (const incident of snapshot.settlementSpool.incidents.filter(
      (candidate) => candidate.state === "dead",
    )) {
      immutable.push({
        source: LLM_ALERT_SOURCE,
        type: LLM_ALERT_EVENTS.dead,
        clientKey: immutableClientKey("settlement-spool-dead", incident.fingerprint),
        payload: {
          kind: "settlement_spool",
          status: "dead",
          producer: incident.producer,
          recordKind: incident.recordKind,
          operation: incident.operation,
          category: incident.category,
          occurredAt: incident.occurredAt,
          fingerprint: incident.fingerprint,
        },
      });
    }

    // Existing immutable rows are common and permanent. One batched lookup
    // avoids doing insert-conflict + reread transactions for them every minute.
    await this.recordNewImmutable(immutable);

    const visibleStuck = snapshot.stuckSpends.filter((spend) => !unknownJobSpendIds.has(spend.id));
    await this.syncAggregate("stuck_reservations", stuckObservation(visibleStuck));
    await this.syncAggregate(
      "settlement_spool",
      settlementSpoolObservation(snapshot.settlementSpool),
      snapshot.settlementSpool.available &&
        snapshot.settlementSpool.complete &&
        snapshot.settlementSpool.unresolvedDeadCount === 0,
    );
    await this.syncAggregate("circuit", circuitObservation(snapshot.monitoring));

    const budgetState = llmBudgetAlertState(snapshot.monitoring.budget);
    await this.syncAggregate(
      "budget",
      budgetState === "reached" ? budgetObservation(snapshot.monitoring) : null,
      budgetState !== "unavailable",
    );
  }

  private async loadSnapshot(at: Date): Promise<LlmAlertSnapshot> {
    const staleBefore = new Date(at.getTime() - LLM_STUCK_RESERVATION_THRESHOLD_MINUTES * 60_000);
    const reservedAtCondition: SQL = or(
      and(isNotNull(llmSpend.reservedAt), lte(llmSpend.reservedAt, staleBefore)),
      and(isNull(llmSpend.reservedAt), lte(llmSpend.createdAt, staleBefore)),
    )!;

    const jobScan = beginImmutableScan(this.immutableScan.jobs, at);
    const spendScan = beginImmutableScan(this.immutableScan.spends, at);
    const deliveryScan = beginImmutableScan(this.immutableScan.deliveries, at);
    const jobAfter: SQL | undefined = jobScan.after
      ? or(
          lt(agentTaskLlmJob.createdAt, jobScan.after.createdAt),
          and(
            eq(agentTaskLlmJob.createdAt, jobScan.after.createdAt),
            gt(agentTaskLlmJob.id, jobScan.after.id),
          ),
        )
      : undefined;
    const spendAfter: SQL | undefined = spendScan.after
      ? or(
          lt(llmSpend.createdAt, spendScan.after.createdAt),
          and(
            eq(llmSpend.createdAt, spendScan.after.createdAt),
            gt(llmSpend.id, spendScan.after.id),
          ),
        )
      : undefined;
    const deliveryAfter: SQL | undefined = deliveryScan.after
      ? or(
          lt(outboxDelivery.createdAt, deliveryScan.after.createdAt),
          and(
            eq(outboxDelivery.createdAt, deliveryScan.after.createdAt),
            gt(outboxDelivery.id, deliveryScan.after.id),
          ),
        )
      : undefined;
    const [monitoring, unknownJobs, unknownSpends, stuckSpends, deliveries, settlementSpool] =
      await Promise.all([
        this.ledger.monitoring(at),
        this.db
          .select({
            id: agentTaskLlmJob.id,
            spendId: agentTaskLlmJob.spendId,
            provider: agentTaskLlmJob.provider,
            model: agentTaskLlmJob.model,
            feature: agentTaskLlmJob.feature,
            unknownAt: agentTaskLlmJob.unknownAt,
            createdAt: agentTaskLlmJob.createdAt,
          })
          .from(agentTaskLlmJob)
          .where(
            and(
              eq(agentTaskLlmJob.status, "unknown"),
              lte(agentTaskLlmJob.createdAt, jobScan.until),
              jobAfter,
            ),
          )
          .orderBy(desc(agentTaskLlmJob.createdAt), asc(agentTaskLlmJob.id))
          .limit(IMMUTABLE_SCAN_PAGE),
        this.db
          .select({
            id: llmSpend.id,
            provider: llmSpend.provider,
            model: llmSpend.model,
            consumer: llmSpend.consumer,
            feature: llmSpend.feature,
            metadata: llmSpend.metadata,
            failedAt: llmSpend.failedAt,
            createdAt: llmSpend.createdAt,
          })
          .from(llmSpend)
          .where(
            and(
              eq(llmSpend.status, "failed"),
              eq(llmSpend.outcome, "unknown"),
              lte(llmSpend.createdAt, spendScan.until),
              spendAfter,
            ),
          )
          .orderBy(desc(llmSpend.createdAt), asc(llmSpend.id))
          .limit(IMMUTABLE_SCAN_PAGE),
        this.db
          .select({
            id: llmSpend.id,
            reservedUsd: llmSpend.reservedUsd,
            reservedAt: llmSpend.reservedAt,
            createdAt: llmSpend.createdAt,
          })
          .from(llmSpend)
          .where(and(eq(llmSpend.status, "reserved"), reservedAtCondition)),
        this.db
          .select({
            id: outboxDelivery.id,
            destination: outboxDelivery.destination,
            status: outboxDelivery.status,
            attempts: outboxDelivery.attempts,
            completedAt: outboxDelivery.completedAt,
            updatedAt: outboxDelivery.updatedAt,
            createdAt: outboxDelivery.createdAt,
          })
          .from(outboxDelivery)
          .where(
            and(
              or(eq(outboxDelivery.status, "unknown"), eq(outboxDelivery.status, "dead")),
              lte(outboxDelivery.createdAt, deliveryScan.until),
              deliveryAfter,
            ),
          )
          .orderBy(desc(outboxDelivery.createdAt), asc(outboxDelivery.id))
          .limit(IMMUTABLE_SCAN_PAGE) as Promise<DeliveryObservation[]>,
        settlementSpoolMonitoring(at, this.settlementSpoolDeadOffset),
      ]);

    advanceImmutableScan(this.immutableScan.jobs, unknownJobs);
    advanceImmutableScan(this.immutableScan.spends, unknownSpends);
    advanceImmutableScan(this.immutableScan.deliveries, deliveries);
    const linkedUnknownSpendIds = await this.findLinkedUnknownSpendIds([
      ...unknownSpends.map((spend) => spend.id),
      ...stuckSpends.map((spend) => spend.id),
    ]);
    this.settlementSpoolDeadOffset = nextDeadScanOffset(
      this.settlementSpoolDeadOffset,
      settlementSpool.unresolvedDeadCount,
    );
    const pagedSettlementSpool = {
      available: settlementSpool.available,
      complete: settlementSpool.complete,
      unresolvedDeadCount: settlementSpool.unresolvedDeadCount,
      // The reader returns every live fallback and one bounded dead page.
      incidents: settlementSpool.incidents,
    };

    return {
      generatedAt: at,
      monitoring,
      unknownJobs,
      linkedUnknownSpendIds,
      unknownSpends,
      stuckSpends,
      deliveries,
      settlementSpool: pagedSettlementSpool,
    };
  }

  private async syncAggregate(
    kind: AggregateKind,
    observation: AggregateObservation | null,
    observable = true,
  ): Promise<void> {
    const source = aggregateSource(kind);
    const [lastOpen, lastRecovery] = await Promise.all([
      this.events.latest({ source, type: aggregateOpenEvent(kind) }),
      this.events.latest({ source, type: LLM_ALERT_EVENTS.recovered }),
    ]);
    const openFingerprint = payloadFingerprint(lastOpen?.payload);
    const recoveredFingerprint = payloadFingerprint(lastRecovery?.payload);
    const activeFingerprint =
      openFingerprint !== null && openFingerprint !== recoveredFingerprint ? openFingerprint : null;

    if (observation) {
      // Budget policy is intentionally one notification per Tashkent day. If
      // exposure dipped below 80% and crossed again the same day, the matching
      // recovery proves the daily alert was already delivered; do not hammer
      // the same idempotency key every minute.
      if (
        kind === "budget" &&
        openFingerprint === observation.fingerprint &&
        recoveredFingerprint === observation.fingerprint
      ) {
        return;
      }
      const notifyChangedEpisode =
        (kind === "circuit" || kind === "budget") &&
        activeFingerprint !== null &&
        activeFingerprint !== observation.fingerprint;
      if (activeFingerprint !== null && !notifyChangedEpisode) return;
      await this.record({
        source,
        type: observation.eventType,
        clientKey: aggregateClientKey(kind, "open", observation.fingerprint),
        payload: { ...observation.payload, fingerprint: observation.fingerprint },
      });
      return;
    }

    // An unavailable spool or invalid budget is unknown, not recovered.
    if (!observable || activeFingerprint === null) return;
    await this.record({
      source,
      type: LLM_ALERT_EVENTS.recovered,
      clientKey: aggregateClientKey(kind, "recovered", activeFingerprint),
      payload: { kind, fingerprint: activeFingerprint },
    });
  }

  private async record(input: RecordEventInput): Promise<void> {
    try {
      await this.events.record(input);
    } catch (error) {
      // Two Core replicas may observe the same incident with slightly
      // different aggregate counters. The unique clientKey already selected
      // the winner, so a 409 here is successful cross-replica dedup.
      if (error instanceof ConflictException || errorStatus(error) === 409) return;
      throw error;
    }
  }

  private async recordNewImmutable(inputs: ImmutableEventInput[]): Promise<void> {
    const unique = new Map(inputs.map((input) => [input.clientKey, input]));
    const ordered = [...unique.values()].sort((left, right) =>
      left.clientKey.localeCompare(right.clientKey),
    );
    for (let offset = 0; offset < ordered.length; offset += EVENT_KEY_BATCH) {
      const batch = ordered.slice(offset, offset + EVENT_KEY_BATCH);
      const keys = batch.map((input) => input.clientKey);
      const rows = await this.db
        .select({ clientKey: event.clientKey })
        .from(event)
        .where(inArray(event.clientKey, keys));
      const existing = new Set(rows.flatMap((row) => (row.clientKey ? [row.clientKey] : [])));
      for (const input of batch) {
        if (!existing.has(input.clientKey)) await this.record(input);
      }
    }
  }

  private async findLinkedUnknownSpendIds(ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    const linked: string[] = [];
    for (let offset = 0; offset < unique.length; offset += EVENT_KEY_BATCH) {
      const batch = unique.slice(offset, offset + EVENT_KEY_BATCH);
      const rows = await this.db
        .select({ spendId: agentTaskLlmJob.spendId })
        .from(agentTaskLlmJob)
        .where(
          and(
            eq(agentTaskLlmJob.status, "unknown"),
            isNotNull(agentTaskLlmJob.spendId),
            inArray(agentTaskLlmJob.spendId, batch),
          ),
        );
      linked.push(...rows.flatMap((row) => (row.spendId ? [row.spendId] : [])));
    }
    return [...new Set(linked)];
  }
}

export function llmBudgetAlertState(budget: LlmLedgerMonitoring["budget"]): BudgetAlertState {
  if (budget.configError || !Number.isFinite(budget.globalCapUsd) || budget.globalCapUsd <= 0) {
    return "unavailable";
  }
  if (!Number.isFinite(budget.globalExposureUsd) || budget.globalExposureUsd < 0) {
    return "unavailable";
  }
  const cap = numberToNano(budget.globalCapUsd);
  const exposure = numberToNano(budget.globalExposureUsd);
  if (cap === null || exposure === null || cap <= 0n) return "unavailable";
  return exposure * 5n >= cap * 4n ? "reached" : "below";
}

export function llmAlertFingerprint(category: string, identity: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ version: 1, category, identity }), "utf8")
    .digest("hex");
}

function immutableClientKey(category: string, fingerprint: string): string {
  return `llm-alert:v1:${category}:${fingerprint}`;
}

function aggregateClientKey(
  kind: AggregateKind,
  state: "open" | "recovered",
  fingerprint: string,
): string {
  return `llm-alert:v1:${kind}:${state}:${fingerprint}`;
}

function aggregateSource(kind: AggregateKind): string {
  return `${LLM_ALERT_SOURCE}:${kind}`;
}

function aggregateOpenEvent(kind: AggregateKind): AggregateObservation["eventType"] {
  if (kind === "stuck_reservations" || kind === "settlement_spool") {
    return LLM_ALERT_EVENTS.stuck;
  }
  if (kind === "circuit") return LLM_ALERT_EVENTS.circuit;
  return LLM_ALERT_EVENTS.budget;
}

function stuckObservation(rows: StuckSpendObservation[]): AggregateObservation | null {
  if (rows.length === 0) return null;
  const ordered = [...rows].sort(
    (left, right) =>
      reservationTimestamp(left).getTime() - reservationTimestamp(right).getTime() ||
      left.id.localeCompare(right.id),
  );
  const oldest = ordered[0]!;
  const fingerprint = llmAlertFingerprint("stuck-reservations", oldest.id);
  return {
    fingerprint,
    eventType: LLM_ALERT_EVENTS.stuck,
    payload: {
      kind: "stuck_reservations",
      count: ordered.length,
      reservedUsd: sumUsd(ordered.map((row) => row.reservedUsd)),
      oldestReservedAt: iso(reservationTimestamp(oldest)),
      thresholdMinutes: LLM_STUCK_RESERVATION_THRESHOLD_MINUTES,
    },
  };
}

function settlementSpoolObservation(
  snapshot: LlmSettlementOutboxAlertMonitoring,
): AggregateObservation | null {
  if (!snapshot.available) return null;
  const stuck = snapshot.incidents
    .filter((incident) => incident.state === "fallback_stuck")
    .sort(
      (left, right) =>
        left.occurredAt.localeCompare(right.occurredAt) ||
        left.fingerprint.localeCompare(right.fingerprint),
    );
  if (stuck.length === 0) return null;
  const oldest = stuck[0]!;
  return {
    fingerprint: llmAlertFingerprint("settlement-spool-stuck", oldest.fingerprint),
    eventType: LLM_ALERT_EVENTS.stuck,
    payload: {
      kind: "settlement_spool",
      status: "stuck",
      count: stuck.length,
      producers: [...new Set(stuck.map((incident) => incident.producer))].sort(),
      oldestAt: oldest.occurredAt,
      thresholdMinutes: LLM_STUCK_RESERVATION_THRESHOLD_MINUTES,
    },
  };
}

function circuitObservation(monitoring: LlmLedgerMonitoring): AggregateObservation | null {
  if (monitoring.openCircuits.length === 0) return null;
  const circuits = [...monitoring.openCircuits].sort(
    (left, right) =>
      left.openedAt.localeCompare(right.openedAt) || left.provider.localeCompare(right.provider),
  );
  const first = circuits[0]!;
  const identity = circuits.map((circuit) => ({
    provider: circuit.provider,
    openedAt: circuit.openedAt,
    resetsAt: circuit.resetsAt,
  }));
  return {
    fingerprint: llmAlertFingerprint("circuit", JSON.stringify({ day: monitoring.day, identity })),
    eventType: LLM_ALERT_EVENTS.circuit,
    payload: {
      kind: "circuit",
      day: monitoring.day,
      count: circuits.length,
      providers: [...new Set(circuits.map((circuit) => circuit.provider))].sort(),
      openedAt: first.openedAt,
      resetsAt: circuits[0]!.resetsAt,
    },
  };
}

function budgetObservation(monitoring: LlmLedgerMonitoring): AggregateObservation {
  const { budget } = monitoring;
  return {
    fingerprint: llmAlertFingerprint("budget-80", monitoring.day),
    eventType: LLM_ALERT_EVENTS.budget,
    payload: {
      kind: "budget",
      day: monitoring.day,
      globalCapUsd: budget.globalCapUsd,
      globalExposureUsd: budget.globalExposureUsd,
      remainingUsd: budget.remainingUsd,
      percent: Math.round((budget.globalExposureUsd / budget.globalCapUsd) * 1_000) / 10,
      thresholdPercent: 80,
    },
  };
}

async function settlementSpoolMonitoring(
  at: Date,
  deadOffset: number,
): Promise<LlmSettlementOutboxAlertMonitoring> {
  const rootDir = (process.env.LLM_LEDGER_OUTBOX_ROOT ?? "").trim();
  if (rootDir === "") {
    return { available: false, complete: false, unresolvedDeadCount: 0, incidents: [] };
  }
  return readLlmSettlementOutboxAlertMonitoring({
    rootDir,
    stuckAfterMs: LLM_STUCK_RESERVATION_THRESHOLD_MINUTES * 60_000,
    deadOffset,
    maxDeadIncidents: IMMUTABLE_SCAN_PAGE,
    clock: () => at,
  });
}

function nextDeadScanOffset(current: number, total: number): number {
  if (total <= 0) return 0;
  const normalized = current % total;
  const next = normalized + IMMUTABLE_SCAN_PAGE;
  return next >= total ? 0 : next;
}

function spendOpenedCircuit(metadata: unknown): boolean {
  if (!isObject(metadata)) return false;
  const ledger = metadata._llmLedger;
  return isObject(ledger) && ledger.circuitOpen === true;
}

function reservationTimestamp(row: StuckSpendObservation): Date {
  return row.reservedAt ?? row.createdAt;
}

function sumUsd(values: string[]): number {
  let total = 0n;
  for (const value of values) total += decimalToNano(value) ?? 0n;
  return Number(total) / 1_000_000_000;
}

function decimalToNano(value: string): bigint | null {
  const match = /^(\d+)(?:\.(\d{1,9}))?$/.exec(value);
  if (!match) return null;
  const whole = match[1]!;
  const fraction = (match[2] ?? "").padEnd(9, "0");
  return BigInt(whole) * 1_000_000_000n + BigInt(fraction || "0");
}

function numberToNano(value: number): bigint | null {
  if (!Number.isFinite(value) || value < 0 || value >= 1e21) return null;
  return decimalToNano(value.toFixed(9));
}

function payloadFingerprint(payload: unknown): string | null {
  if (!isObject(payload)) return null;
  return typeof payload.fingerprint === "string" && /^[a-f0-9]{64}$/.test(payload.fingerprint)
    ? payload.fingerprint
    : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function iso(value: Date): string {
  return Number.isNaN(value.getTime()) ? new Date(0).toISOString() : value.toISOString();
}

function errorStatus(error: unknown): number | null {
  if (!isObject(error) || typeof error.getStatus !== "function") return null;
  try {
    const status = error.getStatus();
    return typeof status === "number" ? status : null;
  } catch {
    return null;
  }
}

function immutableScanState(): ImmutableScanState {
  return { until: null, after: null };
}

function beginImmutableScan(
  state: ImmutableScanState,
  at: Date,
): { until: Date; after: ImmutableScanState["after"] } {
  state.until ??= at;
  return { until: state.until, after: state.after };
}

function advanceImmutableScan(
  state: ImmutableScanState,
  rows: Array<{ id: string; createdAt: Date }>,
): void {
  const last = rows.at(-1);
  if (rows.length >= IMMUTABLE_SCAN_PAGE && last) {
    state.after = { id: last.id, createdAt: last.createdAt };
    return;
  }
  state.until = null;
  state.after = null;
}
