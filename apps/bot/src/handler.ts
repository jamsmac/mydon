import { answer, type LlmResolver } from "@mydon/assistant";
import { DOMAIN_LABELS } from "@mydon/shared";
import { approvalKeyboard, formatApproval, formatBriefing } from "./briefing";
import type { CoreClient } from "./core-client";
import { parseIntent } from "./intent";
import type { RateLimiter } from "./security/access";
import { isAllowed } from "./security/access";

export interface HandlerDeps {
  core: CoreClient;
  allowlist: Set<number>;
  limiter: RateLimiter;
  /** LLM-слой: понимает вопросы вне правил. Нет ключа → ветка «непонятно» = подсказка. */
  llm?: LlmResolver;
}

export interface Reply {
  text: string;
  keyboard?: ReturnType<typeof approvalKeyboard>;
}

const HELP = [
  "MYDON на связи. Что умею:",
  "",
  "• «брифинг» — сводка: просрочки, автоматы, сроки, что требует решения",
  "• «что просрочено» — обязательства и долги",
  "• «какие автоматы простаивают»",
  "• «согласования» — очередь на твоё решение",
  "• «найди Olma» — поиск по реестру",
].join("\n");

/**
 * Обработка входящего сообщения.
 * Порядок проверок важен: сначала доступ, потом частота, и только затем смысл —
 * чтобы чужой чат не мог ни нагрузить бота, ни узнать что-либо о данных.
 */
export async function handleMessage(
  chatId: number,
  text: string,
  deps: HandlerDeps,
  now: number = Date.now(),
): Promise<Reply | null> {
  // Здесь обрабатывается только владелец. Сообщения сотрудников маршрутизирует
  // цикл бота: у них свой, узкий режим (см. staff.ts) — только свои задачи.
  if (!isAllowed(chatId, deps.allowlist)) {
    // Чужим не отвечаем вовсе: молчание не подтверждает существование бота.
    return null;
  }
  if (!deps.limiter.allow(chatId, now)) {
    return { text: "Слишком много запросов подряд. Подожди минуту." };
  }

  const intent = parseIntent(text);

  try {
    switch (intent.kind) {
      case "briefing": {
        const [b, approvals] = await Promise.all([
          deps.core.briefing(),
          deps.core.pendingApprovals(),
        ]);
        return { text: formatBriefing(b, approvals) };
      }

      case "approvals": {
        const list = await deps.core.pendingApprovals();
        if (list.length === 0) return { text: "Очередь пуста — ничего не ждёт твоего решения." };
        const first = list[0];
        return { text: formatApproval(first), keyboard: approvalKeyboard(first.id) };
      }

      case "overdue": {
        const b = await deps.core.briefing();
        return {
          text:
            b.overdueMoney > 0
              ? `Просрочено платежей: ${b.overdueMoney}. Полный список — в разделе обязательств.`
              : "Просрочек не найдено.",
        };
      }

      case "machines": {
        const b = await deps.core.briefing();
        return {
          text:
            b.idleMachines > 0
              ? `Простаивают автоматы: ${b.idleMachines}.`
              : "Простаивающих автоматов не найдено.",
        };
      }

      case "obligations": {
        const o = await deps.core.obligations(intent.domain);
        const label = DOMAIN_LABELS[intent.domain];
        if (o.totals.length === 0) {
          return { text: `По направлению ${label} обязательств в реестре пока нет.` };
        }
        return { text: `Обязательства ${label}: позиций ${o.totals.length}, просрочено ${o.overdue.length}.` };
      }

      case "recent": {
        const log = await deps.core.recent(10);
        if (log.length === 0) return { text: "Пока ничего не происходило — журнал пуст." };
        const label: Record<string, string> = {
          "entity.create": "завёл карточку",
          "task.create": "поставил задачу",
          "task.done": "закрыл задачу",
          "approval.request": "агент попросил разрешения",
          "approval.approved": "ты одобрил",
          "approval.rejected": "ты отклонил",
        };
        const lines = log.map((e) => `• ${label[e.action] ?? e.action}`);
        return { text: ["Последнее в системе:", "", ...lines].join("\n") };
      }

      case "search": {
        let found = await deps.core.searchEntities({
          q: intent.query,
          ...(intent.domain ? { domain: intent.domain } : {}),
        });

        // Слово из запроса может совпасть с названием направления
        // и случайно сузить поиск до чужого домена. Если там пусто — ищем везде,
        // иначе владелец получает «не найдено» на существующую запись.
        if (found.length === 0 && intent.domain) {
          found = await deps.core.searchEntities({ q: intent.query });
        }

        if (found.length === 0) return { text: `По запросу «${intent.query}» ничего не найдено.` };
        const lines = found.slice(0, 10).map((e) => `• ${e.name} (${e.type})`);
        if (found.length > 10) lines.push(`…и ещё ${found.length - 10}`);
        return { text: [`Нашёл по «${intent.query}»:`, "", ...lines].join("\n") };
      }

      default: {
        // Непонятый правилами вопрос. Есть LLM — отдаём общему «мозгу» помощника
        // (тот же answer(), что и в панели): распознает намерение → Core ответит
        // фактами, либо короткий ответ по снимку. Нет ключа — подсказка.
        if (!deps.llm) return { text: HELP };
        const reply = await answer(text, deps.core, { llm: deps.llm });
        return reply.approvalId
          ? { text: reply.text, keyboard: approvalKeyboard(reply.approvalId) }
          : { text: reply.text };
      }
    }
  } catch (err) {
    // Наружу — понятная фраза, детали только в лог.
    console.error("Ошибка обработки сообщения:", err);
    return { text: "Не удалось получить данные из MYDON Core. Попробуй ещё раз чуть позже." };
  }
}

/** Разбор нажатия кнопки согласования: "ap:<решение>:<id>". */
export function parseApprovalCallback(
  data: string,
): { decision: "approved" | "rejected" | "clarify"; id: string } | null {
  const parts = data.split(":");
  if (parts.length !== 3 || parts[0] !== "ap") return null;
  const [, decision, id] = parts;
  if (decision !== "approved" && decision !== "rejected" && decision !== "clarify") return null;
  if (!id) return null;
  return { decision, id };
}
