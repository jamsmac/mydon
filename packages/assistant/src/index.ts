import {
  DOMAIN_LABELS,
  DOMAINS,
  LlmBudgetDeniedError,
  LlmLedgerUnavailableError,
  LlmReplayBlockedError,
  type Domain,
  type LlmCallContext,
} from "@mydon/shared";
import { DOMAIN_HINT, parseIntent, type Intent } from "./intent";

export { parseIntent, DOMAIN_HINT };
export type { Intent };

// LLM-слой (реализация порта LlmResolver через Claude API). SDK внутри грузится
// лениво — этот реэкспорт не тянет @anthropic-ai/sdk при импорте пакета.
export { createLlmResolver } from "./llm";
export type { LlmConfig } from "./llm";

// Память помощника: поиск по прошлым разговорам и знаниям (через Core).
export { createContextSearch } from "./context";
export type { ContextConfig } from "./context";

// LLM от подписки Claude владельца (Agent SDK) — без отдельного API-ключа.
export { createSubscriptionResolver, withLlmFallback } from "./llm-subscription";
export type { SubscriptionLlmConfig } from "./llm-subscription";

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

/** Кофе-факт для заземления LLM: расход по наборам за последние 30 дней. */
export interface AssistantCoffeeFacts {
  totalGrams: number;
  /** Себестоимость; null — цены ингредиентов не заведены. */
  totalCost: number | null;
  /** Точка с наибольшим расходом; null — пар нет. */
  topLocation: string | null;
}

/** Что помощник умеет спросить у Core. Реализуется и ботом, и панелью. */
export interface AssistantCore {
  briefing(): Promise<AssistantBriefing>;
  pendingApprovals(): Promise<AssistantApproval[]>;
  obligations(domain: Domain): Promise<AssistantObligations>;
  searchEntities(q: { q: string; domain?: Domain }): Promise<AssistantEntity[]>;
  recent(limit: number): Promise<AssistantAudit[]>;
  /** Опционально: сурфейс без кофе-данных просто не отдаёт этот метод. */
  coffeeConsumption30d?(): Promise<AssistantCoffeeFacts | null>;
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
  /** Расход кофе за 30 дней — если сурфейс отдаёт кофе-данные. */
  coffee?: AssistantCoffeeFacts;
  /** Что нашлось в прошлых разговорах и знаниях по этому вопросу. */
  context?: ContextHit[];
}

export type LlmResolution =
  | { kind: "intent"; intent: Intent } // выполнить это намерение через Core
  | { kind: "answer"; text: string } // готовый фактический ответ по снимку
  | { kind: "none" }; // не удалось понять

export type LlmResolver = (
  question: string,
  snapshot: LlmSnapshot,
  context?: LlmCallContext,
) => Promise<LlmResolution>;

/**
 * Поиск по прошлым разговорам и знаниям.
 *
 * Без него помощник отвечает «с чистого листа» и предлагает то, что владелец
 * уже решил. С ним — видит, о чём договаривались, и опирается на это.
 */
export type ContextSearch = (query: string) => Promise<ContextHit[]>;

export interface ContextHit {
  /** Откуда: «разговор» (история) или «знание» (заметка). */
  kind: "разговор" | "знание";
  /** Где именно: проект или заголовок заметки. */
  where: string;
  text: string;
}

export interface AnswerOptions {
  /** Если задан — непонятые вопросы уходят в LLM. Нет ключа/резолвера → подсказка. */
  llm?: LlmResolver;
  /** Идемпотентная идентичность запроса для денежного ledger. */
  llmContext?: LlmCallContext;
  /** Поиск по истории и заметкам: помощник отвечает, зная контекст. */
  context?: ContextSearch;
}

/** Честный текст для денежного отказа; null — это не ledger-ошибка. */
export function llmLedgerErrorText(error: unknown): string | null {
  if (error instanceof LlmBudgetDeniedError) {
    return `Платный ИИ-запрос не выполнен: ${error.reason}`;
  }
  if (error instanceof LlmLedgerUnavailableError) {
    return "Не удалось проверить лимит расходов на ИИ, поэтому платный запрос не выполнен. Попробуй позже.";
  }
  if (error instanceof LlmReplayBlockedError) {
    return "Этот платный ИИ-запрос уже был принят, но готовый ответ не сохранён. Повтори его как новый запрос.";
  }
  return null;
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
async function buildSnapshot(
  core: AssistantCore,
  context: ContextHit[] = [],
): Promise<LlmSnapshot> {
  const [briefing, approvals, recent, coffee] = await Promise.all([
    core.briefing(),
    core.pendingApprovals(),
    core.recent(5),
    // Кофе — дополнение: нет метода или он упал → снимок без кофе, не ошибка.
    core.coffeeConsumption30d
      ? core.coffeeConsumption30d().catch(() => null)
      : Promise.resolve(null),
  ]);
  return {
    briefing,
    pendingApprovals: approvals.length,
    recentLabels: recent.map((e) => actionLabel(e.action)),
    domains: DOMAINS.join(", "),
    ...(coffee !== null ? { coffee } : {}),
    ...(context.length > 0 ? { context } : {}),
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
    // Ищем в прошлых разговорах и знаниях ДО обращения к модели: ответ должен
    // опираться на то, о чём уже договаривались, а не начинаться с нуля.
    // Поиск не обязателен — не нашёлся или сломался, отвечаем как раньше.
    let context: ContextHit[] = [];
    if (opts.context) {
      try {
        context = await opts.context(intent.text);
      } catch (err) {
        // Память не критична — отвечаем без неё. Но молчать нельзя: иначе
        // владелец не отличит «в памяти ничего нет» от «поиск сломан»
        // (находка ревизии 2026-07-30).
        console.warn(
          "Память недоступна — отвечаю без прошлых разговоров:",
          err instanceof Error ? err.message : err,
        );
        context = [];
      }
    }
    const snapshot = await buildSnapshot(core, context);
    res = await opts.llm(intent.text, snapshot, opts.llmContext);
  } catch (err) {
    const ledgerText = llmLedgerErrorText(err);
    if (ledgerText !== null) {
      console.warn(
        "LLM-вызов заблокирован денежным ledger:",
        err instanceof Error ? err.message : err,
      );
      return { text: ledgerText };
    }
    // LLM недоступен (нет ключа, сеть, лимит) — не роняем помощника, даём
    // подсказку. Но след в журнале обязателен: иначе «кончился лимит подписки»
    // неотличим от «вопрос не понят», и владелец не узнает о поломке.
    console.error(
      "LLM-слой не ответил, отвечаю подсказкой:",
      err instanceof Error ? err.message : err,
    );
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
