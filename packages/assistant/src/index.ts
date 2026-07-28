import { DOMAIN_LABELS, DOMAINS, type Domain } from "@mydon/shared";
import { DOMAIN_HINT, parseIntent, type Intent } from "./intent";

export { parseIntent, DOMAIN_HINT };
export type { Intent };

// LLM-слой (реализация порта LlmResolver через Claude API). SDK внутри грузится
// лениво — этот реэкспорт не тянет @anthropic-ai/sdk при импорте пакета.
export { createLlmResolver } from "./llm";
export type { LlmConfig } from "./llm";

// ── Данные, которые помощнику нужны от Core. Сурфейс (бот/панель) даёт адаптер. ──
export interface AssistantBriefing {
  overdueMoney: number;
  idleMachines: number;
  pendingApprovals: number;
  contractsDueSoon: number;
  /** Договоры с нераспознанной датой — «известная неизвестность» из Core. */
  contractsBadDate?: number;
  overdueTasks?: number;
}
export interface AssistantApproval {
  id: string;
  agent: string;
  action: string;
  tier: string;
}
export interface AssistantEntity {
  name: string;
  type: string;
}
export interface AssistantObligations {
  totals: unknown[];
  overdue: unknown[];
}
export interface AssistantAudit {
  actorKind: "human" | "agent" | "system";
  action: string;
  actorRef: string | null;
  ts: string;
}

/** Что помощник умеет спросить у Core. Реализуется и ботом, и панелью. */
export interface AssistantCore {
  briefing(): Promise<AssistantBriefing>;
  pendingApprovals(): Promise<AssistantApproval[]>;
  obligations(domain: Domain): Promise<AssistantObligations>;
  searchEntities(q: { q: string; domain?: Domain }): Promise<AssistantEntity[]>;
  recent(limit: number): Promise<AssistantAudit[]>;
}

export interface AssistantReply {
  text: string;
  /** Если ответ про конкретное согласование — сурфейс может привесить кнопки. */
  approvalId?: string;
}

// ── LLM-слой (FR-4): понимает вопросы вне готовых правил ──────────────────────
// Резолвер — это порт: сурфейс подаёт реализацию (Claude API), а ядро остаётся
// чистым и тестируемым без сети. Задача резолвера — ПОНЯТЬ вопрос: перевести его
// в известное намерение (тогда ответ соберёт Core — факты честные) или дать
// короткий фактический ответ по снимку. «Не понял» → none, ответит подсказка.

/** Снимок системы, который ядро отдаёт резолверу для заземления ответа. */
export interface LlmSnapshot {
  briefing: AssistantBriefing;
  pendingApprovals: number;
  /** Человеко-понятные метки последних действий из журнала. */
  recentLabels: string[];
  /** Список направлений («globerent, vendhub, …») для распознавания домена. */
  domains: string;
}

export type LlmResolution =
  | { kind: "intent"; intent: Intent } // выполнить это намерение через Core
  | { kind: "answer"; text: string } // готовый фактический ответ по снимку
  | { kind: "none" }; // не удалось понять

export type LlmResolver = (question: string, snapshot: LlmSnapshot) => Promise<LlmResolution>;

export interface AnswerOptions {
  /** Если задан — непонятые вопросы уходят в LLM. Нет ключа/резолвера → подсказка. */
  llm?: LlmResolver;
}

const HELP = [
  "MYDON на связи. Что умею:",
  "",
  "• «брифинг» — сводка: просрочки, автоматы, сроки, что требует решения",
  "• «что просрочено» — обязательства и долги",
  "• «какие автоматы простаивают»",
  "• «согласования» — очередь на твоё решение",
  "• «найди Olma» — поиск по реестру",
  "• «что было / что я решал» — память: последние действия",
].join("\n");

/** Человеко-понятное имя действия из журнала. */
function actionLabel(action: string): string {
  const map: Record<string, string> = {
    "entity.create": "завёл карточку",
    "entity.update": "изменил карточку",
    "task.create": "поставил задачу",
    "task.done": "закрыл задачу",
    "approval.request": "агент попросил разрешения",
    "approval.approved": "ты одобрил",
    "approval.rejected": "ты отклонил",
    "approval.clarify": "ты отправил на уточнение",
    "claim.confirmed": "заявленное подтвердилось",
    "claim.refuted": "заявленное НЕ подтвердилось",
  };
  return map[action] ?? action;
}

/** Компактный снимок для заземления LLM-ответа. Собирается только при непонятом
 * вопросе — на распознанные правилами вопросы лишних обращений к Core нет. */
async function buildSnapshot(core: AssistantCore): Promise<LlmSnapshot> {
  const [briefing, approvals, recent] = await Promise.all([
    core.briefing(),
    core.pendingApprovals(),
    core.recent(5),
  ]);
  return {
    briefing,
    pendingApprovals: approvals.length,
    recentLabels: recent.map((e) => actionLabel(e.action)),
    domains: DOMAINS.join(", "),
  };
}

/**
 * Единый ответ помощника. UI-агностичен: возвращает текст (+ id согласования,
 * если релевантно). Бот привешивает клавиатуру, панель — кнопки.
 *
 * Порядок: правила (быстро, без сети) → если непонятно и есть LLM, спросить его.
 * Ошибки Core наружу превращаются в понятную фразу — детали остаются у сурфейса.
 */
export async function answer(
  text: string,
  core: AssistantCore,
  opts: AnswerOptions = {},
): Promise<AssistantReply> {
  const intent = parseIntent(text);

  if (intent.kind !== "unknown") {
    return dispatchKnown(intent, core);
  }

  // Непонятый вопрос. Без LLM — подсказка (прежнее поведение).
  if (!opts.llm) return { text: HELP };

  let res: LlmResolution;
  try {
    const snapshot = await buildSnapshot(core);
    res = await opts.llm(intent.text, snapshot);
  } catch {
    // LLM недоступен (нет ключа, сеть, лимит) — не роняем помощника, даём подсказку.
    return { text: HELP };
  }

  if (res.kind === "answer") {
    const t = res.text.trim();
    return { text: t.length > 0 ? t : HELP };
  }
  if (res.kind === "intent") {
    // Защита от петли: LLM не может снова вернуть «непонятно».
    if (res.intent.kind === "unknown") return { text: HELP };
    return dispatchKnown(res.intent, core);
  }
  return { text: HELP };
}

/** Выполнение уже распознанного намерения через Core (общее для правил и LLM). */
async function dispatchKnown(intent: Intent, core: AssistantCore): Promise<AssistantReply> {
  switch (intent.kind) {
    case "help":
      return { text: HELP };

    case "briefing": {
      const [b, approvals] = await Promise.all([core.briefing(), core.pendingApprovals()]);
      const alarms: string[] = [];
      if (b.overdueMoney > 0) alarms.push(`💸 просрочено платежей: ${b.overdueMoney}`);
      if (b.idleMachines > 0) alarms.push(`☕ автоматы простаивают: ${b.idleMachines}`);
      if (b.contractsDueSoon > 0) alarms.push(`📄 договоры на исходе: ${b.contractsDueSoon}`);
      if ((b.overdueTasks ?? 0) > 0) alarms.push(`⏰ просроченных задач: ${b.overdueTasks}`);
      if (approvals.length > 0) alarms.push(`✋ ждут решения: ${approvals.length}`);
      if (alarms.length === 0) {
        return { text: "☀️ Тревог нет: просрочек, простоев и незакрытых согласований не найдено." };
      }
      return { text: ["☀️ Сводка:", "", ...alarms].join("\n") };
    }

    case "approvals": {
      const list = await core.pendingApprovals();
      if (list.length === 0) return { text: "Очередь пуста — ничего не ждёт твоего решения." };
      const first = list[0];
      const more = list.length > 1 ? `\n\nВсего в очереди: ${list.length}.` : "";
      return {
        text: `✋ Требует решения\n\n${first.action}\n\nАгент: ${first.agent} · уровень ${first.tier}${more}`,
        approvalId: first.id,
      };
    }

    case "overdue": {
      const b = await core.briefing();
      return {
        text:
          b.overdueMoney > 0
            ? `Просрочено платежей: ${b.overdueMoney}. Полный список — в разделе обязательств.`
            : "Просрочек не найдено.",
      };
    }

    case "machines": {
      const b = await core.briefing();
      return {
        text:
          b.idleMachines > 0
            ? `Простаивают автоматы: ${b.idleMachines}.`
            : "Простаивающих автоматов не найдено.",
      };
    }

    case "obligations": {
      const o = await core.obligations(intent.domain);
      const label = DOMAIN_LABELS[intent.domain];
      if (o.totals.length === 0) {
        return { text: `По направлению ${label} обязательств в реестре пока нет.` };
      }
      return {
        text: `Обязательства ${label}: позиций ${o.totals.length}, просрочено ${o.overdue.length}.`,
      };
    }

    case "search": {
      let found = await core.searchEntities({
        q: intent.query,
        ...(intent.domain ? { domain: intent.domain } : {}),
      });
      // Слово запроса может совпасть с названием направления и сузить поиск не туда.
      if (found.length === 0 && intent.domain) {
        found = await core.searchEntities({ q: intent.query });
      }
      if (found.length === 0) return { text: `По запросу «${intent.query}» ничего не найдено.` };
      const lines = found.slice(0, 10).map((e) => `• ${e.name} (${e.type})`);
      if (found.length > 10) lines.push(`…и ещё ${found.length - 10}`);
      return { text: [`Нашёл по «${intent.query}»:`, "", ...lines].join("\n") };
    }

    case "recent": {
      const log = await core.recent(10);
      if (log.length === 0) return { text: "Пока ничего не происходило — журнал пуст." };
      const lines = log.map((e) => {
        const who = e.actorKind === "human" ? "ты" : e.actorKind === "agent" ? "агент" : "система";
        const ref = e.actorRef ? ` (${e.actorRef})` : "";
        return `• ${actionLabel(e.action)}${e.actorKind === "human" ? "" : ` — ${who}${ref}`}`;
      });
      return { text: ["Последнее в системе:", "", ...lines].join("\n") };
    }

    default:
      // Сюда попадает только «unknown» — его answer() уводит в LLM раньше.
      return { text: HELP };
  }
}
