import { answer, type ContextSearch, type LlmResolver } from "@mydon/assistant";
import type { DocumentRequest, GeneratedDocument } from "@mydon/documents";
import { DOMAIN_LABELS } from "@mydon/shared";
import { approvalKeyboard, formatApproval, formatBriefing } from "./briefing";
import type { CoreClient } from "./core-client";
import {
  formatCashAck,
  formatCashSessions,
  isCashHistoryQuery,
  isCashPrefixed,
  parseCashSession,
} from "./cash-intake";
import { parseIntent } from "./intent";
import {
  formatPurchaseBrief,
  formatPurchaseOrders,
  formatPurchaseSubmitAck,
  formatReceiveOrderAck,
  isPurchaseOrdersQuery,
  isPurchaseReceiveCommand,
  isPurchaseSubmitCommand,
} from "./purchase-brief";
import { planReport } from "./reports";
import { formatStockAck, isStockCommand, parseStockItems } from "./stock-intake";
import type { RateLimiter } from "./security/access";
import { isAllowed } from "./security/access";

export type DocumentBuilder = (req: DocumentRequest) => Promise<GeneratedDocument>;

export interface HandlerDeps {
  core: CoreClient;
  allowlist: Set<number>;
  limiter: RateLimiter;
  /** LLM-слой: понимает вопросы вне правил. Нет ключа → ветка «непонятно» = подсказка. */
  llm?: LlmResolver;
  /** Память: поиск по прошлым разговорам и заметкам перед ответом. */
  context?: ContextSearch;
  /** Построение документов (Excel, Word). Нет ключа — файлов не делаем. */
  buildDocument?: DocumentBuilder;
}

export interface Reply {
  text: string;
  keyboard?: ReturnType<typeof approvalKeyboard>;
  /** Готовый файл: владелец получает его в чат, а не текст для переписывания. */
  document?: { filename: string; content: Buffer; caption?: string };
}

const HELP = [
  "MYDON на связи. Что умею:",
  "",
  "• «брифинг» — сводка: просрочки, автоматы, сроки, что требует решения",
  "• «что просрочено» — обязательства и долги",
  "• «какие автоматы простаивают»",
  "• «что заказать» — сводка к закупу вендинга",
  "• «оформить закуп» — отправить закуп тебе на утверждение",
  "• «накладные» — одобренные закупы",
  "• «принять закуп» — оприходовать накладную на склад",
  "• «склад Montella 24, Fanta 12» — записать остатки склада",
  "• «касса закупа: получил 2400000, базар 376300» — записать кассу похода на базар",
  "• «кассы закупа» / «история кассы» — прошлые кассы",
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

  // Касса закупа — мутация; СТРОГО до приёмки накладной: «касса закупа:
  // получил N, …» содержит и «получил», и «закуп» — isPurchaseReceiveCommand
  // перехватила бы её раньше, если бы эта проверка шла после.
  //
  // Гейт — isCashPrefixed (только префикс), а НЕ isCashCommand (полный разбор):
  // если сообщение явно начинается с «касса закупа», оно КОММИТИТСЯ как
  // кассовое — ошибка разбора отвечает подсказкой формата, а не проваливается
  // дальше по цепочке. «касса закупа: получил 2400000» (без статьи) раньше
  // проваливалась в isPurchaseReceiveCommand и вызывала приёмку накладной
  // вместо ошибки формата — реальная мутация не по адресу (найдено
  // адверсариал-ревью).
  if (isCashPrefixed(text)) {
    const session = parseCashSession(text);
    if (!session) {
      return {
        text:
          "Не понял формат кассы. Нужны «получил N» и хотя бы одна статья:\n" +
          "«касса закупа: получил 2400000, базар 376300».",
      };
    }
    try {
      const res = await deps.core.recordVendingCash(session.receivedAmount, session.categories);
      return { text: formatCashAck(res) };
    } catch (err) {
      console.error("Ошибка записи кассы закупа:", err);
      return { text: "Не удалось записать кассу закупа в MYDON Core. Попробуй ещё раз чуть позже." };
    }
  }

  // История касс закупа — чтение, отдельная фраза от «накладные».
  if (isCashHistoryQuery(text)) {
    try {
      const sessions = await deps.core.vendingCashSessions();
      return { text: formatCashSessions(sessions) };
    } catch (err) {
      console.error("Ошибка чтения касс закупа:", err);
      return { text: "Не удалось получить кассы закупа из MYDON Core. Попробуй ещё раз чуть позже." };
    }
  }

  // Оформление закупа — мутация (создаёт заявку на утверждение), ловим до
  // parseIntent: иначе «оформить закуп» ушёл бы в брифинг «закуп». Само «закуп»
  // без глагола-намерения остаётся брифингом (isPurchaseSubmitCommand=false).
  if (isPurchaseSubmitCommand(text)) {
    try {
      const res = await deps.core.submitVendingPurchase("owner");
      return { text: formatPurchaseSubmitAck(res) };
    } catch (err) {
      console.error("Ошибка отправки закупа на утверждение:", err);
      return { text: "Не удалось отправить закуп в MYDON Core. Попробуй ещё раз чуть позже." };
    }
  }

  // Приёмка накладной на склад — мутация; до списка накладных, иначе «накладная
  // принята» ушла бы в чтение списка (обе ловят слово «накладн»).
  if (isPurchaseReceiveCommand(text)) {
    try {
      const res = await deps.core.receiveVendingOrder();
      return { text: formatReceiveOrderAck(res) };
    } catch (err) {
      console.error("Ошибка приёмки накладной:", err);
      return { text: "Не удалось принять накладную в MYDON Core. Попробуй ещё раз чуть позже." };
    }
  }

  // Накладные закупа — чтение результата одобрения; ловим здесь, чтобы «накладные»
  // не ушло в общий разбор как непонятое.
  if (isPurchaseOrdersQuery(text)) {
    try {
      const orders = await deps.core.vendingOrders();
      return { text: formatPurchaseOrders(orders) };
    } catch (err) {
      console.error("Ошибка чтения накладных:", err);
      return { text: "Не удалось получить накладные из MYDON Core. Попробуй ещё раз чуть позже." };
    }
  }

  // Ввод остатков склада — мутация, ловим до чтения-намерений: «склад X 24, Y 12».
  // Без разбираемых пар (просто «остаток?») isStockCommand=false — уйдёт в общий разбор.
  if (isStockCommand(text)) {
    const items = parseStockItems(text);
    try {
      const res = await deps.core.setVendingStock(items);
      return { text: formatStockAck(items, res.adjustments) };
    } catch (err) {
      console.error("Ошибка записи остатков склада:", err);
      return { text: "Не удалось записать остатки в MYDON Core. Попробуй ещё раз чуть позже." };
    }
  }

  const intent = parseIntent(text);

  try {
    switch (intent.kind) {
      case "briefing": {
        const [b, approvals, purchase] = await Promise.all([
          deps.core.briefing(),
          deps.core.pendingApprovals(),
          deps.core.vendingPurchase().catch(() => null),
        ]);
        return {
          text: formatBriefing(
            b,
            approvals,
            purchase ? { positions: purchase.items.length, costRounded: purchase.costRounded } : undefined,
          ),
        };
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

      case "purchase": {
        const p = await deps.core.vendingPurchase();
        return { text: formatPurchaseBrief(p) };
      }

      case "obligations": {
        const o = await deps.core.obligations(intent.domain);
        const label = DOMAIN_LABELS[intent.domain];
        if (o.totals.length === 0) {
          return { text: `По направлению ${label} обязательств в реестре пока нет.` };
        }
        return { text: `Обязательства ${label}: позиций ${o.totals.length}, просрочено ${o.overdue.length}.` };
      }

      case "report": {
        // Готовые навыки Anthropic (xlsx/docx). Нет ключа — честно говорим,
        // а не отдаём текст вместо обещанного файла.
        if (!deps.buildDocument) {
          return {
            text:
              "Чтобы делать файлы (Excel, Word), нужен ключ Claude в настройках сервера. " +
              "Пока могу ответить только текстом.",
          };
        }

        const plan = await planReport(
          { format: intent.format, topic: intent.topic, ...(intent.domain ? { domain: intent.domain } : {}) },
          deps.core,
        );
        if (plan.emptyReason) return { text: plan.emptyReason };

        const doc = await deps.buildDocument({
          kind: plan.kind,
          instruction: plan.instruction,
          data: plan.data,
          filename: plan.filename,
        });
        return {
          text: doc.summary.length > 0 ? doc.summary : "Готово.",
          document: { filename: doc.filename, content: doc.content },
        };
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
        const reply = await answer(text, deps.core, {
          llm: deps.llm,
          ...(deps.context ? { context: deps.context } : {}),
        });
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
