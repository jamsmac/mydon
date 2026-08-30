import { createHash, randomUUID } from "node:crypto";
import type { AutonomyTier } from "@mydon/shared";
import {
  LlmBudgetDeniedError,
  LlmLedgerUnavailableError,
  LlmReplayBlockedError,
  isLlmLedgerBlockingError,
} from "@mydon/shared";
import type {
  AgentTaskCheckpoint,
  AgentTaskCommittedOutcome,
  AgentsCoreClient,
} from "./core-client";
import { EXECUTORS } from "./executors";
import { checkLimit, dailyCap, startOfTashkentDay } from "./limits";
import { matchesSignature, signature } from "./memory";
import { effectiveActionTier, explainPolicy, requiresApproval } from "./policy";
import type { AgentDefinition } from "./registry";
import { SKILLS, type SkillRunContext } from "./skills";
import { TaskLlmWorkflowChangedError } from "./task-llm-session";

/** Everything Core needs to atomically fence and commit a task outcome. */
export interface TaskCommitIntent {
  outcome: AgentTaskCommittedOutcome;
  note: string;
  action?: string;
  facts?: Record<string, unknown>;
  next?: string[];
  tier?: AutonomyTier;
  memorySignature?: string;
  executionDetail?: string;
}

export interface RunResult {
  agent: string;
  skill: string;
  outcome: "approval_requested" | "executed" | "skipped";
  approvalId?: string;
  reason: string;
  /** Почему пропущено — вызывающий отличает «нет повода» от «потолок исчерпан». */
  skipReason?:
    | "inactive"
    | "not_implemented"
    | "no_signal"
    | "capped"
    | "no_change"
    | "budget_denied"
    | "execution_unknown"
    | "workflow_changed"
    | "ledger_unavailable";
  /** Предложение навыка (текст и факты) — чтобы отчёт по задаче не звал навык
   *  повторно (иначе первый прогон и отчёт могут разойтись). */
  action?: string;
  facts?: Record<string, unknown>;
  /** Подсказки «что дальше» (follow-up) от навыка. */
  next?: string[];
  /** Task-mode never writes approval/event/memory/task status itself. */
  commit?: TaskCommitIntent;
}

/** Bounded stable key for retry-safe cron events. Task events are committed by Core. */
function eventClientKey(requestKey: string, effect: string): string {
  const hash = createHash("sha256").update(`${requestKey}:${effect}`).digest("hex");
  return `agent-event:${hash}`;
}

/** Stable approval key shared by every replica handling the same cron occurrence. */
function approvalClientKey(requestKey: string): string {
  const hash = createHash("sha256").update(`${requestKey}:approval`).digest("hex");
  return `agent-approval:${hash}`;
}

function checkpointProposal(checkpoint: AgentTaskCheckpoint): {
  action: string;
  facts: Record<string, unknown>;
  next?: string[];
} | null {
  if (checkpoint.kind === "no_signal") return null;
  if (typeof checkpoint.action !== "string" || checkpoint.action.trim() === "") {
    throw new Error(`Task checkpoint ${checkpoint.id} не содержит proposal.action`);
  }
  return {
    action: checkpoint.action,
    facts: checkpoint.facts ?? {},
    ...(checkpoint.next && checkpoint.next.length ? { next: checkpoint.next } : {}),
  };
}

/** A skill may place a bounded owner-facing report in facts without widening action. */
function taskResultNote(proposal: { action: string; facts: Record<string, unknown> }): string {
  const report = proposal.facts.ownerReport;
  const body =
    typeof report === "string" && report.trim().length > 0
      ? report.trim()
      : `${proposal.action}\n\nВынес на твоё решение.`;
  return body.slice(0, 2000);
}

/**
 * Прогон одного навыка агента (Фаза К3: агенты подключены к Core).
 *
 * Порядок: агент СНАЧАЛА смотрит данные Core, и только если есть предметный
 * повод — выносит предложение владельцу. Нет повода — тишина: пустые
 * согласования приучали бы жать «одобрить» не глядя.
 *
 * При текущем пороге (T0 — «всё вручную», ответ владельца Ф6) предложение
 * всегда идёт через согласование. Исполнение появится, когда владелец
 * поднимет порог.
 */
export async function runSkill(
  agent: AgentDefinition,
  skill: string,
  core: AgentsCoreClient,
  threshold: AutonomyTier,
  /** Минимальный тир навыка (frontmatter `requires-approval`). Не задан —
   *  тир берётся только из карточки агента (поведение как раньше). */
  skillFloor?: AutonomyTier,
  invocation?: SkillRunContext,
): Promise<RunResult> {
  if (agent.status !== "active") {
    return {
      agent: agent.name,
      skill,
      outcome: "skipped",
      skipReason: "inactive",
      reason: `агент со статусом "${agent.status}" не запускается`,
    };
  }

  const context: SkillRunContext = invocation ?? {
    requestKey: `agent:${agent.name}:${skill}:${randomUUID()}`,
    traceKey: `agent:${agent.name}:${skill}`,
  };

  // Эффективный тир — floor из карточки агента и объявленного тира навыка
  // (строже побеждает). Раньше рантайм читал только карточку и молча игнорировал
  // `requires-approval` навыка — навык мог исполниться ниже собственного уровня.
  const tier = effectiveActionTier(agent.autonomyDefault, skillFloor);
  const taskMode = context.task;
  const existingCheckpoint = taskMode?.checkpoint;
  if (existingCheckpoint && existingCheckpoint.skill !== skill) {
    throw new Error(
      `Task checkpoint ${existingCheckpoint.id} привязан к ${existingCheckpoint.skill}, а не ${skill}`,
    );
  }

  // Cron keeps the old direct event path. A durable task defers every internal
  // effect to Core commit; even agent.run must not precede its checkpoint.
  if (!taskMode) {
    await context.assertLease?.();
    await core.recordEvent({
      source: `agent:${agent.name}`,
      type: "agent.run",
      payload: { skill, tier },
      clientKey: eventClientKey(context.requestKey, "run"),
    });
  }

  // Навык ещё не реализован — честно говорим об этом, а не изображаем работу.
  const impl = SKILLS[skill];
  if (impl === undefined && existingCheckpoint === undefined) {
    return {
      agent: agent.name,
      skill,
      outcome: "skipped",
      skipReason: "not_implemented",
      reason: `навык "${skill}" ещё не подключён к данным`,
    };
  }

  let proposal;
  try {
    if (existingCheckpoint) {
      // Takeover resumes the immutable Core result and never calls skill/LLM.
      proposal = checkpointProposal(existingCheckpoint);
      await context.assertLease?.();
    } else {
      proposal = await impl!(agent, core, context);
      // Provider/embedding мог ответить уже после takeover. Core's
      // checkpoint endpoint repeats this CAS inside its transaction.
      await context.assertLease?.();
      if (taskMode) {
        await taskMode.saveCheckpoint(
          proposal === null
            ? { skill, kind: "no_signal" }
            : {
                skill,
                kind: "proposal",
                action: proposal.action,
                facts: proposal.facts,
                ...(proposal.next && proposal.next.length ? { next: proposal.next } : {}),
              },
        );
      }
    }
  } catch (error) {
    if (error instanceof TaskLlmWorkflowChangedError) {
      return {
        agent: agent.name,
        skill,
        outcome: "skipped",
        skipReason: "workflow_changed",
        reason: `LLM workflow изменился после старта execution: ${error.message}`,
      };
    }
    if (!isLlmLedgerBlockingError(error)) throw error;
    if (error instanceof LlmReplayBlockedError) {
      return {
        agent: agent.name,
        skill,
        outcome: "skipped",
        skipReason: "execution_unknown",
        reason: `Повтор уже принятого LLM-вызова заблокирован: ${error.message}`,
      };
    }
    if (error instanceof LlmBudgetDeniedError) {
      return {
        agent: agent.name,
        skill,
        outcome: "skipped",
        skipReason: "budget_denied",
        reason: `LLM-бюджет не разрешил вызов (${error.action}): ${error.message}`,
      };
    }
    // instanceof оставляем явным: тип ошибки не должен слиться с no_signal.
    const unavailable = error as LlmLedgerUnavailableError;
    return {
      agent: agent.name,
      skill,
      outcome: "skipped",
      skipReason: "ledger_unavailable",
      reason: `LLM-ledger недоступен — платный вызов не выполнен: ${unavailable.message}`,
    };
  }
  if (proposal === null) {
    const note = "Проверил — по данным MYDON повода для действий нет.";
    return {
      agent: agent.name,
      skill,
      outcome: "skipped",
      skipReason: "no_signal",
      reason: "повода нет: по данным Core предлагать нечего",
      ...(taskMode ? { commit: { outcome: "no_signal", note } } : {}),
    };
  }

  // Дельта-память: повод есть, но не изменился ли он с прошлого раза? Если тот
  // же самый — молчим, не повторяем предложение (иначе владелец приучится жать
  // «одобрить» не глядя). Сигнатуру прошлого повода читаем из журнала Core.
  // Запоминаем НИЖЕ — только после успешной подачи, чтобы перекрытый потолком
  // или несостоявшийся повод не «забылся».
  const source = `agent:${agent.name}`;
  const sig = signature(proposal.facts);
  const lastSig = await core.recallMemory(source, skill);
  if (matchesSignature(lastSig, proposal.facts)) {
    const note = "Проверил — с прошлого раза ничего не изменилось.";
    return {
      agent: agent.name,
      skill,
      outcome: "skipped",
      skipReason: "no_change",
      reason: "с прошлого раза ничего не изменилось — не повторяю предложение",
      action: proposal.action,
      facts: proposal.facts,
      ...(proposal.next && proposal.next.length ? { next: proposal.next } : {}),
      ...(taskMode
        ? {
            commit: {
              outcome: "no_change",
              note,
              action: proposal.action,
              facts: proposal.facts,
              ...(proposal.next && proposal.next.length ? { next: proposal.next } : {}),
            },
          }
        : {}),
    };
  }

  // Дневной потолок действий: считаем ДО того, как агент вынесет предложение
  // или исполнит. Потолок написали давно (Ф9), но в рантайме не применяли —
  // теперь применяем. Использование берём из журнала Core, а не из памяти.
  const cap = dailyCap();
  if (!taskMode && cap > 0) {
    const used = await core.countAgentActions(`agent:${agent.name}`, startOfTashkentDay());
    const limit = checkLimit(used, cap);
    if (!limit.allowed) {
      return {
        agent: agent.name,
        skill,
        outcome: "skipped",
        skipReason: "capped",
        reason: limit.reason ?? `дневной потолок действий исчерпан (${used}/${cap})`,
      };
    }
  }

  // Реальное исполнение — только если (а) порог автономии это разрешает И
  // (б) у навыка есть зарегистрированный исполнитель. Исполнитель САМ проверяет
  // результат: `ok=true` лишь когда действие подтверждено перечиткой. Провал
  // проверки НЕ выдаём за «сделано» — уходим в согласование ниже. Реестр
  // исполнителей пуст → поведение прежнее: всё через согласование (аудит P1:
  // не изображать исполнение без исполнителя).
  // Break-glass: навык из списка агента ВСЕГДА идёт через согласование — не
  // исполняется сам ни при каком пороге. Аварийные/особо рискованные операции
  // владелец держит под ручным контролем осознанно.
  const isBreakGlass = (agent.breakGlass ?? []).includes(skill);

  const executor = EXECUTORS[skill];
  // Task executors mutate Core (notes/cards) and cannot share the task commit
  // transaction. Until each executor has its own durable outbox, task mode
  // must fail safe into approval instead of risking a duplicate effect after
  // crash/takeover. Cron keeps its established direct-execution behaviour.
  if (!taskMode && executor && !isBreakGlass && !requiresApproval(tier, threshold)) {
    await context.assertLease?.();
    const exec = await executor(agent, proposal, core);
    if (exec.ok) {
      await context.assertLease?.();
      await core.recordEvent({
        source: `agent:${agent.name}`,
        type: "agent.action",
        payload: { skill, action: proposal.action, executed: true, verified: exec.detail },
        clientKey: eventClientKey(context.requestKey, "action"),
      });
      // Подача состоялась (исполнено) — запоминаем повод, чтобы не повторять его.
      await context.assertLease?.();
      await core.rememberMemory(source, skill, sig, eventClientKey(context.requestKey, "memory"));
      return {
        agent: agent.name,
        skill,
        outcome: "executed",
        action: proposal.action,
        facts: proposal.facts,
        reason: `исполнено и проверено: ${exec.detail}`,
      };
    }
    // Результат не подтверждён — не врём: не считаем сделанным, выносим владельцу.
  }

  // Действие идёт через согласование: порог не разрешает исполнение, или у
  // навыка нет исполнителя, или исполнитель не подтвердил результат. Порог
  // сохраняем в payload и reason — он в силе, когда исполнитель появится.
  const approvalReason = isBreakGlass
    ? `break-glass: навык «${skill}» всегда идёт через согласование`
    : requiresApproval(tier, threshold)
      ? explainPolicy(tier, threshold)
      : "порог допускает исполнение, но исполнителя навыка ещё нет — вынесено на согласование";
  if (taskMode) {
    return {
      agent: agent.name,
      skill,
      outcome: "approval_requested",
      action: proposal.action,
      facts: proposal.facts,
      ...(proposal.next && proposal.next.length ? { next: proposal.next } : {}),
      reason: approvalReason,
      commit: {
        outcome: "approval_requested",
        note: taskResultNote(proposal),
        action: proposal.action,
        facts: proposal.facts,
        ...(proposal.next && proposal.next.length ? { next: proposal.next } : {}),
        tier,
        memorySignature: sig,
      },
    };
  }

  await context.assertLease?.();
  const approval = await core.requestApproval({
    agent: agent.name,
    action: proposal.action,
    tier,
    clientKey: approvalClientKey(context.requestKey),
    // Факты кладём рядом с предложением: по ним проверяется «по следам»,
    // что агент не выдумал повод.
    payload: {
      skill,
      business: agent.business,
      facts: proposal.facts,
      ...(proposal.next && proposal.next.length ? { next: proposal.next } : {}),
    },
  });
  await context.assertLease?.();
  await core.recordEvent({
    source: `agent:${agent.name}`,
    type: "agent.action",
    payload: { skill, action: proposal.action, approvalId: approval.id },
    clientKey: eventClientKey(context.requestKey, "action"),
  });
  // Подача состоялась (вынесено владельцу) — запоминаем повод, чтобы не повторять.
  await context.assertLease?.();
  await core.rememberMemory(source, skill, sig, eventClientKey(context.requestKey, "memory"));
  return {
    agent: agent.name,
    skill,
    outcome: "approval_requested",
    approvalId: approval.id,
    action: proposal.action,
    facts: proposal.facts,
    ...(proposal.next && proposal.next.length ? { next: proposal.next } : {}),
    reason: approvalReason,
  };
}
