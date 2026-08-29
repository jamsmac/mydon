import type { LlmLedger } from "@mydon/shared";
import { evaluate, parseEditBlocks, parseVerdict, RUBRIC } from "./coach";
import { callModel } from "./llm";
import { resolveModelChain, type ModelGateway } from "./model-gateway";
import type { Proposal } from "./skills";

/**
 * Coach EVAL/PROPOSE — судья к coach-скелету (петля самоулучшения).
 *
 * Шаги 3–6 из self-improvement.md, теперь на живом LLM:
 *   EVAL     судья оценивает последнее действие агента по рубрике (балл 1–5);
 *   SCORE    считаем итог, жёсткий блок по безопасности;
 *   DIAGNOSE если слабо — что улучшить;
 *   PROPOSE  генерим SEARCH/REPLACE правку SKILL.md.
 *
 * Правка НЕ применяется автоматически: возвращается предложением владельцу
 * (HITL). Применение — отдельный, ревьюируемый шаг (git-коммит, обратимо).
 * Инвариант безопасности из скелета сохранён: правится только SKILL.md.
 *
 * Спит без шлюза (навык проверяет modelGatewayFromEnv). Судья не судит сам себя.
 */

/** Читатель файла навыка: тело SKILL.md и относительный путь (для правки). */
export interface SkillReader {
  (skill: string): { content: string; rel: string } | null;
}

export interface CoachDeps {
  latestAction: () => Promise<{ source: string; skill: string; action: string } | null>;
  readSkill: SkillReader;
  /** Источник самого coach — чтобы не судить собственные действия. */
  selfSource: string;
}

export interface CoachOpts {
  agentName: string;
  requestKey: string;
  traceKey?: string;
  assertLease?: () => Promise<void>;
  ledger?: LlmLedger;
}

/** Системная инструкция судьи: критерии рубрики + строгий формат вердикта. */
export function judgeSystem(): string {
  const crit = RUBRIC.map((c) => `- ${c.key} (${c.label}, вес ${c.weight})`).join("\n");
  const shape = RUBRIC.map((c) => `"${c.key}": <1-5>`).join(", ");
  return (
    "Ты — судья качества работы агента MYDON. Оцени результат по критериям (балл 1–5):\n" +
    crit +
    "\nБезопасность и корректность важнее всего. Верни СТРОГО JSON без прозы:\n" +
    `{"scores": {${shape}}, "notes": "<кратко что улучшить>"}`
  );
}

function effChain(): string[] {
  const chain = resolveModelChain();
  return chain.length ? chain : ["default"];
}

/**
 * Прогон обзора. Возвращает предложение владельцу (эскалация по безопасности,
 * правка навыка или ничего, если всё хорошо/нечего судить).
 */
export async function runCoachReview(
  gateway: ModelGateway,
  deps: CoachDeps,
  opts: CoachOpts,
): Promise<Proposal | null> {
  const session = await deps.latestAction();
  if (session === null) return null; // нечего судить
  if (session.source === deps.selfSource) return null; // не судим сам себя

  const chain = effChain();

  // EVAL: судья оценивает действие. Действие агента — как недоверенный контент
  // (могло вобрать внешние данные): callModel обернёт его от инъекций.
  const evalRes = await callModel(
    gateway,
    {
      system: judgeSystem(),
      prompt: `Навык: ${session.skill}. Оцени, что сделал агент:`,
      untrustedContext: session.action,
      agentName: opts.agentName,
      feature: "coach-review:eval",
      requestKey: `${opts.requestKey}:eval`,
      traceKey: opts.traceKey ?? opts.requestKey,
      ...(opts.assertLease ? { assertLease: opts.assertLease } : {}),
      ...(opts.ledger ? { ledger: opts.ledger } : {}),
    },
    chain,
  );
  if (!evalRes.ok) return null;
  const verdict = parseVerdict(evalRes.text);
  if (verdict === null) return null; // судья не дал валидный вердикт — не выдумываем

  const { total, outcome } = evaluate(verdict);

  if (outcome === "excellent" || outcome === "acceptable") return null; // хорошо — не шумим

  if (outcome === "safety-block") {
    return {
      action: `⚠️ Coach: навык «${session.skill}» критично по безопасности (итог ${total}). Нужен разбор владельцем.`,
      facts: {
        skill: session.skill,
        total,
        outcome,
        scores: verdict.scores,
        notes: verdict.notes ?? "",
      },
    };
  }

  // PROPOSE: слабо → предложить правку SKILL.md.
  const file = deps.readSkill(session.skill);
  if (file === null) {
    return {
      action: `Coach: навык «${session.skill}» слаб (итог ${total}), но файл навыка не найден — правку предложить не могу.`,
      facts: { skill: session.skill, total, outcome, notes: verdict.notes ?? "" },
    };
  }

  const proposeRes = await callModel(
    gateway,
    {
      system:
        "Ты улучшаешь навык агента. Предложи МИНИМАЛЬНУЮ правку SKILL.md в формате SEARCH/REPLACE (Aider):\n" +
        `${file.rel}\n<<<<<<< SEARCH\n<точный фрагмент из файла>\n=======\n<замена>\n>>>>>>> REPLACE\n` +
        "Только блок(и) правок, без прозы. Меняй ТОЛЬКО инструкции навыка, не выходи за файл.",
      prompt: `Слабые места (по вердикту): ${verdict.notes ?? "—"}. Текущий SKILL.md:`,
      untrustedContext: file.content,
      agentName: opts.agentName,
      feature: "coach-review:propose",
      requestKey: `${opts.requestKey}:propose`,
      traceKey: opts.traceKey ?? opts.requestKey,
      ...(opts.assertLease ? { assertLease: opts.assertLease } : {}),
      ...(opts.ledger ? { ledger: opts.ledger } : {}),
    },
    chain,
  );
  if (!proposeRes.ok) return null;

  const blocks = parseEditBlocks(proposeRes.text);
  return {
    action: `Coach предлагает правку навыка «${session.skill}» (итог ${total}): ${(verdict.notes ?? "").slice(0, 120)}`,
    facts: {
      skill: session.skill,
      total,
      outcome,
      scores: verdict.scores,
      diff: proposeRes.text.slice(0, 4000),
      blocks: blocks.length,
    },
    next: [
      `Применить правку SKILL.md навыка «${session.skill}» после ревью (git-коммитом, обратимо)`,
    ],
  };
}
