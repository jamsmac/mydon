import type { AutonomyTier } from "@mydon/shared";
import type { AgentsCoreClient } from "./core-client";
import { EXECUTORS } from "./executors";
import { checkLimit, dailyCap, startOfTashkentDay } from "./limits";
import { signature } from "./memory";
import { effectiveActionTier, explainPolicy, requiresApproval } from "./policy";
import type { AgentDefinition } from "./registry";
import { SKILLS } from "./skills";

export interface RunResult {
  agent: string;
  skill: string;
  outcome: "approval_requested" | "executed" | "skipped";
  approvalId?: string;
  reason: string;
  /** Почему пропущено — вызывающий отличает «нет повода» от «потолок исчерпан». */
  skipReason?: "inactive" | "not_implemented" | "no_signal" | "capped" | "no_change";
  /** Предложение навыка (текст и факты) — чтобы отчёт по задаче не звал навык
   *  повторно (иначе первый прогон и отчёт могут разойтись). */
  action?: string;
  facts?: Record<string, unknown>;
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

  // Эффективный тир — floor из карточки агента и объявленного тира навыка
  // (строже побеждает). Раньше рантайм читал только карточку и молча игнорировал
  // `requires-approval` навыка — навык мог исполниться ниже собственного уровня.
  const tier = effectiveActionTier(agent.autonomyDefault, skillFloor);
  await core.recordEvent({
    source: `agent:${agent.name}`,
    type: "agent.run",
    payload: { skill, tier },
  });

  // Навык ещё не реализован — честно говорим об этом, а не изображаем работу.
  const impl = SKILLS[skill];
  if (impl === undefined) {
    return {
      agent: agent.name,
      skill,
      outcome: "skipped",
      skipReason: "not_implemented",
      reason: `навык "${skill}" ещё не подключён к данным`,
    };
  }

  const proposal = await impl(agent, core);
  if (proposal === null) {
    return {
      agent: agent.name,
      skill,
      outcome: "skipped",
      skipReason: "no_signal",
      reason: "повода нет: по данным Core предлагать нечего",
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
  if (lastSig === sig) {
    return {
      agent: agent.name,
      skill,
      outcome: "skipped",
      skipReason: "no_change",
      reason: "с прошлого раза ничего не изменилось — не повторяю предложение",
      action: proposal.action,
      facts: proposal.facts,
    };
  }

  // Дневной потолок действий: считаем ДО того, как агент вынесет предложение
  // или исполнит. Потолок написали давно (Ф9), но в рантайме не применяли —
  // теперь применяем. Использование берём из журнала Core, а не из памяти.
  const cap = dailyCap();
  if (cap > 0) {
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
  if (executor && !isBreakGlass && !requiresApproval(tier, threshold)) {
    const exec = await executor(agent, proposal, core);
    if (exec.ok) {
      await core.recordEvent({
        source: `agent:${agent.name}`,
        type: "agent.action",
        payload: { skill, action: proposal.action, executed: true, verified: exec.detail },
      });
      // Подача состоялась (исполнено) — запоминаем повод, чтобы не повторять его.
      await core.rememberMemory(source, skill, sig);
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
  const approval = await core.requestApproval({
    agent: agent.name,
    action: proposal.action,
    tier,
    // Факты кладём рядом с предложением: по ним проверяется «по следам»,
    // что агент не выдумал повод.
    payload: { skill, business: agent.business, facts: proposal.facts },
  });
  await core.recordEvent({
    source: `agent:${agent.name}`,
    type: "agent.action",
    payload: { skill, action: proposal.action, approvalId: approval.id },
  });
  // Подача состоялась (вынесено владельцу) — запоминаем повод, чтобы не повторять.
  await core.rememberMemory(source, skill, sig);
  return {
    agent: agent.name,
    skill,
    outcome: "approval_requested",
    approvalId: approval.id,
    action: proposal.action,
    facts: proposal.facts,
    reason: isBreakGlass
      ? `break-glass: навык «${skill}» всегда идёт через согласование`
      : requiresApproval(tier, threshold)
        ? explainPolicy(tier, threshold)
        : "порог допускает исполнение, но исполнителя навыка ещё нет — вынесено на согласование",
  };
}
