import { LlmLedgerUnavailableError, type AutonomyTier } from "@mydon/shared";
import type { AgentsCoreClient } from "./core-client";
import type { AgentDefinition } from "./registry";
import { runSkill } from "./runner";
import { hasSkill } from "./skills";
import { TaskLlmSession } from "./task-llm-session";
import { buildTaskLlmWorkflowPlan } from "./task-llm-workflow";

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

/** Заведомо меньше 15-минутного stale lease Core. */
export const AGENT_RUN_HEARTBEAT_MS = 60_000;

/** По заголовку задачи ищем навык агента, который её закрывает. */
export function matchSkill(agent: AgentDefinition, title: string): string | null {
  const text = title.toLowerCase();
  // Прямое упоминание навыка в тексте — самый надёжный признак.
  for (const skill of agent.skills) {
    if (text.includes(skill.toLowerCase()) && hasSkill(skill)) return skill;
  }
  // Иначе — по смыслу: слова задачи против того, что навык умеет.
  const HINTS: Record<string, RegExp> = {
    "watch-receivables": /дебитор|долг|просроч|платеж|оплат/,
    "monitor-stock": /остат|автомат|пополн|простаив|запас/,
    "morning-digest": /сводк|дайджест|обзор|что нового|как дела/,
    "read-sources": /источник|сайт|страниц|прочит|разведк|рынок|тендер|цен[аы]/,
    "scan-ideas": /иде[яйи]|канал|что нового|фишк|перенять|promtjam/,
    "coach-review": /обзор|оцени агент|самоулучшен|coach|разбор недел/,
  };
  for (const skill of agent.skills) {
    const re = HINTS[skill];
    if (re && re.test(text) && hasSkill(skill)) return skill;
  }
  return null;
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
): Promise<TaskRunResult[]> {
  if (agent.status !== "active") return [];

  const tasks = await core.myTasks(agent.name);
  const results: TaskRunResult[] = [];

  for (const t of tasks) {
    // Core — единственная точка конкурентного выбора. Два worker могут
    // увидеть одну задачу в myTasks(), но лишь один получит durable runId.
    const claim = await core.claimAgentTask(t.id, agent.name);
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
        claim.execution?.skill ??
        claimedCheckpoint?.skill ??
        matchSkill(agent, claim.taskInput.title);
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
      const requestedPlan = claim.execution?.plan ?? buildTaskLlmWorkflowPlan(skill);
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
        task: {
          ...(checkpoint ? { checkpoint } : {}),
          llm: taskLlm,
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
      await core.releaseAgentTask(
        t.id,
        agent.name,
        runId,
        executionAttemptId,
        run.skipReason === "budget_denied" ||
          run.skipReason === "execution_unknown" ||
          run.skipReason === "workflow_changed"
          ? run.skipReason
          : undefined,
        run.reason,
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
