import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { GitHubConnector } from "@mydon/connectors";
import { LlmLedgerUnavailableError, type Domain } from "@mydon/shared";
import { runCoachReview } from "./coach-review";
import type { AgentTaskCheckpoint, AgentTaskInputSnapshot, AgentsCoreClient } from "./core-client";
import { embeddingGatewayFromEnv } from "./embedding";
import { llmLedgerFromEnv } from "./llm-ledger";
import type { AgentDefinition } from "./registry";
import { assessIdeas, buildIdeasProposal, readIdeaChannels, type IdeasMemory } from "./ideas";
import { modelGatewayFromEnv, type ModelReasoningEffort } from "./model-gateway";
import { partsAudit } from "./parts-audit";
import { isLlmSkill, llmSkill } from "./llm-skill";
import { findSolutions } from "./solution-search";
import type { TaskLlmSession } from "./task-llm-session";
import { loadSkillMeta } from "./skill-loader";
import { buildWebProposal, readWebSources } from "./web-read";

/** Каталог агентов — как в index.ts; нужен coach-у для чтения файлов навыков. */
const AGENTS_DIR = path.resolve(__dirname, "../agents");

/**
 * Предметные навыки агентов (Фаза К3: агенты подключены к Core).
 *
 * До этого прогон навыка создавал согласование ВСЕГДА — даже когда предлагать
 * нечего. Такой шум приучает владельца жать «одобрить» не глядя, и очередь
 * перестаёт быть сигналом. Теперь навык сперва СМОТРИТ данные Core и:
 *   • есть повод  → готовит предложение с конкретикой (что и почему);
 *   • повода нет  → возвращает null, согласование не создаётся.
 *
 * Данных владелец пока не загружал (ТЗ: только структурный сид), поэтому на
 * пустой базе навыки честно молчат — это ожидаемое, а не сломанное поведение.
 */

/** Предложение агента: что вынести владельцу на решение. */
export interface Proposal {
  /** Человеко-понятная формулировка: что предлагается и почему. */
  action: string;
  /** Факты, на которых построено предложение — для проверки «по следам». */
  facts: Record<string, unknown>;
  /**
   * СТАБИЛЬНОЕ подмножество фактов ТОЛЬКО для дельта-памяти (дедупа). Когда
   * задано — runner считает сигнатуру от него, а не от `facts`. Так владельцу
   * по-прежнему показываются ПОЛНЫЕ `facts`, а повтор подавляется по
   * содержательному подмножеству без волатильных полей (excerpt/costUsd/
   * retrievedAt/stars/сырьё LLM), которые «плывут» каждый прогон и иначе не
   * давали сигнатуре совпасть — навык слал бы дубли. Не задано → сигнатура
   * от `facts` целиком (прежнее поведение). Значения должны быть
   * детерминированы (отсортированы), иначе сигнатура снова «поплывёт».
   */
  signatureFacts?: Record<string, unknown>;
  /** Подсказки «что дальше» (follow-up) — платформа их показывает (F0.5). */
  next?: string[];
}

export interface TaskSkillCheckpointDraft {
  skill: string;
  kind: "no_signal" | "proposal";
  action?: string;
  facts?: Record<string, unknown>;
  next?: string[];
}

/** Durable task-only context. Cron invocations intentionally omit it. */
export interface TaskSkillRunContext {
  /** Existing Core checkpoint returned by claim after crash/takeover. */
  checkpoint?: AgentTaskCheckpoint;
  /** Existing immutable public retrieval evidence returned by start/takeover. */
  inputSnapshot?: AgentTaskInputSnapshot;
  /** First-write-wins Core persistence before a dependent paid ranking call. */
  saveInputSnapshot?: (input: {
    kind: string;
    payload: Record<string, unknown>;
  }) => Promise<AgentTaskInputSnapshot>;
  /** CAS-fenced persistence; must finish before any task side effect. */
  saveCheckpoint: (checkpoint: TaskSkillCheckpointDraft) => Promise<AgentTaskCheckpoint>;
  /** Core-owned provider jobs/results for metered task calls. */
  llm?: TaskLlmSession;
}

/** Навык: читает Core и либо предлагает дело, либо честно молчит (null). */
export interface SkillRunContext {
  /** Уникальная основа физического прогона навыка. */
  requestKey: string;
  /** Стабильная корреляция задачи/крона. */
  traceKey?: string;
  /** Fail-closed CAS перед каждым provider dispatch durable task-run. */
  assertLease?: () => Promise<void>;
  /**
   * Atomic Core snapshot used by task-only skills; never use the stale list row.
   * `agentSkill` — явный навык задачи (R-SD-3), `runOptions.modelEffort` —
   * усилие ЭТОГО прогона, перекрывающее усилие паспорта (R-SD-4). Оба поля
   * есть только когда владелец их задал.
   */
  taskInput?: {
    title: string;
    description?: string;
    domain?: Domain;
    agentSkill?: string;
    runOptions?: { modelEffort?: ModelReasoningEffort };
  };
  /** Есть только у порученной Core task; включает checkpoint/resume. */
  task?: TaskSkillRunContext;
}

export type Skill = (
  agent: AgentDefinition,
  core: AgentsCoreClient,
  context?: SkillRunContext,
) => Promise<Proposal | null>;

function runContext(
  agent: AgentDefinition,
  skill: string,
  context: SkillRunContext | undefined,
): SkillRunContext {
  return (
    context ?? {
      requestKey: `agent:${agent.name}:${skill}:${randomUUID()}`,
      traceKey: `agent:${agent.name}:${skill}`,
    }
  );
}

function asDomain(business: string): Domain {
  const known = ["globerent", "vendhub", "personal", "mydon"];
  return (known.includes(business) ? business : "mydon") as Domain;
}

/** Сумма прописью для владельца: без хвостов и с разделением разрядов. */
function money(amount: string | number, currency: string): string {
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n)) return `${String(amount)} ${currency}`;
  return `${Math.round(n).toLocaleString("ru-RU")} ${currency}`;
}

// ── mydon-finance: контроль дебиторки ────────────────────────────────────────
const watchReceivables: Skill = async (agent, core) => {
  const domain = asDomain(agent.business);
  const o = await core.obligations(domain);
  if (o.overdueTotal === 0) return null; // просрочек нет — повода нет

  const top = o.overdue[0];
  const sum = o.overdue.reduce((acc, r) => acc + (Number(r.amount) || 0), 0);
  const cur = top?.currency ?? "UZS";
  const tail = o.overdueTruncated ? ` (показаны первые ${o.overdue.length})` : "";

  return {
    action:
      `Разобрать просроченную дебиторку: ${o.overdueTotal} позиций на ${money(sum, cur)}${tail}. ` +
      `Самая давняя — от ${top?.date ?? "неизвестной даты"}.`,
    facts: {
      domain,
      overdueTotal: o.overdueTotal,
      sum: Math.round(sum),
      currency: cur,
      oldestDate: top?.date ?? null,
      truncated: o.overdueTruncated,
    },
  };
};

// ── vendhub-ops: простаивающие автоматы ──────────────────────────────────────
const monitorStock: Skill = async (_agent, core) => {
  const b = await core.briefing();
  if (b.idleMachines === 0) return null; // все работают — повода нет

  const facts = { idleMachines: b.idleMachines };
  // Дедуп — по СОСТАВУ простаивающих, а не только по числу. Тот же различитель,
  // что закрыл ротацию у morning-digest: A починен, встал B — idleMachines всё
  // время 1 (обнуления до 0, что сбросило бы память через no_signal, нет), и без
  // состава сигнатура совпала бы → no_change → владелец через этот навык не
  // узнал бы, что теперь стоит ДРУГОЙ автомат. alarmComposition.idleMachines из
  // Core (хеш отсортированного состава) меняется ⟺ меняется состав. Кладём его в
  // signatureFacts (ключ дедупа), а facts владельцу оставляем прежними (только
  // счётчик). Старое ядро без alarmComposition → сигнатура по счётчику (прежнее
  // поведение, без падения).
  const signatureFacts = b.alarmComposition
    ? { ...facts, composition: b.alarmComposition.idleMachines }
    : facts;
  return {
    action:
      `Проверить простаивающие автоматы: ${b.idleMachines} без признака работы. ` +
      `Нужен выезд или пополнение — решает владелец.`,
    facts,
    signatureFacts,
  };
};

// ── chief-of-staff: утренняя сводка ──────────────────────────────────────────
const morningDigest: Skill = async (_agent, core) => {
  const b = await core.briefing();
  const alarms: string[] = [];
  if (b.overdueMoney > 0) alarms.push(`просрочено платежей: ${b.overdueMoney}`);
  if (b.idleMachines > 0) alarms.push(`автоматы простаивают: ${b.idleMachines}`);
  if (b.contractsDueSoon > 0) alarms.push(`договоры на исходе: ${b.contractsDueSoon}`);
  if (b.overdueTasks > 0) alarms.push(`просроченные задачи: ${b.overdueTasks}`);
  // Нераспознанные даты — «известная неизвестность»: молчать о них нельзя.
  if (b.contractsBadDate > 0)
    alarms.push(`договоров с нераспознанной датой: ${b.contractsBadDate}`);

  if (alarms.length === 0) return null; // тревог нет — не дёргаем владельца

  // Отображаемые владельцу факты — содержательные счётчики, от которых построены
  // тревоги (полные, НЕ урезаны). Раньше здесь было `{ ...b }` — spread копировал
  // ВЕСЬ рантайм-ответ Core, включая generatedAt (уникален каждый запуск) и
  // pendingApprovals (растёт из-за самих согласований), и сигнатура (тогда — от
  // facts целиком) не совпадала никогда: одна и та же сводка подавалась заново.
  const facts = {
    overdueMoney: b.overdueMoney,
    idleMachines: b.idleMachines,
    contractsDueSoon: b.contractsDueSoon,
    overdueTasks: b.overdueTasks,
    contractsBadDate: b.contractsBadDate,
  };
  // Дедуп — по СОСТАВУ тревог, а не только по числу. Счётчики глотали ротацию:
  // A оплачен, но просрочился новый C (overdueMoney по-прежнему 2) — та же
  // сигнатура, владелец не узнавал о новом инциденте. alarmComposition из Core
  // (детерминированный хеш отсортированных id по каждой категории) меняется ⟺
  // меняется состав. Кладём различители в signatureFacts (ключ дедупа), а не в
  // отображаемые facts: владельцу показывать хеши незачем. Старое ядро без
  // alarmComposition → сигнатура по счётчикам (прежнее поведение, без падения).
  const signatureFacts = b.alarmComposition
    ? { ...facts, composition: b.alarmComposition }
    : facts;
  return {
    action: `Разобрать за день: ${alarms.join("; ")}.`,
    facts,
    signatureFacts,
  };
};

// ── market-analyst: чтение указанных владельцем сайтов (только чтение) ────────
const readSources: Skill = async (agent) => {
  const sources = agent.webSources ?? [];
  if (sources.length === 0) return null; // источников нет — читать нечего
  const results = await readWebSources(sources);
  return buildWebProposal(results);
};

// ── knowledge-curator: идеи из Telegram-каналов владельца (@promtjam) ─────────
const scanIdeas: Skill = async (agent) => {
  const channels = agent.ideaChannels ?? [];
  if (channels.length === 0) return null; // каналов нет — читать нечего
  const digests = await readIdeaChannels(channels);
  return buildIdeasProposal(digests);
};

// ── knowledge-curator: ОЦЕНКА идей моделью (первый LLM-навык, Stage 0) ────────
const assessIdeasSkill: Skill = async (agent, core, context) => {
  const call = runContext(agent, "assess-ideas", context);
  const gateway = modelGatewayFromEnv();
  if (gateway === null) return null; // LLM-путь выключен — навык спит
  const channels = agent.ideaChannels ?? [];
  if (channels.length === 0) return null;
  const digests = await readIdeaChannels(channels);
  // Есть embed-шлюз → включаем семантический дедуп идей; нет → память спит.
  const embedder = embeddingGatewayFromEnv();
  const memory: IdeasMemory | undefined = embedder
    ? { core, embedder, namespace: "ideas" }
    : undefined;
  const taskLlm = call.task?.llm;
  const hasMeteredRoute = gateway.billingMode === "metered" || embedder?.billingMode === "metered";
  if (call.task && hasMeteredRoute && !taskLlm) {
    throw new LlmLedgerUnavailableError("Task-mode metered route не получил durable LLM session");
  }
  const needsLedger = call.task === undefined && hasMeteredRoute;
  const ledger = needsLedger ? llmLedgerFromEnv() : undefined;
  return assessIdeas(gateway, digests, {
    agentName: agent.name,
    requestKey: call.requestKey,
    ...(call.traceKey ? { traceKey: call.traceKey } : {}),
    ...(call.assertLease ? { assertLease: call.assertLease } : {}),
    ...(ledger ? { ledger } : {}),
    ...(taskLlm ? { taskLlm } : {}),
    ...(memory ? { memory } : {}),
    ...(call.task ? { deferMemoryWrites: true } : {}),
  });
};

// ── solution-scout: bounded GitHub research + one durable ranking step ───────
const findSolutionSkill: Skill = async (agent, _core, context) => {
  const call = runContext(agent, "find-solution", context);
  if (!call.task) return null; // First slice is intentionally assigned-task only.
  if (!call.taskInput) {
    throw new LlmLedgerUnavailableError(
      "Task-mode solution-scout не получил atomic taskInput из Core claim",
    );
  }

  const gateway = modelGatewayFromEnv();
  if (gateway === null) {
    throw new LlmLedgerUnavailableError(
      "Task-mode solution-scout не получил настроенный LLM route",
    );
  }
  if (gateway.billingMode === "metered" && !call.task.llm) {
    throw new LlmLedgerUnavailableError(
      "Task-mode metered solution-scout не получил durable LLM session",
    );
  }

  const saveInputSnapshot = call.task.saveInputSnapshot;
  if (!call.task.inputSnapshot && !saveInputSnapshot) {
    throw new LlmLedgerUnavailableError(
      "Task-mode solution-scout не получил Core input-snapshot boundary",
    );
  }

  return findSolutions(gateway, new GitHubConnector(), call.taskInput, {
    agentName: agent.name,
    requestKey: call.requestKey,
    ...(call.traceKey ? { traceKey: call.traceKey } : {}),
    ...(call.assertLease ? { assertLease: call.assertLease } : {}),
    ...(call.task.llm ? { taskLlm: call.task.llm } : {}),
    snapshotPort: {
      ...(call.task.inputSnapshot ? { existing: call.task.inputSnapshot } : {}),
      save: async (kind, payload) => {
        if (!saveInputSnapshot) {
          throw new LlmLedgerUnavailableError(
            "Core input-snapshot boundary недоступен для новой retrieval попытки",
          );
        }
        return saveInputSnapshot({ kind, payload });
      },
    },
  });
};

// ── coach-agent: судья + предложение правки навыка (EVAL/PROPOSE) ────────────
/** Читатель SKILL.md по имени навыка — из каталога агентов на диске. */
function readSkillFile(skill: string): { content: string; rel: string } | null {
  const meta = loadSkillMeta(AGENTS_DIR).find((m) => m.name === skill);
  if (!meta) return null;
  try {
    return { content: fs.readFileSync(meta.file, "utf8"), rel: `${meta.agent}/skills/${skill}.md` };
  } catch {
    return null;
  }
}

const coachReview: Skill = async (agent, core, context) => {
  const call = runContext(agent, "coach-review", context);
  const gateway = modelGatewayFromEnv();
  if (gateway === null) return null; // судья не подключён — навык спит
  if (call.task && gateway.billingMode === "metered" && !call.task.llm) {
    throw new LlmLedgerUnavailableError("Task-mode metered coach не получил durable LLM session");
  }
  return runCoachReview(
    gateway,
    {
      latestAction: () => core.latestAgentAction(),
      readSkill: readSkillFile,
      selfSource: `agent:${agent.name}`,
    },
    {
      agentName: agent.name,
      requestKey: call.requestKey,
      ...(call.traceKey ? { traceKey: call.traceKey } : {}),
      ...(call.assertLease ? { assertLease: call.assertLease } : {}),
      ...(call.task?.llm ? { taskLlm: call.task.llm } : {}),
      ...(gateway.billingMode === "metered" && !call.task?.llm
        ? { ledger: llmLedgerFromEnv() }
        : {}),
    },
  );
};

/**
 * Реестр реализованных навыков. Навыка нет в реестре — прогон честно
 * сообщает, что он ещё не подключён (а не изображает работу).
 */
export const SKILLS: Record<string, Skill> = {
  "watch-receivables": watchReceivables,
  "monitor-stock": monitorStock,
  "parts-audit": partsAudit,
  "morning-digest": morningDigest,
  "read-sources": readSources,
  "scan-ideas": scanIdeas,
  "assess-ideas": assessIdeasSkill,
  "coach-review": coachReview,
  "find-solution": findSolutionSkill,
};

/** Навык реализован кодом (реестр SKILLS). */
export function hasCodeSkill(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(SKILLS, name);
}

/**
 * Навык «подключён»: есть код ИЛИ зарегистрирован llm-исполнитель (frontmatter
 * `executor: llm`). Раньше подключённость означала только код; теперь runner и
 * подбор навыка по задаче видят оба вида одинаково.
 */
export function hasSkill(name: string): boolean {
  return hasCodeSkill(name) || isLlmSkill(name);
}

/** Реализация навыка: код побеждает llm (двусмысленность помечает check-passports). */
export function resolveSkill(name: string): Skill | undefined {
  return SKILLS[name] ?? llmSkill(name);
}
