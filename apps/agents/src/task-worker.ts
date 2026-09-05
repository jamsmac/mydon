import { LlmLedgerUnavailableError, type AutonomyTier } from "@mydon/shared";
import type { AgentsCoreClient, AgentTaskClaim, AgentTaskInvocation } from "./core-client";
import { isLlmSkill, llmSkillFeature, llmSkillTriggers } from "./llm-skill";
import type { AgentDefinition } from "./registry";
import { runSkill } from "./runner";
import { hasSkill } from "./skills";
import { TaskLlmSession } from "./task-llm-session";
import { buildTaskLlmWorkflowPlan, type TaskLlmWorkflowPlan } from "./task-llm-workflow";

/**
 * Задачи, поручённые агенту (решение владельца: «агент берёт и делает»).
 *
 * Владелец ставит задачу агенту так же, как человеку. Агент берёт её в работу,
 * пробует выполнить своим навыком и ОТЧИТЫВАЕТСЯ результатом — как сотрудник.
 *
 * Если подходящего навыка нет, агент честно пишет «не умею» и возвращает задачу
 * владельцу, а не изображает работу и не закрывает её молча.
 */

export interface TaskRunResult {
  taskId: string;
  outcome: "done" | "returned" | "proposed" | "skipped";
  note: string;
}

export interface RunAgentTasksOptions {
  /** Assigned owner work and scheduled system occurrences are separate queues. */
  invocation?: AgentTaskInvocation;
  /**
   * Admission guard checked immediately before every new claim. A task whose
   * claim already succeeded remains in-flight and is allowed to finish.
   */
  canClaim?: () => boolean;
}

/** Заведомо меньше 15-минутного stale lease Core. */
export const AGENT_RUN_HEARTBEAT_MS = 60_000;

/** В плане ровно один metered chat-шаг с этим ключом и непустой цепочкой моделей. */
function hasChatStep(plan: TaskLlmWorkflowPlan, stepKey: string): boolean {
  const matches = plan.steps.filter((step) => step.stepKey === stepKey);
  return (
    matches.length === 1 &&
    matches[0]?.kind === "chat" &&
    matches[0].feature === stepKey &&
    matches[0].models.length > 0
  );
}

/**
 * Навыки, которым metered-маршрут обязателен: без него задача не стартует, а
 * возвращается в Core с `route_unavailable` (bounded retry), как у find-solution.
 * llm-навык (executor: llm) — ровно один шаг `llm-skill:<навык>` (R-LS-2).
 */
export function requiredChatStep(skill: string): string | null {
  if (skill === "find-solution") return "find-solution:rank";
  if (isLlmSkill(skill)) return llmSkillFeature(skill);
  return null;
}

/** По заголовку задачи ищем навык агента, который её закрывает. */
export function matchSkill(agent: AgentDefinition, title: string): string | null {
  const text = title.toLowerCase();
  // Прямое упоминание навыка в тексте — самый надёжный признак.
  for (const skill of agent.skills) {
    if (text.includes(skill.toLowerCase()) && hasSkill(skill)) return skill;
  }
  // Триггеры из frontmatter llm-навыка (`triggers`) — паспорт сам говорит, какие
  // задачи он закрывает; статическая карта HINTS ниже — для навыков с кодом.
  for (const skill of agent.skills) {
    if (!isLlmSkill(skill)) continue;
    if (llmSkillTriggers(skill).some((re) => re.test(title))) return skill;
  }
  // Иначе — по смыслу: слова задачи против того, что навык умеет.
  const HINTS: Record<string, RegExp> = {
    "watch-receivables": /дебитор|долг|просроч|платеж|оплат/,
    "monitor-stock": /остат|автомат|пополн|простаив|запас/,
    "morning-digest": /сводк|дайджест|обзор|что нового|как дела/,
    "read-sources": /источник|сайт|страниц|прочит|разведк|рынок|тендер|цен[аы]/,
    "scan-ideas": /иде[яйи]|канал|что нового|фишк|перенять|promtjam/,
    "coach-review": /обзор|оцени агент|самоулучшен|coach|разбор недел/,
    "find-solution": /найд|готов.{0,12}решен|инструмент|автоматизац|шаблон|github|n8n|saas/,
  };
  for (const skill of agent.skills) {
    const re = HINTS[skill];
    if (re && re.test(text) && hasSkill(skill)) return skill;
  }
  return null;
}

/**
 * Навык задачи: явный побеждает угадывание (R-SD-3).
 *
 * `agentSkill` ставят запуск из deck и задачи по расписанию — там навык ИЗВЕСТЕН,
 * и угадывать его по заголовку было бы прямой потерей воли владельца. Но верим
 * полю не на слово: навык должен быть закреплён за агентом (карточка — источник
 * истины, снятый навык уважаем сразу) и иметь реализацию (код ∨ llm). Чужой или
 * неподключённый навык — не ошибка задачи, а повод вернуться к прежнему подбору
 * по тексту: пусть агент попробует, а «не умею» скажет уже по-настоящему.
 */
export function resolveTaskSkill(
  agent: AgentDefinition,
  claim: Pick<AgentTaskClaim, "taskInput">,
): string | null {
  const explicit = claim.taskInput.agentSkill;
  if (explicit && agent.skills.includes(explicit) && hasSkill(explicit)) return explicit;
  return matchSkill(
    agent,
    [claim.taskInput.title, claim.taskInput.description].filter(Boolean).join("\n"),
  );
}

/**
 * Прогон задач одного агента.
 *
 * Порядок важен: сначала берём в работу (владелец видит, что агент занялся),
 * потом выполняем, потом отчитываемся. При сбое задача остаётся открытой —
 * лучше повторить, чем потерять.
 */
export async function runAgentTasks(
  agent: AgentDefinition,
  core: AgentsCoreClient,
  threshold: AutonomyTier,
  /** Карта «навык → минимальный тир» (floor). Не задана — тир берётся только
   *  из карточки агента; гейт по навыку не применяется. */
  skillFloors?: Map<string, AutonomyTier>,
  options: RunAgentTasksOptions = {},
): Promise<TaskRunResult[]> {
  if (agent.status !== "active") return [];

  const tasks = await core.myTasks(agent.name, options.invocation ?? "assigned");
  const results: TaskRunResult[] = [];

  for (const t of tasks) {
    // Pause is an admission gate, not cancellation: finish an already claimed
    // task, then re-check before taking the next one from the same snapshot.
    if (options.canClaim?.() === false) break;

    // Core — единственная точка конкурентного выбора. Два worker могут
    // увидеть одну задачу в myTasks(), но лишь один получит durable runId.
    const claim = await core.claimAgentTask(
      t.id,
      agent.name,
      options.invocation ?? "assigned",
    );
    if (claim === null) {
      results.push({
        taskId: t.id,
        outcome: "skipped",
        note: "задачу уже выполняет другой worker",
      });
      continue;
    }
    const runId = claim.runId;
    const executionAttemptId = claim.executionAttemptId;
    let leaseLost = false;
    let heartbeatRequest: Promise<boolean> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    // Все CAS-проверки (таймер и provider guards) делят один in-flight
    // request: они не плодят heartbeat и одинаково видят потерю generation.
    const renewLease = (): Promise<boolean> => {
      if (heartbeatRequest !== null) return heartbeatRequest;
      const request = core.heartbeatAgentTask(t.id, agent.name, runId);
      heartbeatRequest = request;
      const clear = () => {
        if (heartbeatRequest === request) heartbeatRequest = null;
      };
      // .then(success, failure) не создаёт отброшенный rejecting promise, как .finally().
      void request.then(clear, clear);
      return request;
    };
    const assertLease = async (): Promise<void> => {
      let renewed: boolean;
      try {
        renewed = await renewLease();
      } catch (error) {
        throw new LlmLedgerUnavailableError(
          `не удалось подтвердить lease задачи ${t.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!renewed) {
        leaseLost = true;
        throw new LlmLedgerUnavailableError(`lease задачи ${t.id} уже перешёл другой generation`);
      }
    };

    try {
      // Закрываем окно claim→timer и заодно проверяем, что generation ещё наша.
      await assertLease();
      heartbeatTimer = setInterval(() => {
        void assertLease().catch((error: unknown) => {
          if (!leaseLost) {
            console.error(`[${agent.name}] heartbeat задачи ${t.id} не прошёл:`, error);
          }
        });
      }, AGENT_RUN_HEARTBEAT_MS);
      heartbeatTimer.unref();

      // A durable checkpoint is authoritative after crash/takeover even if the
      // task title or the agent's current skill list changed in the meantime.
      const claimedCheckpoint = claim.execution?.checkpoint ?? claim.checkpoint;
      const skill =
        claim.execution?.skill ?? claimedCheckpoint?.skill ?? resolveTaskSkill(agent, claim);
      if (skill === null) {
        // Честный отказ пишем в durable block самой задачи.
        // Отдельный comment здесь неидемпотентен: потеря ответа
        // плодила бы комментарии на каждом poll. Core атомарно снимает
        // lease и блокирует новый claim до явного owner retry.
        const note = (
          `Не умею это делать. Мои навыки: ${agent.skills.join(", ") || "нет"}. ` +
          `Уточни или переназначь задачу, затем запусти owner retry.`
        ).slice(0, 1000);
        const blocked = await core.releaseAgentTask(
          t.id,
          agent.name,
          runId,
          executionAttemptId,
          "unsupported",
          note,
        );
        if (!blocked) {
          leaseLost = true;
          results.push({
            taskId: t.id,
            outcome: "skipped",
            note: "generation задачи изменилась до установки block",
          });
          continue;
        }
        results.push({ taskId: t.id, outcome: "returned", note });
        continue;
      }

      if (!claim.taskInputHash) {
        throw new LlmLedgerUnavailableError(
          `Core claim задачи ${t.id} не содержит taskInputHash для durable execution`,
        );
      }
      let requestedPlan: TaskLlmWorkflowPlan;
      let routeError: string | undefined;
      if (claim.execution) {
        requestedPlan = claim.execution.plan;
      } else {
        try {
          requestedPlan = buildTaskLlmWorkflowPlan(skill);
        } catch (error) {
          if (requiredChatStep(skill) === null) throw error;
          requestedPlan = { version: 1, steps: [] };
          routeError = error instanceof Error ? error.message : String(error);
        }
      }
      const neededStep = requiredChatStep(skill);
      if (neededStep !== null && !hasChatStep(requestedPlan, neededStep)) {
        // Do not create an empty immutable execution while the route is off.
        // Core keeps this unstarted attempt and applies a bounded retryAt, so
        // enabling the route later can create its first plan without an owner
        // retry or a false workflow_changed conflict.
        const detail = (
          routeError
            ? `${skill} metered route is unavailable: ${routeError}`
            : `${skill} requires metered workflow step ${neededStep}`
        ).slice(0, 1000);
        const released = await core.releaseAgentTask(
          t.id,
          agent.name,
          runId,
          executionAttemptId,
          "route_unavailable",
          detail,
        );
        if (!released) {
          leaseLost = true;
          results.push({
            taskId: t.id,
            outcome: "skipped",
            note: "generation задачи изменилась до route backoff",
          });
          continue;
        }
        results.push({
          taskId: t.id,
          outcome: "skipped",
          note: `LLM-маршрут ${skill} пока недоступен; Core отложил повтор на 60 секунд.`,
        });
        continue;
      }
      const started = await core.startAgentTaskExecution(t.id, {
        agentName: agent.name,
        runId,
        executionAttemptId,
        claimedTaskInputHash: claim.taskInputHash,
        skill,
        workflowVersion: claim.execution?.workflowVersion ?? requestedPlan.version,
        plan: requestedPlan,
      });
      const execution = started.execution;
      if (
        execution.skill !== skill ||
        execution.status === "abandoned" ||
        execution.status === "committed" ||
        (execution.status === "ready" && execution.checkpoint === undefined)
      ) {
        throw new LlmLedgerUnavailableError(
          `Core вернул несовместимую execution ${execution.id} (${execution.skill}/${execution.status})`,
        );
      }
      const checkpoint = execution.checkpoint ?? claimedCheckpoint;
      const taskLlm = new TaskLlmSession(
        core,
        { taskId: t.id, agentName: agent.name, runId, executionAttemptId },
        execution.plan,
      );

      const traceKey = `task:${t.id}:${agent.name}:${skill}`;
      const run = await runSkill(agent, skill, core, threshold, skillFloors?.get(skill), {
        // executionAttemptId рождает Core один раз и переживает stale takeover.
        // Новый lease не даёт второй metered dispatch; новую денежную
        // попытку создаёт только явный redo/переназначение владельца.
        requestKey: `task:${t.id}:execution:${executionAttemptId}`,
        traceKey,
        assertLease,
        taskInput: claim.taskInput,
        task: {
          ...(checkpoint ? { checkpoint } : {}),
          ...(execution.inputSnapshot ? { inputSnapshot: execution.inputSnapshot } : {}),
          llm: taskLlm,
          saveInputSnapshot: (input) =>
            core.ensureAgentTaskInputSnapshot(t.id, {
              agentName: agent.name,
              runId,
              executionAttemptId,
              ...input,
            }),
          saveCheckpoint: (checkpoint) =>
            core.checkpointAgentTask(t.id, {
              agentName: agent.name,
              runId,
              executionAttemptId,
              ...checkpoint,
            }),
        },
      });

      if (leaseLost) {
        results.push({
          taskId: t.id,
          outcome: "skipped",
          note: "во время выполнения lease перешёл другой generation",
        });
        continue;
      }

      if (run.commit) {
        // Point-in-time heartbeat is only a fast hint; Core repeats the runId
        // fence atomically with cap, internal effects, task result and outbox.
        await assertLease();
        const committed = await core.commitAgentTaskOutcome(t.id, {
          agentName: agent.name,
          runId,
          executionAttemptId,
          outcome: run.commit.outcome,
          note: run.commit.note,
          ...(run.commit.action !== undefined ? { action: run.commit.action } : {}),
          ...(run.commit.facts !== undefined ? { facts: run.commit.facts } : {}),
          ...(run.commit.next !== undefined ? { next: run.commit.next } : {}),
          ...(run.commit.tier !== undefined ? { tier: run.commit.tier } : {}),
          ...(run.commit.memorySignature !== undefined
            ? { memorySignature: run.commit.memorySignature }
            : {}),
          ...(run.commit.executionDetail !== undefined
            ? { executionDetail: run.commit.executionDetail }
            : {}),
        });

        if (committed.status === "capped") {
          // Core already atomically released the run and scheduled the retry;
          // a second release here could race a fresh generation.
          const note =
            "Дневной потолок действий исчерпан — Core отложил задачу до следующих суток по Ташкенту.";
          results.push({ taskId: t.id, outcome: "skipped", note });
          continue;
        }
        if (committed.status === "blocked") {
          // Core detected that task input changed after the checkpoint, fenced
          // this execution and cleared its lease. Only an owner retry may
          // rotate the execution attempt; releasing here would race that flow.
          const note =
            "Задача изменилась после сохранённого результата — выполнение заблокировано до явного повтора владельцем.";
          results.push({ taskId: t.id, outcome: "skipped", note });
          continue;
        }

        results.push({
          taskId: t.id,
          outcome: run.commit.outcome === "approval_requested" ? "proposed" : "done",
          note: run.commit.note,
        });
        continue;
      }

      if (run.outcome !== "skipped") {
        throw new Error(`Task-mode ${skill} вернул ${run.outcome} без commit intent`);
      }
      if (run.skipReason === "no_signal" || run.skipReason === "no_change") {
        throw new Error(`Task-mode ${skill} вернул ${run.skipReason} без commit intent`);
      }
      // llm-навык: ответ не по контракту или provider rejection — терминальный
      // durable результат, на повторном claim он воспроизведётся тем же. Без
      // block задача крутилась бы claim→replay→release на каждом poll; Core
      // блокирует её до owner retry (он ротирует attempt — одна новая попытка).
      const releaseReason =
        run.skipReason === "budget_denied" ||
        run.skipReason === "execution_unknown" ||
        run.skipReason === "workflow_changed"
          ? run.skipReason
          : run.skipReason === "llm_invalid_output" || run.skipReason === "llm_failed"
            ? "skill_failed"
            : undefined;
      await core.releaseAgentTask(
        t.id,
        agent.name,
        runId,
        executionAttemptId,
        releaseReason,
        run.reason.slice(0, 1000),
      );
      results.push({ taskId: t.id, outcome: "skipped", note: run.reason });
    } catch (error) {
      if (leaseLost) {
        results.push({
          taskId: t.id,
          outcome: "skipped",
          note: "generation задачи уже перехватил другой worker",
        });
        continue;
      }
      throw error;
    } finally {
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      // Не оставляем висящих timer/request после close/release/ошибки.
      // Assignment происходит в renewLease closure; явный тип не даёт
      // control-flow анализу TS ошибочно счесть значение всегда null.
      const pending = heartbeatRequest as Promise<boolean> | null;
      if (pending !== null) await pending.catch(() => undefined);
    }
  }

  return results;
}
