import { randomUUID } from "node:crypto";
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import {
  agentTaskLlmAuthorization,
  agentTaskLlmJob,
  agentTaskLlmResult,
  auditLog,
  llmSpend,
  task,
  taskAgentExecution,
} from "@mydon/db";
import {
  inputTokenCeiling,
  tashkentDay,
  type LlmBudgetAction,
  type LlmBudgetSnapshot,
} from "@mydon/shared";
import { and, eq } from "drizzle-orm";
import { DB, type Db } from "../db/db.module";
import { LlmLedgerService } from "../llm-ledger/llm-ledger.service";
import type { ReserveLlmDto, SettleLlmDto } from "../llm-ledger/llm-ledger.dto";
import {
  assertBoundedProviderPayload,
  canonicalJsonHash,
  canonicalJsonValue,
  normalizeTaskLlmResultPayload,
  parseStoredTaskLlmExecutionPlan,
  type TaskLlmStoredResult,
} from "./task-llm-contract";
import type {
  ClaimTaskLlmDispatchDto,
  CompleteTaskLlmJobDto,
  EnsureTaskLlmJobDto,
} from "./task-llm-jobs.dto";
import { durableTaskInputHash, solutionSearchInputSnapshotConflict } from "./tasks.service";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type TaskRow = typeof task.$inferSelect;
type ExecutionRow = typeof taskAgentExecution.$inferSelect;
type JobRow = typeof agentTaskLlmJob.$inferSelect;
type ResultRow = typeof agentTaskLlmResult.$inferSelect;
type AuthorizationRow = typeof agentTaskLlmAuthorization.$inferSelect;

const DISPATCH_GRANT_MS = 2 * 60_000;

interface EnsureResponse {
  jobId: string;
  status: JobRow["status"];
  operationHash: string;
  result?: TaskLlmStoredResult;
  denial?: { action: LlmBudgetAction; reason: string; budget: LlmBudgetSnapshot };
}

interface ClaimResponse {
  granted: boolean;
  replay: boolean;
  status: JobRow["status"];
  operationHash: string;
  requestPayload?: Record<string, unknown>;
  result?: TaskLlmStoredResult;
}

interface CompleteResponse {
  status: JobRow["status"];
  replay: boolean;
  result?: TaskLlmStoredResult;
}

interface DurableConflict {
  durableConflict: string;
}

class TaskLlmAuthorizationIntegrityError extends Error {}

@Injectable()
export class TaskLlmJobsService {
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly ledger: LlmLedgerService,
  ) {}

  async ensure(
    taskId: string,
    input: EnsureTaskLlmJobDto,
    now = new Date(),
  ): Promise<EnsureResponse> {
    const requestPayload = assertBoundedProviderPayload(input.requestPayload);
    this.assertProviderPayload(input, requestPayload, "new");
    if (input.inputTokenCeiling + input.outputTokenCeiling > 100_000_000) {
      throw new BadRequestException("Combined token ceiling exceeds 100000000");
    }
    const result = await this.db.transaction(
      async (tx): Promise<EnsureResponse | DurableConflict> => {
        const lockedTask = await this.lockTask(tx, taskId);
        const fenceConflict = this.fenceConflict(lockedTask, input);
        if (fenceConflict) throw new ConflictException(fenceConflict);
        const execution = await this.lockExecution(tx, input.executionAttemptId);
        if (
          !execution ||
          execution.taskId !== taskId ||
          execution.agentName !== input.agentName.trim()
        ) {
          return this.blockTask(
            tx,
            lockedTask,
            "Durable execution is missing or belongs to another task",
            now,
          );
        }
        if (execution.status !== "active") {
          return this.blockTask(
            tx,
            lockedTask,
            `Execution is ${execution.status}; new LLM jobs are forbidden`,
            now,
          );
        }
        if (execution.taskInputHash !== durableTaskInputHash(lockedTask)) {
          return this.blockTask(tx, lockedTask, "Task input changed after execution start", now);
        }

        const planConflict = this.planConflict(execution, input);
        if (planConflict) return this.blockTask(tx, lockedTask, planConflict, now);
        const snapshotConflict = this.solutionRankSnapshotConflict(execution, input);
        if (snapshotConflict) return this.blockTask(tx, lockedTask, snapshotConflict, now);
        const operationHash = this.operationHash(execution, input, requestPayload);
        const jobKey = `task-llm:${execution.id}:${input.stepKey}:${input.providerAttemptNo}`;

        let job = await this.lockJobByAttempt(
          tx,
          execution.id,
          input.stepKey,
          input.providerAttemptNo,
        );
        if (job) {
          const mismatch = this.jobMismatch(job, input, jobKey, operationHash);
          if (mismatch) return this.blockTask(tx, lockedTask, mismatch, now);
        } else {
          const fallbackConflict = await this.fallbackConflict(tx, execution.id, input);
          if (fallbackConflict) return this.blockTask(tx, lockedTask, fallbackConflict, now);
          const [created] = await tx
            .insert(agentTaskLlmJob)
            .values({
              id: randomUUID(),
              taskAgentExecutionId: execution.id,
              stepKey: input.stepKey,
              providerAttemptNo: input.providerAttemptNo,
              kind: input.kind,
              feature: input.feature.trim(),
              adapter: input.adapter.trim(),
              adapterVersion: input.adapterVersion,
              endpointProfile: input.endpointProfile.trim(),
              provider: input.provider.trim().toLowerCase(),
              model: input.model.trim(),
              inputTokenCeiling: input.inputTokenCeiling,
              outputTokenCeiling: input.outputTokenCeiling,
              jobKey,
              operationHash,
              requestPayload,
              status: "waiting_budget",
              updatedAt: now,
            })
            .returning();
          if (!created) throw new Error("Task LLM job did not persist");
          job = created;
        }

        job = await this.expireDispatchIfNeeded(tx, job, now);
        const terminal = await this.jobResponse(tx, job);
        if (job.status !== "waiting_budget") return terminal;

        let authorizationDay = tashkentDay(now);
        let currentAuthorization: AuthorizationRow | undefined;
        let requestKey = `${job.jobKey}:day:${authorizationDay}`;
        let reservation: Awaited<ReturnType<LlmLedgerService["reserveInTx"]>>;
        try {
          reservation = await this.ledger.reserveInTx(
            tx,
            this.reservePayload(taskId, execution, job, requestKey),
            {
              requestKeyForDay: async (ledgerDay) => {
                authorizationDay = ledgerDay;
                [currentAuthorization] = await tx
                  .select()
                  .from(agentTaskLlmAuthorization)
                  .where(
                    and(
                      eq(agentTaskLlmAuthorization.jobId, job.id),
                      eq(agentTaskLlmAuthorization.day, ledgerDay),
                    ),
                  )
                  .limit(1)
                  .for("update");
                if (!currentAuthorization) {
                  requestKey = `${job.jobKey}:day:${ledgerDay}`;
                  return requestKey;
                }
                const [authorizedSpend] = await tx
                  .select()
                  .from(llmSpend)
                  .where(eq(llmSpend.id, currentAuthorization.spendId))
                  .limit(1)
                  .for("update");
                if (!authorizedSpend || authorizedSpend.day !== ledgerDay) {
                  throw new TaskLlmAuthorizationIntegrityError(
                    "Daily LLM authorization lost or mismatched its spend",
                  );
                }
                // A prior rollover may have produced a request key whose text
                // contains D while its spend was correctly serialized on D+1.
                // The authorization link, not the suffix, is authoritative.
                requestKey = authorizedSpend.requestKey;
                return requestKey;
              },
            },
          );
        } catch (error) {
          if (error instanceof TaskLlmAuthorizationIntegrityError) {
            return this.blockTask(tx, lockedTask, error.message, now);
          }
          throw error;
        }
        const [spend] = await tx
          .select()
          .from(llmSpend)
          .where(eq(llmSpend.requestKey, requestKey))
          .limit(1)
          .for("update");
        if (!spend) throw new Error("LLM ledger did not persist its authorization decision");
        if (spend.day !== authorizationDay) {
          return this.blockTask(
            tx,
            lockedTask,
            "LLM ledger day changed outside its stable lock",
            now,
          );
        }

        const decision = reservation.allowed ? "granted" : "denied";
        if (currentAuthorization) {
          if (
            currentAuthorization.spendId !== spend.id ||
            currentAuthorization.decision !== decision
          ) {
            return this.blockTask(
              tx,
              lockedTask,
              "Stored daily LLM authorization is inconsistent",
              now,
            );
          }
        } else {
          await tx.insert(agentTaskLlmAuthorization).values({
            jobId: job.id,
            day: spend.day,
            spendId: spend.id,
            decision,
          });
        }

        if (!reservation.allowed) {
          if (reservation.status !== "denied") {
            return this.blockTask(
              tx,
              lockedTask,
              `LLM authorization replay is blocked with status ${reservation.status}`,
              now,
            );
          }
          return {
            jobId: job.id,
            status: "waiting_budget",
            operationHash: job.operationHash,
            denial: {
              action: reservation.action,
              reason: reservation.reason ?? "Core denied the paid LLM provider call",
              budget: reservation.budget,
            },
          };
        }

        const [ready] = await tx
          .update(agentTaskLlmJob)
          .set({ spendId: spend.id, status: "ready", updatedAt: now })
          .where(and(eq(agentTaskLlmJob.id, job.id), eq(agentTaskLlmJob.status, "waiting_budget")))
          .returning();
        if (!ready)
          throw new ConflictException("Task LLM job authorization raced with another writer");
        return this.jobResponse(tx, ready);
      },
    );
    if ("durableConflict" in result) throw new ConflictException(result.durableConflict);
    return result;
  }

  async claimDispatch(
    taskId: string,
    jobId: string,
    input: ClaimTaskLlmDispatchDto,
    now = new Date(),
  ): Promise<ClaimResponse> {
    const result = await this.db.transaction(
      async (tx): Promise<ClaimResponse | DurableConflict> => {
        const lockedTask = await this.lockTask(tx, taskId);
        const fenceConflict = this.fenceConflict(lockedTask, input);
        if (fenceConflict) throw new ConflictException(fenceConflict);
        const execution = await this.lockExecution(tx, input.executionAttemptId);
        if (
          !execution ||
          execution.taskId !== taskId ||
          execution.agentName !== input.agentName.trim()
        ) {
          return this.blockTask(tx, lockedTask, "Durable execution is missing or mismatched", now);
        }
        if (
          execution.status !== "active" ||
          execution.taskInputHash !== durableTaskInputHash(lockedTask)
        ) {
          return this.blockTask(
            tx,
            lockedTask,
            "Execution or task input changed before dispatch",
            now,
          );
        }
        let job = await this.lockJob(tx, jobId);
        if (job.taskAgentExecutionId !== execution.id) {
          return this.blockTask(tx, lockedTask, "LLM job belongs to another execution", now);
        }
        const storedPlanConflict = this.storedJobPlanConflict(execution, job);
        if (storedPlanConflict) return this.blockTask(tx, lockedTask, storedPlanConflict, now);
        const snapshotConflict = this.solutionRankSnapshotConflict(execution, job);
        if (snapshotConflict) return this.blockTask(tx, lockedTask, snapshotConflict, now);
        let verifiedPayload: Record<string, unknown> | undefined;
        if (job.status === "ready" || job.status === "dispatching") {
          try {
            verifiedPayload = this.verifiedStoredPayload(execution, job);
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : "Stored operation hash is invalid";
            return this.blockTask(tx, lockedTask, reason, now);
          }
        }
        const statusBeforeExpiry = job.status;
        job = await this.expireDispatchIfNeeded(tx, job, now);
        const expiredNow = statusBeforeExpiry === "dispatching" && job.status === "unknown";

        if (job.status === "succeeded" || job.status === "rejected" || job.status === "unknown") {
          if (job.dispatchToken !== input.dispatchToken) {
            if (expiredNow) {
              return { durableConflict: "Provider dispatch was already granted to another token" };
            }
            throw new ConflictException("Provider dispatch was already granted to another token");
          }
          return {
            granted: false,
            replay: true,
            status: job.status,
            operationHash: job.operationHash,
            ...(await this.resultProperty(tx, job)),
          };
        }
        if (job.status === "dispatching") {
          if (job.dispatchToken !== input.dispatchToken) {
            throw new ConflictException("Provider dispatch was already granted to another token");
          }
          return {
            granted: true,
            replay: true,
            status: "dispatching",
            operationHash: job.operationHash,
            requestPayload: verifiedPayload!,
          };
        }
        if (job.status !== "ready") {
          return {
            granted: false,
            replay: false,
            status: job.status,
            operationHash: job.operationHash,
          };
        }

        // The job lock is already held, so this preserves the global order
        // task -> execution -> job -> ledger. Fetching requestKey is read-only;
        // reserveInTx itself acquires provider -> request -> budget locks and
        // row-locks the spend. A settings change after ensure must therefore
        // fail closed before the first provider wire leaves this transaction.
        if (!job.spendId) {
          return this.blockTask(tx, lockedTask, "Ready LLM job has no ledger spend", now);
        }
        const [authorizedSpend] = await tx
          .select({ requestKey: llmSpend.requestKey })
          .from(llmSpend)
          .where(eq(llmSpend.id, job.spendId))
          .limit(1);
        if (!authorizedSpend) {
          return this.blockTask(tx, lockedTask, "Ready LLM job lost its ledger spend", now);
        }
        const reauthorization = await this.ledger.reserveInTx(
          tx,
          this.reservePayload(taskId, execution, job, authorizedSpend.requestKey),
        );
        if (!reauthorization.allowed) {
          return this.blockTask(
            tx,
            lockedTask,
            `LLM dispatch reauthorization denied: ${reauthorization.reason ?? "current ledger policy rejected the replay"}`,
            now,
          );
        }
        const replayReservation = reauthorization.reservation;
        if (
          !replayReservation ||
          !replayReservation.replay ||
          replayReservation.id !== job.spendId ||
          replayReservation.requestKey !== authorizedSpend.requestKey
        ) {
          return this.blockTask(
            tx,
            lockedTask,
            "LLM dispatch reauthorization did not exact-replay the original spend",
            now,
          );
        }

        const [dispatching] = await tx
          .update(agentTaskLlmJob)
          .set({
            status: "dispatching",
            dispatchCount: 1,
            dispatchToken: input.dispatchToken,
            dispatchRunId: input.runId,
            dispatchGrantedAt: now,
            dispatchDeadlineAt: new Date(now.getTime() + DISPATCH_GRANT_MS),
            updatedAt: now,
          })
          .where(
            and(
              eq(agentTaskLlmJob.id, job.id),
              eq(agentTaskLlmJob.status, "ready"),
              eq(agentTaskLlmJob.dispatchCount, 0),
            ),
          )
          .returning();
        if (!dispatching)
          throw new ConflictException("Provider dispatch grant was already consumed");
        return {
          granted: true,
          replay: false,
          status: "dispatching",
          operationHash: dispatching.operationHash,
          requestPayload: verifiedPayload!,
        };
      },
    );
    if ("durableConflict" in result) throw new ConflictException(result.durableConflict);
    return result;
  }

  async complete(
    taskId: string,
    jobId: string,
    input: CompleteTaskLlmJobDto,
    now = new Date(),
  ): Promise<CompleteResponse> {
    if (input.outcome === "unknown" && input.result !== undefined) {
      throw new BadRequestException("unknown completion cannot contain a result");
    }
    if (input.outcome !== "unknown" && input.result === undefined) {
      throw new BadRequestException(`${input.outcome} completion requires result evidence`);
    }

    const locator = await this.locateJob(jobId);
    const result = await this.db.transaction(
      async (tx): Promise<CompleteResponse | DurableConflict> => {
        // Same global order as start/ensure/claim/retry: task -> execution -> job -> ledger.
        const lockedTask = await this.lockTask(tx, taskId);
        const execution = await this.lockExecutionById(tx, locator.taskAgentExecutionId);
        if (!execution || execution.taskId !== taskId) {
          throw new NotFoundException(`LLM job ${jobId} not found`);
        }
        const job = await this.lockJob(tx, jobId);
        if (job.taskAgentExecutionId !== execution.id) {
          throw new ConflictException("LLM job execution link changed during completion");
        }
        if (job.dispatchToken !== input.dispatchToken || job.dispatchCount !== 1) {
          throw new ConflictException("Completion does not own the provider dispatch grant");
        }

        if (input.outcome === "unknown") {
          if (job.status === "unknown") {
            return { status: "unknown", replay: true };
          }
          if (job.status !== "dispatching") {
            throw new ConflictException(`LLM job is ${job.status}; unknown completion conflicts`);
          }
          const [unknown] = await tx
            .update(agentTaskLlmJob)
            .set({
              status: "unknown",
              requestPayload: null,
              unknownAt: now,
              lastError: "Provider outcome is ambiguous",
              updatedAt: now,
            })
            .where(and(eq(agentTaskLlmJob.id, job.id), eq(agentTaskLlmJob.status, "dispatching")))
            .returning();
          if (!unknown) throw new ConflictException("LLM job completion raced with another writer");
          return { status: "unknown", replay: false };
        }

        const kind = input.outcome;
        const payload = normalizeTaskLlmResultPayload(job.kind, kind, input.result);
        const resultHash = canonicalJsonHash({ schemaVersion: 1, jobId: job.id, kind, payload });
        const stored = await this.lockResult(tx, job.id);
        if (stored) {
          if (stored.kind !== kind || stored.resultHash !== resultHash) {
            await tx.insert(auditLog).values({
              actorKind: "system",
              actorRef: "task-llm-job",
              action: "task.llm_result.conflict",
              target: job.id,
              after: { storedResultHash: stored.resultHash, receivedResultHash: resultHash },
            });
            return { durableConflict: "LLM job already has different immutable result evidence" };
          }
          return {
            status: job.status,
            replay: true,
            result: resultView(stored),
          };
        }
        if (job.status !== "dispatching" && job.status !== "unknown") {
          throw new ConflictException(`LLM job is ${job.status}; completion is not accepted`);
        }
        if (!job.spendId)
          throw new ConflictException("Dispatched LLM job has no ledger reservation");

        const [created] = await tx
          .insert(agentTaskLlmResult)
          .values({ jobId: job.id, kind, payload, resultHash, receivedAt: now })
          .returning();
        if (!created) throw new Error("Immutable task LLM result did not persist");
        await this.ledger.settleInTx(tx, job.spendId, taskLlmSettlementDto(job, kind, payload), {
          allowTaskJobSpend: true,
        });
        const terminalStatus = kind === "success" ? "succeeded" : "rejected";
        const [terminal] = await tx
          .update(agentTaskLlmJob)
          .set({
            status: terminalStatus,
            requestPayload: null,
            completedAt: now,
            lastError: kind === "provider_rejection" ? String(payload.error) : null,
            updatedAt: now,
          })
          .where(eq(agentTaskLlmJob.id, job.id))
          .returning();
        if (!terminal) throw new ConflictException("LLM job terminal update failed");
        if (
          execution.status === "active" &&
          lockedTask.status === "todo" &&
          lockedTask.agentExecutionAttemptId === execution.executionAttemptId &&
          lockedTask.agentExecutionBlockedAt !== null &&
          lockedTask.agentExecutionBlockedReason?.startsWith("execution_unknown:") === true &&
          execution.taskInputHash === durableTaskInputHash(lockedTask)
        ) {
          const jobs = await tx
            .select()
            .from(agentTaskLlmJob)
            .where(eq(agentTaskLlmJob.taskAgentExecutionId, execution.id));
          if (
            jobs.length > 0 &&
            jobs.every(
              (candidate) =>
                candidate.status === "succeeded" ||
                candidate.status === "rejected" ||
                candidate.status === "cancelled",
            )
          ) {
            await tx
              .update(task)
              .set({
                status: "todo",
                agentExecutionRetryAt: null,
                agentExecutionBlockedAt: null,
                agentExecutionBlockedReason: null,
              })
              .where(
                and(
                  eq(task.id, taskId),
                  eq(task.status, "todo"),
                  eq(task.agentExecutionAttemptId, execution.executionAttemptId),
                  eq(task.agentExecutionBlockedAt, lockedTask.agentExecutionBlockedAt),
                  eq(task.agentExecutionBlockedReason, lockedTask.agentExecutionBlockedReason),
                ),
              );
          }
        }
        return { status: terminal.status, replay: false, result: resultView(created) };
      },
    );
    if ("durableConflict" in result) throw new ConflictException(result.durableConflict);
    return result;
  }

  private async lockTask(tx: Tx, id: string): Promise<TaskRow> {
    const [row] = await tx.select().from(task).where(eq(task.id, id)).for("update");
    if (!row) throw new NotFoundException(`Task ${id} not found`);
    return row;
  }

  private async locateJob(id: string): Promise<{ taskAgentExecutionId: string }> {
    const [row] = await this.db
      .select({ taskAgentExecutionId: agentTaskLlmJob.taskAgentExecutionId })
      .from(agentTaskLlmJob)
      .where(eq(agentTaskLlmJob.id, id))
      .limit(1);
    if (!row) throw new NotFoundException(`LLM job ${id} not found`);
    return row;
  }

  private async lockExecution(tx: Tx, attemptId: string): Promise<ExecutionRow | undefined> {
    const [row] = await tx
      .select()
      .from(taskAgentExecution)
      .where(eq(taskAgentExecution.executionAttemptId, attemptId))
      .limit(1)
      .for("update");
    return row;
  }

  private async lockExecutionById(tx: Tx, id: string): Promise<ExecutionRow | undefined> {
    const [row] = await tx
      .select()
      .from(taskAgentExecution)
      .where(eq(taskAgentExecution.id, id))
      .limit(1)
      .for("update");
    return row;
  }

  private async lockJob(tx: Tx, id: string): Promise<JobRow> {
    const [row] = await tx
      .select()
      .from(agentTaskLlmJob)
      .where(eq(agentTaskLlmJob.id, id))
      .limit(1)
      .for("update");
    if (!row) throw new NotFoundException(`LLM job ${id} not found`);
    return row;
  }

  private async lockJobByAttempt(
    tx: Tx,
    executionId: string,
    stepKey: string,
    attemptNo: number,
  ): Promise<JobRow | undefined> {
    const [row] = await tx
      .select()
      .from(agentTaskLlmJob)
      .where(
        and(
          eq(agentTaskLlmJob.taskAgentExecutionId, executionId),
          eq(agentTaskLlmJob.stepKey, stepKey),
          eq(agentTaskLlmJob.providerAttemptNo, attemptNo),
        ),
      )
      .limit(1)
      .for("update");
    return row;
  }

  private async lockResult(tx: Tx, jobId: string): Promise<ResultRow | undefined> {
    const [row] = await tx
      .select()
      .from(agentTaskLlmResult)
      .where(eq(agentTaskLlmResult.jobId, jobId))
      .limit(1)
      .for("update");
    return row;
  }

  private fenceConflict(
    row: TaskRow,
    input: { agentName: string; runId: string; executionAttemptId: string },
  ): string | undefined {
    if (
      row.ownerKind !== "agent" ||
      row.ownerRef !== input.agentName.trim() ||
      row.agentRunId !== input.runId ||
      row.agentExecutionAttemptId !== input.executionAttemptId ||
      row.status === "done" ||
      row.status === "cancelled"
    ) {
      return "Agent run fence is stale or task is closed";
    }
    return undefined;
  }

  private async blockTask(
    tx: Tx,
    before: TaskRow,
    reason: string,
    now: Date,
  ): Promise<DurableConflict> {
    const boundedReason = reason.slice(0, 1000);
    const [blocked] = await tx
      .update(task)
      .set({
        status: "todo",
        agentRunId: null,
        agentRunClaimedAt: null,
        agentExecutionRetryAt: null,
        agentExecutionBlockedAt: now,
        agentExecutionBlockedReason: boundedReason,
      })
      .where(eq(task.id, before.id))
      .returning();
    if (blocked) {
      await tx.insert(auditLog).values({
        actorKind: "system",
        actorRef: "task-llm-job",
        action: "task.agent_execution.blocked",
        target: before.id,
        before,
        after: blocked,
      });
    }
    return { durableConflict: boundedReason };
  }

  private planConflict(execution: ExecutionRow, input: EnsureTaskLlmJobDto): string | undefined {
    let plan;
    try {
      plan = parseStoredTaskLlmExecutionPlan(execution.executionPlan);
    } catch (error) {
      return error instanceof Error ? error.message : "Stored execution plan is invalid";
    }
    if (
      execution.workflowVersion !== plan.version ||
      canonicalJsonHash(plan) !== execution.executionPlanHash
    ) {
      return "Workflow plan version or canonical hash is inconsistent";
    }
    const step = plan.steps.find((candidate) => candidate.stepKey === input.stepKey);
    if (!step) return `Step ${input.stepKey} is not allowlisted by the execution plan`;
    if (
      step.kind !== input.kind ||
      step.feature !== input.feature.trim() ||
      step.adapter !== input.adapter.trim() ||
      step.adapterVersion !== input.adapterVersion ||
      step.endpointProfile !== input.endpointProfile.trim() ||
      step.provider !== input.provider.trim().toLowerCase()
    ) {
      return `Step ${input.stepKey} route differs from the execution plan`;
    }
    if (step.models[input.providerAttemptNo - 1] !== input.model.trim()) {
      return `Attempt ${input.providerAttemptNo} model differs from the execution plan`;
    }
    return undefined;
  }

  private storedJobPlanConflict(execution: ExecutionRow, job: JobRow): string | undefined {
    let plan;
    try {
      plan = parseStoredTaskLlmExecutionPlan(execution.executionPlan);
    } catch (error) {
      return error instanceof Error ? error.message : "Stored execution plan is invalid";
    }
    if (
      execution.workflowVersion !== plan.version ||
      canonicalJsonHash(plan) !== execution.executionPlanHash
    ) {
      return "Stored workflow plan version or canonical hash is inconsistent";
    }
    const step = plan.steps.find((candidate) => candidate.stepKey === job.stepKey);
    if (
      !step ||
      step.kind !== job.kind ||
      step.feature !== job.feature ||
      step.adapter !== job.adapter ||
      step.adapterVersion !== job.adapterVersion ||
      step.endpointProfile !== job.endpointProfile ||
      step.provider !== job.provider ||
      step.models[job.providerAttemptNo - 1] !== job.model
    ) {
      return "Stored LLM job no longer matches its immutable execution plan";
    }
    return undefined;
  }

  private solutionRankSnapshotConflict(
    execution: ExecutionRow,
    operation: Pick<JobRow, "kind" | "stepKey" | "feature">,
  ): string | undefined {
    if (
      operation.kind !== "chat" ||
      operation.stepKey !== "find-solution:rank" ||
      operation.feature.trim() !== "find-solution:rank"
    ) {
      return undefined;
    }
    if (execution.skill !== "find-solution") {
      return "find-solution:rank requires a find-solution execution";
    }
    return solutionSearchInputSnapshotConflict(execution);
  }

  private operationHash(
    execution: ExecutionRow,
    input: EnsureTaskLlmJobDto,
    requestPayload: Record<string, unknown>,
  ): string {
    return canonicalJsonHash({
      schemaVersion: 1,
      executionId: execution.id,
      workflowVersion: execution.workflowVersion,
      stepKey: input.stepKey,
      providerAttemptNo: input.providerAttemptNo,
      adapter: input.adapter.trim(),
      adapterVersion: input.adapterVersion,
      provider: input.provider.trim().toLowerCase(),
      endpointProfile: input.endpointProfile.trim(),
      requestPayload,
    });
  }

  /** One canonical payload for initial authorization and pre-wire reauthorization. */
  private reservePayload(
    taskId: string,
    execution: ExecutionRow,
    job: JobRow,
    requestKey: string,
  ): ReserveLlmDto {
    return {
      requestKey,
      traceKey: `task:${taskId}:execution:${execution.executionAttemptId}`,
      consumer: job.kind === "embedding" ? "embeddings" : "agents",
      feature: job.feature,
      agentName: execution.agentName,
      provider: job.provider,
      model: job.model,
      inputTokenCeiling: job.inputTokenCeiling,
      outputTokenCeiling: job.outputTokenCeiling,
      metadata: {
        taskId,
        executionAttemptId: execution.executionAttemptId,
        taskLlmJobId: job.id,
        stepKey: job.stepKey,
        providerAttemptNo: job.providerAttemptNo,
        operationHash: job.operationHash,
      },
    };
  }

  private jobMismatch(
    job: JobRow,
    input: EnsureTaskLlmJobDto,
    jobKey: string,
    operationHash: string,
  ): string | undefined {
    if (
      job.jobKey !== jobKey ||
      job.operationHash !== operationHash ||
      job.kind !== input.kind ||
      job.feature !== input.feature.trim() ||
      job.adapter !== input.adapter.trim() ||
      job.adapterVersion !== input.adapterVersion ||
      job.endpointProfile !== input.endpointProfile.trim() ||
      job.provider !== input.provider.trim().toLowerCase() ||
      job.model !== input.model.trim() ||
      job.inputTokenCeiling !== input.inputTokenCeiling ||
      job.outputTokenCeiling !== input.outputTokenCeiling
    ) {
      return "Existing task LLM job differs from the requested physical operation";
    }
    return undefined;
  }

  private async fallbackConflict(
    tx: Tx,
    executionId: string,
    input: EnsureTaskLlmJobDto,
  ): Promise<string | undefined> {
    if (input.providerAttemptNo === 1) return undefined;
    const prior = await this.lockJobByAttempt(
      tx,
      executionId,
      input.stepKey,
      input.providerAttemptNo - 1,
    );
    if (!prior) return "Fallback attempt cannot skip the preceding provider attempt";
    if (prior.status !== "rejected") {
      return `Fallback attempt is forbidden while the preceding job is ${prior.status}`;
    }
    return undefined;
  }

  private verifiedStoredPayload(execution: ExecutionRow, job: JobRow): Record<string, unknown> {
    if (job.requestPayload === null)
      throw new ConflictException("Stored provider payload is missing");
    const payload = assertBoundedProviderPayload(job.requestPayload);
    this.assertProviderPayload(job, payload, "stored");
    const hash = canonicalJsonHash({
      schemaVersion: 1,
      executionId: execution.id,
      workflowVersion: execution.workflowVersion,
      stepKey: job.stepKey,
      providerAttemptNo: job.providerAttemptNo,
      adapter: job.adapter,
      adapterVersion: job.adapterVersion,
      provider: job.provider,
      endpointProfile: job.endpointProfile,
      requestPayload: payload,
    });
    if (hash !== job.operationHash) {
      throw new ConflictException("Stored task LLM operation hash does not match its payload");
    }
    return payload;
  }

  private assertProviderPayload(
    input: Pick<
      EnsureTaskLlmJobDto,
      "kind" | "provider" | "model" | "inputTokenCeiling" | "outputTokenCeiling"
    >,
    payload: Record<string, unknown>,
    source: "new" | "stored",
  ): void {
    const officialOpenAiChat =
      input.kind === "chat" && input.provider.trim().toLowerCase() === "openai";
    const storedOpenAiPayload = officialOpenAiChat && source === "stored";
    const allowedKeys =
      input.kind === "chat"
        ? officialOpenAiChat
          ? new Set([
              "model",
              "messages",
              "max_completion_tokens",
              "service_tier",
              ...(storedOpenAiPayload ? ["max_tokens"] : []),
            ])
          : new Set(["model", "messages", "max_tokens"])
        : new Set(["model", "input"]);
    const unknownKey = Object.keys(payload).find((key) => !allowedKeys.has(key));
    if (unknownKey) {
      throw new BadRequestException(`requestPayload.${unknownKey} is not allowlisted`);
    }
    if (payload.model !== input.model.trim()) {
      throw new BadRequestException("requestPayload.model must equal the planned model");
    }
    if (input.kind === "chat") {
      if (!Array.isArray(payload.messages) || payload.messages.length !== 2) {
        throw new BadRequestException(
          "chat requestPayload requires exactly system and user messages",
        );
      }
      const [systemMessage, userMessage] = payload.messages as Record<string, unknown>[];
      if (systemMessage?.role !== "system" || userMessage?.role !== "user") {
        throw new BadRequestException("chat requestPayload message order must be system then user");
      }
      const serverInputCeiling = inputTokenCeiling(
        `${String(systemMessage.content)}\n\n${String(userMessage.content)}`,
      );
      if (input.inputTokenCeiling !== serverInputCeiling) {
        throw new BadRequestException("inputTokenCeiling does not match the exact chat payload");
      }
      for (const message of payload.messages) {
        if (message === null || typeof message !== "object" || Array.isArray(message)) {
          throw new BadRequestException("requestPayload.messages contains a non-object message");
        }
        const record = message as Record<string, unknown>;
        if (
          Object.keys(record).some((key) => key !== "role" && key !== "content") ||
          (record.role !== "system" && record.role !== "user" && record.role !== "assistant") ||
          typeof record.content !== "string"
        ) {
          throw new BadRequestException("requestPayload.messages contains unsupported fields");
        }
      }
      if (officialOpenAiChat) {
        const hasCurrentCeiling = Object.prototype.hasOwnProperty.call(
          payload,
          "max_completion_tokens",
        );
        const hasLegacyCeiling = Object.prototype.hasOwnProperty.call(payload, "max_tokens");
        if (hasCurrentCeiling && hasLegacyCeiling) {
          throw new BadRequestException(
            "Stored OpenAI requestPayload cannot contain both token ceiling fields",
          );
        }
        if (hasLegacyCeiling) {
          throw new BadRequestException(
            "Stored legacy OpenAI requestPayload.max_tokens cannot be dispatched safely; owner retry is required",
          );
        } else {
          if (
            !Number.isInteger(payload.max_completion_tokens) ||
            payload.max_completion_tokens !== input.outputTokenCeiling
          ) {
            throw new BadRequestException(
              "requestPayload.max_completion_tokens must equal outputTokenCeiling for provider openai",
            );
          }
          if (payload.service_tier !== "default") {
            throw new BadRequestException(
              "requestPayload.service_tier must equal default for provider openai",
            );
          }
        }
      } else if (
        !Number.isInteger(payload.max_tokens) ||
        payload.max_tokens !== input.outputTokenCeiling
      ) {
        throw new BadRequestException("requestPayload.max_tokens must equal outputTokenCeiling");
      }
    } else {
      if (typeof payload.input !== "string" || payload.input.length === 0) {
        throw new BadRequestException("embedding requestPayload.input must be a non-empty string");
      }
      if (input.inputTokenCeiling !== inputTokenCeiling(payload.input, 256)) {
        throw new BadRequestException(
          "inputTokenCeiling does not match the exact embedding payload",
        );
      }
      if (input.outputTokenCeiling !== 0) {
        throw new BadRequestException("embedding outputTokenCeiling must be zero");
      }
    }
  }

  private async expireDispatchIfNeeded(tx: Tx, job: JobRow, now: Date): Promise<JobRow> {
    if (
      job.status !== "dispatching" ||
      job.dispatchDeadlineAt === null ||
      job.dispatchDeadlineAt.getTime() > now.getTime()
    ) {
      return job;
    }
    const [unknown] = await tx
      .update(agentTaskLlmJob)
      .set({
        status: "unknown",
        requestPayload: null,
        unknownAt: now,
        lastError: "Dispatch grant expired without durable completion",
        updatedAt: now,
      })
      .where(and(eq(agentTaskLlmJob.id, job.id), eq(agentTaskLlmJob.status, "dispatching")))
      .returning();
    return unknown ?? job;
  }

  private async jobResponse(tx: Tx, job: JobRow): Promise<EnsureResponse> {
    return {
      jobId: job.id,
      status: job.status,
      operationHash: job.operationHash,
      ...(await this.resultProperty(tx, job)),
    };
  }

  private async resultProperty(tx: Tx, job: JobRow): Promise<{ result?: TaskLlmStoredResult }> {
    if (job.status !== "succeeded" && job.status !== "rejected") return {};
    const result = await this.lockResult(tx, job.id);
    if (!result) throw new ConflictException(`Terminal LLM job ${job.id} has no result`);
    return { result: resultView(result) };
  }
}

function resultView(row: ResultRow): TaskLlmStoredResult {
  return {
    kind: row.kind,
    payload:
      row.payload !== null && typeof row.payload === "object" && !Array.isArray(row.payload)
        ? (canonicalJsonValue(row.payload) as Record<string, unknown>)
        : {},
    resultHash: row.resultHash,
  };
}

export function taskLlmSettlementDto(
  job: JobRow,
  kind: "success" | "provider_rejection",
  payload: Record<string, unknown>,
): SettleLlmDto {
  const usage =
    payload.usage !== null && typeof payload.usage === "object" && !Array.isArray(payload.usage)
      ? (payload.usage as SettleLlmDto["usage"])
      : undefined;
  return {
    outcome: kind === "success" ? "success" : "provider_error",
    ...(usage ? { usage } : {}),
    ...(typeof payload.providerRequestId === "string"
      ? { providerRequestId: payload.providerRequestId }
      : {}),
    ...(typeof payload.resolvedModel === "string" ? { resolvedModel: payload.resolvedModel } : {}),
    ...(typeof payload.providerReportedUsd === "number"
      ? { providerReportedUsd: payload.providerReportedUsd }
      : {}),
    ...(kind === "provider_rejection" ? { reason: String(payload.error) } : {}),
    metadata: { taskLlmJobId: job.id, operationHash: job.operationHash },
  };
}
