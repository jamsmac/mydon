import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from "@nestjs/common";
import { agent, agentTaskLlmJob, llmModelPrice, llmSpend, systemConfig } from "@mydon/db";
import { readLlmSettlementOutboxMonitoring } from "@mydon/llm-ledger-outbox";
import {
  tashkentDay,
  tashkentDayStartOf,
  type LlmBudgetAction,
  type LlmBudgetSnapshot,
  type LlmLedgerMonitoring,
  type LlmReserveResponse,
  type LlmSettlementOutboxMonitoring,
  type LlmSpendStatus,
} from "@mydon/shared";
import { and, asc, eq, gt, gte, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { meteredLlmRouteEnabled, resolveConfigValue } from "../system/config-spec";
import type {
  LlmTokenUsageDto,
  RecoverPreDispatchLlmDto,
  ReleaseLlmDto,
  ReserveLlmDto,
  SettleLlmDto,
} from "./llm-ledger.dto";
import {
  agentCapValue,
  billableInputTokenCeiling,
  DOCUMENTS_INPUT_OVERHEAD_TOKENS,
  DOCUMENTS_LEDGER_POLICY,
  globalCapValue,
  hashLedgerPayload,
  nanoToNumber,
  nanoToUsd,
  reserveProviderRouteCostNano,
  resolvedModelMatchesCatalogPrice,
  selectCatalogPrice,
  settlementCostNano,
  usdToNano,
  type LedgerPriceSnapshot,
} from "./llm-ledger.money";

export type LlmLedgerTx = Parameters<Parameters<Db["transaction"]>[0]>[0];
export interface LlmLedgerReserveInTxOptions {
  requestKeyForDay?: (day: string) => Promise<string> | string;
}
type Tx = LlmLedgerTx;
type AgentRow = typeof agent.$inferSelect;
type PriceRow = typeof llmModelPrice.$inferSelect;
type SpendRow = typeof llmSpend.$inferSelect;

interface CapValue {
  nano: bigint;
  error?: string;
}

export interface LlmAdmissionPolicy {
  enabled: boolean;
  reservationCapNano: bigint;
  denial?: string;
}

interface Exposure {
  global: bigint;
  agent?: bigint;
}

type NormalizedSettlement = ReturnType<typeof normalizeSettlement>;

export const LLM_STUCK_RESERVATION_THRESHOLD_MINUTES = 5;
export const LLM_PRE_DISPATCH_RECOVERY_REASON =
  "settlement_outbox_reserve_uncertain_before_provider_dispatch";

export interface LlmPreDispatchRecoveryResult {
  status: LlmSpendStatus | "missing";
  replay: boolean;
}

export interface LlmMonitoringFrame {
  day: string;
  start: Date;
  end: Date;
  staleBefore: Date;
}

export interface SettlementAnomaly {
  kind: "missing_resolved_model" | "resolved_model_mismatch" | "missing_usage_or_cost";
  circuitOpen: boolean;
  requestedModel: string;
  resolvedModel?: string;
}

/**
 * Единственная точка решения «можно ли потратить деньги на LLM».
 *
 * Резерв и все settlement/release берут один транзакционный advisory-lock
 * на ташкентские сутки. Поэтому два процесса не могут одновременно
 * прочитать один остаток и оба пройти потолок.
 */
@Injectable()
export class LlmLedgerService {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Read-only, secret-free operational view of the financial ledger.
   *
   * The clock is captured once so a request crossing Tashkent midnight cannot
   * combine yesterday's budget with today's failures/circuit state. The
   * optional argument is intentionally available for deterministic tests.
   */
  async monitoring(at: Date = new Date()): Promise<LlmLedgerMonitoring> {
    const frame = llmMonitoringFrame(at);
    const completedAt = sql`coalesce(${llmSpend.settledAt}, ${llmSpend.failedAt})`;
    const reservedAt = sql`coalesce(${llmSpend.reservedAt}, ${llmSpend.createdAt})`;

    const [
      configRows,
      dailyRows,
      latestRows,
      stuckRows,
      failureRows,
      lastFailureRows,
      circuitRows,
      settlementOutbox,
    ] = await Promise.all([
      this.db.select().from(systemConfig),
      this.db
        .select({
          knownCostUsd: sql<string>`coalesce(sum(
            case
              when ${llmSpend.status} in ('settled', 'failed')
                then coalesce(${llmSpend.actualUsd}, 0)
              else 0
            end
          ), 0)::text`,
          globalExposureUsd: exposureSumSql(),
          reservedUsd: sql<string>`coalesce(sum(
            case when ${llmSpend.status} = 'reserved' then ${llmSpend.reservedUsd} else 0 end
          ), 0)::text`,
        })
        .from(llmSpend)
        .where(eq(llmSpend.day, frame.day)),
      this.db
        .select({
          provider: llmSpend.provider,
          consumer: llmSpend.consumer,
          feature: llmSpend.feature,
          requestedModel: llmSpend.model,
          resolvedModel: llmSpend.resolvedModel,
          status: llmSpend.status,
          outcome: llmSpend.outcome,
          actualUsd: llmSpend.actualUsd,
          cacheCreationInputTokens: llmSpend.cacheCreationInputTokens,
          cacheCreation5mInputTokens: llmSpend.cacheCreation5mInputTokens,
          cacheCreation1hInputTokens: llmSpend.cacheCreation1hInputTokens,
          metadata: llmSpend.metadata,
          settledAt: llmSpend.settledAt,
          failedAt: llmSpend.failedAt,
        })
        .from(llmSpend)
        .where(or(eq(llmSpend.status, "settled"), eq(llmSpend.status, "failed")))
        .orderBy(sql`${completedAt} desc nulls last`, asc(llmSpend.id))
        .limit(1),
      this.db
        .select({
          count: sql<number>`count(*)::int`,
          reservedUsd: sql<string>`coalesce(sum(${llmSpend.reservedUsd}), 0)::text`,
          oldestReservedAt: sql<Date | string | null>`min(${reservedAt})`,
        })
        .from(llmSpend)
        .where(
          and(
            eq(llmSpend.status, "reserved"),
            // Keep a timestamp column on the left so Drizzle applies its Date
            // encoder. Comparing the raw coalesce SQL to a Date leaves the
            // parameter unencoded and postgres-js rejects it before the query.
            or(
              and(isNotNull(llmSpend.reservedAt), lte(llmSpend.reservedAt, frame.staleBefore)),
              and(isNull(llmSpend.reservedAt), lte(llmSpend.createdAt, frame.staleBefore)),
            ),
          ),
        ),
      this.db
        .select({
          count: sql<number>`count(*)::int`,
          providerErrorCount: sql<number>`count(*) filter (
            where ${llmSpend.outcome} = 'provider_error'
          )::int`,
          unknownCount: sql<number>`count(*) filter (
            where ${llmSpend.outcome} = 'unknown'
          )::int`,
        })
        .from(llmSpend)
        .where(failureWindowCondition(frame)),
      this.db
        .select({
          failedAt: llmSpend.failedAt,
          provider: llmSpend.provider,
          requestedModel: llmSpend.model,
          resolvedModel: llmSpend.resolvedModel,
          outcome: llmSpend.outcome,
        })
        .from(llmSpend)
        .where(failureWindowCondition(frame))
        .orderBy(sql`${llmSpend.failedAt} desc nulls last`, asc(llmSpend.id))
        .limit(1),
      this.db
        .select({
          provider: llmSpend.provider,
          failedAt: llmSpend.failedAt,
        })
        .from(llmSpend)
        .where(
          and(
            failureWindowCondition(frame),
            eq(llmSpend.outcome, "unknown"),
            sql`${llmSpend.metadata} -> '_llmLedger' ->> 'circuitOpen' = 'true'`,
          ),
        )
        .orderBy(asc(llmSpend.failedAt), asc(llmSpend.provider)),
      settlementOutboxMonitoring(at),
    ]);

    const config = rowsToConfig(configRows);
    const globalCap = parseCap(globalCapValue(config, process.env), "глобальный LLM-потолок");

    // Действующая ли цена у выбранной модели. Тот же провайдер/модель и тот же
    // критерий, что использует reserve: если маршрут метрируемый и цены нет,
    // ledger молча отклонит все вызовы — статус обязан показать это явно.
    const priceProvider = resolveConfigValue("LLM_PRICE_PROVIDER_ID", config, process.env);
    const priceModel = resolveConfigValue("LLM_MODEL", config, process.env);
    const meteredEnabled = meteredLlmRouteEnabled(
      resolveConfigValue("LLM_ENABLED", config, process.env),
      resolveConfigValue("LLM_ROUTE", config, process.env),
    );
    const activePrice = await findActiveCatalogPrice(this.db, priceProvider, priceModel, at);
    const daily = dailyRows[0];
    const knownCost = moneyNano(daily?.knownCostUsd);
    const exposure = moneyNano(daily?.globalExposureUsd);
    const reserved = moneyNano(daily?.reservedUsd);
    const remaining = globalCap.nano > exposure ? globalCap.nano - exposure : 0n;
    const stuck = stuckRows[0];
    const failures = failureRows[0];

    return {
      generatedAt: at.toISOString(),
      day: frame.day,
      settlementOutbox,
      budget: {
        globalCapUsd: nanoToNumber(globalCap.nano),
        knownCostUsd: nanoToNumber(knownCost),
        globalExposureUsd: nanoToNumber(exposure),
        reservedUsd: nanoToNumber(reserved),
        remainingUsd: nanoToNumber(remaining),
        ...(globalCap.error ? { configError: globalCap.error } : {}),
      },
      latestCompleted: monitoringLatestCompleted(latestRows[0]),
      stuckReservations: {
        thresholdMinutes: LLM_STUCK_RESERVATION_THRESHOLD_MINUTES,
        count: nonNegativeCount(stuck?.count),
        reservedUsd: nanoToNumber(moneyNano(stuck?.reservedUsd)),
        oldestReservedAt: nullableIso(stuck?.oldestReservedAt),
      },
      failuresToday: {
        count: nonNegativeCount(failures?.count),
        providerErrorCount: nonNegativeCount(failures?.providerErrorCount),
        unknownCount: nonNegativeCount(failures?.unknownCount),
        last: monitoringLastFailure(lastFailureRows[0]),
      },
      openCircuits: monitoringOpenCircuits(circuitRows, frame.end),
      catalogPrice: {
        meteredEnabled,
        provider: priceProvider,
        model: priceModel,
        hasActivePrice: activePrice !== undefined,
      },
    };
  }

  async reserve(dto: ReserveLlmDto): Promise<LlmReserveResponse> {
    return this.db.transaction((tx) => this.reserveInTx(tx, dto));
  }

  /**
   * Closes an ambiguous reserve only when the caller knows provider dispatch
   * never happened. The endpoint intentionally accepts requestKey rather than
   * reservation id because a lost reserve response never revealed that id.
   */
  async recoverPreDispatch(
    dto: RecoverPreDispatchLlmDto,
  ): Promise<LlmPreDispatchRecoveryResult> {
    return this.db.transaction((tx) => this.recoverPreDispatchInTx(tx, dto));
  }

  async recoverPreDispatchInTx(
    tx: LlmLedgerTx,
    dto: RecoverPreDispatchLlmDto,
  ): Promise<LlmPreDispatchRecoveryResult> {
    const requestKey = dto.requestKey.trim();
    const hint = await preDispatchRecoveryHint(tx, requestKey);
    if (!hint) return { status: "missing", replay: true };

    // Same global order as reserve/settle/release. The hint columns are
    // immutable, and the row is re-read FOR UPDATE after all advisory locks.
    await lock(tx, `llm-provider-circuit:${hint.provider}`);
    await lock(tx, `llm-request:${requestKey}`);
    await lock(tx, `llm-budget:${hint.day}`);

    const row = await spendByRequestKeyForUpdate(tx, requestKey);
    if (!row) return { status: "missing", replay: true };
    await assertNotTaskJobSpend(tx, row.id);

    if (row.status !== "reserved") {
      return { status: row.status, replay: true };
    }

    const now = new Date();
    await tx
      .update(llmSpend)
      .set({
        status: "released",
        reason: LLM_PRE_DISPATCH_RECOVERY_REASON,
        releasedAt: now,
        updatedAt: now,
      })
      .where(eq(llmSpend.id, row.id));
    return { status: "released", replay: false };
  }

  /** Internal composition point for task job + financial authorization. */
  async reserveInTx(
    tx: LlmLedgerTx,
    dto: ReserveLlmDto,
    options: LlmLedgerReserveInTxOptions = {},
  ): Promise<LlmReserveResponse> {
    let request = normalizeReserve(dto);

    {
      // Все ledger-операции держат один порядок: provider -> request -> budget.
      // Это линеаризует provider circuit и idempotency, не создавая цикла с
      // settlement/release на историческом billing day.
      await lock(tx, `llm-provider-circuit:${request.provider}`);
      let now: Date;
      let day: string;
      if (options.requestKeyForDay) {
        // Task jobs derive their idempotency key from the ledger day. Acquire
        // each candidate request lock before its budget lock, then re-check
        // the clock after both waits. Old locks are harmless if midnight
        // advances; this order cannot form request<->budget lock inversion.
        let cursor = new Date();
        for (;;) {
          const candidateDay = tashkentDay(cursor);
          const requestKey = await options.requestKeyForDay(candidateDay);
          request = normalizeReserve({ ...dto, requestKey });
          await lock(tx, `llm-request:${request.requestKey}`);
          const afterRequestLock = new Date();
          if (tashkentDay(afterRequestLock) !== candidateDay) {
            cursor = afterRequestLock;
            continue;
          }
          await lock(tx, `llm-budget:${candidateDay}`);
          const afterBudgetLock = new Date();
          if (tashkentDay(afterBudgetLock) === candidateDay) {
            now = afterBudgetLock;
            day = candidateDay;
            break;
          }
          cursor = afterBudgetLock;
        }
      } else {
        await lock(tx, `llm-request:${request.requestKey}`);
        // request_key уникален не только внутри суток. Дневной lock выбирается
        // после потенциального ожидания и перепроверяется после его получения:
        // вчерашний timestamp не должен авторизовать вызов уже в новых сутках.
        ({ now, day } = await stabilizeLedgerDay((currentDay) =>
          lock(tx, `llm-budget:${currentDay}`),
        ));
      }
      const requestHash = hashLedgerPayload(request);

      const [prior] = await tx
        .select()
        .from(llmSpend)
        .where(eq(llmSpend.requestKey, request.requestKey))
        .limit(1)
        .for("update");

      const config = await configMap(tx);
      const globalCap = parseCap(globalCapValue(config, process.env), "глобальный LLM-потолок");
      const admission = resolveLlmAdmissionPolicy(config, process.env);
      const requestPolicyDenial = flatOpenAiPriceTierDenial(request);

      if (prior) {
        const priorAgent = prior.agentId ? await agentById(tx, prior.agentId) : undefined;
        const perAgentCap = prior.agentId
          ? parseCap(
              agentCapValue(priorAgent?.budgetPerDayUsd ?? null, config, process.env),
              `потолок агента ${prior.agentName ?? prior.agentId}`,
            )
          : undefined;
        const exposure = await readExposure(tx, day, prior.agentId);
        const snapshot = budget(day, globalCap.nano, exposure, perAgentCap?.nano);
        const currentAction = budgetAction(priorAgent?.budgetOnExceeded);
        const globalExposureDenial =
          exposure.global > globalCap.nano
            ? `Текущая LLM-экспозиция $${nanoToUsd(exposure.global)} выше нового дневного потолка $${nanoToUsd(globalCap.nano)}`
            : undefined;
        const agentExposureDenial =
          perAgentCap && (exposure.agent ?? 0n) > perAgentCap.nano
            ? `Текущая LLM-экспозиция агента ${prior.agentName ?? prior.agentId} выше нового дневного потолка`
            : undefined;
        const currentPolicyDenial =
          admission.denial ??
          requestPolicyDenial ??
          globalCap.error ??
          perAgentCap?.error ??
          (prior.day !== day
            ? `LLM-reserve относится к ташкентским суткам ${prior.day}; повтор в текущих сутках ${day} запрещён`
            : undefined) ??
          globalExposureDenial ??
          agentExposureDenial ??
          reservationLimitDenial(
            usdToNano(prior.reservedUsd, "ceil"),
            admission.reservationCapNano,
          );
        if (currentPolicyDenial) {
          return {
            allowed: false,
            status: prior.status,
            action: currentAction,
            reason: currentPolicyDenial,
            replayBlocked: true,
            budget: snapshot,
          };
        }
        if (prior.requestHash !== requestHash) {
          return {
            allowed: false,
            status: prior.status,
            action: currentAction,
            reason:
              "requestKey уже использован с другим reserve-payload; повторный provider call запрещён",
            replayBlocked: true,
            budget: snapshot,
          };
        }
        if (prior.status === "denied") {
          const action = storedDenialAction(prior.metadata, currentAction);
          return {
            allowed: false,
            status: "denied",
            action,
            reason: prior.reason ?? "Core не разрешил платный вызов LLM",
            budget: snapshot,
          };
        }
        if (prior.status !== "reserved") {
          return {
            allowed: false,
            status: prior.status,
            action: currentAction,
            reason: `requestKey уже закрыт статусом ${prior.status}; повторный provider call запрещён`,
            replayBlocked: true,
            budget: snapshot,
          };
        }
        const priceRows = await activeProviderPrices(tx, request.provider, now);
        const activePriceRow = selectCatalogPrice(priceRows, request.model);
        if (!activePriceRow) {
          return {
            allowed: false,
            status: prior.status,
            action: currentAction,
            reason: `В Core больше нет действующей цены ${request.provider}/${request.model}; replay запрещён`,
            replayBlocked: true,
            budget: snapshot,
          };
        }
        const activePrice = snapshotOf(activePriceRow);
        let storedPrice: LedgerPriceSnapshot;
        try {
          storedPrice = parseSnapshot(prior.priceSnapshot);
        } catch {
          return {
            allowed: false,
            status: prior.status,
            action: currentAction,
            reason: "Сохранённый LLM price snapshot повреждён; replay запрещён",
            replayBlocked: true,
            budget: snapshot,
          };
        }
        if (
          prior.priceId !== activePriceRow.id ||
          hashLedgerPayload(storedPrice) !== hashLedgerPayload(activePrice)
        ) {
          return {
            allowed: false,
            status: prior.status,
            action: currentAction,
            reason: `Действующая цена ${request.provider}/${request.model} изменилась после reserve; replay запрещён`,
            replayBlocked: true,
            budget: snapshot,
          };
        }
        let currentRouteReserveNano: bigint;
        try {
          currentRouteReserveNano = reserveProviderRouteCostNano(
            activePrice,
            priceRows.map(snapshotOf),
            request,
          );
        } catch (error) {
          return {
            allowed: false,
            status: prior.status,
            action: currentAction,
            reason:
              error instanceof Error
                ? `Действующий LLM-тариф непригоден для replay: ${error.message}`
                : "Действующий LLM-тариф непригоден для replay",
            replayBlocked: true,
            budget: snapshot,
          };
        }
        if (currentRouteReserveNano > usdToNano(prior.reservedUsd, "ceil")) {
          return {
            allowed: false,
            status: prior.status,
            action: currentAction,
            reason: `Текущий консервативный reserve $${nanoToUsd(currentRouteReserveNano)} выше сохранённого $${prior.reservedUsd}; replay запрещён`,
            replayBlocked: true,
            budget: snapshot,
          };
        }
        return allowedResponse(prior, true, snapshot, currentAction);
      }

      const resolvedAgent = await resolveAgent(tx, request.consumer, request.agentName);
      const perAgentCap = resolvedAgent.row
        ? parseCap(
            agentCapValue(resolvedAgent.row.budgetPerDayUsd, config, process.env),
            `потолок агента ${resolvedAgent.row.name}`,
          )
        : undefined;
      const exposure = await readExposure(tx, day, resolvedAgent.row?.id);
      const priceRows = await activeProviderPrices(tx, request.provider, now);
      const priceRow = selectCatalogPrice(priceRows, request.model);
      const price = priceRow ? snapshotOf(priceRow) : undefined;
      const routedModels =
        request.consumer === "agents" || request.consumer === "embeddings"
          ? priceRows.map((row) => row.model).sort()
          : undefined;
      const openCircuit = await providerCircuit(tx, now, request.provider);

      let reserveNano = 0n;
      let denial =
        admission.denial ??
        requestPolicyDenial ??
        globalCap.error ??
        perAgentCap?.error ??
        resolvedAgent.error ??
        (openCircuit
          ? `LLM provider ${request.provider} заблокирован до ручной сверки/новых суток: ${openCircuit}`
          : undefined);
      if (!denial && !price) {
        denial = `В Core нет действующей цены ${request.provider}/${request.model}`;
      }
      if (!denial && price) {
        try {
          reserveNano = reserveProviderRouteCostNano(price, priceRows.map(snapshotOf), request);
        } catch (error) {
          denial = error instanceof Error ? error.message : "Тариф LLM непригоден для резерва";
        }
      }
      if (!denial) {
        denial = reservationLimitDenial(reserveNano, admission.reservationCapNano);
      }
      if (!denial && exposure.global + reserveNano > globalCap.nano) {
        denial = `Дневной LLM-потолок исчерпан: резерв $${nanoToUsd(reserveNano)} не помещается`;
      }
      if (!denial && perAgentCap && (exposure.agent ?? 0n) + reserveNano > perAgentCap.nano) {
        denial = `Дневной потолок агента ${resolvedAgent.row?.name ?? ""} исчерпан`;
      }

      const action = budgetAction(resolvedAgent.row?.budgetOnExceeded);
      const common = {
        requestKey: request.requestKey,
        requestHash,
        traceKey: request.traceKey ?? null,
        consumer: request.consumer,
        feature: request.feature,
        agentId: resolvedAgent.row?.id ?? null,
        agentName: resolvedAgent.row?.name ?? request.agentName ?? null,
        provider: request.provider,
        model: request.model,
        priceId: priceRow?.id ?? null,
        priceSnapshot: price ?? {},
        day,
        inputTokenCeiling: price
          ? billableInputTokenCeiling(price, request.consumer, request.inputTokenCeiling)
          : request.inputTokenCeiling,
        outputTokenCeiling: request.outputTokenCeiling,
        reservedUsd: nanoToUsd(reserveNano),
        metadata: reserveMetadata(request.metadata, request.consumer, undefined, routedModels),
        updatedAt: now,
      };

      if (denial) {
        await tx.insert(llmSpend).values({
          ...common,
          status: "denied",
          reason: denial,
          metadata: reserveMetadata(request.metadata, request.consumer, action, routedModels),
          deniedAt: now,
        });
        return {
          allowed: false,
          status: "denied",
          action,
          reason: denial,
          budget: budget(day, globalCap.nano, exposure, perAgentCap?.nano),
        };
      }

      const [created] = await tx
        .insert(llmSpend)
        .values({
          ...common,
          status: "reserved",
          reservedAt: now,
        })
        .returning();
      const after: Exposure = {
        global: exposure.global + reserveNano,
        ...(exposure.agent !== undefined ? { agent: exposure.agent + reserveNano } : {}),
      };
      return allowedResponse(
        created,
        false,
        budget(day, globalCap.nano, after, perAgentCap?.nano),
        action,
      );
    }
  }

  async settle(
    id: string,
    dto: SettleLlmDto,
  ): Promise<{ status: "settled" | "failed"; replay: boolean }> {
    return this.db.transaction((tx) => this.settleInTx(tx, id, dto));
  }

  /** Internal composition point for immutable result + financial settlement. */
  async settleInTx(
    tx: LlmLedgerTx,
    id: string,
    dto: SettleLlmDto,
    options: { allowTaskJobSpend?: boolean } = {},
  ): Promise<{ status: "settled" | "failed"; replay: boolean }> {
    const settlement = normalizeSettlement(dto);
    const settlementHash = hashLedgerPayload(settlement);

    {
      const hint = await spendHint(tx, id);
      await lock(tx, `llm-provider-circuit:${hint.provider}`);
      await lock(tx, `llm-request:${hint.requestKey}`);
      await lock(tx, `llm-budget:${hint.day}`);
      const row = await spendForUpdate(tx, id);
      if (!options.allowTaskJobSpend) await assertNotTaskJobSpend(tx, id);
      const detectedAt = new Date();

      if (row.status === "settled" || row.status === "failed") {
        if (row.settlementHash === settlementHash) return { status: row.status, replay: true };
        throw new ConflictException("LLM-резерв уже закрыт другим settlement");
      }
      if (row.status !== "reserved") {
        throw new ConflictException(`LLM-резерв в статусе ${row.status}; settlement невозможен`);
      }

      const price = parseSnapshot(row.priceSnapshot);
      const snapshotActualNano = settlementCostNano(price, {
        consumer: row.consumer,
        feature: row.feature,
        ...(settlement.usage ? { usage: settlement.usage } : {}),
        ...(settlement.providerReportedUsd !== undefined
          ? { providerReportedUsd: settlement.providerReportedUsd }
          : {}),
      });
      const anomaly = classifySettlementAnomaly(price, settlement, snapshotActualNano);
      const actualNano = anomaly
        ? await anomalyActualNano(tx, row, settlement, snapshotActualNano)
        : snapshotActualNano;
      const success = settlement.outcome === "success" && anomaly === undefined;
      const storedOutcome = anomaly ? "unknown" : settlement.outcome;
      const usage = settlement.usage;
      await tx
        .update(llmSpend)
        .set({
          status: success ? "settled" : "failed",
          outcome: storedOutcome,
          settlementHash,
          actualUsd: actualNano === null ? null : nanoToUsd(actualNano),
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
          cacheReadInputTokens: usage?.cacheReadInputTokens ?? null,
          cacheCreationInputTokens: usage?.cacheCreationInputTokens ?? null,
          cacheCreation5mInputTokens: usage?.cacheCreation5mInputTokens ?? null,
          cacheCreation1hInputTokens: usage?.cacheCreation1hInputTokens ?? null,
          codeExecutionRequests: usage?.codeExecutionRequests ?? null,
          providerRequestId: settlement.providerRequestId ?? null,
          resolvedModel: settlement.resolvedModel ?? null,
          reason: anomaly ? anomalyReason(anomaly) : (settlement.reason ?? null),
          metadata: mergeSettlementMetadata(
            row.metadata,
            settlement.metadata,
            storedOutcome === "unknown" && actualNano !== null,
            anomaly,
          ),
          settledAt: success ? detectedAt : null,
          failedAt: success ? null : detectedAt,
          updatedAt: detectedAt,
        })
        .where(eq(llmSpend.id, id));
      // failed + actual=null намеренно оставляет exposure=reserved_usd:
      // неизвестный сетевой исход не доказывает, что провайдер не списал деньги.
      return { status: success ? "settled" : "failed", replay: false };
    }
  }

  async release(id: string, dto: ReleaseLlmDto): Promise<{ status: "released"; replay: boolean }> {
    return this.db.transaction((tx) => this.releaseInTx(tx, id, dto));
  }

  /** Internal composition point for job cancellation + reservation release. */
  async releaseInTx(
    tx: LlmLedgerTx,
    id: string,
    dto: ReleaseLlmDto,
    options: { allowTaskJobSpend?: boolean } = {},
  ): Promise<{ status: "released"; replay: boolean }> {
    const reason = dto.reason.trim();
    {
      const hint = await spendHint(tx, id);
      await lock(tx, `llm-provider-circuit:${hint.provider}`);
      await lock(tx, `llm-request:${hint.requestKey}`);
      await lock(tx, `llm-budget:${hint.day}`);
      const row = await spendForUpdate(tx, id);
      if (!options.allowTaskJobSpend) await assertNotTaskJobSpend(tx, id);

      if (row.status === "released" && row.reason === reason) {
        return { status: "released", replay: true };
      }
      if (row.status !== "reserved") {
        throw new ConflictException(`LLM-резерв в статусе ${row.status}; release невозможен`);
      }
      await tx
        .update(llmSpend)
        .set({ status: "released", reason, releasedAt: new Date(), updatedAt: new Date() })
        .where(eq(llmSpend.id, id));
      return { status: "released", replay: false };
    }
  }
}

/**
 * Единый fail-closed policy для всех reserve-потребителей Core.
 * Значения резолвятся тем же DB > env > fallback правилом, что и UI.
 */
export function resolveLlmAdmissionPolicy(
  config: Record<string, string>,
  env: Record<string, string | undefined>,
): LlmAdmissionPolicy {
  const enabled = resolveConfigValue("LLM_ENABLED", config, env) === "1";
  const cap = parseCap(
    resolveConfigValue("LLM_MAX_RESERVATION_USD", config, env),
    "максимум одного LLM-reserve",
  );
  return {
    enabled,
    reservationCapNano: cap.nano,
    ...(!enabled
      ? { denial: "LLM выключен: LLM_ENABLED должен быть равен 1" }
      : cap.error
        ? { denial: cap.error }
        : {}),
  };
}

/** Плоский каталог пока не умеет surcharge всего GPT-5.6 Sol request после 272K input. */
export function flatOpenAiPriceTierDenial(
  request: Pick<ReserveLlmDto, "provider" | "model" | "inputTokenCeiling">,
): string | undefined {
  return request.provider === "openai" &&
    request.model === "gpt-5.6-sol" &&
    request.inputTokenCeiling > 272_000
    ? "OpenAI gpt-5.6-sol: inputTokenCeiling выше 272000 заблокирован, пока каталог не умеет tier surcharge"
    : undefined;
}

/** Равный cap reserve допустим; отклоняем только строгое превышение. */
export function reservationLimitDenial(reserveNano: bigint, capNano: bigint): string | undefined {
  return reserveNano > capNano
    ? `Один LLM-reserve $${nanoToUsd(reserveNano)} превышает потолок $${nanoToUsd(capNano)}`
    : undefined;
}

async function lock(tx: Tx, key: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

/**
 * Acquires the budget lock for the day that is still current after the lock
 * wait. On a midnight rollover the transaction keeps the old lock and moves
 * forward to the new day, so no reserve can escape either day's serialization.
 */
export async function stabilizeLedgerDay(
  acquireBudgetDay: (day: string) => Promise<void>,
  clock: () => Date = () => new Date(),
): Promise<{ now: Date; day: string }> {
  let beforeLock = clock();
  for (;;) {
    const candidateDay = tashkentDay(beforeLock);
    await acquireBudgetDay(candidateDay);
    const afterLock = clock();
    if (tashkentDay(afterLock) === candidateDay) {
      return { now: afterLock, day: candidateDay };
    }
    beforeLock = afterLock;
  }
}

async function configMap(tx: Tx): Promise<Record<string, string>> {
  const rows = await tx.select().from(systemConfig);
  return rowsToConfig(rows);
}

function rowsToConfig(rows: ReadonlyArray<{ key: string; value: string }>): Record<string, string> {
  const map: Record<string, string> = {};
  for (const row of rows) map[row.key] = row.value;
  return map;
}

function failureWindowCondition(frame: Pick<LlmMonitoringFrame, "start" | "end">) {
  return and(
    eq(llmSpend.status, "failed"),
    or(eq(llmSpend.outcome, "provider_error"), eq(llmSpend.outcome, "unknown")),
    gte(llmSpend.failedAt, frame.start),
    lt(llmSpend.failedAt, frame.end),
  );
}

interface MonitoringLatestRow {
  provider: string;
  consumer: SpendRow["consumer"];
  feature: string;
  requestedModel: string;
  resolvedModel: string | null;
  status: SpendRow["status"];
  outcome: SpendRow["outcome"];
  actualUsd: string | null;
  cacheCreationInputTokens: number | null;
  cacheCreation5mInputTokens: number | null;
  cacheCreation1hInputTokens: number | null;
  metadata: unknown;
  settledAt: Date | null;
  failedAt: Date | null;
}

function monitoringLatestCompleted(
  row: MonitoringLatestRow | undefined,
): LlmLedgerMonitoring["latestCompleted"] {
  if (!row || (row.status !== "settled" && row.status !== "failed")) return null;
  const completedAt = row.status === "settled" ? row.settledAt : row.failedAt;
  const completedAtIso = nullableIso(completedAt);
  if (!completedAtIso) return null;
  const hasCost = row.actualUsd !== null;
  const hasLowerBound =
    row.consumer === "documents" || ledgerMetadataBoolean(row.metadata, "lowerBound");
  const hasAggregateOnlyCacheCost =
    row.cacheCreationInputTokens !== null &&
    row.cacheCreationInputTokens !== undefined &&
    row.cacheCreationInputTokens > 0 &&
    row.cacheCreation5mInputTokens == null &&
    row.cacheCreation1hInputTokens == null;
  const costBasis = !hasCost
    ? "unknown"
    : hasLowerBound && hasAggregateOnlyCacheCost
      ? "estimate"
      : hasLowerBound
        ? "lower_bound"
        : hasAggregateOnlyCacheCost
          ? "upper_bound"
          : "actual";
  return {
    provider: row.provider,
    consumer: row.consumer,
    feature: row.feature,
    requestedModel: row.requestedModel,
    resolvedModel: row.resolvedModel,
    status: row.status,
    outcome: row.outcome,
    costUsd: hasCost ? nanoToNumber(moneyNano(row.actualUsd)) : null,
    costBasis,
    completedAt: completedAtIso,
  };
}

interface MonitoringFailureRow {
  failedAt: Date | null;
  provider: string;
  requestedModel: string;
  resolvedModel: string | null;
  outcome: SpendRow["outcome"];
}

function monitoringLastFailure(
  row: MonitoringFailureRow | undefined,
): LlmLedgerMonitoring["failuresToday"]["last"] {
  const failedAt = nullableIso(row?.failedAt);
  if (!row || !failedAt || (row.outcome !== "provider_error" && row.outcome !== "unknown")) {
    return null;
  }
  return {
    failedAt,
    provider: row.provider,
    requestedModel: row.requestedModel,
    resolvedModel: row.resolvedModel,
    outcome: row.outcome,
    reason:
      row.outcome === "provider_error" ? "Provider вернул ошибку" : "Исход запроса неизвестен",
  };
}

interface MonitoringCircuitRow {
  provider: string;
  failedAt: Date | null;
}

function monitoringOpenCircuits(
  rows: readonly MonitoringCircuitRow[],
  resetsAt: Date,
): LlmLedgerMonitoring["openCircuits"] {
  const byProvider = new Map<string, { openedAt: string; reason: string | null }>();
  for (const row of rows) {
    const openedAt = nullableIso(row.failedAt);
    if (!openedAt) continue;
    const prior = byProvider.get(row.provider);
    if (!prior || openedAt < prior.openedAt) {
      byProvider.set(row.provider, { openedAt, reason: "Аномалия модели открыла circuit" });
    }
  }
  const resetIso = resetsAt.toISOString();
  return [...byProvider.entries()]
    .map(([provider, value]) => ({
      provider,
      openedAt: value.openedAt,
      resetsAt: resetIso,
      reason: value.reason,
    }))
    .sort(
      (left, right) =>
        left.openedAt.localeCompare(right.openedAt) || left.provider.localeCompare(right.provider),
    );
}

function ledgerMetadataBoolean(metadata: unknown, key: string): boolean {
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const internal = (metadata as Record<string, unknown>)._llmLedger;
  if (internal === null || typeof internal !== "object" || Array.isArray(internal)) return false;
  return (internal as Record<string, unknown>)[key] === true;
}

function moneyNano(value: string | number | null | undefined): bigint {
  return usdToNano(value ?? "0", "ceil");
}

function nonNegativeCount(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

function nullableIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

async function resolveAgent(
  tx: Tx,
  consumer: string,
  agentName: string | undefined,
): Promise<{ row?: AgentRow; error?: string }> {
  if (!agentName) {
    return consumerRequiresAgent(consumer)
      ? { error: `Вызов consumer=${consumer} требует agentName` }
      : {};
  }
  const [row] = await tx
    .select()
    .from(agent)
    .where(and(eq(agent.name, agentName), isNull(agent.archivedAt)))
    .limit(1);
  return row ? { row } : { error: `Агент "${agentName}" не найден или архивирован` };
}

export function consumerRequiresAgent(consumer: string): boolean {
  return consumer === "agents" || consumer === "embeddings";
}

async function agentById(tx: Tx, id: string): Promise<AgentRow | undefined> {
  const [row] = await tx.select().from(agent).where(eq(agent.id, id)).limit(1);
  return row;
}

async function activeProviderPrices(tx: Tx | Db, provider: string, at: Date): Promise<PriceRow[]> {
  return tx
    .select()
    .from(llmModelPrice)
    .where(
      and(
        eq(llmModelPrice.provider, provider),
        lte(llmModelPrice.validFrom, at),
        or(isNull(llmModelPrice.validTo), gt(llmModelPrice.validTo, at)),
      ),
    );
}

/**
 * Действующая каталожная цена для `provider/model` на момент `at`, или
 * `undefined`, если её нет. ЕДИНЫЙ критерий с fail-closed `reserve`
 * (`activeProviderPrices` + `selectCatalogPrice`): валидация профиля и статус
 * не должны расходиться с ledger в ответе «есть ли цена». Экспортируется как
 * чистая функция — потребителю (SystemService) не нужен ни DI, ни импорт
 * класса сервиса.
 */
export async function findActiveCatalogPrice(
  db: Tx | Db,
  provider: string,
  model: string,
  at: Date,
): Promise<PriceRow | undefined> {
  return selectCatalogPrice(await activeProviderPrices(db, provider, at), model);
}

export function providerCircuitWindow(at: Date): { start: Date; end: Date } {
  const start = tashkentDayStartOf(at);
  return { start, end: new Date(start.getTime() + 86_400_000) };
}

/** One coherent Tashkent-day frame for every monitoring query. */
export function llmMonitoringFrame(at: Date): LlmMonitoringFrame {
  const { start, end } = providerCircuitWindow(at);
  return {
    day: tashkentDay(at),
    start,
    end,
    staleBefore: new Date(at.getTime() - LLM_STUCK_RESERVATION_THRESHOLD_MINUTES * 60_000),
  };
}

async function settlementOutboxMonitoring(
  at: Date,
): Promise<LlmSettlementOutboxMonitoring> {
  const rootDir = (process.env.LLM_LEDGER_OUTBOX_ROOT ?? "").trim();
  if (rootDir === "") return unavailableSettlementOutboxMonitoring();
  try {
    return await readLlmSettlementOutboxMonitoring({ rootDir, clock: () => at });
  } catch {
    // Monitoring must stay secret-free and must not take the System page down
    // when a read-only host mount is temporarily unavailable.
    return unavailableSettlementOutboxMonitoring();
  }
}

function unavailableSettlementOutboxMonitoring(): LlmSettlementOutboxMonitoring {
  return {
    available: false,
    pendingCount: 0,
    retryingCount: 0,
    processingCount: 0,
    deadCount: 0,
    fallbackCount: 0,
    exactCount: 0,
    oldestPendingAt: null,
    nextRetryAt: null,
    maxAttempts: 0,
  };
}

async function providerCircuit(tx: Tx, at: Date, provider: string): Promise<string | undefined> {
  const { start, end } = providerCircuitWindow(at);
  const [row] = await tx
    .select({ reason: llmSpend.reason })
    .from(llmSpend)
    .where(
      and(
        eq(llmSpend.provider, provider),
        eq(llmSpend.status, "failed"),
        eq(llmSpend.outcome, "unknown"),
        gte(llmSpend.failedAt, start),
        lt(llmSpend.failedAt, end),
        sql`${llmSpend.metadata} -> '_llmLedger' ->> 'circuitOpen' = 'true'`,
      ),
    )
    .limit(1);
  return row ? (row.reason ?? "аномалия resolved model") : undefined;
}

/**
 * A successful paid response is settleable only when the physical model is
 * known, compatible with the reserved SKU, and its price can be computed.
 * Anything else is persisted as unknown rather than left as an orphan reserve.
 */
export function classifySettlementAnomaly(
  price: LedgerPriceSnapshot,
  settlement: Pick<NormalizedSettlement, "outcome" | "resolvedModel">,
  actualNano: bigint | null,
): SettlementAnomaly | undefined {
  if (
    settlement.resolvedModel &&
    !resolvedModelMatchesCatalogPrice(price.provider, settlement.resolvedModel, price.model)
  ) {
    return {
      kind: "resolved_model_mismatch",
      circuitOpen: true,
      requestedModel: price.model,
      resolvedModel: settlement.resolvedModel,
    };
  }
  if (settlement.outcome !== "success") return undefined;
  if (!settlement.resolvedModel) {
    return {
      kind: "missing_resolved_model",
      circuitOpen: true,
      requestedModel: price.model,
    };
  }
  if (actualNano === null) {
    return {
      kind: "missing_usage_or_cost",
      circuitOpen: false,
      requestedModel: price.model,
      resolvedModel: settlement.resolvedModel,
    };
  }
  return undefined;
}

async function anomalyActualNano(
  tx: Tx,
  row: SpendRow,
  settlement: NormalizedSettlement,
  snapshotActualNano: bigint | null,
): Promise<bigint | null> {
  const at = row.reservedAt ?? row.createdAt;
  const rows = await activeProviderPrices(tx, row.provider, at);
  const matching = settlement.resolvedModel
    ? rows.filter((candidate) =>
        resolvedModelMatchesCatalogPrice(row.provider, settlement.resolvedModel!, candidate.model),
      )
    : [];
  const candidates = matching.length > 0 ? matching : rows;
  const usage = settlement.usage ?? { inputTokens: 0, outputTokens: 0 };
  const costs: bigint[] = candidates
    .map((candidate) =>
      settlementCostNano(snapshotOf(candidate), {
        consumer: row.consumer,
        feature: row.feature,
        usage,
      }),
    )
    .filter((cost): cost is bigint => cost !== null);
  // Provider-reported money is one lower-bound candidate, never an override of
  // a higher server-catalog calculation for token-priced anomalies.
  if (settlement.providerReportedUsd !== undefined) {
    costs.push(usdToNano(settlement.providerReportedUsd, "ceil"));
  }
  if (snapshotActualNano !== null) costs.push(snapshotActualNano);
  return costs.length > 0
    ? costs.reduce((highest, cost) => (cost > highest ? cost : highest), 0n)
    : null;
}

function anomalyReason(anomaly: SettlementAnomaly): string {
  if (anomaly.kind === "missing_resolved_model") {
    return `Provider не сообщил resolvedModel для ${anomaly.requestedModel}; circuit открыт`;
  }
  if (anomaly.kind === "resolved_model_mismatch") {
    return `Provider вернул ${anomaly.resolvedModel ?? "unknown"} вместо ${anomaly.requestedModel}; circuit открыт`;
  }
  return `Provider не дал usage/cost для ${anomaly.requestedModel}; резерв сохранён`;
}

function snapshotOf(row: PriceRow): LedgerPriceSnapshot {
  return {
    version: 2,
    provider: row.provider,
    model: row.model,
    billingKind: row.billingKind,
    settlementKind: row.settlementKind,
    inputUsdPerMtok: row.inputUsdPerMtok,
    outputUsdPerMtok: row.outputUsdPerMtok,
    cacheReadUsdPerMtok: row.cacheReadUsdPerMtok,
    cacheWrite5mUsdPerMtok: row.cacheWrite5mUsdPerMtok,
    cacheWrite1hUsdPerMtok: row.cacheWrite1hUsdPerMtok,
    fixedRequestUsd: row.fixedRequestUsd,
    reservationCeilingUsd: row.reservationCeilingUsd,
    codeExecutionUsdPerRequest: row.codeExecutionUsdPerRequest,
    documentsPolicy: DOCUMENTS_LEDGER_POLICY,
    validFrom: row.validFrom.toISOString(),
  };
}

function parseSnapshot(value: unknown): LedgerPriceSnapshot {
  if (value === null || typeof value !== "object") {
    throw new InternalServerErrorException("LLM-ledger: в резерве нет price snapshot");
  }
  const raw = value as Record<string, unknown>;
  const strings = [
    "provider",
    "model",
    "inputUsdPerMtok",
    "outputUsdPerMtok",
    "cacheReadUsdPerMtok",
    "cacheWrite5mUsdPerMtok",
    "cacheWrite1hUsdPerMtok",
    "fixedRequestUsd",
    "codeExecutionUsdPerRequest",
    "validFrom",
  ];
  if (
    raw.version !== 2 ||
    !strings.every((key) => typeof raw[key] === "string") ||
    !["metered", "subscription"].includes(String(raw.billingKind)) ||
    !["tokens", "provider_reported"].includes(String(raw.settlementKind)) ||
    !(raw.reservationCeilingUsd === null || typeof raw.reservationCeilingUsd === "string") ||
    !isDocumentsPolicy(raw.documentsPolicy)
  ) {
    throw new InternalServerErrorException("LLM-ledger: price snapshot повреждён");
  }
  return raw as unknown as LedgerPriceSnapshot;
}

function isDocumentsPolicy(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  const codeExecution = policy.codeExecution;
  if (codeExecution === null || typeof codeExecution !== "object" || Array.isArray(codeExecution)) {
    return false;
  }
  const code = codeExecution as Record<string, unknown>;
  return (
    policy.version === DOCUMENTS_LEDGER_POLICY.version &&
    policy.inputOverheadTokens === DOCUMENTS_INPUT_OVERHEAD_TOKENS &&
    code.exact === false &&
    code.basis === "container_5m_minimum" &&
    code.monthlyFreePoolApplied === false
  );
}

async function readExposure(tx: Tx, day: string, agentId?: string | null): Promise<Exposure> {
  const global = await sumExposure(tx, day);
  return agentId ? { global, agent: await sumExposure(tx, day, agentId) } : { global };
}

async function sumExposure(tx: Tx, day: string, agentId?: string): Promise<bigint> {
  const conditions = [eq(llmSpend.day, day)];
  if (agentId) conditions.push(eq(llmSpend.agentId, agentId));
  const [row] = await tx
    .select({
      value: exposureSumSql(),
    })
    .from(llmSpend)
    .where(and(...conditions));
  return usdToNano(row?.value ?? "0", "ceil");
}

/** Keep monitoring and admission on the exact same conservative exposure formula. */
function exposureSumSql() {
  return sql<string>`coalesce(sum(
    case
      when ${llmSpend.status} = 'reserved' then ${llmSpend.reservedUsd}
      when ${llmSpend.status} = 'settled' then coalesce(${llmSpend.actualUsd}, 0)
      when ${llmSpend.status} = 'failed' and ${llmSpend.outcome} = 'unknown'
        then greatest(${llmSpend.reservedUsd}, coalesce(${llmSpend.actualUsd}, 0))
      when ${llmSpend.status} = 'failed' then coalesce(${llmSpend.actualUsd}, ${llmSpend.reservedUsd})
      else 0
    end
  ), 0)::text`;
}

function budget(
  day: string,
  globalCap: bigint,
  exposure: Exposure,
  agentCap?: bigint,
): LlmBudgetSnapshot {
  return {
    day,
    globalCapUsd: nanoToNumber(globalCap),
    globalExposureUsd: nanoToNumber(exposure.global),
    remainingUsd: nanoToNumber(globalCap > exposure.global ? globalCap - exposure.global : 0n),
    ...(agentCap !== undefined
      ? {
          agentCapUsd: nanoToNumber(agentCap),
          agentExposureUsd: nanoToNumber(exposure.agent ?? 0n),
        }
      : {}),
  };
}

function allowedResponse(
  row: SpendRow,
  replay: boolean,
  snapshot: LlmBudgetSnapshot,
  action: LlmBudgetAction = "pause",
): LlmReserveResponse {
  return {
    allowed: true,
    status: "reserved",
    action,
    reservation: {
      id: row.id,
      requestKey: row.requestKey,
      day: row.day,
      reservedUsd: Number(row.reservedUsd),
      replay,
    },
    budget: snapshot,
  };
}

function parseCap(raw: string, label: string): CapValue {
  try {
    return { nano: usdToNano(raw, "floor") };
  } catch {
    return { nano: 0n, error: `Настройка «${label}» не является неотрицательной суммой` };
  }
}

function budgetAction(value: string | null | undefined): LlmBudgetAction {
  return value === "downgrade" || value === "ask" ? value : "pause";
}

function reserveMetadata(
  metadata: Record<string, unknown>,
  consumer: string,
  denialAction?: LlmBudgetAction,
  routedModels?: readonly string[],
): Record<string, unknown> {
  const { _llmLedger: _clientInternal, ...clientMetadata } = metadata;
  const internal = {
    ...(consumer === "documents"
      ? {
          documentsPolicy: DOCUMENTS_LEDGER_POLICY,
          codeExecution: DOCUMENTS_LEDGER_POLICY.codeExecution,
        }
      : {}),
    ...(routedModels
      ? {
          routeReserve: {
            basis: "max_active_provider_sku",
            models: [...routedModels],
          },
        }
      : {}),
    ...(denialAction ? { denialAction } : {}),
  };
  return Object.keys(internal).length > 0
    ? { ...clientMetadata, _llmLedger: internal }
    : clientMetadata;
}

function storedDenialAction(metadata: unknown, fallback: LlmBudgetAction): LlmBudgetAction {
  if (metadata === null || typeof metadata !== "object") return fallback;
  const internal = (metadata as Record<string, unknown>)._llmLedger;
  if (internal === null || typeof internal !== "object") return fallback;
  const value = (internal as Record<string, unknown>).denialAction;
  return value === "pause" || value === "downgrade" || value === "ask" ? value : fallback;
}

function normalizeReserve(dto: ReserveLlmDto) {
  return {
    requestKey: dto.requestKey.trim(),
    ...(dto.traceKey ? { traceKey: dto.traceKey.trim() } : {}),
    consumer: dto.consumer,
    feature: dto.feature.trim(),
    ...(dto.agentName ? { agentName: dto.agentName.trim() } : {}),
    provider: dto.provider.trim().toLowerCase(),
    model: dto.model.trim(),
    inputTokenCeiling: dto.inputTokenCeiling,
    outputTokenCeiling: dto.outputTokenCeiling,
    metadata: dto.metadata ?? {},
  };
}

export function normalizeSettlement(dto: SettleLlmDto) {
  const usage = dto.usage ? normalizeUsage(dto.usage) : undefined;
  return {
    outcome: dto.outcome,
    ...(usage ? { usage } : {}),
    ...(dto.providerRequestId ? { providerRequestId: dto.providerRequestId.trim() } : {}),
    ...(dto.resolvedModel ? { resolvedModel: dto.resolvedModel.trim() } : {}),
    ...(dto.providerReportedUsd !== undefined
      ? { providerReportedUsd: dto.providerReportedUsd }
      : {}),
    ...(dto.reason !== undefined ? { reason: dto.reason.trim() } : {}),
    metadata: dto.metadata ?? {},
  };
}

export function normalizeUsage(usage: LlmTokenUsageDto) {
  const hasCacheBreakdown =
    usage.cacheCreation5mInputTokens !== undefined ||
    usage.cacheCreation1hInputTokens !== undefined;
  const cacheCreation5mInputTokens = usage.cacheCreation5mInputTokens ?? 0;
  const cacheCreation1hInputTokens = usage.cacheCreation1hInputTokens ?? 0;
  const splitTotal = cacheCreation5mInputTokens + cacheCreation1hInputTokens;
  if (
    hasCacheBreakdown &&
    usage.cacheCreationInputTokens !== undefined &&
    usage.cacheCreationInputTokens !== splitTotal
  ) {
    throw new BadRequestException(
      "cacheCreationInputTokens должен равняться сумме cacheCreation5mInputTokens и cacheCreation1hInputTokens",
    );
  }
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens ?? 0,
    ...(usage.cacheCreationInputTokens !== undefined
      ? { cacheCreationInputTokens: usage.cacheCreationInputTokens }
      : {}),
    ...(usage.cacheCreation5mInputTokens !== undefined
      ? { cacheCreation5mInputTokens: usage.cacheCreation5mInputTokens }
      : {}),
    ...(usage.cacheCreation1hInputTokens !== undefined
      ? { cacheCreation1hInputTokens: usage.cacheCreation1hInputTokens }
      : {}),
    codeExecutionRequests: usage.codeExecutionRequests ?? 0,
  };
}

async function spendHint(
  tx: Tx,
  id: string,
): Promise<{ day: string; requestKey: string; provider: string }> {
  const [row] = await tx
    .select({ day: llmSpend.day, requestKey: llmSpend.requestKey, provider: llmSpend.provider })
    .from(llmSpend)
    .where(eq(llmSpend.id, id))
    .limit(1);
  if (!row) throw new NotFoundException(`LLM-резерв ${id} не найден`);
  return row;
}

async function preDispatchRecoveryHint(
  tx: Tx,
  requestKey: string,
): Promise<{ day: string; provider: string } | undefined> {
  const [row] = await tx
    .select({ day: llmSpend.day, provider: llmSpend.provider })
    .from(llmSpend)
    .where(eq(llmSpend.requestKey, requestKey))
    .limit(1);
  return row;
}

async function spendByRequestKeyForUpdate(tx: Tx, requestKey: string): Promise<SpendRow | undefined> {
  const [row] = await tx
    .select()
    .from(llmSpend)
    .where(eq(llmSpend.requestKey, requestKey))
    .limit(1)
    .for("update");
  return row;
}

async function spendForUpdate(tx: Tx, id: string): Promise<SpendRow> {
  const [row] = await tx.select().from(llmSpend).where(eq(llmSpend.id, id)).limit(1).for("update");
  if (!row) throw new NotFoundException(`LLM-резерв ${id} не найден`);
  return row;
}

async function assertNotTaskJobSpend(tx: Tx, id: string): Promise<void> {
  const [linked] = await tx
    .select({ id: agentTaskLlmJob.id })
    .from(agentTaskLlmJob)
    .where(eq(agentTaskLlmJob.spendId, id))
    .limit(1);
  if (linked) {
    throw new ConflictException(
      "Task LLM reservation can only be closed through the durable task job API",
    );
  }
}

function mergeSettlementMetadata(
  existing: unknown,
  settlement: Record<string, unknown> | undefined,
  lowerBound: boolean,
  anomaly?: SettlementAnomaly,
): Record<string, unknown> {
  const base =
    existing !== null && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const existingInternal =
    base._llmLedger !== null &&
    typeof base._llmLedger === "object" &&
    !Array.isArray(base._llmLedger)
      ? (base._llmLedger as Record<string, unknown>)
      : {};
  return {
    ...base,
    ...(Object.keys(existingInternal).length > 0 || lowerBound || anomaly
      ? {
          _llmLedger: {
            ...existingInternal,
            ...(lowerBound ? { lowerBound: true } : {}),
            ...(anomaly
              ? {
                  anomaly,
                  ...(anomaly.circuitOpen ? { circuitOpen: true } : {}),
                }
              : {}),
          },
        }
      : {}),
    settlement: settlement ?? {},
  };
}
