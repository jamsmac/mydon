import { DOMAIN_LABELS, type Domain } from "@mydon/shared";
import { DOMAIN_HINT, parseIntent, type Intent } from "./intent";

export { parseIntent, DOMAIN_HINT };
export type { Intent };

// ── Данные, которые помощнику нужны от Core. Сурфейс (бот/панель) даёт адаптер. ──
export interface AssistantBriefing {
  overdueMoney: number;
  idleMachines: number;
  pendingApprovals: number;
  contractsDueSoon: number;
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

/**
 * Единый ответ помощника. UI-агностичен: возвращает текст (+ id согласования,
 * если релевантно). Бот привешивает клавиатуру, панель — кнопки.
 *
 * Ошибки Core наружу превращаются в понятную фразу — детали остаются у сурфейса.
 */
export async function answer(text: string, core: AssistantCore): Promise<AssistantReply> {
  const intent = parseIntent(text);

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
      // Непонятый вопрос: пока подсказка. Здесь позже включится LLM-слой.
      return { text: HELP };
  }
}
